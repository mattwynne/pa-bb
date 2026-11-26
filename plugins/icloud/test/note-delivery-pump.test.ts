import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NoteDeliveryPump } from '../adapters/note-delivery-pump.ts';
import { NoteDeliveryQueue, noteDeliverySchema } from '../adapters/note-delivery-queue.ts';
import { NoteDeliveryRecovery, deliveryRecoverySchema } from '../adapters/note-delivery-recovery.ts';

test('a lost publication response is reconciled from exact provider evidence without sending again', async () => {
  const db = new Database(':memory:');
  try {
    noteDeliverySchema.forEach(sql => db.exec(sql));
    db.exec(deliveryRecoverySchema);
    const mirrorId = 'generated', path = 'existing.md', operationId = randomUUID();
    const queue = new NoteDeliveryQueue(db), journal = new NoteDeliveryRecovery(db);
    const expected = { documentId: 'one', parentId: 'parent', etag: 'v1', hash: 'a'.repeat(64), size: 10, modifiedMs: 100 };
    const published = { ...expected, hash: 'b'.repeat(64), etag: 'v2', modifiedMs: 200 };
    queue.stage(mirrorId, null, { changes: [], cursor: 0, hasMore: false });
    queue.stage(mirrorId, 0, { changes: [{ path, operationId, sequence: 1, previousHash: expected.hash, hash: published.hash }], cursor: 1, hasMore: false });
    let attempted = 0, reconciled = false, current = { ...published, documentId: 'same-name-recreation' };
    const worker = {
      async prepare() { return { mirrorId, path, operations: [operationId], expected, wantedHash: published.hash }; },
      async publish() {
        assert.equal(journal.pending(mirrorId)?.operations[0], operationId, 'intent existed before request');
        attempted++;
        return { outcome: 'uncertain' as const };
      },
      async readBack() { return current; },
      async reconcile() { reconciled = true; },
    };
    assert.equal(await new NoteDeliveryPump(queue, journal, worker).deliverOne(mirrorId), 'needs_reconciliation');
    assert.equal(await new NoteDeliveryPump(queue, journal, worker).deliverOne(mirrorId), 'needs_reconciliation');
    assert.equal(attempted, 1);
    assert.equal(reconciled, false);
    current = published;
    assert.equal(await new NoteDeliveryPump(queue, journal, worker).deliverOne(mirrorId), 'delivered');
    assert.equal(attempted, 1);
    assert.equal(reconciled, true);
    assert.equal(journal.pending(mirrorId), null);
    assert.equal(queue.oldest(mirrorId).length, 0);
  } finally { db.close(); }
});
