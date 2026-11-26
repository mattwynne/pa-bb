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

test('an unresolved move allows a disjoint write and recovers its lost reply first', async () => {
  const db = new Database(':memory:');
  try {
    noteDeliverySchema.forEach(sql => db.exec(sql));
    db.exec(deliveryRecoverySchema);
    const mirrorId = 'generated', source = 'Original.md', destination = 'Moved.md', other = 'Independent.md';
    const moveId = randomUUID(), writeId = randomUUID();
    const queue = new NoteDeliveryQueue(db);
    let journal = new NoteDeliveryRecovery(db);
    const previous = { documentId: 'original', parentId: 'parent', etag: 'v1', hash: 'a'.repeat(64), size: 10, modifiedMs: 100 };
    const beforeWrite = { ...previous, documentId: 'independent', hash: 'b'.repeat(64) };
    const moved = { ...previous, documentId: 'destination', etag: 'new', hash: 'c'.repeat(64) };
    const written = { ...beforeWrite, etag: 'v2', hash: 'd'.repeat(64) };
    queue.stage(mirrorId,null,{changes:[],cursor:0,hasMore:false});
    queue.stage(mirrorId,0,{changes:[
      {path:destination,source,operationId:moveId,sequence:1,previousHash:previous.hash,hash:moved.hash},
      {path:other,operationId:writeId,sequence:2,previousHash:beforeWrite.hash,hash:written.hash},
    ],cursor:2,hasMore:false});
    // Simulate a move journal surviving installation of the independent lanes.
    const old = {mirrorId,path:destination,source,operations:[moveId],expected:previous,wantedHash:moved.hash,publication:null};
    db.prepare('INSERT INTO icloud_delivery_intent VALUES (?,?)').run(mirrorId,JSON.stringify(old));
    journal = new NoteDeliveryRecovery(db);
    assert.equal(journal.pending(mirrorId,'move')?.operations[0],moveId);
    assert.equal(journal.pending(mirrorId,'write'),null);

    const soFar: string[] = [];
    const worker: import('../adapters/note-delivery-pump.ts').NotePublicationWorker = {
      async prepare(id,plan) {
        assert.equal(plan.path,other);
        return {mirrorId:id,path:plan.path,expected:beforeWrite,wantedHash:plan.hash,operations:plan.operations};
      },
      async publish(intent) {
        soFar.push('send '+intent.path);
        assert.equal(journal.pending(mirrorId,'write')?.path,other);
        assert.equal(journal.pending(mirrorId,'move')?.source,source);
        return {outcome:'uncertain'};
      },
      async readBack(intent) {
        soFar.push('recover '+intent.path);
        return intent.path === other ? written : moved;
      },
      async reconcile() {},
      acknowledgedBinding:'generated-binding',
    };
    assert.equal(await new NoteDeliveryPump(queue,journal,worker).deliverOne(mirrorId,other),'needs_reconciliation');
    journal = new NoteDeliveryRecovery(db);
    assert.equal(await new NoteDeliveryPump(queue,journal,worker).deliverOne(mirrorId,destination),'delivered');
    assert.equal(journal.pending(mirrorId,'write'),null);
    assert.equal(journal.pending(mirrorId,'move')?.source,source);
    assert.equal(journal.head(mirrorId,other,'generated-binding')?.etag,'v2');
    assert.equal(await new NoteDeliveryPump(queue,journal,worker).deliverOne(mirrorId,destination),'delivered');
    assert.equal(journal.pending(mirrorId),null);
    assert.deepEqual(soFar,['send '+other,'recover '+other,'recover '+destination]);
    assert.deepEqual(queue.pendingPaths(mirrorId),[]);
  } finally { db.close(); }
});
