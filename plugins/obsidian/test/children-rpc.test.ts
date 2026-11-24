import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { InventoryInput } from '../core/ports.ts';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
test('consumer child enumeration is scoped, read-only, bounded and fails safely', async () => {
  const host = createFakePluginHost({ pluginId: 'obsidian' }); const files = new FilesFake();
  let fail = false, calls = 0;
  const source = Object.assign(files, { children: async () => ({ entries: [], incomplete: false }),
    vaultInventory: async (input: InventoryInput, revision: number) => {
    assert.equal(input.vaultId, 'one'); assert.ok(revision > 0); assert.equal(input.root, 'Projects'); calls++;
    if (fail) throw new Error('private-sentinel');
    return { notes: [], folders: ['Projects', 'Projects/Empty'], incomplete: false };
  } });
  await plugin(host.bb, { catalog: new CatalogFake(), files: source, repository: new MemoryState() });
  await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
  try {
    const status = await host.harness.behavior.callRpc('status', null) as any; assert.equal(status.childrenAccessVersion, 1);
    assert.deepEqual(await host.harness.behavior.callRpc('listChildren', { vaultId: 'one', folder: 'Projects' }), { entries: [{ name: 'Empty', kind: 'directory' }], incomplete: false });
    for (const folder of ['../Projects', '/Projects', 'Projects/..']) await assert.rejects(host.harness.behavior.callRpc('listChildren', { vaultId: 'one', folder }));
    assert.equal(calls, 1); assert.equal(files.saved.length, 0);
    fail = true; await assert.rejects(host.harness.behavior.callRpc('listChildren', { vaultId: 'one', folder: 'Projects' }), /Directory listing did not complete/);
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
