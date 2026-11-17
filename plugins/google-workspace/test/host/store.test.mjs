import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../../adapters/bb-store.mjs';
import { memoryStore } from '../support/memory-store.mjs';

for (const kind of ['memory', 'sqlite']) {
  test(`${kind}: account storage is case-insensitive, updates by subject, and removes`, async () => {
    const host = kind === 'sqlite' ? createFakePluginHost({ pluginId: 'google-workspace' }) : null;
    const store = host ? createBbStore(host.bb.storage.database(), (...args) => host.bb.storage.migrate(...args)) : memoryStore();
    try {
      await store.saveAccount({ subject: 'subject', email: 'alice@example.test', accessToken: 'access', refreshToken: 'refresh' });
      assert.equal((await store.byEmail('ALICE@example.test')).accessToken, 'access');
      await store.saveAccount({ subject: 'subject', email: 'alice@example.test', accessToken: 'new-access', refreshToken: 'refresh' });
      assert.equal((await store.accounts()).length, 1);
      assert.equal((await store.bySubject('subject')).accessToken, 'new-access');
      assert.equal(await store.removeAccount('subject'), true);
      assert.equal(await store.removeAccount('subject'), false);
      assert.equal(await store.byEmail('alice@example.test'), undefined);
    } finally { await host?.harness.lifecycle.dispose(); }
  });
  test(`${kind}: pending OAuth state is consumed once`, async () => {
    const host = kind === 'sqlite' ? createFakePluginHost({ pluginId: 'google-workspace' }) : null;
    const store = host ? createBbStore(host.bb.storage.database(), (...args) => host.bb.storage.migrate(...args)) : memoryStore();
    try {
      const record = { stateHash: 'hash', verifier: 'private-verifier', expiresAt: 300000 };
      await store.savePending(record);
      assert.deepEqual(await store.consumePending('hash'), record);
      assert.equal(await store.consumePending('hash'), undefined);
      assert.equal(await store.consumePending('unknown'), undefined);
    } finally { await host?.harness.lifecycle.dispose(); }
  });
}
