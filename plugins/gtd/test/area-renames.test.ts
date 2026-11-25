import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

const source = 'fixture';
const id = 'Areas/Club.md', destination = 'Areas/Community Club.md';
const fromFolder = 'Areas/Club', toFolder = 'Areas/Community Club';
const input = { source, id, newFilename: 'Community Club.md' };
const notesDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Move = { vaultId: string; operationId: string; path: string; destination: string; outcome: string };
const privateFailure = 'PRIVATE_RENAME_PROVIDER_SENTINEL';

async function setup(paired = false) {
  const notes = new Map<string, Record<string, unknown>>([
    [id, { title: 'Existing title' }], ['Areas/Elsewhere.md', {}],
    ['Projects/Active/Legacy.md', { area: 'Areas/Club.md', keep: 'other property' }],
    ['Projects/Done/Repaired.md', { area: '[[Club|Committee]]' }],
    ['Projects/Unrelated.md', { area: '[[Elsewhere]]' }],
  ]);
  const folders = new Set(['Areas', 'Projects', 'Projects/Active', 'Projects/Done']);
  if (paired) {
    folders.add(fromFolder).add(fromFolder + '/Committee');
    notes.set(fromFolder + '/Committee/Minutes.md', {});
    notes.set('Projects/Nested.md', { area: ['../Areas/Club/Committee/Minutes.md', '[[Areas/Club/Committee/Minutes|Agenda]]'] });
    notes.set('Projects/NestedFolder.md', { area: 'Areas/Club/Committee/' });
  }
  const meta = new Map<string, Record<string, unknown>>([
    ['active', { area: {source, id}, other: 'keep' }], ['archived', { area: {source, id} }],
    ['other', { area: {source, id: 'Areas/Elsewhere.md'} }],
    ['project', { project: {source, id} }],
    ['historical', { area: 'invalid historical reference' }],
  ]);
  const moves: Move[] = [];
  const properties: string[] = [];
  const threads: string[] = [];
  const saves = new Map<string, string>();
  const state = {
    lose: '', receiptHidden: false, refuse: '', setupChange: () => {}, afterNote: () => {}, beforeSave: () => {},
    afterMetadataRead: () => {}, enteredMove: async () => {},
  };
  const host = createFakePluginHost({
    pluginId: 'gtd', agentSkillIds: ['gtd-projects'], settings: { vaultId: source },
    sdk: {
      plugins: { callRpc: async ({ method, input }: any) => {
        if (method === 'vaultLocations') return { vaults: [{ id: source, root: '', name: 'Fixture' }], incomplete: false };
        if (method === 'vaultInventory') return {
          source: { vaultId: source, name: 'Fixture', cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null },
          notes: [...notes].map(([path, properties]) => ({ path, properties, malformed: false })), folders: [...folders], incomplete: false,
        };
        if (method === 'noteEvidence') {
          const note = notes.get(input.path);
          assert.ok(note);
          const result = { hash: notesDigest(note), properties: structuredClone(note), receipt: saves.get(input.operationId) ?? null };
          if (input.path === id) state.setupChange();
          return result;
        }
        if (method === 'movePath') {
          const receipt = { vaultId: input.vaultId, path: input.path, destination: input.destination, operationId: input.operationId, outcome: 'not_moved' };
          assert.ok(!moves.some(move => move.operationId === receipt.operationId), 'No operation replay');
          moves.push(receipt);
          await state.enteredMove();
          if (state.refuse === input.kind) return receipt;
          if (input.kind === 'note') {
            const note = notes.get(input.path);
            if (!note || notesDigest(note) !== input.expectedHash || notes.has(input.destination)) return receipt;
            notes.delete(input.path);
            notes.set(input.destination, note);
            notes.get('Projects/Done/Repaired.md')!.area = '[[Community Club|Committee]]';
            state.afterNote();
          } else {
            assert.ok(folders.has(input.path));
            for (const path of [...folders]) if (path === input.path || path.startsWith(input.path + '/')) {
              folders.delete(path);
              folders.add(input.destination + path.slice(input.path.length));
            }
            for (const [path, note] of notes) if (path.startsWith(input.path + '/')) {
              notes.delete(path);
              notes.set(input.destination + path.slice(input.path.length), note);
            }
          }
          receipt.outcome = 'moved_locally_pending_sync';
          if (state.lose === input.kind) throw new Error(privateFailure);
          return receipt;
        }
        if (method === 'moveReceipt') return state.receiptHidden ? null : moves.find(move => move.operationId === input.operationId) ?? null;
        if (method === 'writeProperties') {
          properties.push(input.path);
          assert.ok(!saves.has(input.operationId), 'No property replay');
          const note = notes.get(input.path);
          assert.ok(note);
          state.beforeSave();
          const outcome = notesDigest(note) === input.expectedHash ? 'saved_locally_pending_sync' : 'not_saved';
          saves.set(input.operationId, outcome);
          if (outcome === 'saved_locally_pending_sync') {
            Object.assign(note, input.set);
            if (state.lose === 'property') throw new Error(privateFailure);
          }
          return { operationId: input.operationId, outcome };
        }
        assert.fail('Unexpected RPC ' + method);
      } },
      threads: {
        list: async args => args?.offset ? [] : [...meta.keys()].filter(thread => !!args?.archived === (thread === 'archived'))
          .map(id => makeThreadResponse({ id, archivedAt: id === 'archived' ? 1 : null })),
        experimental_listPluginMetadata: async ({ threadIds }) => ({ threads: threadIds.map(threadId => ({ threadId, metadata: structuredClone(meta.get(threadId)!) })) }),
        getPluginMetadata: async ({threadId}) => {
          state.afterMetadataRead();
          return structuredClone(meta.get(threadId)!);
        },
        updatePluginMetadata: async ({threadId, set}) => {
          threads.push(threadId);
          const updated = Object.assign(meta.get(threadId)!, set);
          if (state.lose === 'thread') throw new Error(privateFailure);
          return structuredClone(updated);
        },
      },
    },
  });
  await plugin(host.bb);
  const handles = { host };
  return { handles, notes, folders, meta, moves, properties, threads, state,
    async reload() { handles.host = await handles.host.harness.lifecycle.reload(plugin); },
    async rename(args: object = input) {
      const result = await handles.host.harness.behavior.callAgentTool('gtd_rename_area', args);
      assert.ok(typeof result !== 'string');
      const text = (result.content[0] as {text: string}).text;
      assert.ok(!text.includes(privateFailure));
      return JSON.parse(text);
    },
  };
}

