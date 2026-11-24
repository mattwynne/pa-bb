import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

const source = 'one', owner = 'Projects/Example.md', done = 'Projects/Done/Example.md';
const area = 'Areas/Work/Example.md';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Receipt = { vaultId: string; path: string; destination: string; operationId: string; outcome: string; identity?: object; legacy?: unknown };

async function setup(paired = false) {
  const docs = new Map<string, Record<string, unknown>>([[owner, { title: 'Example', area: '../Areas/Work/Example.md' }], [area, {}]]);
  const folders = new Set(['Projects', 'Projects/Active', 'Projects/Done', 'Projects/Deferred', 'Areas', 'Areas/Work']);
  if (paired) folders.add(owner.slice(0, -3));
  const meta = { project: { source, id: owner }, other: 'unchanged' };
  const history: Array<{ method: string; input: any }> = [];
  const moves = new Map<string, Receipt>();
  const saves = new Map<string, string>();
  let lostMove: string | undefined, loseThreads = false, archiveFails = false, hideReceipt = false;
  let writes = 0, archived = false;
  const fixture = createFakePluginHost({
    pluginId: 'gtd', agentSkillIds: ['gtd-projects'], settings: { vaultId: source },
    sdk: {
      plugins: { callRpc: async ({ method, input }: any) => {
        history.push({ method, input });
        if (method === 'vaultLocations') return { vaults: [{ id: source, root: '', name: 'Fixture' }], incomplete: false };
        if (method === 'status') return { vaults: [{ vaultId: source, name: 'Fixture', source: {
          local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null,
        } }] };
        if (method === 'vaultInventory') {
          const under = (path: string) => !input.folders?.length ||
            input.folders.some((dir: string) => path === dir || path.startsWith(dir + '/'));
          return { notes: [...docs].filter(([path]) => under(path)).map(([path, properties]) => ({
            path, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => input.fields.includes(key))), malformed: false,
          })), folders: [...folders].filter(under), incomplete: false };
        }
        if (method === 'noteEvidence') {
          const note = docs.get(input.path);
          assert.ok(note, 'Note exists');
          return { hash: digest(note), properties: structuredClone(note), receipt: saves.get(input.operationId) ?? null };
        }
        if (method === 'writeProperties') {
          const note = docs.get(input.path);
          assert.ok(note, 'Note exists');
          const operationId = input.operationId ?? randomUUID();
          assert.ok(!saves.has(operationId));
          const outcome = input.expectedHash === digest(note) ? 'saved_locally_pending_sync' : 'not_saved';
          if (outcome === 'saved_locally_pending_sync') {
            Object.assign(note, input.set);
            for (const key of input.remove ?? []) delete note[key];
          }
          saves.set(operationId, outcome);
          return { operationId, outcome };
        }
        if (method === 'movePath') {
          const { vaultId, path, destination, operationId, kind, expectedHash } = input;
          assert.ok(!moves.has(operationId));
          const entry = docs.get(path);
          const receipt = { vaultId, path, destination, operationId, outcome: 'not_moved', identity: entry };
          if (!folders.has(destination) && !docs.has(destination)) {
            if (kind === 'note' && entry && digest(entry) === expectedHash) {
              docs.delete(path);
              docs.set(destination, entry);
              receipt.outcome = 'moved_locally_pending_sync';
            } else if (kind === 'folder' && folders.delete(path)) {
              folders.add(destination);
              receipt.outcome = 'moved_locally_pending_sync';
            }
          }
          moves.set(operationId, receipt);
          if (lostMove === kind) throw new Error('PRIVATE_LOST_REPLY');
          return receipt;
        }
        if (method === 'moveReceipt') {
          const receipt = moves.get(input.operationId);
          if (receipt && hideReceipt) throw new Error('PRIVATE_RECEIPT_UNAVAILABLE');
          if (!receipt || !receipt.identity || receipt.outcome !== 'moved_locally_pending_sync') return receipt ?? null;
          return { ...receipt, outcome: docs.get(receipt.destination) === receipt.identity && !docs.has(receipt.path)
            ? receipt.outcome : 'uncertain' };
        }
        assert.fail('Unexpected RPC ' + method);
      } },
      threads: {
        list: async (a) => a?.offset || !!a?.archived !== archived ? [] : [makeThreadResponse({ id: 'linked', visibility: 'hidden', archivedAt: archived ? 1 : null })],
        archive: async () => {
          if (archiveFails) throw new Error('PRIVATE_ARCHIVE_SENTINEL');
          archived = true;
          return { ok: true, archivedThreadIds: ['linked'] };
        },
        experimental_listPluginMetadata: async () => ({ threads: [{ threadId: 'linked', metadata: structuredClone(meta) }] }),
        getPluginMetadata: async () => structuredClone(meta),
        updatePluginMetadata: async (a: any) => {
          meta.project = a.set.project;
          writes++;
          if (loseThreads) throw new Error('PRIVATE_THREAD_REPLY');
          return meta;
        },
      },
    },
  });
  const handles = { host: fixture };
  await plugin(fixture.bb);
  return {
    handles, docs, folders, meta, history, moves, writes: () => writes, archived: () => archived,
    loseMove: (kind: string) => { lostMove = kind; },
    hideReceipt: (value: boolean) => { hideReceipt = value; },
    loseThreadWrite: () => { loseThreads = true; },
    failArchive: (value: boolean) => { archiveFails = value; },
    reload: async () => { handles.host = await handles.host.harness.lifecycle.reload(plugin); },
    async tool(name: string, input: object, expectedError = false) {
      const result = await handles.host.harness.behavior.callAgentTool(name, input, { threadId: 'operator' });
      assert.ok(typeof result !== 'string');
      assert.equal(!!result.isError, expectedError, JSON.stringify(result));
      if (expectedError) return result;
      return JSON.parse((result.content[0] as { text: string }).text);
    },
  };
}

