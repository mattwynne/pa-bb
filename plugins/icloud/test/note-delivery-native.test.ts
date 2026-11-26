import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeNoteDelivery } from '../adapters/note-delivery-native.ts';
import type { PublicationIntent } from '../adapters/note-delivery-pump.ts';
import type { NoteDeliveryRecovery } from '../adapters/note-delivery-recovery.ts';

const target = {
  binary: '/generated/native', workdir: '/generated/work', remote: 'icloud:generated', binding: 'FOLDER::com.apple.CloudDocs::generated',
} as const;
const wantedHash = 'b'.repeat(64);
const expected = { documentId: 'document', parentId: 'parent', etag: 'initial', hash: 'a'.repeat(64), modifiedMs: 1, size: 1 };
const observed = { ...expected, etag: 'new', hash: wantedHash, modifiedMs: 2 };
const operationId = '40b59f60-57ab-4486-a651-8b265a4ddda3';

test('ordinary recovery verifies its exact staged version through the native worker after a later local edit', async () => {
  for (const create of [true, false]) {
    const intent: PublicationIntent = { mirrorId: 'mirror', path: 'Generated.md', expected: create ? null : expected, wantedHash, operations: [operationId] };
    const journal = {} as NoteDeliveryRecovery;
    let calls = 0;
    const worker = new NativeNoteDelivery(target, {
      async noteDeliveryCommand(selected, operation, frame) {
        assert.equal(selected, target);
        assert.equal(operation, create ? 'recover-create' : 'recover');
        assert.deepEqual(frame, { path: intent.path, operationId, wantedHash,
          ...(create ? {} : { expected: { documentId: expected.documentId, parentId: expected.parentId, etag: expected.etag, hash: expected.hash } }) });
        calls++;
        if (calls === 1) return { outcome: 'published', observation: observed };
        if (calls === 2) return { outcome: 'refused' };
        return { outcome: 'cleared' };
      },
    }, journal, async () => ({ hash: 'c'.repeat(64), text: 'later local edit' }));
    assert.deepEqual(await worker.readBack(intent), observed);
    assert.equal(await worker.readBack(intent), null);
    assert.equal(await worker.readBack(intent), 'cleared');
  }
});

test('explicit empty text is forwarded and an empty publication can be verified', async () => {
  const intent: PublicationIntent = { mirrorId: 'mirror', path: 'Generated.md', expected, wantedHash, operations: [operationId] };
  const zero = { ...observed, size: 0 };
  const worker = new NativeNoteDelivery(target, {
    async noteDeliveryCommand(selected, operation, frame) {
      assert.equal(selected, target);
      assert.equal(operation, 'replace');
      assert.equal(frame.text, '');
      return { outcome: 'published', observation: zero };
    },
  }, {} as NoteDeliveryRecovery, async () => ({ hash: wantedHash, text: '' }));
  assert.deepEqual(await worker.publish(intent), { outcome: 'published', observation: zero });
});
