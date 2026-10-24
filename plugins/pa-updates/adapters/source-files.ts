import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

const ignored = new Set(['.git', 'node_modules', 'dist', 'test', 'tests', 'features', 'docs']);
export const sourceFile = (path: string) => !path.split('/').some(part => ignored.has(part)) &&
  !/(^|\/)(README[^/]*|LICENSE[^/]*|\.DS_Store|\.env[^/]*)$/.test(path);
const safePath = (path: string) => path.length <= 1024 && !/[\0\\]/.test(path) &&
  path.split('/').length <= 16 && path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
export const sourceDigest = (entries: [string, string][]) => createHash('sha256')
  .update(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');

/** Git blob identities let raw working files compare with remote trees without
 * running filters/builds, downloading historical builders or trusting versions. */
export async function sourceDetails(root: string, paths?: string[]): Promise<{ fingerprint: string; stamp: string }> {
  const base = await realpath(root), selected: string[] = [];
  if (!(await lstat(base)).isDirectory()) throw new Error('source_unavailable');
  if (paths) selected.push(...new Set(paths.filter(sourceFile)));
  else {
    const visit = async (directory: string, prefix = '') => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + item.name;
        if (!sourceFile(path)) continue;
        if (!safePath(path) || item.isSymbolicLink()) throw new Error('source_unsupported');
        if (item.isDirectory()) await visit(join(directory, item.name), path + '/');
        else if (item.isFile()) selected.push(path);
        else throw new Error('source_unsupported');
        if (selected.length > 512) throw new Error('source_limit');
      }
    };
    await visit(base);
  }
  if (!selected.length || selected.length > 512) throw new Error('source_limit');
  const entries: [string, string][] = [], stamps: [string, string][] = []; let total = 0;
  for (const path of selected) {
    if (!safePath(path)) throw new Error('source_unsupported');
    const full = join(base, path);
    let actual: string;
    try { actual = await realpath(full); }
    catch (error) { if (paths && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!actual.startsWith(base + sep)) throw new Error('source_unsupported');
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat({ bigint: true }); total += Number(stat.size);
      if (!stat.isFile() || stat.size > 2n * 1024n * 1024n || total > 32 * 1024 * 1024) throw new Error('source_limit');
      const data = await file.readFile(), after = await file.stat({ bigint: true });
      if (BigInt(data.length) !== stat.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) throw new Error('source_changed');
      entries.push([path, createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')]);
      stamps.push([path, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')]);
    } finally { await file.close(); }
  }
  return { fingerprint: sourceDigest(entries), stamp: sourceDigest(stamps) };
}
export async function sourceFingerprint(root: string, paths?: string[]): Promise<string> { return (await sourceDetails(root, paths)).fingerprint; }

export function treeFingerprint(listing: Buffer, prefix: string): string {
  const entries: [string, string][] = [];
  for (const line of listing.toString().split('\0').filter(Boolean)) {
    const match = line.match(/^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/);
    if (!match || !match[3].startsWith(prefix)) throw new Error('source_unsupported');
    const path = match[3].slice(prefix.length);
    if (!safePath(path)) throw new Error('source_unsupported');
    if (sourceFile(path)) entries.push([path, match[2]]);
  }
  if (!entries.length || entries.length > 512) throw new Error('source_limit');
  return sourceDigest(entries);
}