test('a direct move preserves a relative Area, finishes a companion step, and updates the captured conversation', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.loseMove('note');
  f.hideReceipt(true);
  const entered = await f.tool('gtd_change_project', { source, id: owner, status: 'done' });
  assert.equal(entered.state, 'unconfirmed');
  assert.equal(f.meta.project.id, owner);
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 1);
  await f.reload();
  f.hideReceipt(false);
  assert.equal((await f.tool('gtd_check_project_change', { planId: entered.planId })).state, 'move_not_verified');
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 1);
  const result = await f.tool('gtd_check_project_change', { planId: entered.planId, finishLinks: true });
  assert.equal(result.state, 'links_verified');
  assert.equal(f.meta.project.id, done);
  assert.equal(f.meta.other, 'unchanged');
  assert.deepEqual(f.docs.get(done), { title: 'Example', area });
  assert.equal(f.folders.has(done.slice(0, -3)), true);
  const dispatches = f.history.filter(call => call.method === 'movePath');
  assert.deepEqual(dispatches.map(call => call.input.kind), ['note', 'folder']);
  assert.ok(dispatches.every(call => !Object.hasOwn(call.input, 'dryRun')));
  assert.equal(f.history.filter(call => call.method === 'writeProperties').length, 1);
  assert.equal(f.writes(), 1);
  assert.doesNotMatch(JSON.stringify(f.handles.host.harness.inspection.logEntries), /PRIVATE_LOST_REPLY/);
  await f.reload();
  const checked = await f.tool('gtd_check_project_change', { planId: entered.planId, finishLinks: true });
  assert.equal(checked.state, 'links_verified');
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 2);
  assert.equal(f.writes(), 1);
});

test('a replaced destination blocks conversation changes and never dispatches again', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.loseThreadWrite();
  const result = await f.tool('gtd_change_project', { source, id: owner, status: 'done' });
  assert.equal(result.state, 'unconfirmed');
  await f.reload();
  f.docs.set(done, structuredClone(f.docs.get(done)!));
  const checked = await f.tool('gtd_check_project_change', { planId: result.planId, finishLinks: true });
  assert.equal(checked.state, 'move_not_verified');
  assert.equal(checked.moveOutcome, 'uncertain');
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 1);
  assert.equal(f.writes(), 1);
});