test('renames a path Area and its supporting tree, preserving plain, native-repaired and nested assignments', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  // Historical project-change rows play no role in the Area operation.
  f.handles.host.bb.storage.database().prepare('INSERT INTO project_change_plans(id, created, plan) VALUES(?,?,?)')
    .run(randomUUID(), Date.now(), '{}');
  const result = await f.rename();
  assert.equal(result.state, 'renamed');
  assert.equal(result.assignmentsVerified, 4);
  assert.equal(result.threadsVerified, 2);
  assert.deepEqual(f.notes.get(destination), { title: 'Existing title' });
  assert.equal(f.notes.has(id), false);
  assert.equal(f.folders.has(fromFolder), false);
  assert.ok(f.notes.has(toFolder + '/Committee/Minutes.md'));
  assert.deepEqual(f.notes.get('Projects/Active/Legacy.md'), { area: destination, keep: 'other property' });
  assert.equal(f.notes.get('Projects/Done/Repaired.md')?.area, '[[Community Club|Committee]]');
  assert.deepEqual(f.notes.get('Projects/Nested.md')?.area, [
    toFolder + '/Committee/Minutes.md', '[[Areas/Community Club/Committee/Minutes.md|Agenda]]',
  ]);
  assert.equal(f.notes.get('Projects/NestedFolder.md')?.area, toFolder + '/Committee/');
  assert.equal(f.notes.get('Projects/Unrelated.md')?.area, '[[Elsewhere]]');
  assert.ok(!f.properties.includes('Projects/Done/Repaired.md'));
  assert.deepEqual(f.meta.get('active'), {area: {source, id: destination}, other: 'keep'});
  assert.deepEqual(f.meta.get('archived'), {area: {source, id: destination}});
  assert.deepEqual(f.meta.get('project'), {project: {source, id}});
  assert.deepEqual(await f.rename(), result);
  assert.equal(f.moves.length, 2);
  assert.equal(f.threads.length, 2);
});

