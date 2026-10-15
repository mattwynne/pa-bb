import type { TransferProgress } from '../core/ports.ts';
const MAX_LINE = 64 * 1024;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const total = (value: unknown, done: number) => count(value) && value > 0 && value >= done ? value : null;
export function transferStats(record: unknown): TransferProgress | null {
  const stats = (record as { stats?: Record<string, unknown> } | null)?.stats;
  if (!stats || !count(stats.bytes) || !count(stats.transfers)) return null;
  return { bytes: stats.bytes, totalBytes: total(stats.totalBytes, stats.bytes), files: stats.transfers, totalFiles: total(stats.totalTransfers, stats.transfers) };
}
export class RcloneStatsStream {
  private pending = Buffer.alloc(0);
  private dropping = false;
  constructor(private report?: (stats: TransferProgress) => void, private observe?: (record: unknown | null) => void) {}
  write(chunk: Buffer) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start); const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (this.pending.length + part.length > MAX_LINE) { this.pending = Buffer.alloc(0); this.dropping = true; }
      if (!this.dropping) this.pending = Buffer.concat([this.pending, part]);
      if (newline < 0) return;
      this.line(); start = newline + 1;
    }
  }
  private line() {
    if (this.dropping || !this.pending.length) this.observe?.(null);
    else {
      try {
        const record: unknown = JSON.parse(this.pending.toString('utf8'));
        this.observe?.(record);
        const safe = transferStats(record); if (safe) this.report?.(safe);
      } catch { this.observe?.(null); /* Bad records and callback errors never break a file operation. */ }
    }
    this.pending = Buffer.alloc(0); this.dropping = false;
  }
  end() {
    // Keep the historical stats-only EOF behavior, but never trust a final
    // unterminated record as native proof: the child could have truncated it.
    if (this.pending.length || this.dropping) {
      this.observe?.(null);
      if (!this.dropping) {
        try { const safe = transferStats(JSON.parse(this.pending.toString('utf8'))); if (safe) this.report?.(safe); }
        catch { /* Bad stats and callbacks cannot break the command. */ }
      }
    }
    this.pending = Buffer.alloc(0); this.dropping = false;
  }
}
