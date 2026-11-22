import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { experimental_PluginRpcCallError } from '@get-bb/plugin-sdk';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
import { enclosingArea } from '../core/area-presentation.ts';
import { plugin } from '../server.ts';

const firstPublication = '22222222-2222-4222-8222-222222222222';
const nextPublication = '33333333-3333-4333-8333-333333333333';
const authority = { revision: 1, route: 'index', epoch: '11111111-1111-4111-8111-111111111111' };
const available = { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null };
const status = { inventoryBatchVersion: 1, inventoryEvidenceVersion: 1, propertiesAccessVersion: 1,
  vaults: [{ vaultId: 'one', name: 'Fixture', source: available }] };
const mark = (...names: string[]) => names.map(name => ({ name, kind: 'markdown' }));
const dir = (...names: string[]) => names.map(name => ({ name, kind: 'directory' }));
const signal = () => new AbortController().signal;

function fixture(t: TestContext, notes = 240) {
  const calls: Array<{ method: string; input: any }> = [];
  const state = { publication: firstPublication, available: true, partial: false, corrupt: false, staleOnVerify: false,
    capacity: 128, delayMs: 0, oldProducer: false, lightweight: 'available' as 'available' | 'unknown' | 'refused', productionError: false, legacy: false, rootAvailable: true, finalProbe: 0, block: undefined as (() => Promise<void>) | undefined };
  const roots = mark(...Array.from({ length: notes }, (_, i) => `Plan-${i}.md`), 'Pair.md');
  const children: Record<string, Array<{ name: string; kind: string }>> = {
    'Life/Projects': [...dir('Active', 'Pair'), ...roots],
    'Life/Projects/Active': dir('Pilot', 'Empty'),
    'Life/Projects/Active/Pilot': mark('README.md'),
    'Life/Projects/Pair': mark('README.md'),
    'Life/Areas': [...mark('Learning.md'), ...dir('Learning', 'Home')],
  };
  function row(request: any) {
    if (request.kind === 'children') return { kind: request.kind, entries: children[request.folder] ?? [], incomplete: state.partial && request.folder === 'Life/Projects/Active' };
    if (request.kind === 'target') return { kind: request.kind, status: 'matched', matches: [{ path: 'Life/Areas/Learning/Reading.md', kind: 'markdown' }], basename: null, fragment: false, embed: false, incomplete: false };
    const props = request.path.endsWith('README.md') ? { title: 'Pilot title', area: 'Learning/Reading.md', status: 'done' } : {};
    return { kind: request.kind, status: 'observed', properties: props, unsupported: [] };
  }
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'],
    settings: { vaultId: 'one/Life' }, sdk: {
      threads: { updatePluginMetadata: async () => ({}) as any },
      plugins: { callRpc: async ({ method, input }: any) => {
        calls.push({ method, input });
        if (state.delayMs) await delay(state.delayMs);
        if (method === 'inventoryStatus' && state.lightweight !== 'available') {
          const code = state.lightweight === 'unknown' ? 'unknown_method' : 'forbidden';
          throw new experimental_PluginRpcCallError({ code, message: 'status-sentinel' });
        }
        if (method === 'status' || method === 'inventoryStatus') return { ...status, ...(state.oldProducer ? { inventoryBatchVersion: undefined } : {}), vaults: [{ ...status.vaults[0], source: { ...available, local: { available: state.available } } }] };
        if (method === 'vaultLocations') return { vaults: state.rootAvailable ? [{ id: 'one', root: 'Life', name: 'Life' }] : [], incomplete: false };
        const proof = { authority: state.legacy ? { ...authority, route: 'direct' } : authority, publication: state.legacy ? null : state.publication };
        if (method === 'inventoryBatch') {
          if (state.oldProducer) throw new experimental_PluginRpcCallError({ code: 'unknown_method', message: 'old producer' });
          assert.equal(input.root, 'Life');
          if (!state.rootAvailable && !state.legacy) throw new Error('private-root-sentinel');
          const requests = input.requests as any[];
          if (requests.length > state.capacity) {
            const error = { code: 'invalid' as const, message: 'private-capacity-sentinel', issues: [{ path: ['requests'], message: 'output_limit' }] };
            if (state.productionError) throw Object.assign(new Error('private-capacity-sentinel'), { status: 422, body: { ok: false, error } });
            throw new experimental_PluginRpcCallError(error);
          }
          if (requests.length) {
            assert.ok(requests.length <= 128);
            if (state.legacy) throw new experimental_PluginRpcCallError({
              code: 'invalid', message: 'live source', issues: [{ path: ['requests'], message: 'incompatible' }],
            });
            if (input.publication) {
              assert.equal(input.publication, state.publication);
              assert.deepEqual(input.expectedAuthority, authority);
              await state.block?.();
            } else {
              assert.ok(requests.every(request => request.kind === 'children'));
              assert.equal(input.expectedAuthority, undefined);
            }
          } else if (input.publication) {
            state.finalProbe++;
            if (state.staleOnVerify) return { ...proof, publication: nextPublication, rows: [] };
          }
          return { ...proof, rows: requests.map((request, i) => state.corrupt && i === 0 ? row({ kind: 'properties' , path: 'wrong' }) : row(request)) };
        }
        const kind = { inventoryChildren: 'children', inventoryProperties: 'properties', inventoryTarget: 'target' }[method as string];
        assert.ok(kind);
        if (!state.legacy) assert.equal(input.publication, state.publication);
        const { kind: _, ...fields } = row({ kind, ...input });
        return { ...proof, ...fields };
      } }
    }
  });
  t.after(() => host.harness.lifecycle.dispose());
  return { ...host, state, calls, children, backend: new ObsidianBackend(host.bb.sdk, { vaultId: 'one', root: 'Life', folder: 'Projects', areasFolder: 'Areas' }) };
}

