import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { VaultError } from '../core/ports.ts';

const identity = z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = {
  operationId: z.string().uuid(),
  mirrorId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  path: z.string().min(1).max(1024),
  at: z.string().datetime(),
  hash,
  root: identity,
  inode: identity,
  birthtime: z.number().finite().optional(),
  publication: z.enum(['atomic', 'desktop']).optional(),
};
const versionIdentity = identity.extend({ birthtime: z.number().finite() });
const previous = { previousHash: hash.nullable(), previousIdentity: versionIdentity.optional() };
const record = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('save'), ...previous, outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']) }).strict(),
  z.object({ ...base, kind: z.literal('move'), destination: base.path,
    directory: z.literal(true).optional(),
    tree: z.object({ from: base.path, to: base.path, inode: identity, fingerprint: hash }).strict().optional(), outcome: z.enum(['moved_locally_pending_sync', 'not_moved', 'uncertain']) }).strict(),
  z.object({ ...base, kind: z.literal('resolution'), previousHash: hash.nullable().optional(), choice: z.enum(['keep_local', 'accept_incoming', 'replace']), outcome: z.enum(['saved_locally_pending_sync', 'adopted_content', 'not_saved', 'uncertain']) }).strict(),
]);
export type LocalReceipt = z.infer<typeof record>;
export type FileIdentity = z.infer<typeof identity>;
export const fileIdentity = ({ dev, ino }: FileIdentity): FileIdentity => ({ dev, ino });

const legacyKey = 'filesystem-note-receipts';
const migrations = [
  `CREATE TABLE obsidian_receipt_events (
    sequence INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('intent', 'dispatch', 'terminal')),
    mirror TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT,
    UNIQUE(operation_id, event)
  )`,
  `CREATE INDEX obsidian_receipts_scope ON obsidian_receipt_events(event, mirror, kind, at, sequence)`,
  `CREATE INDEX obsidian_receipts_path ON obsidian_receipt_events(event, mirror, path, sequence)`,
  `CREATE TABLE obsidian_receipt_imports (source TEXT PRIMARY KEY)`,
  `CREATE TABLE obsidian_recovery_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL)`,
  `CREATE TABLE obsidian_receipt_pending (sequence INTEGER PRIMARY KEY, operation_id TEXT UNIQUE, mirror TEXT NOT NULL)`,
  `CREATE INDEX obsidian_pending_mirror ON obsidian_receipt_pending(mirror, sequence)`,
  `CREATE TRIGGER obsidian_receipt_begin AFTER INSERT ON obsidian_receipt_events WHEN NEW.event = 'intent'
    BEGIN INSERT INTO obsidian_receipt_pending VALUES (NEW.sequence, NEW.operation_id, NEW.mirror); END`,
  `CREATE TRIGGER obsidian_receipt_finish AFTER INSERT ON obsidian_receipt_events WHEN NEW.event = 'terminal'
    BEGIN DELETE FROM obsidian_receipt_pending WHERE operation_id = NEW.operation_id; END`,
];
const pendingEvents = `FROM obsidian_receipt_pending open CROSS JOIN obsidian_receipt_events intent
  ON intent.sequence = open.sequence`;
const projection = `intent.sequence AS sequence, COALESCE(terminal.payload, intent.payload) AS payload,
  EXISTS(SELECT 1 FROM obsidian_receipt_events dispatched
    WHERE dispatched.operation_id = intent.operation_id AND dispatched.event = 'dispatch') AS dispatched`;
const projectedEvents = `FROM obsidian_receipt_events intent LEFT JOIN obsidian_receipt_events terminal
  ON terminal.operation_id = intent.operation_id AND terminal.event = 'terminal'`;
type Stored = { sequence: number; payload: string; dispatched: number };
type Entry = { sequence: number; row: LocalReceipt; dispatched: boolean };
type Filter = { mirrorId: string; operationId?: string; path?: string; since?: string; limit: number };
const receiptPaths = (row: LocalReceipt) =>
  [row.path, ...(row.kind === 'move' ? [row.destination, ...(row.tree ? [row.tree.from, row.tree.to] : [])] : [])];
const pathsOverlap = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

const queueKey = Symbol.for('pa-bb.obsidian.receipt-queues');
const globals = globalThis as typeof globalThis & { [queueKey]?: Map<string, Promise<unknown>> };
const queues = globals[queueKey] ??= new Map();

// SQLite owns receipt durability. The mirror owns every note and staging byte.
export class LocalReceipts {
  private readonly db: ReturnType<BbPluginApi['storage']['database']>;
  private ready = false;

