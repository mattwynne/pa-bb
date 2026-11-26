import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { projectChanges } from '../core/project-changes.ts';

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
  const saves = new Map<string, { outcome: string; path: string; before: object; after: object }>();
  let lostProperty: string | undefined;
  let lostMove: string | undefined, loseThreads = false, archiveFails = false, hideReceipt = false;
  let writes = 0, archived = false, incomplete = false;
  const fixture = createFakePluginHost({
    pluginId: 'gtd', agentSkillIds: ['gtd-projects'], settings: { vaultId: source },
    sdk: {
      plugins: { callRpc: async ({ method, input }: any) => {
        history.push({ method, input });
        if (method === 'vaultLocations') return { vaults: [{ id: source, root: '', name: 'Fixture' }], incomplete: false };
        if (method === 'vaultInventory') {
          const under = (path: string) => !input.folders ||
            input.folders.some((dir: string) => path === dir || path.startsWith(dir + '/'));
          return {
            source: { vaultId: source, name: 'Fixture', cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null },
            notes: [...docs].filter(([path]) => under(path)).map(([path, properties]) => ({
            path, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => input.fields.includes(key))), malformed: false,
          })), folders: [...folders].filter(under), incomplete };
        }
        if (method === 'noteEvidence') {
          const note = docs.get(input.path);
          assert.ok(note, 'Note exists');
          return { hash: digest(note), properties: structuredClone(note), receipt: saves.get(input.operationId)?.outcome ?? null };
        }
        if (method === 'writeProperties') {
          const note = docs.get(input.path);
          assert.ok(note, 'Note exists');
          const operationId = input.operationId ?? randomUUID();
          assert.ok(!saves.has(operationId));
          const outcome = input.expectedHash === digest(note) ? 'saved_locally_pending_sync' : 'not_saved';
          const next = { ...note };
          if (outcome === 'saved_locally_pending_sync') {
            Object.assign(next, input.set);
            for (const key of input.remove ?? []) delete next[key];
            docs.set(input.path, next);
          }
          saves.set(operationId, { outcome, path: input.path, before: note, after: next });
          if (lostProperty && outcome === 'saved_locally_pending_sync' &&
              (Object.hasOwn(input.set ?? {}, lostProperty) || input.remove?.includes(lostProperty)))
            throw new Error('PRIVATE_LOST_SAVE_REPLY');
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
          let current = receipt.identity;
          for (const save of saves.values()) {
            if (save.outcome === 'saved_locally_pending_sync' && save.path === receipt.destination && save.before === current)
              current = save.after;
          }
          return { ...receipt, outcome: docs.get(receipt.destination) === current && !docs.has(receipt.path)
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
    losePropertySave: (key: string) => { lostProperty = key; },
    hideReceipt: (value: boolean) => { hideReceipt = value; },
    setIncomplete: (value: boolean) => { incomplete = value; },
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

test('a versioned migration move establishes the folder classification before status cleanup', async t => {
  for (const [legacy, status, folder] of [
    ['completed', 'done', 'Completed'], ['done', 'done', 'Done'],
    ['deferred', 'deferred', 'Deferred'], ['someday', 'someday', 'Someday'],
  ]) {
    await t.test(legacy, async t => {
      const f = await setup(true);
      t.after(() => f.handles.host.harness.lifecycle.dispose());
      const destination = `Projects/${folder}/Example.md`;
      if (folder === 'Completed') f.folders.delete('Projects/Done');
      f.folders.add(`Projects/${folder}`);
      const before = f.docs.get(owner)!;
      before.status = legacy;
      before.keep = 'unrelated value';
      const prepare = { source, id: owner, expectedHash: digest(before), status };
      const plan = await f.tool('gtd_prepare_project_change', prepare);
      assert.equal(plan.destination, destination);
      assert.equal(plan.previousArea, area);
      assert.equal(plan.linkedThreads, 1);

      const result = await f.tool(plan.next.tool, plan.next.input);
      assert.equal(result.state, 'links_verified');
      assert.equal(f.docs.has(owner), false);
      assert.equal(f.folders.has(destination.slice(0, -3)), true);
      assert.equal(f.meta.project.id, destination);
      assert.equal(f.archived(), false);
      // Model the subsequent versioned Obsidian property removal in the file fixture.
      const { status: storedStatus, ...cleaned } = f.docs.get(destination)!;
      assert.equal(storedStatus, legacy);
      assert.deepEqual(cleaned, { title: 'Example', area, keep: 'unrelated value' });
      f.docs.set(destination, cleaned);
      const listing = await f.tool('gtd_list_projects', { status });
      assert.equal(listing.coverage, 'complete');
      assert.deepEqual(listing.projects, [{ id: destination, title: 'Example', areaId: area, status }]);
    });
  }
});

test('migration preview blocks on partial coverage, missing or ambiguous status folders, and path collisions', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  const before = f.docs.get(owner)!;
  before.status = 'completed';
  const prepare = { source, id: owner, expectedHash: digest(before), status: 'done' };
  const refuses = async (message: RegExp) => {
    const result = await f.tool('gtd_prepare_project_change', prepare, true);
    assert.match(result.content[0].text, message);
  };
  f.setIncomplete(true);
  await refuses(/Complete project and ownership evidence/);
  f.setIncomplete(false);
  f.folders.delete('Projects/Done');
  await refuses(/Create a Done folder/);
  f.folders.add('Projects/Done');
  f.folders.add('Projects/Completed');
  await refuses(/duplicate Done folders/);
  f.folders.delete('Projects/Completed');
  f.folders.add(done.slice(0, -3));
  await refuses(/Destination note or support folder already exists/);
  assert.equal(f.history.some(call => call.method === 'movePath' || call.method === 'writeProperties'), false);
  assert.equal(f.docs.get(owner)?.status, 'completed');
  assert.equal(f.meta.project.id, owner);
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
    outcome: 'moved_locally_pending_sync', legacy: { paired: true, expectedHash: digest({ title: 'Example' }), outcome: 'moved_supported_links_updated' } });
  const config = { vaultId: source, projectsFolder: 'Projects', areasFolder: 'Areas' };
  f.handles.host.bb.storage.database().prepare('INSERT INTO project_change_plans (id,created,plan) VALUES (?,?,?)')
    .run(planId, Date.now(), JSON.stringify({ config, source, id: owner, owner, destination: done,
      expectedHash: digest({ title: 'Example' }), project: 'paired', status: 'done', originalArea: area, threads: ['linked'] }));
  const receipt = f.moves.get(planId)!;
  f.moves.set(planId, { ...receipt, legacy: { paired: true, expectedHash: digest({ wrong: true }), outcome: 'moved_supported_links_updated' } });
  await f.tool('gtd_check_project_change', { planId, finishLinks: true }, true);
  assert.equal(f.writes(), 0);
  f.moves.set(planId, receipt);
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

test('a saved deferral date survives reply loss and reload after replacing the moved file', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.losePropertySave('defer-until');
  const first = await f.tool('gtd_defer_project', { id: owner, deferUntil: '2026-12-01' });
  assert.equal(first.state, 'date_unconfirmed');
  assert.equal(f.docs.get(first.id)!['defer-until'], '2026-12-01');
  const move = f.moves.get(first.moveOperationId);
  assert.notEqual(f.docs.get(first.id), move?.identity);
  await f.reload();
  const result = await f.tool('gtd_defer_project', { id: owner, deferUntil: '2026-12-01' });
  assert.equal(result.state, 'deferred');
  assert.equal(result.dateVerified, true);
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 1);
  assert.equal(f.history.filter(call => call.method === 'writeProperties' && call.input.set?.['defer-until']).length, 1);
  f.docs.set(first.id, { ...f.docs.get(first.id)! });
  const replaced = await f.tool('gtd_defer_project', { id: owner, deferUntil: '2026-12-01' });
  assert.equal(replaced.dateVerified, undefined);
  assert.notEqual(replaced.state, 'deferred');
});

test('automatic reactivation settles a saved date removal across reload without reissuing the write', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  const deferred = 'Projects/Deferred/Example.md', active = 'Projects/Active/Example.md';
  f.docs.delete(owner);
  f.docs.set(deferred, { area, 'defer-until': '2026-11-24' });
  f.meta.project.id = deferred;
  f.losePropertySave('defer-until');
  const run = () => projectChanges(f.handles.host.bb,
    async () => ({ vaultId: source, projectsFolder: 'Projects', areasFolder: 'Areas', automaticReactivation: true }),
    () => Date.parse('2026-11-24T16:00:00Z')).reactivate(new AbortController().signal, true);
  await run();
  assert.equal(f.meta.project.id, active);
  assert.equal(Object.hasOwn(f.docs.get(active)!, 'defer-until'), false);
  assert.ok(f.handles.host.bb.storage.database().prepare('SELECT 1 FROM project_reactivations').get());
  await f.reload();
  await run();
  assert.equal(f.handles.host.bb.storage.database().prepare('SELECT 1 FROM project_reactivations').get(), undefined);
  assert.equal(f.history.filter(call => call.method === 'movePath').length, 1);
  assert.equal(f.history.filter(call => call.method === 'writeProperties' && call.input.remove?.includes('defer-until')).length, 1);
});

test('panel completion archives the verified linked thread and can finish after an archive failure', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.failArchive(true);
  let result: any = await f.handles.host.harness.behavior.callRpc('changeProject', { source, id: owner, change: { kind: 'done' } });
  assert.equal(result.state, 'partial');
  assert.equal(result.movedToDone, true);
  assert.equal(f.meta.project.id, done);
  assert.equal(f.archived(), false);
  f.failArchive(false);
  result = await f.handles.host.harness.behavior.callRpc('changeProject', { source, id: done, change: { kind: 'done' } });
  assert.equal(result.state, 'done');
  assert.equal(result.movedToDone, undefined);
  assert.equal(f.archived(), true);
  assert.doesNotMatch(JSON.stringify(f.handles.host.harness.inspection.logEntries), /PRIVATE_ARCHIVE_SENTINEL/);
});

test('panel rename preserves project status, Area, companion folder, and linked conversations', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.docs.get(owner)!.status = 'someday';
  const renamed = 'Projects/New name.md';
  const rename = () => f.handles.host.harness.behavior.callRpc('changeProject', {
    source, id: owner, change: { kind: 'rename', name: 'New name' },
  });
  f.folders.add('Projects/New name');
  assert.deepEqual(await rename(), { state: 'blocked', message: 'Destination note or support folder already exists.' });
  assert.equal(f.moves.size, 0);
  f.folders.delete('Projects/New name');
  assert.deepEqual(await rename(), { state: 'renamed', id: renamed, message: 'Project renamed in Obsidian.' });
  assert.equal(f.docs.has(owner), false);
  assert.deepEqual(f.docs.get(renamed), { title: 'Example', area: '../Areas/Work/Example.md', status: 'someday' });
  assert.equal(f.folders.has('Projects/Example'), false);
  assert.equal(f.folders.has('Projects/New name'), true);
  assert.deepEqual(f.meta.project, { source, id: renamed });
  assert.equal(f.archived(), false);
});