test('refuses an occupied note/folder, wrong source, nested note, and case-only rename before any write', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.notes.set(destination, {});
  assert.equal((await f.rename()).stage, 'destination');
  f.notes.delete(destination);
  f.folders.add(toFolder.toUpperCase());
  assert.equal((await f.rename()).stage, 'destination');
  f.folders.delete(toFolder.toUpperCase());
  for (const args of [
    {...input, source: 'other'}, {...input, id: fromFolder + '/Committee/Minutes.md'}, {...input, newFilename: 'club.md'},
  ]) assert.equal((await f.rename(args)).state, 'refused');
  assert.equal(f.moves.length, 0);
  assert.equal(f.properties.length + f.threads.length, 0);
});

test('refuses a destination that would change an unrelated basename assignment', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.notes.set('Areas/Other/Community Club.md', {});
  f.notes.set('Projects/Ambiguous.md', {area: '[[Community Club]]'});
  assert.equal((await f.rename()).stage, 'assignments');
  assert.equal(f.moves.length, 0);
});

test('recovers a lost note reply after reload and a lost folder reply without replay', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.state.lose = 'note';
  f.state.receiptHidden = true;
  const entered = await f.rename();
  assert.equal(entered.state, 'unconfirmed');
  const stored = f.handles.host.bb.storage.database().prepare('SELECT scope FROM area_renames WHERE source = ?').get(id);
  assert.deepEqual(stored, {scope: JSON.stringify({
    vaultId: source, projectsFolder: 'Projects', areasFolder: 'Areas', identity: 'legacy',
  })});
  const logs = JSON.stringify(f.handles.host.harness.inspection.logEntries);
  assert.match(logs, /GTD area_rename note_move unconfirmed/);
  assert.doesNotMatch(logs, /PRIVATE_RENAME_PROVIDER_SENTINEL|Areas\/Club/);
  await f.reload();
  assert.equal((await f.rename()).noteOperationId, entered.noteOperationId);
  assert.equal((await f.rename({...input, requestId: randomUUID()})).stage, 'busy');
  assert.equal(f.moves.length, 1);
  f.state.receiptHidden = false;
  f.state.lose = 'folder';
  const partial = await f.rename();
  assert.equal(partial.state, 'partial');
  assert.equal(partial.noteMoveConfirmed, true);
  const resolved = await f.rename();
  assert.equal(resolved.state, 'renamed');
  assert.equal(resolved.folderOperationId, partial.folderOperationId);
  assert.equal(f.moves.length, 2);
});

test('a renewed request can reuse a completed path pair after a round trip', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  const first = await f.rename();
  assert.equal(first.state, 'renamed');
  assert.equal((await f.rename({source, id: destination, newFilename: 'Club.md'})).state, 'renamed');
  assert.equal((await f.rename()).state, 'historical');
  assert.equal(f.moves.length, 2);
  assert.ok(f.notes.has(id));
  const renewed = {...input, requestId: randomUUID()};
  const third = await f.rename(renewed);
  assert.equal(third.state, 'renamed');
  assert.notEqual(third.noteOperationId, first.noteOperationId);
  assert.deepEqual(await f.rename(renewed), third);
  assert.equal(f.moves.length, 3);
  assert.equal(f.notes.has(id), false);
  assert.deepEqual(f.meta.get('archived')?.area, {source, id: destination});
});

