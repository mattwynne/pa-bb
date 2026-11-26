import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { coalesceDelivery, NoteDeliveryQueue, noteDeliverySchema } from '../adapters/note-delivery-queue.ts';

test('the cursor and pending edits recover together and settling a coalesced edit preserves later saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-note-queue-'));
  const path = join(root, 'queue.db');
  let db = new Database(path);
  try {
    db.pragma('synchronous = FULL');
    noteDeliverySchema.forEach(sql => db.exec(sql));
    let queue = new NoteDeliveryQueue(db);
    queue.stage('mirror', null, { cursor: 10, hasMore: false, changes: [] });
    const make = (sequence: number, previousHash: string, hash: string) => ({ sequence, operationId: randomUUID(),
      path: 'Generated.md', previousHash: previousHash.repeat(64), hash: hash.repeat(64) });
    const first = make(12, 'a', 'b');
    const second = make(15, 'b', 'c');
    queue.stage('mirror', 10, { cursor: 18, hasMore: false, changes: [first, second] });
    assert.throws(() => queue.stage('mirror', 10, { cursor: 18, hasMore: false, changes: [first, second] }), /source_changed/);
    db.close();
    db = new Database(path);
    queue = new NoteDeliveryQueue(db);
    assert.equal(queue.cursor('mirror'), 18);
    const plan = coalesceDelivery(queue.oldest('mirror'));
    assert.deepEqual(plan?.operations, [first.operationId, second.operationId]);
    const third = make(21, 'c', 'd');
    queue.stage('mirror', 18, { cursor: 21, hasMore: false, changes: [third] });
    queue.settle('mirror', 'Generated.md', plan!.operations);
    assert.deepEqual(queue.oldest('mirror').map(x => x.operationId), [third.operationId]);

    const discontinuity = make(25, 'a', 'e');
    queue.stage('mirror', 21, { cursor: 25, hasMore: false, changes: [discontinuity] });
    assert.equal(coalesceDelivery(queue.oldest('mirror')), null);
    assert.throws(() => queue.settle('mirror', 'Generated.md', [discontinuity.operationId]), /source_changed/);
    const capacityRejected = { ...make(30, 'e', 'f'), operationId: third.operationId };
    assert.throws(() => queue.stage('mirror', 25, { cursor: 30, hasMore: false, changes: [capacityRejected] }));
    assert.equal(queue.cursor('mirror'), 25, 'failed transaction did not skip an edit');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
