import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { mkdir, readdir, lstat, readFile, writeFile, rename, rm, statfs, copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { CloudError, activity } from '../core/ports.ts';
import type { ProgressReporter, TransferProgress } from '../core/ports.ts';
import type { CommandRunner } from './rclone-process.ts';
export const BACKUP_LIMIT = 1024 * 1024 * 1024;
// Pin matches lib/encoder.Standard in stock rclone v1.75.2 (Slash, Del, Ctl, Dot).
const STANDARD_LOCAL = ':local,encoding=0x2018002:';
const encodingSensitive = (path: string) => /[\x00-\x1f\x7f\u2400-\u241f\u2421\uff0f\uff0e\u201b]/.test(path);
const RETENTION = 30 * 24 * 60 * 60_000;
type Entry = { side: 'cloud' | 'local'; path: string; blob: string; version?: string | null };
type Snapshot = { mirror: string; captured: number; entries: Entry[]; schema?: number; complete?: boolean; generation?: number; cloudPathEncoding?: 'rclone-standard' };
type CloudFile = { path: string; size: number; stamp: string; version: string | null };
type LocalFile = { path: string; size: number; version: string; blob: string };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function safePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\0') || value.split('/').some(p => !p || p === '.' || p === '..')) throw new CloudError('invalid_selection');
}
export async function treeSize(path: string): Promise<number> {
  const rootInfo = await lstat(path);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new CloudError('invalid_selection');
  let size = 0;
  for (const name of await readdir(path)) {
    const child = join(path, name); const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new CloudError('invalid_selection');
    size += info.isDirectory() ? await treeSize(child) : info.size;
  }
  if (!Number.isSafeInteger(size)) throw new CloudError('capacity');
  return size;
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const rootInfo = await lstat(join(root, prefix));
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new CloudError('invalid_selection');
  const result: string[] = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name; const info = await lstat(join(root, path)); safePath(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new CloudError('invalid_selection');
    if (info.isDirectory()) result.push(...await files(root, path)); else result.push(path);
  }
  return result.sort();
}
async function hashFile(path: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export class RecoveryCopies {
  constructor(private root: string, private run: CommandRunner, private limit = BACKUP_LIMIT, private now = () => Date.now()) {}
  private async prune(): Promise<Snapshot[]> {
    const referenced = new Set<string>(); const retained: Snapshot[] = [];
    for (const name of await readdir(join(this.root, 'snapshots'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new CloudError('recovery_required');
      const path = join(this.root, 'snapshots', name); let value: Snapshot;
      try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new CloudError('recovery_required'); }
      if (!value || !Number.isSafeInteger(value.captured) || value.captured <= 0 || !Array.isArray(value.entries)) throw new CloudError('recovery_required');
      if (this.now() - value.captured > RETENTION) await rm(path);
      else {
        for (const entry of value.entries) {
          if (!entry || !isHash(entry.blob)) throw new CloudError('recovery_required');
          referenced.add(entry.blob);
        }
        retained.push(value);
      }
    }
    for (const blob of await readdir(join(this.root, 'blobs'))) {
      if (!isHash(blob)) throw new CloudError('recovery_required');
      if (!referenced.has(blob)) await rm(join(this.root, 'blobs', blob));
    }
    for (const blob of referenced) {
      try { const info = await lstat(join(this.root, 'blobs', blob)); if (!info.isFile() || info.isSymbolicLink()) throw new Error(); }
      catch { throw new CloudError('recovery_required'); }
    }
    return retained;
  }
  private async cloud(remote: string): Promise<CloudFile[]> {
    let records: any;
    try { records = JSON.parse(await this.run(['lsjson', remote, '--recursive', '--files-only', '--no-mimetype'], true)); }
    catch (error) { if (error instanceof CloudError) throw error; throw new CloudError('sync_failed'); }
    if (!Array.isArray(records)) throw new CloudError('sync_failed');
    const paths = new Set<string>();
    return records.map(item => {
      safePath(item?.Path);
      if (item.IsDir !== false || paths.has(item.Path)) throw new CloudError('invalid_selection');
      paths.add(item.Path);
      if (!Number.isSafeInteger(item.Size) || item.Size < 0) throw new CloudError('capacity');
      const modified = typeof item.ModTime === 'string' ? item.ModTime : null;
      const stamp = sha({ size: item.Size, modified, id: typeof item.ID === 'string' ? item.ID : null });
      const validTime = modified !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(modified) && Date.parse(modified) > 0;
      return { path: item.Path, size: item.Size, stamp, version: validTime ? stamp : null };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  private async local(root: string): Promise<LocalFile[]> {
    const result: LocalFile[] = [];
    for (const path of await files(root)) {
      const source = join(root, path); const before = await lstat(source, { bigint: true });
      if (before.size > BigInt(this.limit)) throw new CloudError('capacity');
      const blob = await hashFile(source); const after = await lstat(source, { bigint: true });
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new CloudError('source_changed');
      const size = Number(after.size); if (!Number.isSafeInteger(size)) throw new CloudError('capacity');
      result.push({ path, size, blob, version: sha({ blob, size, modified: String(after.mtimeNs) }) });
    }
    return result;
  }
  async capture(mirror: string, remote: string, local: string, report?: ProgressReporter) {
    report?.(activity('checking'));
    for (const dir of ['blobs', 'snapshots']) await mkdir(join(this.root, dir), { recursive: true, mode: 0o700 });
    if ((await readdir(this.root)).some(name => !['blobs', 'snapshots'].includes(name))) throw new CloudError('recovery_required');
    const retained = await this.prune();
    const indexed = retained.filter(s => s.mirror === mirror && s.schema === 2 && s.complete === true && s.cloudPathEncoding === 'rclone-standard');
    if (indexed.some(s => !Number.isSafeInteger(s.generation) || s.generation! < 1) || new Set(indexed.map(s => s.generation)).size !== indexed.length) throw new CloudError('recovery_required');
    const previous = indexed.sort((a, b) => b.generation! - a.generation!)[0];
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new CloudError('recovery_required');
    const cloudIndex = new Map<string, Entry>(); const localIndex = new Map<string, Entry>();
    for (const entry of previous?.entries ?? []) {
      safePath(entry.path);
      if (!['cloud', 'local'].includes(entry.side) || (entry.version !== null && !isHash(entry.version)) || (entry.side === 'local' && entry.version === null)) throw new CloudError('recovery_required');
      const index = entry.side === 'cloud' ? cloudIndex : localIndex;
      if (index.has(entry.path)) throw new CloudError('recovery_required'); index.set(entry.path, entry);
    }
    const cloud = await this.cloud(remote); const locals = await this.local(local); const currentLocal = new Map(locals.map(f => [f.path, f]));
    // Local changes can overwrite/delete cloud data even when its metadata lies or is unchanged.
    const atRisk = new Set([...localIndex.keys(), ...currentLocal.keys()].filter(path => localIndex.get(path)?.version !== currentLocal.get(path)?.version));
    const selectedCloud = cloud.filter(f => encodingSensitive(f.path) || !f.version || f.version !== cloudIndex.get(f.path)?.version || atRisk.has(f.path));
    const verified = new Set<string>();
    const verifyBlob = async (blob: string): Promise<boolean> => {
      if (verified.has(blob)) return true;
      try { const info = await lstat(join(this.root, 'blobs', blob)); if (!info.isFile() || info.isSymbolicLink() || await hashFile(join(this.root, 'blobs', blob)) !== blob) throw new CloudError('recovery_required'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
      verified.add(blob); return true;
    };
    const downloaded = new Set(selectedCloud.map(f => f.path));
    for (const f of cloud) if (!downloaded.has(f.path) && !await verifyBlob(cloudIndex.get(f.path)!.blob)) throw new CloudError('recovery_required');
    const selectedLocal: LocalFile[] = []; for (const f of locals) if (!await verifyBlob(f.blob)) selectedLocal.push(f);
    const incoming = [...selectedCloud, ...selectedLocal].reduce((sum, f) => sum + f.size, 0);
    const provisional: Entry[] = [...cloud.map(f => ({ side: 'cloud' as const, path: f.path, blob: '0'.repeat(64), version: f.version })), ...locals.map(f => ({ side: 'local' as const, path: f.path, blob: f.blob, version: f.version }))];
    const manifestBytes = Buffer.byteLength(JSON.stringify({ mirror, captured: this.now(), schema: 2, complete: true, generation, cloudPathEncoding: 'rclone-standard', entries: provisional }));
    const selectorBytes = [...selectedCloud, ...selectedLocal].reduce((sum, f) => sum + Buffer.byteLength(f.path) + 1, 0);
    const reserve = manifestBytes + selectorBytes + 64 * 1024;
    const used = await treeSize(this.root); const disk = await statfs(this.root);
    if (!Number.isSafeInteger(incoming) || used + incoming * 2 + reserve > this.limit || disk.bavail * disk.bsize < incoming * 2 + reserve + 16 * 1024 * 1024) throw new CloudError('capacity');
    const staging = join(this.root, `staging-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
    for (const side of ['cloud', 'local']) await mkdir(join(staging, side), { mode: 0o700 });
    const copy = async (side: 'cloud' | 'local', source: string, selected: { path: string; size: number }[]) => {
      const stage = side === 'cloud' ? 'backing_up_cloud' : 'backing_up_local'; const bytes = selected.reduce((sum, f) => sum + f.size, 0);
      const update = (stats: TransferProgress) => report?.({ ...stats, stage, totalBytes: Math.max(stats.totalBytes ?? 0, bytes) || null, totalFiles: Math.max(stats.totalFiles ?? 0, selected.length) || null, reusedFiles: side === 'cloud' ? cloud.length - selectedCloud.length : locals.length - selectedLocal.length });
      update({ bytes: 0, totalBytes: null, files: 0, totalFiles: null }); if (!selected.length) return;
      const budget = () => Math.max(1, Math.floor((this.limit - used - reserve) / 2));
      if (selected.every(f => !/[\r\n]/.test(f.path))) {
        const list = join(staging, `${side}-files`); await writeFile(list, selected.map(f => f.path).join('\n') + '\n', { mode: 0o600 });
        await this.run(['copy', source, STANDARD_LOCAL + join(staging, side), '--files-from-raw', list, '--max-transfer', String(budget()), '--cutoff-mode', 'hard'], false, report ? update : undefined);
      } else {
        // A newline filename cannot safely be represented in a line-based selector.
        let completedBytes = 0; let completedFiles = 0;
        for (const f of selected) {
          const remaining = Math.max(1, Math.floor((this.limit - await treeSize(this.root) - reserve) / 2));
          const target = join(staging, side, f.path); await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
          await this.run(['copyto', source.replace(/\/$/, '') + '/' + f.path, STANDARD_LOCAL + target, '--max-transfer', String(remaining), '--cutoff-mode', 'hard'], false, report ? stats => update({ ...stats, bytes: completedBytes + stats.bytes, files: completedFiles + stats.files }) : undefined);
          completedBytes += f.size; completedFiles++; update({ bytes: completedBytes, totalBytes: bytes, files: completedFiles, totalFiles: selected.length });
        }
      }
    };
    const validate = async (side: 'cloud' | 'local', selected: { path: string; size: number }[]) => {
      if (JSON.stringify(await files(join(staging, side))) !== JSON.stringify(selected.map(f => f.path).sort())) throw new CloudError('source_changed');
      for (const f of selected) if ((await lstat(join(staging, side, f.path))).size !== f.size) throw new CloudError('source_changed');
    };
    await copy('cloud', remote, selectedCloud);
    // Short commands can complete between stats samples. Only validated staging proves their final counts.
    await validate('cloud', selectedCloud);
    const cloudTotal = selectedCloud.reduce((sum, f) => sum + f.size, 0);
    report?.({ stage: 'backing_up_cloud', bytes: cloudTotal, totalBytes: cloudTotal || null, files: selectedCloud.length, totalFiles: selectedCloud.length || null, reusedFiles: cloud.length - selectedCloud.length });
    // Native local names need no reimplementation of rclone's filename encoder.
    // Limit each read to its planned size so a growing source cannot exhaust storage.
    const localTotal = selectedLocal.reduce((sum, f) => sum + f.size, 0); let localBytes = 0; let localFiles = 0;
    report?.({ ...activity('backing_up_local'), totalBytes: localTotal || null, totalFiles: selectedLocal.length || null, reusedFiles: locals.length - selectedLocal.length });
    for (const f of selectedLocal) {
      const target = join(staging, 'local', f.path); await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      const source = await open(join(local, f.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const output = await open(target, 'wx', 0o600);
        try {
          if (f.size) for await (const chunk of source.createReadStream({ start: 0, end: f.size - 1, autoClose: false })) {
            await output.writeFile(chunk); localBytes += chunk.length;
            report?.({ bytes: localBytes, totalBytes: localTotal || null, files: localFiles, totalFiles: selectedLocal.length || null, stage: 'backing_up_local', reusedFiles: locals.length - selectedLocal.length });
          }
        } finally { await output.close(); }
      } finally { await source.close(); }
      localFiles++; report?.({ bytes: localBytes, totalBytes: localTotal || null, files: localFiles, totalFiles: selectedLocal.length || null, stage: 'backing_up_local', reusedFiles: locals.length - selectedLocal.length });
    }
    // No invented catalogue entries, truncated files, or extra selected paths may be sealed.
    await validate('local', selectedLocal);
    report?.(activity('saving_recovery'));
    const entries: Entry[] = [];
    for (const f of cloud) entries.push({ side: 'cloud', path: f.path, blob: downloaded.has(f.path) ? await hashFile(join(staging, 'cloud', f.path)) : cloudIndex.get(f.path)!.blob, version: f.version });
    for (const f of selectedLocal) if (await hashFile(join(staging, 'local', f.path)) !== f.blob) throw new CloudError('source_changed');
    entries.push(...locals.map(f => ({ side: 'local' as const, path: f.path, blob: f.blob, version: f.version })));
    const same = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);
    if (!same(cloud, await this.cloud(remote)) || !same(locals, await this.local(local))) throw new CloudError('source_changed');
    const snapshot: Snapshot = { mirror, captured: this.now(), schema: 2, complete: true, generation, cloudPathEncoding: 'rclone-standard', entries }; const manifest = JSON.stringify(snapshot);
    let allocated = await treeSize(this.root);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]; const target = join(this.root, 'blobs', entry.blob);
      if (!await verifyBlob(entry.blob)) {
        const source = join(staging, entry.side, entry.path);
        const bytes = (await lstat(source)).size;
        if (allocated + bytes + Buffer.byteLength(manifest) > this.limit) throw new CloudError('capacity');
        await copyFile(source, target, constants.COPYFILE_EXCL); allocated += bytes;
        if (!await verifyBlob(entry.blob)) throw new CloudError('recovery_required');
      }
      report?.({ ...activity('saving_recovery'), files: i + 1, totalFiles: entries.length || null });
    }
    if (await treeSize(this.root) + Buffer.byteLength(manifest) > this.limit) throw new CloudError('capacity');
    const identity = sha({ mirror, schema: 2, entries });
    const temporary = join(staging, 'manifest.json'); await writeFile(temporary, manifest, { mode: 0o600 });
    await rename(temporary, join(this.root, 'snapshots', `${identity}.json`)); await rm(staging, { recursive: true });
  }
}
