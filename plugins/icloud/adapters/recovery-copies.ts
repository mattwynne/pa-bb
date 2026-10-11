import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat, readFile, writeFile, rename, rm, statfs, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudError } from '../core/ports.ts';
import type { CommandRunner } from './rclone-process.ts';
export const BACKUP_LIMIT = 1024 * 1024 * 1024;
const RETENTION = 30 * 24 * 60 * 60_000;
type Entry = { side: 'cloud' | 'local'; path: string; blob: string };
type Snapshot = { mirror: string; captured: number; entries: Entry[] };
export async function treeSize(path: string): Promise<number> {
  const rootInfo = await lstat(path);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new CloudError('invalid_selection');
  let size = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name); const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new CloudError('invalid_selection');
    size += info.isDirectory() ? await treeSize(child) : info.size;
  }
  return size;
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name; const info = await lstat(join(root, path));
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new CloudError('invalid_selection');
    if (info.isDirectory()) result.push(...await files(root, path)); else result.push(path);
  }
  return result;
}
async function hashFile(path: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export class RecoveryCopies {
  constructor(private root: string, private run: CommandRunner, private limit = BACKUP_LIMIT, private now = () => Date.now()) {}
  private async prune() {
    const referenced = new Set<string>();
    for (const name of await readdir(join(this.root, 'snapshots'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new CloudError('recovery_required');
      const path = join(this.root, 'snapshots', name);
      const value: Snapshot = JSON.parse(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(value.captured) || !Array.isArray(value.entries)) throw new CloudError('recovery_required');
      if (this.now() - value.captured > RETENTION) await rm(path);
      else for (const entry of value.entries) {
        if (!/^[a-f0-9]{64}$/.test(entry.blob)) throw new CloudError('recovery_required');
        referenced.add(entry.blob);
      }
    }
    for (const blob of await readdir(join(this.root, 'blobs'))) {
      if (!/^[a-f0-9]{64}$/.test(blob)) throw new CloudError('recovery_required');
      if (!referenced.has(blob)) await rm(join(this.root, 'blobs', blob));
    }
  }
  async capture(mirror: string, remote: string, local: string) {
    for (const dir of ['blobs', 'snapshots']) await mkdir(join(this.root, dir), { recursive: true, mode: 0o700 });
    // A leftover staging tree means an interrupted backup; never silently remove it.
    if ((await readdir(this.root)).some(name => !['blobs', 'snapshots'].includes(name))) throw new CloudError('recovery_required');
    await this.prune();
    const used = await treeSize(this.root); const localBytes = await treeSize(local);
    const remoteSize = JSON.parse(await this.run(['size', remote, '--json'], true));
    if (!Number.isSafeInteger(remoteSize.bytes) || remoteSize.bytes < 0) throw new CloudError('capacity');
    const incoming = localBytes + remoteSize.bytes;
    const disk = await statfs(this.root);
    // Reserve staging + immutable blobs + metadata; refuse unsafe capacity before downloads.
    if (used + incoming * 2 + 64 * 1024 > this.limit || disk.bavail * disk.bsize < incoming * 2 + 16 * 1024 * 1024) throw new CloudError('capacity');
    const staging = join(this.root, `staging-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
    for (const dir of ['cloud', 'local']) await mkdir(join(staging, dir), { mode: 0o700 });
    const budget = String(Math.max(1, Math.floor((this.limit - used - 64 * 1024) / 2)));
    await this.run(['copy', remote, join(staging, 'cloud'), '--max-transfer', budget, '--cutoff-mode', 'hard']);
    await this.run(['copy', local, join(staging, 'local'), '--max-transfer', budget, '--cutoff-mode', 'hard']);
    if (await treeSize(this.root) > this.limit - 64 * 1024) throw new CloudError('capacity');
    const entries: Entry[] = [];
    for (const side of ['cloud', 'local'] as const) for (const path of (await files(join(staging, side))).sort()) {
      const source = join(staging, side, path); const blob = await hashFile(source); const target = join(this.root, 'blobs', blob);
      try { await lstat(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await copyFile(source, target);
      }
      entries.push({ side, path, blob });
    }
    const identity = createHash('sha256').update(JSON.stringify({ mirror, entries })).digest('hex');
    const snapshot: Snapshot = { mirror, captured: this.now(), entries };
    const manifest = JSON.stringify(snapshot);
    if (await treeSize(this.root) + Buffer.byteLength(manifest) > this.limit) throw new CloudError('capacity');
    // Identical snapshots update their last-seen time rather than duplicating bytes every minute.
    const temporary = join(staging, 'manifest.json'); await writeFile(temporary, manifest, { mode: 0o600 });
    await rename(temporary, join(this.root, 'snapshots', `${identity}.json`));
    await rm(staging, { recursive: true });
  }
}