const batches = (calls: ReturnType<typeof fixture>['calls']) => calls.filter(call => call.method === 'inventoryBatch' && call.input.requests.length);

test('cold grouped inventory batches existing evidence and warm sidebar and association recheck the publication', async t => {
  const { bb, harness, calls, state } = fixture(t);
  await plugin(bb);
  const coldStart = calls.length;
  const result = await harness.behavior.callRpc('browseInventory', { includeAreas: true }) as Awaited<ReturnType<ObsidianBackend['readBoth']>>;
  const coldCalls = calls.slice(coldStart);
  assert.equal(result.projects.projects.length, 243);
  const pilot = result.projects.projects.find(p => p.id === 'Life/Projects/Active/Pilot/');
  assert.deepEqual(pilot, { id: 'Life/Projects/Active/Pilot/', notePath: 'Life/Projects/Active/Pilot/README.md', status: 'active', title: 'Pilot title', areaId: 'Life/Areas/Learning/Reading.md' });
  assert.equal(enclosingArea(result.areas.areas, pilot!.areaId)?.id, 'Life/Areas/Learning.md');
  assert.ok(result.projects.projects.some(p => p.id === 'Life/Projects/Active/Empty/'));
  const requests = batches(coldCalls).flatMap(call => call.input.requests as Array<{ folder?: string; path?: string }>);
  assert.equal(requests.filter(req => req.folder === 'Life/Areas').length, 1);
  assert.ok(!requests.some(req => req.path === 'Life/Projects/Pair/README.md' || req.folder === 'Life/Projects/Pair'));
  assert.equal(requests.length, 249);
  assert.ok(coldCalls.length <= 12, JSON.stringify(coldCalls.map(({ method }) => method)));
  assert.equal(result.projects.complete && result.areas.complete, true);
  const start = calls.length;
  await harness.behavior.callRpc('browseInventory', { includeAreas: true });
  assert.deepEqual(calls.slice(start).map(call => call.method), ['inventoryStatus', 'inventoryBatch']);
  await harness.behavior.callRpc('associate', { threadId: 't1', project: { source: 'one', id: pilot!.id } });
  assert.deepEqual(calls.slice(start + 2).map(call => call.method), ['inventoryStatus', 'inventoryBatch']);
  const beforeFresh = batches(calls).length;
  await harness.behavior.callRpc('browseInventory', { includeAreas: true, fresh: true });
  assert.ok(batches(calls).length > beforeFresh);
  state.legacy = true;
  const directStart = calls.length;
  const direct = await harness.behavior.callRpc('browseInventory', { includeAreas: true }) as typeof result;
  assert.deepEqual(direct.projects.projects, result.projects.projects);
  assert.deepEqual(direct.areas.areas, result.areas.areas);
  t.diagnostic(`Obsidian calls for 243 projects and 2 Areas: direct ${calls.length - directStart}, indexed cold ${coldCalls.length}, indexed warm 2`);
  state.legacy = false;
  state.rootAvailable = false;
  await assert.rejects(harness.behavior.callRpc('browseInventory', { includeAreas: true }));
  assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-root-sentinel/);
});

