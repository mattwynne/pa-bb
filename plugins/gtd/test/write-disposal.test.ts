import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

test('native disposal drains an entered Area standard save', async () => {
  const input = {
    source: 'one', id: 'Areas/Work.md', text: 'Practice weekly.',
    expectedHash: 'a'.repeat(64), operationId: '12345678-1234-4123-8123-123456789abc',
  };
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'], sdk: {
    plugins: { callRpc: async ({ method }) => {
      if (method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Synthetic' }], incomplete: false };
      assert.equal(method, 'writeNoteSection');
      calls++;
      entered();
      await pending;
      return { operationId: input.operationId, outcome: 'saved_locally_pending_sync' };
    } },
  } });
  await plugin(host.bb);
  await host.harness.behavior.setSettings({ vaultId: 'one' });
  const request = host.harness.behavior.callRpc('saveAreaStandard', input);
  await Promise.race([ready, request.then(() => assert.fail('The save returned before reaching Obsidian'))]);
  let stopped = false;
  const disposal = host.harness.lifecycle.dispose().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stopped, false);
  release();
  await request;
  await disposal;
  assert.equal(calls, 1);
});
