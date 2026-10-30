import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RCLONE_LOG_LIMITS, projectRcloneRecord, traceEntrySchema } from '../core/rclone-trace.ts';
import type { TraceEntry, TraceSnapshot } from '../core/rclone-trace.ts';

type Limits = { fileBytes: number; files: number; queueRecords: number; recordBytes: number };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Private, bounded, best-effort trace. The native worker's flock owns writes.
 * This is deliberately separate from failure-only BB logs and run history.
 * Constructors and snapshots never create files or start a native operation.
 */
export class RcloneTrace {
  private ready = false;
  private failed = false;
  private warned = false;
  private queue: string[] = [];
  private draining: Promise<void> | null = null;
  private dropped = 0;
  constructor(private directory: string, private warn: () => void = () => {}, private limits: Limits = RCLONE_LOG_LIMITS) {
    for (const key of ['fileBytes', 'files', 'queueRecords', 'recordBytes'] as const) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > RCLONE_LOG_LIMITS[key]) throw new Error('Invalid trace limits');
    if (limits.recordBytes > limits.fileBytes) throw new Error('Invalid trace limits');
  }
  private path(index: number) { return join(this.directory, index === 0 ? 'rclone.jsonl' : `rclone.${index}.jsonl`); }
  private unavailable() {
    this.failed = true; this.ready = false; this.dropped += this.queue.length; this.queue = [];
    if (!this.warned) { this.warned = true; try { this.warn(); } catch { /* Diagnostics never abort a sync. */ } }
  }
  private async checkDirectory() {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Trace unavailable');
  }
  private async fileSize(index: number) {
    try {
      const info = await lstat(this.path(index));
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) || info.size > this.limits.fileBytes) throw new Error('Trace unavailable');
      return info.size;
    } catch (error) { if (missing(error)) return 0; throw error; }
  }
  async start() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      // Do not chmod through a symlink or alter an unrelated directory.
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('Trace unavailable');
      await chmod(this.directory, 0o700); await this.checkDirectory();
      for (let i = 0; i < this.limits.files; i++) await this.fileSize(i);
      this.ready = true;
    } catch { this.unavailable(); }
  }
  record(commandId: string, elapsedMs: number, record: unknown) {
    this.append({ at: new Date().toISOString(), commandId, elapsedMs: Math.max(0, Math.round(elapsedMs)), ...projectRcloneRecord(record) });
  }
  append(entry: TraceEntry) {
    if (!this.ready || this.failed) return;
    // Strict schema at the persistence boundary, including lifecycle entries.
    const parsed = traceEntrySchema.safeParse(entry);
    if (!parsed.success) { this.dropped++; return; }
    const line = JSON.stringify(parsed.data) + '\n';
    if (Buffer.byteLength(line) > this.limits.recordBytes || this.queue.length >= this.limits.queueRecords) { this.dropped++; return; }
    this.queue.push(line);
    this.pump();
  }
  private pump() {
    if (this.draining || !this.queue.length || this.failed) return;
    this.draining = this.drain().finally(() => { this.draining = null; this.pump(); });
  }
  private async rotate() {
    for (let i = 0; i < this.limits.files; i++) await this.fileSize(i);
    await unlink(this.path(this.limits.files - 1)).catch(error => { if (!missing(error)) throw error; });
    for (let i = this.limits.files - 2; i >= 0; i--) await rename(this.path(i), this.path(i + 1)).catch(error => { if (!missing(error)) throw error; });
  }
  private async drain() {
    try {
      while (this.queue.length) {
        let batch = '';
        // Batching bounds pending memory and avoids one filesystem write per
        // debug message. Full queues drop records rather than block rclone.
        while (this.queue.length && Buffer.byteLength(batch + this.queue[0]) <= Math.min(64 * 1024, this.limits.fileBytes)) batch += this.queue.shift()!;
        if (!batch) { this.queue.shift(); this.dropped++; continue; }
        await this.checkDirectory();
        const bytes = Buffer.byteLength(batch);
        if (await this.fileSize(0) + bytes > this.limits.fileBytes) await this.rotate();
        const file = await open(this.path(0), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) || info.size + bytes > this.limits.fileBytes) throw new Error('Trace unavailable');
          await file.writeFile(batch);
        } finally { await file.close(); }
      }
    } catch { this.unavailable(); }
  }
  async flush() { while (this.draining) await this.draining; }
  async stop() { await this.flush(); this.ready = false; }
  async snapshot(limit = 100): Promise<TraceSnapshot> {
    const result: TraceSnapshot = { available: this.ready && !this.failed, failure: this.failed ? 'unavailable' : null, incomplete: this.failed || this.queue.length > 0 || this.dropped > 0, droppedRecords: this.dropped, queuedRecords: this.queue.length, entries: [], limits: RCLONE_LOG_LIMITS };
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid trace query');
    // Read-only, bounded tail across all four files, oldest to newest. Opening
    // descriptors pins files through rotation; this is not an atomic snapshot.
    try {
      await this.checkDirectory();
      for (let i = this.limits.files - 1; i >= 0; i--) {
        let file;
        try { file = await open(this.path(i), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if (missing(error)) continue; throw error; }
        try {
          const info = await file.stat();
          if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) || info.size > this.limits.fileBytes) throw new Error('Trace unavailable');
          // A bounded positional read cannot grow with a concurrent writer.
          const bytes = Buffer.alloc(info.size);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n');
          if (lines.pop()) result.incomplete = true; // Incomplete final record after a crash/write.
          for (const line of lines) {
            if (Buffer.byteLength(line) > this.limits.recordBytes) { result.incomplete = true; continue; }
            try {
              const parsed = traceEntrySchema.safeParse(JSON.parse(line));
              if (parsed.success) { result.entries.push(parsed.data); if (result.entries.length > limit) result.entries.shift(); }
              else result.incomplete = true;
            } catch { result.incomplete = true; }
          }
        } finally { await file.close(); }
      }
    } catch { result.available = false; result.failure = 'unavailable'; result.incomplete = true; }
    return result;
  }
}
