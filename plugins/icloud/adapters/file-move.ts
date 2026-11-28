// Move-specific recovery ledger. The runtime owns native exclusivity and drains
// local admissions before calling this adapter. Never replay filesystem work.
import type Database from 'better-sqlite3';
import { FileStore, FileError, validateFilePath } from './file-store.ts';
export type MoveInput = { mirrorId: string; path: string; destination: string; expectedHash: string; operationId: string };
export type MoveReceipt = MoveInput & { at: string; outcome: 'moved_locally_pending_sync' | 'not_moved' | 'uncertain' };
export class FileMoves {
  constructor(private db: Database.Database, private files: FileStore, private admission: (id: string) => void = () => {}) {}
  start() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS icloud_note_moves(operation_id TEXT PRIMARY KEY, mirror_id TEXT NOT NULL, path TEXT NOT NULL, destination TEXT NOT NULL, hash TEXT NOT NULL, original TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL);`);
  }
  private receipt(row: any): MoveReceipt { return { operationId: row.operation_id, mirrorId: row.mirror_id, path: row.path, destination: row.destination, expectedHash: row.hash, at: row.at, outcome: row.outcome }; }
  receipts(id: string, operationId?: string): MoveReceipt[] {
    return (this.db.prepare('SELECT * FROM icloud_note_moves WHERE mirror_id=? ORDER BY at DESC').all(id) as any[]).filter(r => !operationId || r.operation_id === operationId).slice(0, 128).map(r => this.receipt(r));
  }
  has(operationId: string) { return !!this.db.prepare('SELECT 1 FROM icloud_note_moves WHERE operation_id=?').get(operationId); }
  blocked(id: string) { return !!this.db.prepare("SELECT 1 FROM icloud_note_moves WHERE mirror_id=? AND outcome='uncertain'").get(id); }
  // Read-only reconciliation of evidence; never retry link/unlink after a crash.
  async inspect(root: string, id: string) {
    for (const row of this.db.prepare("SELECT * FROM icloud_note_moves WHERE mirror_id=? AND outcome='uncertain'").all(id) as any[]) {
      await this.files.syncMoveDirectories(root, row.path, row.destination);
      const a = await this.files.observe(root, row.path), b = await this.files.observe(root, row.destination);
      const original = (v: typeof a) => v !== null && v.hash === row.hash && v.info.dev === row.dev && v.info.ino === row.ino;
      const outcome = !a && original(b) ? 'moved_locally_pending_sync' : original(a) && !b ? 'not_moved' : 'uncertain';
      this.db.prepare('UPDATE icloud_note_moves SET outcome=? WHERE operation_id=?').run(outcome, row.operation_id);
    }
  }
  async move(root: string, input: MoveInput, signal?: AbortSignal): Promise<MoveReceipt> {
    validateFilePath(input.path); validateFilePath(input.destination);
    if (input.path === input.destination) throw new FileError('invalid_path');
    const old: any = this.db.prepare('SELECT * FROM icloud_note_moves WHERE operation_id=?').get(input.operationId);
    if (old) {
      if (old.mirror_id !== input.mirrorId || old.path !== input.path || old.destination !== input.destination || old.hash !== input.expectedHash) throw new FileError('operation_reused');
      return this.receipt(old);
    }
    if (signal?.aborted) throw new FileError('cancelled');
    if (this.blocked(input.mirrorId)) throw new FileError('uncertain');
    const current = await this.files.observe(root, input.path);
    if (!current || current.hash !== input.expectedHash || await this.files.observe(root, input.destination)) throw new FileError('conflict');
    if ((await this.files.conflictCopies(root, input.path)).length || (await this.files.conflictCopies(root, input.destination)).length) throw new FileError('conflict');
    // Conservative fixed lifetime capacity; do not prune recovery or UUID fences.
    // Include existing overlay recovery usage rather than creating an unbounded pool.
    const usage: any = this.db.prepare('SELECT count(*) AS n, coalesce(sum(length(cast(original AS BLOB))),0) AS bytes FROM icloud_note_moves').get();
    const overlay: any = this.db.prepare('SELECT recovery_bytes, staged_recovery_bytes FROM icloud_note_overlay_totals WHERE id=1').get();
    if (usage.n >= 128 || usage.bytes + current.bytes.length > 4 * 1024 * 1024 || usage.bytes + current.bytes.length + (overlay?.recovery_bytes ?? 0) + (overlay?.staged_recovery_bytes ?? 0) > 64 * 1024 * 1024) throw new FileError('capacity');
    this.admission(input.mirrorId);
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO icloud_note_moves VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.operationId, input.mirrorId, input.path, input.destination, input.expectedHash, current.bytes, current.info.dev, current.info.ino, at, 'uncertain');
    try { await this.files.moveExclusive(root, input.path, input.destination, current, signal, () => this.admission(input.mirrorId)); }
    catch { /* The journal is authoritative even if the syscall reply was lost. */ }
    try { await this.inspect(root, input.mirrorId); } catch { /* retain uncertain */ }
    return this.receipts(input.mirrorId, input.operationId)[0];
  }
}
