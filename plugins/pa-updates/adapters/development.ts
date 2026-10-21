import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { integrationId } from '../core/application-model.ts';
import type { DevelopmentWork } from '../core/application-model.ts';
import { SOURCE_URL } from '../core/release.ts';
const LIMIT = 1024 * 1024, paths = integrationId.options.map(id => `plugins/${id}`);
export class DevelopmentError extends Error {
  readonly category: 'unsupported' | 'unavailable' | 'changed' | 'limit';
  constructor(category: DevelopmentError['category']) { super(category); this.category = category; }
}
export const unknownDevelopment = (): DevelopmentWork => Object.fromEntries(integrationId.options.map(id => [id, 'unknown'])) as DevelopmentWork;
async function bytes(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw new DevelopmentError('limit');
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size < buffer.length) { const chunk = await file.read(buffer, size, buffer.length - size, null); if (!chunk.bytesRead) break; size += chunk.bytesRead; }
    if (size > limit) throw new DevelopmentError('limit'); return { data: buffer.subarray(0, size), stat };
  } finally { await file.close(); }
}
async function optional(path: string, limit: number) {
  try { return await bytes(path, limit); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const sha = (value: string) => { if (!/^[a-f0-9]{40}$/.test(value)) throw new DevelopmentError('unsupported'); return value; };
async function head(gitDir: string) {
  const value = (await bytes(join(gitDir, 'HEAD'), 1024)).data.toString().trim();
  if (!value.startsWith('ref: ')) return sha(value);
  const ref = value.slice(5);
  if (!/^refs\/heads\/[\w./-]+$/.test(ref) || ref.includes('..')) throw new DevelopmentError('unsupported');
  const loose = await optional(join(gitDir, ref), 1024); if (loose) return sha(loose.data.toString().trim());
  const packed = await optional(join(gitDir, 'packed-refs'), LIMIT);
  return sha(packed?.data.toString().split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? '');
}
export const canonicalCheckout = (home = homedir()) => join(home, 'src', 'pa-bb');
/** Absence is normal; a present but unreadable/unsupported checkout is not clean. */
export async function inspectCanonicalDevelopment(signal: AbortSignal, source = SOURCE_URL, checkout = canonicalCheckout()): Promise<DevelopmentWork | null> {
  try { await lstat(checkout); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new DevelopmentError('unavailable'); }
  return inspectDevelopment(checkout, signal, source);
}
/** Read the canonical checkout through a private Git directory/index.
 * No Git command runs in, or writes to, the owner repository. No checkout,
 * hooks, filters, builds, credential helpers or source scripts are executed.
 */
export async function inspectDevelopment(checkout: string | undefined, signal: AbortSignal, source = SOURCE_URL): Promise<DevelopmentWork | null> {
  if (!checkout) return null;
  if (!isAbsolute(checkout) || /[\0\r\n]/.test(checkout) || checkout.length > 4096) throw new DevelopmentError('unsupported');
  let temp: string | undefined;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    const root = await realpath(checkout), ownerGit = join(root, '.git');
    if (!(await lstat(ownerGit)).isDirectory() || !(await lstat(join(ownerGit, 'objects'))).isDirectory()) throw new DevelopmentError('unsupported');
    for (const file of ['shallow', 'commondir', 'info/grafts', 'info/attributes', 'objects/info/alternates']) if (await optional(join(ownerGit, file), LIMIT)) throw new DevelopmentError('unsupported');
    const local = await head(ownerGit), index = await bytes(join(ownerGit, 'index'), 8 * LIMIT), config = await bytes(join(ownerGit, 'config'), 64 * 1024);
    temp = await mkdtemp(join(tmpdir(), 'pa-development-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: temp, LANG: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = (args: string[]) => new Promise<Buffer>((resolve, reject) => {
      if (bounded.aborted) return reject(new DevelopmentError('limit'));
      const child = spawn('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'credential.helper=', '-c', 'diff.external=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(source === SOURCE_URL ? [] : ['-c', 'protocol.file.allow=always']), '-c', 'http.followRedirects=false', '-c', 'gc.auto=0', ...args], { cwd: temp, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let size = 0, failed = false; const chunks: Buffer[] = [];
      const stop = () => { failed = true; try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already closed. */ } };
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) stop(); else chunks.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) stop(); });
      const timer = setTimeout(stop, 30_000); bounded.addEventListener('abort', stop, { once: true });
      child.on('error', () => { failed = true; });
      child.once('close', code => { clearTimeout(timer); bounded.removeEventListener('abort', stop); if (failed || code !== 0) reject(new DevelopmentError(failed ? 'limit' : 'unavailable')); else resolve(Buffer.concat(chunks)); });
      if (bounded.aborted) stop();
    });
    await git(['init', '--bare', '.']);
    await writeFile(join(temp, 'owner-config'), config.data, { mode: 0o600 });
    const settings = (await git(['config', '--file', join(temp, 'owner-config'), '--no-includes', '--list', '-z'])).toString().split('\0');
    if (settings.some(entry => /^(filter\.|include\.|includeif\.|extensions\.|core\.(worktree|autocrlf|eol|sparsecheckout|ignorestat|attributesfile|excludesfile)\n)/i.test(entry))) throw new DevelopmentError('unsupported');
    const fileMode = settings.find(entry => entry.startsWith('core.filemode\n'))?.split('\n')[1] ?? 'true';
    if (!['true', 'false'].includes(fileMode)) throw new DevelopmentError('unsupported');
    // Fetch before attaching local objects/refs: even negotiation has no local
    // unpublished commit IDs. Never consult the owner's cached origin/main.
    await git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=256', '--filter=blob:none', source, 'refs/heads/main:refs/heads/published']);
    const published = sha((await git(['rev-parse', 'refs/heads/published'])).toString().trim());
    await mkdir(join(temp, 'objects/info'), { recursive: true });
    await writeFile(join(temp, 'objects/info/alternates'), join(ownerGit, 'objects') + '\n', { mode: 0o600 });
    await git(['update-ref', 'refs/heads/local', local]); await git(['symbolic-ref', 'HEAD', 'refs/heads/local']);
    const exclude = await optional(join(ownerGit, 'info/exclude'), 64 * 1024); if (exclude) await writeFile(join(temp, 'info/exclude'), exclude.data, { mode: 0o600 });
    await writeFile(join(temp, 'index'), index.data, { mode: 0o600 });
    // Retain index time so copying cannot hide Git's racy-clean detection.
    await utimes(join(temp, 'index'), index.stat.atime, index.stat.mtime);
    const worktree = ['--git-dir', temp, '--work-tree', root, '-c', 'core.bare=false', '-c', `core.filemode=${fileMode}`];
    const flags = (await git([...worktree, 'ls-files', '-v', '-z', '--', ...paths])).toString().split('\0');
    if (flags.some(line => /^[a-zS]/.test(line))) throw new DevelopmentError('unsupported');
    const stages = (await git([...worktree, 'ls-files', '--stage', '-z', '--', ...paths])).toString().split('\0');
    if (stages.some(line => /^160000 /.test(line))) throw new DevelopmentError('unsupported');
    const tracked = [...new Set(stages.filter(Boolean).map(line => line.slice(line.indexOf('\t') + 1)))];
    if (tracked.length > 4096) throw new DevelopmentError('limit');
    // A globally configured filter (e.g. LFS) must not become a false dirty
    // verdict just because this isolated Git intentionally has no such driver.
    for (let offset = 0; offset < tracked.length; offset += 128) {
      const attributes = (await git([...worktree, 'check-attr', '--all', '-z', '--', ...tracked.slice(offset, offset + 128)])).toString().split('\0');
      if (attributes.some((value, index) => index % 3 === 1 && value === 'filter')) throw new DevelopmentError('unsupported');
    }
    const status = () => git([...worktree, 'status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=all', '--', ...paths]);
    const before = await status();
    const base = sha((await git(['merge-base', '--all', local, published])).toString().trim());
    const changed = async (from: string, to: string) => (await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', from, to, '--', ...paths])).toString().split('\0').filter(Boolean);
    const localPaths = await changed(base, local), different = new Set(await changed(local, published));
    const dirty = before.toString().split('\0').filter(Boolean).map(line => line.slice(3));
    if (localPaths.length + different.size + dirty.length > 4096) throw new DevelopmentError('limit');
    const after = await status(), nextIndex = await bytes(join(ownerGit, 'index'), 8 * LIMIT);
    if (await head(ownerGit) !== local || digest(index.data) !== digest(nextIndex.data) || !before.equals(after) || !(await bytes(join(ownerGit, 'config'), 64 * 1024)).data.equals(config.data)) throw new DevelopmentError('changed');
    const work = [...dirty, ...localPaths.filter(path => different.has(path))];
    return Object.fromEntries(integrationId.options.map(id => [id, work.some(path => path === `plugins/${id}` || path.startsWith(`plugins/${id}/`)) ? 'unpublished' : 'clean'])) as DevelopmentWork;
  } catch (error) { throw error instanceof DevelopmentError ? error : new DevelopmentError('unavailable'); }
  finally { if (temp) await rm(temp, { recursive: true, force: true }); }
}
