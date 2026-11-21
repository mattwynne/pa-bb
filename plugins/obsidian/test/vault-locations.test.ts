import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';

test('vault locations retain connected mirror identity while exposing actual marker-root names', async () => {
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  const catalog = new CatalogFake(), files = new FilesFake();
  files.vaultRoots = async () => ({ roots: ['Life', 'Work'], incomplete: false });
  await plugin(host.bb, { catalog, files, repository: new MemoryState() });
  try {
    await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
    assert.deepEqual(await host.harness.behavior.callRpc('vaultLocations', null), { vaults: [{ id: 'one', root: 'Life', name: 'Life' }, { id: 'one', root: 'Work', name: 'Work' }], incomplete: false });
    catalog.value.sources[0].local.available = false;
    assert.deepEqual(await host.harness.behavior.callRpc('vaultLocations', null), { vaults: [], incomplete: true });
    files.vaultRoots = async () => { throw new Error('sentinel-secret-root'); };
    catalog.value.sources[0].local.available = true;
    assert.deepEqual(await host.harness.behavior.callRpc('vaultLocations', null), { vaults: [], incomplete: true });
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
