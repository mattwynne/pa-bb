import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };
test('projection byte budget, omitted roots, incomplete catalogs and source errors are bounded and never leak bodies', async () => {
  for (const mode of ['bytes', 'catalog', 'error']) {
    const files = Object.assign(new FilesFake(), { children: async () => ({ entries: [], incomplete: false }) });
    files.notes.clear();
    for (let i = 0; i < 3; i++) files.notes.set(`one/Projects/P${i}.md`, mode === 'bytes' ? 'x'.repeat(800000) : '---\narea: "[[Areas/Finance]]"\n---\nPRIVATE_SENTINEL');
    files.notes.set('one/Areas/Finance.md', 'PRIVATE_TARGET');
    if (mode === 'catalog') { const list = files.list.bind(files); files.list = async (...args) => ({ ...await list(...args), incomplete: true }); }
    if (mode === 'error') files.read = async () => { throw new Error('PRIVATE_SENTINEL'); };
    const host = createFakePluginHost({ pluginId: 'obsidian' });
    await plugin(host.bb, { catalog: new CatalogFake(), files, repository: new MemoryState() });
    await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
    try {
      const input = { vaultId: 'one', root: '', areaFolder: 'Areas', paths: ['Projects/P0.md', 'Projects/P1.md', 'Projects/P2.md'] };
      const value = await host.harness.behavior.callRpc('projectAreas', input, caller) as any;
      assert.equal(value.incomplete, true); assert.ok(value.rows.every((row: any) => !row.areaId));
      if (mode === 'bytes') assert.ok(value.rows.length < 3);
      assert.equal(files.saved.length, 0);
      assert.doesNotMatch(JSON.stringify(value) + JSON.stringify(host.harness.inspection.logEntries), /PRIVATE_SENTINEL|PRIVATE_TARGET/);
      await assert.rejects(host.harness.behavior.callRpc('projectAreas', { ...input, paths: Array(51).fill('Projects/P0.md') }, caller));
    } finally { await host.harness.lifecycle.dispose(); }
  }
});