test('partial catalogs, drift, malformed rows, and access revocation cannot warm a listing', async t => {
  const { state, calls, backend } = fixture(t, 1);
  state.partial = true;
  const first = await backend.readProjects(signal());
  assert.equal(first.complete, false);
  assert.ok(!first.projects.some(p => p.id.endsWith('/Pilot/') || p.id.endsWith('/Empty/')));
  const partialCalls = batches(calls).length;
  await backend.readProjects(signal());
  assert.ok(batches(calls).length > partialCalls);
  state.partial = false;
  state.staleOnVerify = true;
  await assert.rejects(backend.readProjects(signal()));
  state.staleOnVerify = false;
  state.corrupt = true;
  await assert.rejects(backend.readProjects(signal()));
  state.corrupt = false;
  await backend.readProjects(signal());
  const previous = batches(calls).length;
  state.publication = nextPublication;
  await backend.readProjects(signal());
  assert.ok(batches(calls).length > previous);
  state.available = false;
  await assert.rejects(backend.readProjects(signal()));
});

test('supports proof-bound capacity splitting and live nested-root discovery', async t => {
  const { state, calls, backend } = fixture(t, 3);
  state.capacity = 1;
  state.productionError = true;
  assert.ok((await backend.readProjects(signal())).complete);
  state.legacy = true;
  assert.ok((await backend.readProjects(signal())).complete);
  assert.ok(calls.some(call => call.method === 'vaultLocations'));
  state.rootAvailable = false;
  await assert.rejects(backend.readProjects(signal()));
});

test('an aborted caller cannot cancel another caller sharing the evidence', async t => {
  const { state, calls, backend } = fixture(t, 2);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.block = async () => { enter(); await gate; };
  const first = new AbortController();
  const cancelled = assert.rejects(backend.readProjects(first.signal), /cancelled/);
  await entered;
  const second = backend.readProjects(signal());
  await new Promise<void>(resolve => setImmediate(resolve));
  first.abort();
  await cancelled;
  release();
  assert.equal((await second).projects.length, 5);
  const work = batches(calls).length;
  await backend.readProjects(signal());
  assert.equal(batches(calls).length, work);
});

test('a fresh read bypasses in-flight evidence without cancelling independent readers', async t => {
  const { state, calls, backend } = fixture(t, 2);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.block = async () => { enter(); await gate; };
  const normal = backend.readProjects(signal());
  await entered;
  state.block = undefined;
  const before = batches(calls).length;
  const fresh = await backend.readProjects(signal(), true);
  assert.ok(batches(calls).length > before);
  release();
  assert.deepEqual((await normal).projects, fresh.projects);
  const work = batches(calls).length;
  await backend.readProjects(signal());
  assert.equal(batches(calls).length, work);
});

