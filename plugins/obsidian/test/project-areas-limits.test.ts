import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { VaultError } from '../core/ports.ts';
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

test('a source-wide refusal drops earlier live rows; an isolated note omission keeps them partial', async t => {
  for (const category of ['source_unavailable', 'not_connected', 'unavailable']) await t.test(category, async t => {
    const files = Object.assign(new FilesFake(), { children: async () => ({ entries: [], incomplete: false }) });
    const paths = ['Projects/First.md', 'Projects/Second.md'];
    for (const path of paths) files.notes.set('one/' + path, '---\narea: Areas/Example.md\n---');
    files.notes.set('one/Areas/Example.md', 'synthetic target');
    const original = files.read.bind(files), reads: string[] = [];
    files.read = async (id, revision, path) => {
      reads.push(path);
      if (path === paths[1]) throw new VaultError(category, 'PRIVATE_SENTINEL');
      return original(id, revision, path);
    };
    const host = createFakePluginHost({ pluginId: 'obsidian' });
    await plugin(host.bb, { catalog: new CatalogFake(), files, repository: new MemoryState() });
    t.after(() => host.harness.lifecycle.dispose());
    await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
    const result = host.harness.behavior.callRpc('projectAreasFromFrontmatter', { vaultId: 'one', root: '', areaFolder: 'Areas', paths }, caller);
    if (category === 'unavailable') {
      const page = await result as { authority: { epoch: string } };
      assert.match(page.authority.epoch, /^[0-9a-f-]{36}$/);
      assert.deepEqual(page, { rows: [
        { path: paths[0], status: 'resolved', areaId: 'Areas/Example.md' }, { path: paths[1], status: 'unresolved' },
      ], incomplete: true, authority: { revision: 1, route: 'legacy', epoch: page.authority.epoch } });
    } else await assert.rejects(result, /Project Area evidence did not complete/);
    assert.deepEqual(reads, paths);
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /PRIVATE_SENTINEL/);
  });
});