  constructor(private storage: BbPluginApi['storage']) {
    this.db = storage.database();
    // A committed intent must survive before its filesystem effect can start.
    this.db.pragma('synchronous = FULL');
    storage.migrate(this.db, migrations);
  }

  run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new VaultError('cancelled'));
    let cancel = () => {};
    const key = this.db.name;
    const task = (queues.get(key) ?? Promise.resolve()).then(async () => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) throw new VaultError('cancelled');
      await this.importLegacy();
      return action();
    });
    const tail = task.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    if (!signal) return task;
    // Once admitted, the writer owns cancellation and its outcome.
    return new Promise<T>((resolve, reject) => {
      cancel = () => reject(new VaultError('cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      task.then(resolve, reject);
    });
  }

  private async importLegacy() {
    if (this.ready) return;
    try {
      const imported = () => this.db.prepare('SELECT 1 FROM obsidian_receipt_imports WHERE source = ?').get(legacyKey);
      if (!imported()) {
        const rows = z.array(record).max(512).parse(await this.storage.kv.get(legacyKey) ?? []);
        this.db.transaction(() => {
          if (imported()) return;
          for (const row of rows) {
            this.append('intent', { ...row, outcome: 'uncertain' });
            if (row.outcome !== 'uncertain') this.append('terminal', row);
          }
          this.db.prepare('INSERT INTO obsidian_receipt_imports (source) VALUES (?)').run(legacyKey);
        }).immediate();
      }
      this.ready = true;
    } catch {
      throw new VaultError('unavailable', 'Check Obsidian operation receipt storage.');
    }
  }

  private append(event: 'intent' | 'dispatch' | 'terminal', row: LocalReceipt) {
    this.db.prepare(`INSERT INTO obsidian_receipt_events (operation_id, event, mirror, path, kind, at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.operationId, event, row.mirrorId, row.path, row.kind, row.at,
      event === 'dispatch' ? null : JSON.stringify(record.parse(row)));
  }

  private decode(stored: Stored): Entry {
    return { sequence: stored.sequence, row: record.parse(JSON.parse(stored.payload)), dispatched: !!stored.dispatched };
  }

  get(operationId: string): Entry | undefined {
    const row = this.db.prepare(`SELECT ${projection} ${projectedEvents}
      WHERE intent.event = 'intent' AND intent.operation_id = ?`).get(operationId) as Stored | undefined;
    return row && this.decode(row);
  }

  recent({ mirrorId, operationId, path, since, limit }: Filter) {
    const scoped = ['intent.event = ?', 'intent.mirror = ?', "intent.kind != 'move'"];
    const args: Array<string | number> = ['intent', mirrorId];
    if (operationId) { scoped.push('intent.operation_id = ?'); args.push(operationId); }
    if (path) { scoped.push('intent.path = ?'); args.push(path); }
    if (since) { scoped.push('julianday(intent.at) >= julianday(?)'); args.push(since); }
    const rows = this.db.prepare(`SELECT ${projection} ${projectedEvents} WHERE ${scoped.join(' AND ')}
      ORDER BY intent.at DESC, intent.sequence DESC LIMIT ?`).all(...args, limit) as Stored[];
    return rows.map(row => this.decode(row));
  }

  // The terminal event's sequence is the publication order. An intent can stay
  // open across another file's save and must remain visible when it later settles.
  deliveryChanges(mirrorId: string, after: number | null, limit: number) {
    return this.db.transaction(() => {
      const { tail } = this.db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS tail FROM obsidian_receipt_events',
      ).get() as { tail: number };
      if (after === null) return { cursor: tail, hasMore: false, changes: [] };
      if (after > tail) throw new VaultError('source_changed');
      const entries = this.db.prepare(`SELECT sequence, payload FROM obsidian_receipt_events
        WHERE sequence > ? AND sequence <= ? AND event = 'terminal' AND mirror = ?
          AND ((kind = 'save' AND json_extract(payload, '$.outcome') = 'saved_locally_pending_sync')
            OR (kind = 'resolution' AND json_type(payload, '$.previousHash') IS NOT NULL
              AND json_extract(payload, '$.outcome') IN ('saved_locally_pending_sync', 'adopted_content')))
        ORDER BY sequence LIMIT ?`).all(after, tail, mirrorId, limit + 1) as Array<Pick<Stored, 'sequence' | 'payload'>>;
      const hasMore = entries.length > limit;
      const page = entries.slice(0, limit);
      const changes = page.map(({ sequence, payload }) => {
        const row = record.parse(JSON.parse(payload));
        if (row.kind === 'move' || row.previousHash === undefined) throw new VaultError('unavailable');
        const { operationId, path, previousHash, hash } = row;
        return { sequence, operationId, path, previousHash, hash };
      });
      return { cursor: hasMore ? page.at(-1)!.sequence : tail, hasMore, changes };
    })();
  }

  laterSaves(mirrorId: string, path: string, after: number) {
    const rows = this.db.prepare(`SELECT terminal.payload AS payload FROM obsidian_receipt_events terminal
      JOIN obsidian_receipt_events intent ON intent.operation_id = terminal.operation_id AND intent.event = 'intent'
      WHERE terminal.event = 'terminal' AND terminal.mirror = ? AND terminal.path = ? AND terminal.kind = 'save'
      AND intent.sequence > ? ORDER BY intent.sequence`).all(mirrorId, path, after) as Array<Pick<Stored, 'payload'>>;
    return rows.map(row => record.parse(JSON.parse(row.payload)));
  }

  outstanding(mirrors: string[], limit: number, after = 0) {
    const rows = this.db.prepare(`SELECT intent.sequence AS sequence, intent.payload AS payload, 0 AS dispatched
      ${pendingEvents} WHERE open.mirror IN (SELECT value FROM json_each(?))
      AND open.sequence > ? ORDER BY open.sequence LIMIT ?`).all(JSON.stringify(mirrors), after, limit) as Stored[];
    return rows.map(row => this.decode(row));
  }

  statusPending(mirrors: string[], filter: Omit<Filter, 'mirrorId' | 'since'>) {
    const terms = ["intent.kind != 'move'", 'open.mirror IN (SELECT value FROM json_each(?))'];
    const args = [JSON.stringify(mirrors)];
    if (filter.path) { terms.push('intent.path = ?'); args.push(filter.path); }
    if (filter.operationId) { terms.push('intent.operation_id = ?'); args.push(filter.operationId); }
    const where = terms.join(' AND ');
    const rows = this.db.prepare(`SELECT intent.payload AS payload ${pendingEvents}
      WHERE ${where} ORDER BY open.sequence LIMIT ?`).all(...args, filter.limit) as Array<Pick<Stored, 'payload'>>;
    const count = this.db.prepare(`SELECT count(*) AS count ${pendingEvents} WHERE ${where}`).get(...args) as { count: number };
    return { count: count.count, rows: rows.map(row => record.parse(JSON.parse(row.payload))) };
  }

  recoveryPage(mirrors: string[], after?: number) {
    return this.db.transaction(() => {
      const cursor = this.db.prepare('SELECT sequence FROM obsidian_recovery_cursor WHERE id = 1').get() as { sequence: number } | undefined;
      let entries = this.outstanding(mirrors, 11, after ?? cursor?.sequence ?? 0);
      if (!entries.length && after === undefined && cursor?.sequence) entries = this.outstanding(mirrors, 11);
      const page = entries.slice(0, 10);
      if (page.length) this.db.prepare(`INSERT INTO obsidian_recovery_cursor (id, sequence) VALUES (1, ?)
        ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence`).run(page.at(-1)!.sequence);
      return { page, nextAfter: entries.length > 10 ? page.at(-1)!.sequence : null };
    }).immediate();
  }

  assertFree(mirrorId: string, paths: string[]) {
    const rows = this.db.prepare(`SELECT intent.payload AS payload ${pendingEvents}
      WHERE open.mirror = ?`).iterate(mirrorId) as Iterable<Pick<Stored, 'payload'>>;
    for (const previous of rows) {
      if (receiptPaths(record.parse(JSON.parse(previous.payload))).some(other => paths.some(path => pathsOverlap(path, other))))
        throw new VaultError('busy', 'Inspect the unresolved local operation before changing these paths.');
    }
  }

  begin(row: LocalReceipt) {
    try {
      this.db.transaction(() => {
        if (this.get(row.operationId)) throw new VaultError('operation_reused');
        this.assertFree(row.mirrorId, receiptPaths(row));
        this.append('intent', row);
      }).immediate();
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError('unavailable', 'Check Obsidian operation receipt storage.');
    }
  }

  dispatch(row: LocalReceipt) {
    this.append('dispatch', row);
  }

  finish(row: LocalReceipt) {
    try {
      const entry = this.get(row.operationId);
      if (entry?.row.outcome !== 'uncertain' || row.outcome === 'uncertain') throw new VaultError('uncertain');
      this.append('terminal', row);
    } catch {
      throw new VaultError('uncertain', 'Inspect the exact operation receipt before making another change.');
    }
  }
}