test('cold combined reads share group waves and finish with one checked publication', async t => {
  const { backend, children, state, calls } = fixture(t, 4);
  const groups = ['Active', 'Deferred', 'Done', 'Someday'];
  children['Life/Projects'].splice(1, 0, ...dir(...groups.slice(1)));
  for (const group of groups.slice(1)) {
    children[`Life/Projects/${group}`] = dir('Folder');
    children[`Life/Projects/${group}/Folder`] = mark('README.md');
  }
  state.delayMs = 12;
  const start = performance.now();
  const result = await backend.readBoth(signal());
  const elapsed = Math.round(performance.now() - start);
  const rounds = batches(calls);
  const mixed = rounds.filter(call => call.input.requests.some((r: any) => /Projects\/(Active|Deferred|Done|Someday)$/.test(r.folder)) &&
    call.input.requests.some((r: any) => /Projects\/(Active|Deferred|Done|Someday)\/[^/]+$/.test(r.folder)));
  t.diagnostic(`Four status groups: ${calls.length} Obsidian calls, ${elapsed} ms with a synthetic 12 ms delay per RPC`);
  assert.equal(calls[0].method, 'inventoryStatus');
  assert.ok(mixed.length >= 3);
  assert.equal(state.finalProbe, 1);
  assert.ok(calls.length <= 10);
  assert.deepEqual(calls[1].input.requests, [
    { kind: 'children', folder: 'Life/Projects' }, { kind: 'children', folder: 'Life/Areas' },
  ]);
  state.legacy = true;
  const oldRoute = await backend.readBoth(signal());
  assert.deepEqual(result.projects.projects, oldRoute.projects.projects);
  assert.deepEqual(result.areas.areas, oldRoute.areas.areas);
});

test('cold combined lightweight negotiation falls back only for a missing method', async t => {
  const { backend, state, calls } = fixture(t, 1);
  state.lightweight = 'unknown';
  state.oldProducer = true;
  state.legacy = true;
  assert.ok((await backend.readBoth(signal())).projects.complete);
  assert.deepEqual(calls.filter(call => call.method === 'inventoryStatus' || call.method === 'status').map(call => call.method), ['inventoryStatus', 'status']);
  const start = calls.length;
  state.oldProducer = false;
  state.lightweight = 'refused';
  await assert.rejects(backend.readBoth(signal()));
  assert.ok(!calls.slice(start).some(call => call.method === 'status'));
});

test('status overlap preserves the global directory bound and immediate traversal precedence', async t => {
  const { backend, children, state, calls } = fixture(t, 0);
  const early = Array.from({ length: 125 }, (_, index) => `Dir-${index}`);
  children['Life/Projects'] = [...dir(...early, 'Done', 'Someday'), ...mark('Root.md')];
  children['Life/Projects/Done'] = dir('Last');
  children['Life/Projects/Someday'] = dir('Too-late');
  const result = await backend.readProjects(signal());
  const requested = batches(calls).flatMap(call => call.input.requests).filter(row => row.kind === 'children');
  assert.equal(requested.length, 128);
  assert.ok(requested.some(row => row.folder === 'Life/Projects/Done/Last'));
  assert.ok(!requested.some(row => row.folder === 'Life/Projects/Someday'));
  assert.ok(result.projects.some(row => row.id === 'Life/Projects/Done/Last/'));
  assert.ok(result.projects.some(row => row.id === 'Life/Projects/Root.md'));
  assert.equal(result.complete, false);
  state.legacy = true;
  const oldRoute = await backend.readProjects(signal());
  assert.deepEqual(result.projects, oldRoute.projects);
});

test('root priming retries only bounded output or direct route refusals', async t => {
  const { backend, calls, state } = fixture(t, 2);
  state.productionError = true;
  state.capacity = 1;
  assert.ok((await backend.readBoth(signal())).projects.complete);
  assert.deepEqual(calls.slice(1, 3).map(call => call.input.requests.length), [2, 0]);
  state.capacity = 128;
  state.legacy = true;
  state.rootAvailable = true;
  const beforeLive = calls.length;
  assert.ok((await backend.readBoth(signal(), true)).areas.complete);
  assert.deepEqual(calls.slice(beforeLive, beforeLive + 4).map(call => call.method), [
    'inventoryStatus', 'inventoryBatch', 'inventoryBatch', 'vaultLocations',
  ]);
  assert.equal(calls[beforeLive + 2].input.requests.length, 0);
});
