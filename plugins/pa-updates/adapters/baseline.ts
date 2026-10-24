import { execFile } from 'node:child_process';
import { z } from 'zod';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { IntegrationId } from '../core/application.ts';
import { ApplicationError, integrationId } from '../core/application-model.ts';
import { originUrl as SOURCE_URL } from '../core/workspace.ts';
import { treeFingerprint } from './source-files.ts';
const exec = promisify(execFile);
const LIMIT = 32 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const artifacts = ['dist/server.js', 'dist/server.meta.json', 'dist/app.js', 'dist/app.css', 'dist/app.meta.json'];
const ignored = new Set(['.git', 'node_modules', 'test', 'tests', 'features', 'docs']);
const relevant = (path: string) => !path.split('/').some(part => ignored.has(part)) &&
  (artifacts.includes(path) || (!path.startsWith('dist/') && !/(^|\/)(README[^/]*|LICENSE[^/]*|\.DS_Store)$/.test(path)));
type Manifest = { version: string; engines?: { bb?: string; bbPluginSdk?: string } };
const cachedExpected = z.object({
  id: integrationId, commit: z.string().regex(/^[a-f0-9]{40}$/), builder: z.string().regex(/^\d+\.\d+\.\d+$/),
  originalVersion: z.string().min(1).max(64),
  files: z.record(z.string().min(1).max(1024).refine(path => !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')),
    z.string().regex(/^[a-f0-9]{64}$/)).refine(files => Object.keys(files).length > 0 && Object.keys(files).length <= 512),
}).strict();
export const baselineCacheSchema = z.object({ version: z.literal(1), source: z.string().max(2048), records: z.array(cachedExpected).max(6) }).strict()
  .refine(value => new Set(value.records.map(record => record.id)).size === value.records.length && Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024);
export type BaselineCache = z.infer<typeof baselineCacheSchema>;
export type BaselineStore = { load(): Promise<unknown>; save(value: BaselineCache): Promise<void> };
type Expected = z.infer<typeof cachedExpected>;

/** Fixed-source, bounded source/artifact inspection for the six PA packages.
 * Selects only already-installed BB packages. Their normal build command and
 * npm may download pinned build/package dependencies; this is not offline.
 * Expected hashes come from published Git objects, never today's installed bytes.
 */
export class Baselines {
  private expected = new Map<IntegrationId, Expected>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> | null = null;
  private stopped = false;
  private store: BaselineStore | undefined;
  private sources = new Map<string, string>();
  private root: string | null = null;
  private sourceUrl: string;
  private cliHint: string | undefined;
  private signal: AbortSignal | undefined;
  constructor(sourceUrl = SOURCE_URL, cliHint = process.env.BB_CLI, signal?: AbortSignal, store?: BaselineStore) { this.sourceUrl = sourceUrl; this.cliHint = cliHint; this.signal = signal; this.store = store; }
  private active() { if (this.stopped || this.signal?.aborted) throw new ApplicationError('interrupted'); }
  private load() {
    return this.loaded ??= (async () => {
      try {
        const value = await this.store?.load(); this.active();
        if (value == null) return;
        const saved = baselineCacheSchema.parse(value);
        if (saved.source === this.sourceUrl) this.expected = new Map(saved.records.map(record => [record.id, record]));
      } catch { this.active(); throw new ApplicationError('storage'); }
    })();
  }
  private async remember(records: Map<IntegrationId, Expected>) {
    this.active();
    const value = baselineCacheSchema.parse({ version: 1, source: this.sourceUrl, records: [...records.values()] });
    if (this.store) {
      const writing = Promise.resolve().then(() => { this.active(); return this.store!.save(value); }); this.writing = writing;
      try { await writing; this.active(); }
      catch { this.active(); throw new ApplicationError('storage'); }
      finally { if (this.writing === writing) this.writing = null; }
    }
    this.expected = records;
  }
  async retain(ids: IntegrationId[]) {
    await this.load(); this.active();
    const active = new Map([...this.expected].filter(([id]) => ids.includes(id)));
    if (active.size !== this.expected.size) await this.remember(active);
  }
  async stop() { this.stopped = true; await this.writing?.catch(() => {}); }
  private async command(command: string, args: string[], cwd?: string, isolatedHome?: string, buildVersion?: string) {
    try {
      this.active();
      const result = await exec(command, args, { cwd, signal: this.signal, timeout: 120_000, maxBuffer: LIMIT,
        ...(isolatedHome ? { env: { PATH: process.env.PATH, HOME: isolatedHome, NODE_ENV: 'production', BB_APP_VERSION: buildVersion, npm_config_cache: join(isolatedHome, 'npm-cache') } } : {}) });
      this.active(); return result.stdout;
    } catch { this.active(); throw new ApplicationError('baseline_unknown'); }
  }
  async close() { if (this.root) await rm(this.root, { recursive: true, force: true }); this.root = null; this.sources.clear(); }
  private async source(commit: string) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new ApplicationError('baseline_unknown');
    const cached = this.sources.get(commit); if (cached) return cached;
    this.root ??= await mkdtemp(join(tmpdir(), 'pa-update-baselines-'));
    const dir = join(this.root, commit); await mkdir(dir);
    await this.command('git', ['init', '-q', '--bare'], dir);
    await this.command('git', ['fetch', '--quiet', '--depth=1', '--no-tags', this.sourceUrl, commit], dir, this.root);
    this.sources.set(commit, dir); return dir;
  }
  /** Compare code, not the repository commit or package version. No build. */
  async sourceIdentity(commit: string, id: IntegrationId): Promise<string> {
    const dir = await this.source(commit);
    const listing = await this.command('git', ['ls-tree', '-rz', commit, '--', `plugins/${id}`], dir);
    return treeFingerprint(Buffer.from(listing), `plugins/${id}/`);
  }
  async manifest(commit: string, id: IntegrationId): Promise<Manifest> {
    const dir = await this.source(commit);
    try {
      const raw = await this.command('git', ['show', `${commit}:plugins/${id}/package.json`], dir);
      if (Buffer.byteLength(raw) > 65536) throw new Error();
      const value = JSON.parse(raw);
      if (typeof value.version !== 'string' || value.version.length > 64 || value.name !== `bb-plugin-${id}`) throw new Error();
      return { version: value.version, engines: value.engines };
    } catch { throw new ApplicationError('baseline_unknown'); }
  }
  private async builder(recordedVersion: string) {
    const candidates: string[] = [];
    if (this.cliHint) candidates.push(this.cliHint);
    try { candidates.push((await this.command('which', ['bb'])).trim()); } catch { /* optional local launcher */ }
    try { candidates.push(join((await this.command('npm', ['root', '-g'])).trim(), 'bb-app', 'host-daemon', 'dist', 'bb')); } catch { /* optional npm-global installation */ }
    // The native launcher keeps a previous app-version directory. Consider
    // only the exact recorded sibling of an already-located active CLI; never
    // fetch an old toolchain or scan arbitrary installation history.
    for (const candidate of [...candidates]) {
      try {
        let parent = dirname(await realpath(candidate));
        for (let depth = 0; depth < 8; depth++, parent = dirname(parent)) {
          if (basename(parent) === 'app-versions') {
            candidates.push(join(parent, recordedVersion, 'node_modules', 'bb-app', 'host-daemon', 'dist', 'bb')); break;
          }
        }
      } catch { /* optional retained builder */ }
    }
    for (const candidate of candidates) {
      let directory: string;
      try { directory = dirname(await realpath(candidate)); } catch { continue; }
      for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
        try {
          const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          if (value.name !== 'bb-app' || value.version !== recordedVersion) continue;
          const npmPackage = createRequire(join(directory, 'package.json')).resolve('npm/package.json');
          return { cli: join(directory, 'host-daemon/dist/bb'), npm: join(dirname(npmPackage), 'bin/npm-cli.js') };
        } catch { /* not this local package */ }
      }
    }
    throw new ApplicationError('baseline_unknown');
  }
  private async files(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = Object.create(null); let total = 0, count = 0;
    const visit = async (directory: string, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        this.active();
        const path = prefix + entry.name;
        if (ignored.has(entry.name)) continue;
        if (entry.isSymbolicLink()) throw new ApplicationError('baseline_unknown');
        if (entry.isDirectory()) {
          if (path !== 'dist' && !relevant(path)) continue;
          if (path.split('/').length > 16) throw new ApplicationError('baseline_unknown');
          await visit(join(directory, entry.name), path + '/');
        } else if (entry.isFile() && relevant(path)) {
          const stat = await lstat(join(root, path)); total += stat.size; count++;
          if (total > LIMIT || count > 512) throw new ApplicationError('baseline_unknown');
          result[path] = sha(await readFile(join(root, path)));
        }
      }
    };
    await visit(root); return result;
  }
  async inspect(id: IntegrationId, installedRoot: string, sourceRevision: string): Promise<{ local: 'stock' | 'custom'; fingerprint: string; originalVersion: string }> {
    try {
      // BB's managed Git snapshot is checkout-free: it contains no .git.
      // This bounded adapter recognizes the active public inventory root's
      // <commit>/plugins/<id> suffix, not candidate history or a local checkout.
      const active = resolve(installedRoot), commit = basename(dirname(dirname(active)));
      if (basename(active) !== id || basename(dirname(active)) !== 'plugins' ||
        !/^[a-f0-9]{40}$/.test(commit) || !/^(?:[a-f0-9]{12}|[a-f0-9]{40})$/.test(sourceRevision) || !commit.startsWith(sourceRevision)) throw new ApplicationError('baseline_unknown');
      const meta = JSON.parse(await readFile(join(installedRoot, 'dist/server.meta.json'), 'utf8'));
      const recorded = meta.builtWith?.bbVersion;
      if (typeof recorded !== 'string' || !/^\d+\.\d+\.\d+$/.test(recorded)) throw new ApplicationError('baseline_unknown');
      await this.load(); this.active();
      let expected = this.expected.get(id);
      if (expected && (expected.commit !== commit || expected.builder !== recorded)) {
        const active = new Map(this.expected); active.delete(id); await this.remember(active); expected = undefined;
      }
      if (!expected) {
        const builder = await this.builder(recorded), source = await this.source(commit);
        const listing = await this.command('git', ['ls-tree', '-rzl', commit, '--', `plugins/${id}`], source);
        // NUL-delimited paths may legitimately contain spaces and Unicode.
        // Refuse symlinks/gitlinks/traversal and oversized source before extraction.
        const entries = listing.split('\0').filter(Boolean); let sourceBytes = 0;
        if (!entries.length || entries.length > 512) throw new ApplicationError('baseline_unknown');
        for (const entry of entries) {
          const match = entry.match(/^100(?:644|755) blob [a-f0-9]{40} +(\d+)\t([\s\S]+)$/);
          if (!match || !match[2].startsWith(`plugins/${id}/`) || match[2].split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new ApplicationError('baseline_unknown');
          sourceBytes += Number(match[1]);
          if (sourceBytes > LIMIT) throw new ApplicationError('baseline_unknown');
        }
        const work = await mkdtemp(join(this.root!, 'build-'));
        try {
          const tar = join(work, 'source.tar');
          await this.command('git', ['archive', '--format=tar', '-o', tar, commit, `plugins/${id}`], source);
          await this.command('tar', ['-xf', tar, '-C', work]);
          const packageDir = join(work, 'plugins', id);
          await this.command(process.execPath, [builder.npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], packageDir, this.root!);
          await this.command(process.execPath, [builder.cli, 'plugin', 'build', packageDir], work, this.root!, recorded);
          expected = { id, commit, builder: recorded, files: await this.files(packageDir), originalVersion: (await this.manifest(commit, id)).version };
          const active = new Map(this.expected); active.set(id, expected); await this.remember(active);
        } finally { await rm(work, { recursive: true, force: true }); }
      }
      const actual = await this.files(installedRoot);
      const canonical = (files: Record<string, string>) => JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
      return { local: canonical(actual) === canonical(expected.files) ? 'stock' : 'custom', fingerprint: sha(canonical(actual)), originalVersion: expected.originalVersion };
    } catch (error) { throw error instanceof ApplicationError ? error : new ApplicationError('baseline_unknown'); }
  }
}
