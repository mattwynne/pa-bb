import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { classifyReplacementReadback, deliveryRecoverySchema, NoteDeliveryRecovery } from '../adapters/note-delivery-recovery.ts';
import { NoteDeliveryQueue, noteDeliverySchema } from '../adapters/note-delivery-queue.ts';

test('an uncertain publication cannot retire a newer note or a same-name recreation', () => {
  const db = new Database(':memory:');
  try {
    db.exec(deliveryRecoverySchema);
    noteDeliverySchema.forEach(sql => db.exec(sql));
    const queue = new NoteDeliveryQueue(db);
    const journal = new NoteDeliveryRecovery(db);
    const priorHash = 'a'.repeat(64), nextHash = 'b'.repeat(64);
    const mirrorId = 'generated', path = 'Test.md', operationId = randomUUID();
    queue.stage(mirrorId, null, { cursor: 1, hasMore: false, changes: [] });
    queue.stage(mirrorId, 1, { cursor: 3, hasMore: false, changes: [{ sequence: 3, operationId, path, previousHash: priorHash, hash: nextHash }] });
    const original = { documentId: 'doc-1', parentId: 'parent', etag: 'etag-1', hash: priorHash, modifiedMs: 10, size: 500 };
    const created = { ...original, hash: nextHash, etag: 'etag-2', modifiedMs: 20 };
    const recreated = { ...created, documentId: 'doc-2' };
    const draft = { mirrorId, path, operations: [operationId], expected: original, wantedHash: nextHash };
    journal.prepare(draft);
    assert.throws(() => journal.prepare(draft), /recovery_required/);
    assert.equal(classifyReplacementReadback(original, nextHash, recreated).outcome, 'changed_identity');
    assert.equal(classifyReplacementReadback(original, nextHash, null).outcome, 'changed_identity');
    assert.equal(classifyReplacementReadback(original, nextHash, original).outcome, 'unchanged');
    assert.throws(() => journal.published(mirrorId, operationId, recreated), /source_changed/);
    assert.equal(journal.pending(mirrorId)?.publication, null);
    journal.published(mirrorId, operationId, created);
    const nextOp = randomUUID();
    queue.stage(mirrorId, 3, { cursor: 4, hasMore: false, changes: [{ sequence: 4, operationId: nextOp, path, previousHash: nextHash, hash: 'c'.repeat(64) }] });
    assert.throws(() => journal.reconciled(mirrorId, operationId, created.documentId, 'wrong-etag', queue), /recovery_required/);
    assert.deepEqual(queue.oldest(mirrorId).map(row => row.operationId), [operationId, nextOp]);
    journal.reconciled(mirrorId, operationId, created.documentId, created.etag, queue);
    assert.equal(journal.pending(mirrorId), null);
    assert.deepEqual(queue.oldest(mirrorId).map(row => row.operationId), [nextOp]);
  } finally { db.close(); }
});
