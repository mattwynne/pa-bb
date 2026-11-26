import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CloudError } from '../core/ports.ts';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const notePath = z.string().min(1).max(1024).refine(path =>
  path.endsWith('.md') && !/[\\\x00-\x1f\x7f]/.test(path) &&
  path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'));
const change = z.object({ sequence, operationId: z.string().uuid(), path: notePath, previousHash: hash.nullable(), hash }).strict();
export const noteDeliveryPage = z.object({ cursor: sequence, hasMore: z.boolean(), changes: z.array(change).max(32) }).strict();
const queued = change.extend({ mirrorId: z.string() }).strict();
type Queued = z.infer<typeof queued>;
const capacity = 128;

export const noteDeliverySchema = [
  `CREATE TABLE icloud_delivery_cursor (
    mirror TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL
  )`,
  `CREATE TABLE icloud_pending_delivery (
    mirror TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    path TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    previous_hash TEXT,
    hash TEXT NOT NULL,
    PRIMARY KEY (mirror, sequence)
  )`,
  'CREATE INDEX icloud_delivery_path ON icloud_pending_delivery (mirror, path, sequence)',
] as const;

export class NoteDeliveryQueue {
  constructor(private readonly db: Database.Database) {}

  cursor(mirrorId: string) {
    const row = this.db.prepare('SELECT sequence FROM icloud_delivery_cursor WHERE mirror = ?').get(mirrorId) as { sequence: number } | undefined;
    return row?.sequence ?? null;
  }

  stage(mirrorId: string, from: number | null, input: unknown) {
    const page = noteDeliveryPage.safeParse(input);
    if (!page.success) throw new CloudError('invalid_selection');
    let previous = from ?? 0;
    for (const change of page.data.changes) {
      if (change.sequence <= previous || change.sequence > page.data.cursor) throw new CloudError('source_changed');
      previous = change.sequence;
    }
    if (page.data.cursor < previous || (page.data.hasMore && (!page.data.changes.length || page.data.cursor !== previous)) ||
      (from === null && (page.data.hasMore || page.data.changes.length))) throw new CloudError('source_changed');

    this.db.transaction(() => {
      if (this.cursor(mirrorId) !== from) throw new CloudError('source_changed');
      const { count } = this.db.prepare('SELECT count(*) AS count FROM icloud_pending_delivery WHERE mirror = ?').get(mirrorId) as { count: number };
      if (count + page.data.changes.length > capacity) throw new CloudError('capacity');
      const insert = this.db.prepare(`INSERT INTO icloud_pending_delivery (mirror, sequence, path, operation_id, previous_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const row of page.data.changes) insert.run(mirrorId, row.sequence, row.path, row.operationId, row.previousHash, row.hash);
      this.db.prepare(`INSERT INTO icloud_delivery_cursor (mirror, sequence) VALUES (?, ?)
        ON CONFLICT (mirror) DO UPDATE SET sequence = excluded.sequence`).run(mirrorId, page.data.cursor);
    }).immediate();
  }

  oldest(mirrorId: string) {
    const found = this.db.prepare(`SELECT path FROM icloud_pending_delivery WHERE mirror = ? ORDER BY sequence LIMIT 1`).get(mirrorId) as { path: string } | undefined;
    return found ? this.pendingPath(mirrorId, found.path) : [];
  }

  pendingPaths(mirrorId: string) {
    return (this.db.prepare(`SELECT path FROM icloud_pending_delivery WHERE mirror = ? GROUP BY path
      ORDER BY MIN(sequence) LIMIT ?`).all(mirrorId,capacity) as Array<{path:string}>).map(entry=>entry.path);
  }

  pendingPath(mirrorId: string, path: string) {
    return z.array(queued).max(capacity).parse(this.db.prepare(`SELECT mirror AS mirrorId, sequence, path, operation_id AS operationId,
      previous_hash AS previousHash, hash FROM icloud_pending_delivery WHERE mirror = ? AND path = ? ORDER BY sequence`).all(mirrorId, path));
  }

  // A caller supplies only operation IDs whose delivery or conflict was verified.
  // The exact queue prefix is checked again to leave new saves pending.
  settle(mirrorId: string, path: string, operations: string[]) {
    if (!operations.length || operations.length > capacity) throw new CloudError('invalid_selection');
    this.db.transaction(() => {
      const pending = this.pendingPath(mirrorId, path).slice(0, operations.length);
      if (pending.length !== operations.length || pending.some((row, index) => row.operationId !== operations[index]))
        throw new CloudError('source_changed');
      this.db.prepare('DELETE FROM icloud_pending_delivery WHERE mirror = ? AND path = ? AND sequence <= ?')
        .run(mirrorId, path, pending.at(-1)!.sequence);
    }).immediate();
  }
}

export function coalesceDelivery(pending: Queued[]) {
  const first = pending[0], last = pending.at(-1);
  if (!first || !last) return null;
  for (let i = 1; i < pending.length; i++) {
    const current = pending[i]!, previous = pending[i - 1]!;
    if (current.mirrorId !== first.mirrorId || current.path !== first.path || current.sequence <= previous.sequence ||
      current.previousHash !== previous.hash) return null;
  }
  return { path: first.path, previousHash: first.previousHash, hash: last.hash, operations: pending.map(row => row.operationId) };
}
