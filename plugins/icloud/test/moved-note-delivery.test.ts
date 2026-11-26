import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { NativeNoteDelivery } from '../adapters/note-delivery-native.ts';
import { NoteDeliveryRecovery, deliveryRecoverySchema } from '../adapters/note-delivery-recovery.ts';

const hash = (text:string) => createHash('sha256').update(text).digest('hex');

test('a moved note may use its verified provider revision while the folder baseline is pending', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(deliveryRecoverySchema);
    const path = 'Destination/Folder/Note.md';
    const identity = {documentId:'existing-note',parentId:'same-folder',etag:'original'};
    const previous = hash('before'), next = hash('after');
    let observed = {...identity,hash:previous,modifiedMs:1,size:6};
    const movedBaseline = {...identity,hash:previous};
    const native = new NativeNoteDelivery(
      {binary:'/native',remote:'icloud:fixture',binding:'fixture-binding',workdir:'/no-saved-listing'},
      {async noteDeliveryCommand() { return {outcome:'observed',observation:observed,movedBaseline}; }},
      new NoteDeliveryRecovery(db),
      async () => ({text:'after',hash:next}),
    );
    const draft = {path,previousHash:previous,hash:next,operations:['c49521f1-76dd-4858-8f51-b37c3674be3f']};
    const intent = await native.prepare('mirror',draft);
    assert.ok(intent && intent !== 'already_present');
    assert.deepEqual(intent.expected,observed);
    observed = {...observed,documentId:'independent-recreation'};
    assert.equal(await native.prepare('mirror',draft),null);
    observed = {...identity,hash:previous,modifiedMs:1,size:6,etag:'changed-in-iCloud'};
    assert.equal(await native.prepare('mirror',draft),null);
  } finally { db.close(); }
});
