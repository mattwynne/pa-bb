import { z } from 'zod';
import { CloudError } from '../core/ports.ts';
import type Database from 'better-sqlite3';
import type { NoteDeliveryQueue } from './note-delivery-queue.ts';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const metadata = z.string().min(1).max(512);
export const deliveryObservation = z.object({
  documentId: metadata, parentId: metadata, etag: metadata, hash,
  modifiedMs: z.number().int().nonnegative(), size: z.number().int().min(1).max(1024 * 1024),
}).strict();
const notePath = z.string().max(1024).endsWith('.md').refine(p =>
  !/[\\\x00-\x1f\x7f]/.test(p) && p.split('/').every(part => part && part !== '.' && part !== '..'));
const intent = z.object({
  mirrorId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  path: notePath,
  source: notePath.optional(),
  operations: z.array(z.string().uuid()).min(1).max(128),
  sourceOperations: z.array(z.string().uuid()).min(1).max(128).optional(),
  expected: deliveryObservation.nullable(),
  wantedHash: hash,
}).strict();
const stored = intent.extend({ publication: deliveryObservation.nullable() }).strict();
export type DeliveryObservation = z.infer<typeof deliveryObservation>;
export type DeliveryIntent = z.infer<typeof intent>;
type Stored = z.infer<typeof stored>;

export const deliveryRecoverySchema = `CREATE TABLE icloud_delivery_intent (
    mirror TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  );
  CREATE TABLE icloud_delivery_head (
    mirror TEXT NOT NULL,
    path TEXT NOT NULL,
    binding TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (mirror,path)
  )`;

// This runs only after reading the exact path under the same authenticated
// mirror after an uncertain request. An unrelated new identity never counts as
// publication of an existing note, even if its bytes happen to match.
export function classifyReplacementReadback(before: DeliveryObservation, wantedHash: string, current: DeliveryObservation | null) {
  if (!current || current.documentId !== before.documentId || current.parentId !== before.parentId)
    return { outcome: 'changed_identity' } as const;
  if (current.etag === before.etag && current.hash === before.hash) return { outcome: 'unchanged' } as const;
  if (current.etag !== before.etag && current.hash === wantedHash) return { outcome: 'published', current } as const;
  return { outcome: 'changed_content' } as const;
}

export class NoteDeliveryRecovery {
  constructor(private readonly db: Database.Database) {}

  pending(mirrorId: string) {
    const row = this.db.prepare('SELECT payload FROM icloud_delivery_intent WHERE mirror = ?').get(mirrorId) as { payload: string } | undefined;
    return row ? stored.parse(JSON.parse(row.payload)) : null;
  }

  prepare(input: DeliveryIntent) {
    const value = stored.parse({ ...input, publication: null });
    if ((value.sourceOperations && !value.source) ||
        (value.source && (!value.expected || value.path.normalize('NFC').toLowerCase() === value.source.normalize('NFC').toLowerCase())))
      throw new CloudError('source_changed');
    const write = this.db.prepare('INSERT OR IGNORE INTO icloud_delivery_intent (mirror, payload) VALUES (?, ?)');
    if (write.run(value.mirrorId, JSON.stringify(value)).changes !== 1) throw new CloudError('recovery_required');
  }

  published(mirrorId: string, operationId: string, publication: DeliveryObservation, expectedCreateDocumentId?: string) {
    this.db.transaction(() => {
      const row = this.forOperation(mirrorId, operationId);
      if (row.publication) throw new CloudError('recovery_required');
      const next = deliveryObservation.parse(publication);
      if (next.hash !== row.wantedHash ||
        (row.source
          ? !row.expected || next.documentId === row.expected.documentId
          : row.expected
            ? classifyReplacementReadback(row.expected, row.wantedHash, next).outcome !== 'published'
            : !expectedCreateDocumentId || next.documentId !== expectedCreateDocumentId)) throw new CloudError('source_changed');
      this.write({ ...row, publication: next });
    }).immediate();
  }

  refused(mirrorId: string, operationId: string) {
    this.db.transaction(() => {
      const row = this.forOperation(mirrorId, operationId);
      if (row.publication) throw new CloudError('recovery_required');
      this.db.prepare('DELETE FROM icloud_delivery_intent WHERE mirror = ?').run(mirrorId);
    }).immediate();
  }

  // The native paired-listing transaction has already completed or been
  // recovered. Clearing its durable marker and advancing the queue are one
  // SQLite transaction. A mismatching acknowledgement leaves both pending.
  reconciled(mirrorId: string, operationId: string, documentId: string, etag: string, queue: NoteDeliveryQueue, binding?: string) {
    this.db.transaction(() => {
      const row = this.forOperation(mirrorId, operationId);
      if (row.publication?.documentId !== documentId || row.publication.etag !== etag)
        throw new CloudError('recovery_required');
      queue.settle(mirrorId, row.path, row.operations);
      if (row.sourceOperations && row.source) queue.settle(mirrorId,row.source,row.sourceOperations);
      if (row.source) this.db.prepare('DELETE FROM icloud_delivery_head WHERE mirror = ? AND path = ?').run(mirrorId,row.source);
      if (binding) this.db.prepare(`INSERT INTO icloud_delivery_head (mirror,path,binding,body) VALUES (?,?,?,?)
        ON CONFLICT (mirror,path) DO UPDATE SET binding=excluded.binding,body=excluded.body`)
        .run(mirrorId,row.path,binding,JSON.stringify(row.publication));
      this.db.prepare('DELETE FROM icloud_delivery_intent WHERE mirror = ?').run(mirrorId);
    }).immediate();
  }

  head(mirrorId: string, path: string, binding: string) {
    const row = this.db.prepare('SELECT body FROM icloud_delivery_head WHERE mirror = ? AND path = ? AND binding = ?')
      .get(mirrorId, path, binding) as { body: string } | undefined;
    return row ? deliveryObservation.parse(JSON.parse(row.body)) : null;
  }

  private forOperation(mirrorId: string, operationId: string) {
    const row = this.pending(mirrorId);
    if (!row || row.operations.at(-1) !== operationId) throw new CloudError('recovery_required');
    return row;
  }

  private write(row: Stored) {
    this.db.prepare('UPDATE icloud_delivery_intent SET payload = ? WHERE mirror = ?').run(JSON.stringify(row), row.mirrorId);
  }
}