test('a historical paired plan is inspected only through its original move receipt', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  const planId = randomUUID();
  f.docs.set(done, { title: 'Example', area });
  f.docs.delete(owner);
  f.folders.delete(owner.slice(0, -3)); f.folders.add(done.slice(0, -3));
  f.moves.set(planId, { vaultId: source, path: owner, destination: done, operationId: planId,
    outcome: 'moved_locally_pending_sync', legacy: { paired: true, outcome: 'moved_supported_links_updated' } });
  const config = { vaultId: source, projectsFolder: 'Projects', areasFolder: 'Areas' };
  f.handles.host.bb.storage.database().prepare('INSERT INTO project_change_plans (id,created,plan) VALUES (?,?,?)')
    .run(planId, Date.now(), JSON.stringify({ config, source, id: owner, owner, destination: done,
      expectedHash: digest({ title: 'Example' }), project: 'paired', status: 'done', originalArea: area, threads: ['linked'] }));
  const result = await f.tool('gtd_check_project_change', { planId, finishLinks: true });
  assert.equal(result.state, 'links_verified');
  assert.equal(f.meta.project.id, done);
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 0);
});

test('Area browsing, preview, version-checked assignment, clear, and failed-write readback use generic calls', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  let result = await f.tool('gtd_browse_area_targets', { folder: 'Areas/Work' });
  assert.deepEqual(result.entries, [{ path: area, kind: 'note' }]);
  const prepared = await f.tool('gtd_prepare_project_change', {
    source, id: owner, expectedHash: digest(f.docs.get(owner)), areaPath: null,
  });
  assert.equal(prepared.state, 'prepared');
  f.docs.get(owner)!.title = 'Concurrent';
  result = await f.tool(prepared.next.tool, prepared.next.input);
  assert.equal(result.state, 'not_verified');
  assert.equal(f.docs.get(owner)!.area, '../Areas/Work/Example.md');
  result = await f.tool('gtd_change_project', { source, id: owner, areaPath: area });
  assert.equal(result.state, 'verified');
  assert.equal(f.docs.get(owner)!.area, area);
  result = await f.tool('gtd_change_project', { source, id: owner, areaPath: null });
  assert.equal(result.state, 'verified');
  assert.equal(Object.hasOwn(f.docs.get(owner)!, 'area'), false);
});

test('deferral moves directly, verifies the date, and uses the current ID for later changes', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  const result = await f.tool('gtd_defer_project', { id: owner, deferUntil: '2026-12-01' });
  assert.equal(result.state, 'deferred');
  assert.equal(result.dateVerified, true);
  assert.equal(f.docs.get(result.id)!['defer-until'], '2026-12-01');
  assert.equal(f.meta.project.id, result.id);
  assert.equal((await f.tool('gtd_defer_project', { id: owner, deferUntil: '2026-12-01' })).state, 'deferred');
  const changed = await f.tool('gtd_defer_project', { id: result.id, deferUntil: '2026-12-02' });
  assert.equal(changed.dateVerified, true);
  assert.equal(f.docs.get(result.id)!['defer-until'], '2026-12-02');
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 1);
});

test('panel completion archives the verified linked thread and can finish after an archive failure', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.failArchive(true);
  let result: any = await f.handles.host.harness.behavior.callRpc('changeProject', { source, id: owner, change: { kind: 'done' } });
  assert.equal(result.state, 'partial');
  assert.equal(f.meta.project.id, done);
  assert.equal(f.archived(), false);
  f.failArchive(false);
  result = await f.handles.host.harness.behavior.callRpc('changeProject', { source, id: done, change: { kind: 'done' } });
  assert.equal(result.state, 'done');
  assert.equal(f.archived(), true);
  assert.doesNotMatch(JSON.stringify(f.handles.host.harness.inspection.logEntries), /PRIVATE_ARCHIVE_SENTINEL/);
});
