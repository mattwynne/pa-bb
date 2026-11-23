import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
const authority = { revision: 1, route: 'index', epoch: '11111111-1111-4111-8111-111111111111' };
const publication = '22222222-2222-4222-8222-222222222222';
const status = { inventoryEvidenceVersion: 1, propertiesAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Fixture', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
test('partial catalogs and malformed sibling notes cannot establish a folder-only project', async t => {
  for (const mode of ['clipped', 'malformed', 'publication']) await t.test(mode, async t => {
    const paths: string[] = []; let childCalls = 0;
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return status;
      assert.ok(args.method.startsWith('inventory'));
      const proof = { authority, publication };
      if (args.method === 'inventoryChildren') {
        childCalls++;
        if (mode === 'publication' && childCalls > 1) return { ...proof, publication: '33333333-3333-4333-8333-333333333333', entries: [], incomplete: false };
        assert.equal(args.input.folder, 'Projects');
        return { ...proof, entries: [{ name: 'Confirmed.md', kind: 'markdown' }, { name: 'Pair', kind: 'directory' }, ...(mode === 'malformed' ? [{ name: 'Pair.md', kind: 'markdown' }] : [])], incomplete: mode === 'clipped' };
      }
      assert.equal(args.method, 'inventoryProperties');
      paths.push(args.input.path);
      return { ...proof, status: args.input.path === 'Projects/Pair.md' ? 'partial' : 'observed', properties: {}, unsupported: [] };
    } } } });
    t.after(() => host.harness.lifecycle.dispose());
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' });
    if (mode === 'publication') await assert.rejects(backend.readProjects(new AbortController().signal));
    else {
      const snapshot = await backend.readProjects(new AbortController().signal);
      assert.deepEqual(snapshot.projects.map(p => p.id), ['Projects/Confirmed.md']);
      assert.equal(snapshot.complete, false);
      assert.ok(!paths.some(path => path.endsWith('/README.md')));
    }
  });
});
