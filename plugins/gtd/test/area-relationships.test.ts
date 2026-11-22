import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { ObsidianBackend } from '../adapters/obsidian.ts';
const state = { projectAreasVersion: 1, projectAreasFrontmatterOnly: true, projectAreasDeclarationKey: 'area', propertiesAccessVersion: 1, childrenAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Synthetic', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
const authority = { revision: 1, route: 'index', epoch: '11111111-1111-4111-8111-111111111111' };
const restoredEpoch = '22222222-2222-4222-8222-222222222222';

test('relationship projection batches explicit roots only, preserves IDs and never borrows supporting evidence', async () => {
  const requests: string[][] = []; let page = 0;
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'status') return state;
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Synthetic' }], incomplete: false };
    if (args.method === 'listChildren') return { entries: [], incomplete: false };
    if (args.method === 'listProperties') return { notes: page++ === 0 ? [] : [...Array.from({ length: 51 }, (_, i) => ({ path: `Life/Projects/P${i}.md`, properties: {} })), { path: 'Life/Projects/P0/Notes.md', properties: { areaId: 'wrong' } }, { path: 'Life/Projects/P0/README.md', properties: { areaId: 'wrong' } }, { path: 'Life/Projects/Folder/Notes.md', properties: { areaId: 'wrong' } }, { path: 'Life/Projects/Pilot/README.md', properties: { status: 'deferred' } }], nextCursor: page === 1 ? '12345678-1234-4123-8123-123456789abc' : null, incomplete: false, warnings: [], observedAt: 'now' };
    assert.equal(args.method, 'projectAreasFromFrontmatter'); assert.equal(args.input.root, 'Life'); assert.equal(args.input.areaFolder, 'Life/Areas');
    assert.equal(args.input.declarationKey, 'area');
    assert.deepEqual(args.input.expectedAuthority, requests.length ? authority : undefined);
    requests.push(args.input.paths);
    return { rows: args.input.paths.map((path: string) => ({ path, status: 'resolved', areaId: 'Life/Areas/Work/Consulting.md' })), incomplete: false, authority };
  } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', root: 'Life', folder: 'Projects', areasFolder: 'Areas' });
    const result = await backend.readProjects(new AbortController().signal);
    assert.equal(result.complete, true); assert.deepEqual(requests.map(r => r.length), [50, 2]);
    assert.ok(requests.flat().every(path => !path.endsWith('/Notes.md') && path !== 'Life/Projects/P0/README.md'));
    assert.equal(result.projects.find(p => p.id === 'Life/Projects/P0.md')?.areaId, 'Life/Areas/Work/Consulting.md');
    assert.equal(result.projects.find(p => p.id === 'Life/Projects/Folder/')?.areaId, undefined);
    assert.ok(requests.flat().includes('Life/Projects/Pilot/README.md'));
    assert.deepEqual(result.projects.find(p => p.id === 'Life/Projects/Pilot/'), {
      id: 'Life/Projects/Pilot/', notePath: 'Life/Projects/Pilot/README.md', title: 'Pilot', status: 'deferred',
      areaId: 'Life/Areas/Work/Consulting.md',
    });
  } finally { await host.harness.lifecycle.dispose(); }
});
test('missing, malformed or failing relationship rows never claim complete source coverage or infer assignments', async () => {
  for (const mode of ['missing', 'failure', 'partial', 'unresolved', 'out-of-scope']) {
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return state;
      if (args.method === 'listChildren') return { entries: [], incomplete: false };
      if (args.method === 'listProperties') return { notes: [{ path: 'Projects/Plan.md', properties: { areaId: 'Areas/Old.md' } }], nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
      if (mode === 'failure') throw new Error('PRIVATE_SENTINEL');
      return { rows: mode === 'missing' ? [] : [{ path: 'Projects/Plan.md', ...(mode === 'out-of-scope' ? { status: 'resolved', areaId: 'Other/Area.md' } : { status: 'unresolved' }) }], incomplete: mode === 'partial', authority };
    } } } });
    try {
      const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects', areasFolder: 'Areas' }).readProjects(new AbortController().signal);
      assert.equal(result.complete, mode === 'unresolved'); assert.equal(result.projects[0].areaId, undefined);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});

