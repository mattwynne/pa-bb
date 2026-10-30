import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-drive' });
  const db = bb.storage.database();
  const store = createBbStore(db, (db, statements) => bb.storage.migrate(db, statements));
  const sharing = fileId => ({ operationId: randomUUID(), subject: 'synthetic', fileId, state: 'proposed' });
  const filing = () => ({ operationId: randomUUID(), subject: 'synthetic', resource: 'file:item',
    contextIds: ['item', 'source', 'destination', 'ancestor'], state: 'proposed' });
  return { store, db, sharing, filing, close: () => harness.lifecycle.dispose() };
}

for (const id of ['item', 'source', 'destination', 'ancestor']) {
  for (const state of ['reviewing', 'writing', 'uncertain']) {
    test(`filing ${state} blocks sharing on ${id}, including after store recreation`, async () => {
      const h = await setup();
      try {
        const move = h.filing();
        await h.store.filing.reserve(move);
        assert.equal(await h.store.filing.claim(move), true);
        await h.store.filing.save({ ...move, state });
        const restarted = createBbStore(h.db, () => {});
        const share = h.sharing(id);
        await restarted.reserveSharing(share);
        assert.equal(await restarted.claimSharing(share.operationId, id), false);
        const unrelated = h.sharing('unrelated');
        await restarted.reserveSharing(unrelated);
        assert.equal(await restarted.claimSharing(unrelated.operationId, unrelated.fileId), true);
        await restarted.filing.save({ ...move, state: 'verified' });
        assert.equal(await restarted.claimSharing(share.operationId, id), true);
      } finally { await h.close(); }
    });
    test(`sharing ${state} blocks filing through ${id}`, async () => {
      const h = await setup();
      try {
        const share = h.sharing(id), move = h.filing();
        await h.store.reserveSharing(share);
        assert.equal(await h.store.claimSharing(share.operationId, id), true);
        await h.store.updateSharing({ ...share, state });
        await h.store.filing.reserve(move);
        assert.equal(await h.store.filing.claim(move), false);
        await h.store.updateSharing({ ...share, state: 'verified' });
        assert.equal(await h.store.filing.claim(move), true);
      } finally { await h.close(); }
    });
  }
}

test('simultaneous cross-workflow claims have exactly one winner in either ordering', async () => {
  for (const filingFirst of [true, false]) {
    const h = await setup();
    try {
      const share = h.sharing('destination'), move = h.filing();
      await h.store.reserveSharing(share); await h.store.filing.reserve(move);
      const claims = [() => h.store.claimSharing(share.operationId, share.fileId), () => h.store.filing.claim(move)];
      if (filingFirst) claims.reverse();
      assert.deepEqual(await Promise.all(claims.map(claim => claim())), [true, false]);
    } finally { await h.close(); }
  }
});
