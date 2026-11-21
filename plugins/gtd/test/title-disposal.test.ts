import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
test('native disposal waits for an entered title request; no timeout or repeated write is introduced', async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'], sdk: { plugins: { callRpc: async () => ({ vaults: [], incomplete: false }) } } });
  await plugin(host.bb, { select: async () => ({ key: 'source', backend: {
    checkAccess: async () => {},
    readProjects: async () => ({ source: { backend: 'fake', id: 'one', name: 'Synthetic', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null }, projects: [{ id: 'Projects/Plan.md', title: 'Plan', status: 'active' as const }], complete: true, warnings: [] }),
    rename: async () => { calls++; entered(); await new Promise<void>(resolve => { release = resolve; }); return { operationId: '12345678-1234-4123-8123-123456789abc', outcome: 'saved_locally_pending_sync' as const }; },
  } }) });
  const request = host.harness.behavior.callRpc('renameProject', { source: 'one', id: 'Projects/Plan.md', title: 'New' });
  await ready; let stopped = false;
  const disposal = host.harness.lifecycle.dispose().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  release(); await request; await disposal; assert.equal(calls, 1);
});