test('rollback cannot dispatch a body or dual-key resolver, even with earlier batches collected', async t => {
  for (const method of ['projectAreas', 'projectAreasFromFrontmatter'] as const) for (const rollBackAfter of [0, 1]) await t.test(`${method} after ${rollBackAfter} batches`, async t => {
    const historical = createFakePluginHost({ pluginId: 'obsidian' });
    t.after(() => historical.harness.lifecycle.dispose());
    let oldReads = 0;
    const input = z.object({ vaultId: z.string(), root: z.string(), areaFolder: z.string(), paths: z.array(z.string()) }).strict();
    const resolve = () => { oldReads++; return { rows: [{ path: 'Projects/P50.md', status: 'resolved', areaId: 'Areas/FromOldKey.md' }], incomplete: false, authority }; };
    if (method === 'projectAreas') historical.bb.rpc.register(defineRpcContract({ projectAreas: { input, output: z.unknown() } }), { projectAreas: resolve });
    else historical.bb.rpc.register(defineRpcContract({ projectAreasFromFrontmatter: { input: input.extend({ expectedAuthority: z.unknown().optional() }), output: z.unknown() } }), { projectAreasFromFrontmatter: resolve });
    const batches: string[] = [], paths = Array.from({ length: 51 }, (_, i) => `Projects/P${i}.md`);
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return state;
      if (args.method === 'listChildren') return { entries: [], incomplete: false };
      if (args.method === 'listProperties') return { notes: paths.map(path => ({ path, properties: {} })), nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
      batches.push(args.method);
      if (batches.length > rollBackAfter) return historical.harness.behavior.callRpc(args.method, args.input, { experimental_caller: { kind: 'plugin', pluginId: 'gtd' } });
      return { rows: args.input.paths.map((path: string) => ({ path, status: 'resolved', areaId: 'Areas/Example.md' })), incomplete: false, authority };
    } } } });
    t.after(() => host.harness.lifecycle.dispose());
    const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects', areasFolder: 'Areas' }).readProjects(new AbortController().signal);
    assert.deepEqual(batches, Array(rollBackAfter + 1).fill('projectAreasFromFrontmatter'));
    assert.equal(oldReads, 0);
    assert.equal(result.projects.length, 51);
    assert.ok(result.projects.every(project => project.areaId === undefined));
    assert.deepEqual(result.warnings, ['source_partial']);
  });
});

test('a later source refusal or authority mismatch clears earlier assignments, not an isolated omitted row', async t => {
  for (const mode of ['refused', 'revision', 'route', 'restored', 'isolated']) await t.test(mode, async t => {
    const paths = Array.from({ length: 51 }, (_, i) => `Projects/P${i}.md`);
    let batches = 0;
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return state;
      if (args.method === 'listChildren') return { entries: [], incomplete: false };
      if (args.method === 'listProperties') return { notes: paths.map(path => ({ path, properties: {} })), nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
      assert.equal(args.method, 'projectAreasFromFrontmatter');
      assert.equal(args.input.declarationKey, 'area');
      if (++batches === 1) return { rows: args.input.paths.map((path: string) => ({ path, status: 'resolved', areaId: 'Areas/Example.md' })), incomplete: false, authority };
      assert.deepEqual(args.input.expectedAuthority, authority);
      if (mode === 'refused') throw new Error('PRIVATE_SENTINEL');
      return { rows: [mode === 'restored' ? { path: paths[50], status: 'resolved', areaId: 'Areas/New.md' } : { path: paths[50], status: 'unresolved' }], incomplete: mode === 'isolated',
        authority: { revision: mode === 'revision' ? 2 : 1, route: mode === 'route' ? 'legacy' : 'index', epoch: mode === 'restored' ? restoredEpoch : authority.epoch } };
    } } } });
    t.after(() => host.harness.lifecycle.dispose());
    const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects', areasFolder: 'Areas' }).readProjects(new AbortController().signal);
    assert.equal(batches, 2);
    assert.equal(result.complete, false);
    assert.equal(result.projects.filter(project => project.areaId).length, mode === 'isolated' ? 50 : 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  });
});

test('older or unknown Obsidian Area contracts keep projects unassigned with partial coverage', async () => {
  for (const capability of [{ projectAreasVersion: undefined, projectAreasFrontmatterOnly: undefined },
    { projectAreasFrontmatterOnly: undefined }, { projectAreasVersion: 2 },
    { projectAreasDeclarationKey: undefined }, { projectAreasDeclarationKey: 'areaId' }]) {
    let relationshipCalls = 0;
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return { ...state, ...capability };
      if (args.method === 'listChildren') return { entries: [], incomplete: false };
      if (args.method === 'listProperties') return { notes: [{ path: 'Projects/Plan.md', properties: { areaId: 'Areas/Unverified.md' } }], nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
      relationshipCalls++;
      return { rows: [{ path: 'Projects/Plan.md', status: 'resolved', areaId: 'Areas/FromBody.md' }], incomplete: false };
    } } } });
    try {
      const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects', areasFolder: 'Areas' }).readProjects(new AbortController().signal);
      assert.equal(relationshipCalls, 0);
      assert.equal(result.complete, false);
      assert.deepEqual(result.warnings, ['source_partial']);
      assert.deepEqual(result.projects, [{ id: 'Projects/Plan.md', title: 'Plan', status: 'active' }]);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});
