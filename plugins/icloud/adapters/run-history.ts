import type Database from 'better-sqlite3';
import { HISTORY_CAPACITY, HISTORY_DAYS, ERROR_HISTORY_DAYS, historyStateSchema, legacyJournalSchema, pendingRunSchema, runSchema, historyQuerySchema } from '../core/diagnostics.ts';
import type { RunHistoryRepository, PendingRun, RunSummary, HistoryQuery, HistoryCounts, HistoryPage } from '../core/diagnostics.ts';
// Append only: BB hashes each statement at its migration index.
export const HISTORY_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS icloud_sync_history_meta (id INTEGER PRIMARY KEY CHECK(id = 1), schema INTEGER NOT NULL CHECK(schema = 2), sequence INTEGER NOT NULL CHECK(sequence >= 0), active TEXT, trimmed_successes INTEGER NOT NULL DEFAULT 0, trimmed_errors INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS icloud_sync_runs (sequence INTEGER PRIMARY KEY CHECK(sequence > 0), outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'failed', 'interrupted')), is_error INTEGER NOT NULL CHECK(is_error IN (0, 1)), finished_at INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 4096), body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) = bytes), CHECK((outcome = 'succeeded' AND is_error = 0) OR (outcome != 'succeeded' AND is_error = 1)))`,
  `CREATE INDEX IF NOT EXISTS icloud_sync_runs_expiry ON icloud_sync_runs(is_error, finished_at)`,
  `CREATE INDEX IF NOT EXISTS icloud_sync_runs_pages ON icloud_sync_runs(is_error, sequence DESC)`,
] as const;
type Budgets = { successRows?: number; errorRows?: number; successBytes?: number; errorBytes?: number };
type StoredRow = { sequence: number; outcome: RunSummary['outcome']; is_error: number; finished_at: number; bytes: number; body: string };
export class SqliteRunHistory implements RunHistoryRepository {
  private ready: Promise<Database.Database> | null = null;
  private budgets: { successRows: number; errorRows: number; successBytes: number; errorBytes: number };
  constructor(private database: () => Database.Database, private migrate: (db: Database.Database) => void, private legacy: () => Promise<unknown>, budgets: Budgets = {}) {
    this.budgets = { ...HISTORY_CAPACITY, ...budgets };
    if (Object.values(this.budgets).some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('history budget unavailable');
  }
  private db() { this.ready ??= this.initialize(); return this.ready; }
  private async initialize() {
    const db = this.database(); this.migrate(db);
    if (!db.prepare('SELECT id FROM icloud_sync_history_meta WHERE id = 1').get()) {
      const raw = await this.legacy(); const previous = raw === undefined || raw === null ? null : legacyJournalSchema.parse(raw);
      db.transaction(() => {
        if (db.prepare('SELECT id FROM icloud_sync_history_meta WHERE id = 1').get()) return;
        if ((db.prepare('SELECT COUNT(*) AS count FROM icloud_sync_runs').get() as { count: number }).count) throw new Error('history metadata unavailable');
        for (const run of previous?.runs ?? []) this.insert(db, run);
        db.prepare('INSERT INTO icloud_sync_history_meta(id, schema, sequence, active) VALUES (1, 2, ?, ?)').run(previous?.sequence ?? 0, previous?.active ? JSON.stringify(previous.active) : null);
      })();
    }
    return db;
  }
  private metadata(db: Database.Database) {
    const row = db.prepare('SELECT schema, sequence, active FROM icloud_sync_history_meta WHERE id = 1').get() as { schema: number; sequence: number; active: string | null } | undefined;
    if (!row) throw new Error('history metadata unavailable');
    return historyStateSchema.parse({ ...row, active: row.active === null ? null : JSON.parse(row.active) });
  }
  async load() {
    const db = await this.db(); const state = this.metadata(db); const latest = (db.prepare('SELECT MAX(sequence) AS sequence FROM icloud_sync_runs').get() as { sequence: number | null }).sequence;
    if (latest !== null && latest > state.sequence) throw new Error('history sequence unavailable');
    return state;
  }
  private insert(db: Database.Database, value: RunSummary) {
    const run = runSchema.parse(value); const body = JSON.stringify(run); const bytes = Buffer.byteLength(body);
    if (bytes > 4096) throw new Error('history row unavailable');
    db.prepare('INSERT INTO icloud_sync_runs(sequence, outcome, is_error, finished_at, bytes, body) VALUES (?, ?, ?, ?, ?, ?)').run(run.sequence, run.outcome, run.outcome === 'succeeded' ? 0 : 1, Date.parse(run.finishedAt), bytes, body);
  }
  async begin(value: PendingRun) {
    const run = pendingRunSchema.parse(value); const db = await this.db();
    db.transaction(() => {
      const state = this.metadata(db); if (state.active || run.sequence !== state.sequence + 1) throw new Error('history sequence unavailable');
      db.prepare('UPDATE icloud_sync_history_meta SET sequence = ?, active = ? WHERE id = 1').run(run.sequence, JSON.stringify(run));
    })();
  }
  async finish(value: RunSummary) {
    const run = runSchema.parse(value); const db = await this.db();
    db.transaction(() => {
      // A late completion must not replace a run already recorded as interrupted.
      if (db.prepare('SELECT sequence FROM icloud_sync_runs WHERE sequence = ?').get(run.sequence)) return;
      const state = this.metadata(db); if (state.active?.sequence !== run.sequence) throw new Error('history sequence unavailable');
      this.insert(db, run); db.prepare('UPDATE icloud_sync_history_meta SET active = NULL WHERE id = 1').run();
    })();
  }
  async prune(now: string): Promise<HistoryCounts> {
    const db = await this.db(); const epoch = Date.parse(now); if (!Number.isFinite(epoch)) throw new Error('history clock unavailable');
    return db.transaction(() => {
      const delta = { successes: 0, errors: 0 };
      for (const error of [0, 1]) {
        const days = error ? ERROR_HISTORY_DAYS : HISTORY_DAYS;
        db.prepare('DELETE FROM icloud_sync_runs WHERE is_error = ? AND finished_at < ?').run(error, epoch - days * 86400_000);
        const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM icloud_sync_runs WHERE is_error = ?').get(error) as { count: number; bytes: number };
        const rows = error ? this.budgets.errorRows : this.budgets.successRows; const bytes = error ? this.budgets.errorBytes : this.budgets.successBytes;
        let removed = 0;
        if (totals.count > rows) removed += db.prepare('DELETE FROM icloud_sync_runs WHERE sequence IN (SELECT sequence FROM icloud_sync_runs WHERE is_error = ? ORDER BY sequence DESC LIMIT -1 OFFSET ?)').run(error, rows).changes;
        if (totals.bytes > bytes) removed += db.prepare('DELETE FROM icloud_sync_runs WHERE sequence IN (SELECT sequence FROM (SELECT sequence, SUM(bytes) OVER (ORDER BY sequence DESC) AS cumulative FROM icloud_sync_runs WHERE is_error = ?) WHERE cumulative > ?)').run(error, bytes).changes;
        delta[error ? 'errors' : 'successes'] = removed;
      }
      db.prepare('UPDATE icloud_sync_history_meta SET trimmed_successes = MIN(?, trimmed_successes + ?), trimmed_errors = MIN(?, trimmed_errors + ?) WHERE id = 1').run(Number.MAX_SAFE_INTEGER, delta.successes, Number.MAX_SAFE_INTEGER, delta.errors);
      return delta;
    })();
  }
  private decode(row: StoredRow) {
    const run = runSchema.parse(JSON.parse(row.body));
    if (run.sequence !== row.sequence || run.outcome !== row.outcome || Number(run.outcome !== 'succeeded') !== row.is_error || Date.parse(run.finishedAt) !== row.finished_at || Buffer.byteLength(row.body) !== row.bytes) throw new Error('history row unavailable');
    return run;
  }
  async read(input: HistoryQuery, now: string): Promise<HistoryPage> {
    const query = historyQuerySchema.parse(input); const db = await this.db(); const epoch = Date.parse(now); if (!Number.isFinite(epoch)) throw new Error('history clock unavailable');
    const successCutoff = epoch - HISTORY_DAYS * 86400_000; const errorCutoff = epoch - ERROR_HISTORY_DAYS * 86400_000;
    const filter = query.outcome === 'all' ? '((is_error = 0 AND finished_at >= ?) OR (is_error = 1 AND finished_at >= ?))' : 'is_error = ? AND finished_at >= ?';
    const params: number[] = query.outcome === 'all' ? [successCutoff, errorCutoff] : [query.outcome === 'errors' ? 1 : 0, query.outcome === 'errors' ? errorCutoff : successCutoff];
    if (query.before !== undefined) params.push(query.before);
    params.push(query.limit + 1);
    const rows = db.prepare(`SELECT sequence, outcome, is_error, finished_at, bytes, body FROM icloud_sync_runs WHERE ${filter}${query.before === undefined ? '' : ' AND sequence < ?'} ORDER BY sequence DESC LIMIT ?`).all(...params) as StoredRow[];
    const more = rows.length > query.limit; const runs = rows.slice(0, query.limit).map(row => this.decode(row)).reverse();
    const count = (error: number, cutoff: number) => (db.prepare('SELECT COUNT(*) AS count FROM icloud_sync_runs WHERE is_error = ? AND finished_at >= ?').get(error, cutoff) as { count: number }).count;
    const trimmed = db.prepare('SELECT trimmed_successes AS successes, trimmed_errors AS errors FROM icloud_sync_history_meta WHERE id = 1').get() as HistoryCounts;
    return { runs, nextBefore: more ? runs[0].sequence : null, retained: { successes: count(0, successCutoff), errors: count(1, errorCutoff) }, trimmed };
  }
}
