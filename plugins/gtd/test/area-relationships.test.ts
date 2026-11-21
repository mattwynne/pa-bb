import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
const state = { projectAreasVersion: 1, propertiesAccessVersion: 1, childrenAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Synthetic', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
test('relationship projection batches explicit roots only, preserves IDs and never borrows supporting evidence', async () => {
  const requests: string[][] = []; let page = 0;
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'status') return state;
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Synthetic' }], incomplete: false };
    if (args.method === 'listChildren') return { entries: [], incomplete: false };
    if (args.method === 'listProperties') return { notes: page++ === 0 ? [] : [...Array.from({ length: 51 }, (_, i) => ({ path: `Life/Projects/P${i}.md`, properties: {} })), { path: 'Life/Projects/P0/Notes.md', properties: { areaId: 'wrong' } }, { path: 'Life/Projects/Folder/Notes.md', properties: { areaId: 'wrong' } }], nextCursor: page === 1 ? '12345678-1234-4123-8123-123456789abc' : null, incomplete: false, warnings: [], observedAt: 'now' };
    assert.equal(args.method, 'projectAreas'); assert.equal(args.input.root, 'Life'); assert.equal(args.input.areaFolder, 'Life/Areas');
    requests.push(args.input.paths);
    return { rows: args.input.paths.map((path: string) => ({ path, status: 'resolved', areaId: 'Life/Areas/Work/Consulting.md' })), incomplete: false };
  } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', root: 'Life', folder: 'Projects', areasFolder: 'Areas' });
    const result = await backend.readProjects(new AbortController().signal);
    assert.equal(result.complete, true); assert.deepEqual(requests.map(r => r.length), [50, 1]);
    assert.ok(requests.flat().every(path => !path.endsWith('/Notes.md')));
    assert.equal(result.projects.find(p => p.id === 'Life/Projects/P0.md')?.areaId, 'Life/Areas/Work/Consulting.md');
    assert.equal(result.projects.find(p => p.id === 'Life/Projects/Folder/')?.areaId, undefined);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('missing, malformed or failing relationship rows never claim complete source coverage or infer assignments', async () => {
  for (const mode of ['missing', 'failure', 'partial', 'unresolved']) {
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return state;
      if (args.method === 'listChildren') return { entries: [], incomplete: false };
      if (args.method === 'listProperties') return { notes: [{ path: 'Projects/Plan.md', properties: { areaId: 'Areas/Old.md' } }], nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
      if (mode === 'failure') throw new Error('PRIVATE_SENTINEL');
      return { rows: mode === 'missing' ? [] : [{ path: 'Projects/Plan.md', status: 'unresolved' }], incomplete: mode === 'partial' };
    } } } });
    try {
      const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects', areasFolder: 'Areas' }).readProjects(new AbortController().signal);
      assert.equal(result.complete, mode === 'unresolved'); assert.equal(result.projects[0].areaId, undefined);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});