test('recovers lost assignment and thread replies by reading back the same operations', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.state.lose = 'property';
  assert.equal((await f.rename()).stage, 'assignments');
  f.state.lose = 'thread';
  assert.equal((await f.rename()).stage, 'threads');
  await f.reload();
  f.state.lose = '';
  assert.equal((await f.rename()).state, 'renamed');
  assert.deepEqual(f.properties, ['Projects/Active/Legacy.md']);
  assert.deepEqual(f.threads, ['active', 'archived']);
  assert.equal(f.moves.length, 1);
});

test('reports an Obsidian note refusal separately from a folder refusal after a confirmed move', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.state.refuse = 'note';
  assert.equal((await f.rename()).state, 'refused');
  f.state.refuse = 'folder';
  const partial = await f.rename();
  assert.equal(partial.state, 'partial');
  assert.equal(partial.folderOperationId, f.moves.at(-1)?.operationId);
  f.state.refuse = '';
  assert.equal((await f.rename()).state, 'renamed');
  assert.equal(f.moves.filter(move => move.path === id).length, 2);
  assert.equal(f.moves.filter(move => move.path === fromFolder).length, 2);
});

test('uses Obsidian CAS and does not overwrite a concurrent assignment edit', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.state.beforeSave = () => { f.notes.get('Projects/Active/Legacy.md')!.area = 'Areas/Elsewhere.md'; };
  assert.equal((await f.rename()).state, 'partial');
  assert.equal((await f.rename()).stage, 'assignments');
  assert.equal(f.notes.get('Projects/Active/Legacy.md')?.area, 'Areas/Elsewhere.md');
  assert.equal(f.properties.length, 1);
  assert.equal(f.threads.length, 0);
});

test('refuses a stale Area note version and holds a new folder collision after the note move', async t => {
  const f = await setup(true);
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.state.setupChange = () => { f.notes.get(id)!.title = 'Independent edit'; };
  assert.equal((await f.rename()).state, 'refused');
  assert.equal(f.notes.get(id)?.title, 'Independent edit');
  f.state.setupChange = () => {};
  f.state.afterNote = () => { f.folders.add(toFolder); };
  const partial = await f.rename();
  assert.equal(partial.stage, 'folder_move');
  assert.equal(partial.state, 'partial');
  assert.ok(f.folders.has(fromFolder));
  assert.equal(f.moves.filter(move => move.path === fromFolder).length, 0);
  f.folders.delete(toFolder);
  assert.equal((await f.rename()).state, 'renamed');
  assert.equal(f.notes.get(destination)?.title, 'Independent edit');
});

test('checks the current thread association immediately before writing', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  f.state.afterMetadataRead = () => { f.meta.get('active')!.area = {source, id: 'Areas/Elsewhere.md'}; };
  assert.equal((await f.rename()).stage, 'threads');
  assert.equal(f.threads.length, 0);
  assert.deepEqual(f.meta.get('active')?.area, {source, id: 'Areas/Elsewhere.md'});
});

test('serializes overlapping requests while a different Area can proceed', async t => {
  const f = await setup();
  t.after(() => f.handles.host.harness.lifecycle.dispose());
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.state.enteredMove = async () => { f.state.enteredMove = async () => {}; entered(); await blocked; };
  const original = f.rename();
  await started;
  try {
    assert.equal((await f.rename()).stage, 'busy');
    assert.equal((await f.rename({...input, newFilename: 'Different.md'})).stage, 'busy');
    assert.equal((await f.rename({source, id: 'Areas/Elsewhere.md', newFilename: 'Separate.md'})).state, 'renamed');
  } finally { release(); }
  assert.equal((await original).state, 'renamed');
});
