import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { stableIds } from '../core/identity.ts';

const source = 'fixture';
const oldProject = 'Projects/Renew permits.md';
const oldArea = 'Areas/Administration.md';
const folders = ['Projects', 'Projects/Done', 'Areas'];
const hash = (props: object) => createHash('sha256').update(JSON.stringify(props)).digest('hex');

async function fixture() {
  const docs = new Map<string, Record<string, unknown>>([[oldProject, { area: oldArea, status: 'active' }], [oldArea, {}]]);
  const metadata = new Map<string, Record<string, unknown>>([
    ['active-project', { project: { source, id: oldProject }, unrelated: 'keep' }],
    ['archived-project', { project: { source, id: oldProject }, unrelated: 'archived' }],
    ['archived-area', { area: { source, id: oldArea }, unrelated: 'area' }],
  ]);
  const saveReceipts = new Map<string, string>();
  const moveReceipts = new Map<string, object>();
  const writes = { notes: 0, metadata: 0, spawns: 0, moves: 0, inventories: 0 };
  const faults = { note: false, area: false, move: false, thread: false, spawn: false, access: false };
  const creationThread = 'created';
  const sdk = {
    plugins: { callRpc: async ({method, input}: any) => {
      if (method === 'vaultLocations') return {vaults:[{id:source,root:'',name:'Generated'}],incomplete:false};
      assert.equal(input.vaultId, source);
      if (faults.access) throw new Error('PRIVATE_PROVIDER_DATA');
      if (method === 'vaultInventory') {
        writes.inventories++;
        const provenance = { vaultId: source, name: 'Generated', cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null };
        const include = (path: string) => !input.folders || input.folders.some((folder: string) => path === folder || path.startsWith(folder + '/'));
        return { source: provenance, folders: folders.filter(include), incomplete: false,
          notes: [...docs].filter(([path]) => include(path)).map(([path, props]) => ({path,
            properties: Object.fromEntries(Object.entries(props).filter(([key]) => input.fields.includes(key))), malformed: false })) };
      }
      if (method === 'moveReceipt') return moveReceipts.get(input.operationId) ?? null;
      const note = docs.get(input.path);
      assert.ok(note);
      if (method === 'noteEvidence') return { hash: hash(note), properties: structuredClone(note), receipt: saveReceipts.get(input.operationId) ?? null };
      if (method === 'readNoteSection') return { hash: hash(note), text: String(note.standard ?? '') };
      if (method === 'writeNoteSection') {
        assert.equal(input.expectedHash, hash(note));
        note.standard = input.text;
        return { operationId: input.operationId, outcome: 'saved_locally_pending_sync' };
      }
      if (method === 'writeProperties') {
        assert.equal(input.expectedHash, hash(note));
        for (const key of input.remove ?? []) delete note[key];
        Object.assign(note, input.set);
        writes.notes++;
        saveReceipts.set(input.operationId, 'saved_locally_pending_sync');
        if (faults.note || (faults.area && input.set?.area)) {
          faults.note = faults.area = false;
          throw new Error('PRIVATE_LOST_NOTE_REPLY');
        }
        return { operationId: input.operationId, outcome: 'saved_locally_pending_sync' };
      }
      if (method === 'movePath') {
        assert.equal(input.expectedHash, hash(note));
        assert.ok(!docs.has(input.destination));
        docs.set(input.destination, note);
        docs.delete(input.path);
        writes.moves++;
        const receipt = { vaultId: source, path: input.path, destination: input.destination, operationId: input.operationId, outcome: 'moved_locally_pending_sync' };
        moveReceipts.set(input.operationId, receipt);
        if (faults.move) { faults.move = false; throw new Error('PRIVATE_LOST_MOVE_REPLY'); }
        return receipt;
      }
      assert.fail(method);
    } },
    projects: { list: async () => [{ id: 'personal', kind: 'personal' }] as any },
    threads: {
      list: async (input: any) => input.offset ? [] : [...metadata.keys()].filter(id => id.startsWith('archived') === input.archived)
        .map(id => makeThreadResponse({id})),
      experimental_listPluginMetadata: async ({threadIds}: {threadIds: readonly string[]}) => ({threads:
        threadIds.filter(id => metadata.has(id)).map(threadId => ({threadId,metadata: structuredClone(metadata.get(threadId)) as any})) }),
      getPluginMetadata: async ({threadId}: {threadId: string}) => structuredClone(metadata.get(threadId) ?? {}) as any,
      updatePluginMetadata: async (input: any) => {
        const value = metadata.get(input.threadId)!;
        Object.assign(value, input.set);
        writes.metadata++;
        if (faults.thread) { faults.thread = false; throw new Error('PRIVATE_LOST_THREAD_REPLY'); }
        return structuredClone(value) as any;
      },
      spawn: async (input: any) => {
        writes.spawns++;
        metadata.set(creationThread, structuredClone(input.pluginMetadata));
        if (faults.spawn) { faults.spawn = false; throw new Error('PRIVATE_LOST_CREATION_REPLY'); }
        return makeThreadResponse({id:creationThread});
      },
    },
  };
  let host = createFakePluginHost({pluginId:'gtd', agentSkillIds:['gtd-projects'], settings:{vaultId:source}, sdk});
  await plugin(host.bb);
  return {
    docs, metadata, writes, faults, moveReceipts, creationThread,
    get host() { return host; },
    async reload() { host = await host.harness.lifecycle.reload(plugin); },
    async cli(...args: string[]) { return host.harness.behavior.runCli(args); },
    async rpc(method: string, input: any) { return host.harness.behavior.callRpc(method, input) as Promise<any>; },
    async preview(...args: string[]) {
      const result = await host.harness.behavior.runCli(['migration-preview', '--json', ...args]);
      assert.equal(result.exitCode, 0, result.stdout);
      return JSON.parse(result.stdout!);
    },
    move(from: string, to: string) { const note = docs.get(from); assert.ok(note && !docs.has(to)); docs.set(to, note); docs.delete(from); },
  };
}

test('review, interruption, cutover and replay preserve identities and relationships after Obsidian moves', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const warmReads = async () => {
    const calls = f.writes.inventories;
    const started = performance.now();
    for (let i = 0; i < 20; i++) await f.rpc('browseInventoryV2', {includeAreas:true});
    assert.equal(f.writes.inventories - calls, 20);
    return (performance.now() - started) / 20;
  };
  const before = await f.rpc('browseInventoryV2', {includeAreas:true});
  assert.equal(before.identity, 'legacy');
  const legacyMs = await warmReads();
  const requestId = randomUUID();
  f.faults.spawn = true;
  await assert.rejects(f.rpc('newAreaThread', {source,id:oldArea,requestId}));
  const preview = await f.preview();
  if (process.env.GTD_SYNTHETIC_PREVIEW) await writeFile(process.env.GTD_SYNTHETIC_PREVIEW, JSON.stringify(preview, null, 2) + '\n');
  assert.equal(preview.decisions, 0);
  assert.deepEqual(preview.threadsExamined, {active:2,archived:2});
  assert.equal(preview.links.length, 4);
  assert.equal(f.writes.notes + f.writes.metadata, 0);
  const projectId = preview.rows.find((row: any) => row.kind === 'project').proposedId;
  const areaId = preview.rows.find((row: any) => row.kind === 'area').proposedId;
  const apply = () => f.cli('migration-apply', '--plan', preview.planId);
  for (const phase of ['note', 'area', 'thread'] as const) {
    f.faults[phase] = true;
    const interrupted = await apply();
    assert.notEqual(interrupted.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(interrupted), /PRIVATE_/);
    assert.equal((await f.rpc('browseInventoryV2', {includeAreas:true})).identity, 'applying');
    await assert.rejects(f.rpc('associate', {threadId:'active-project', project:null}));
    const status = await f.cli('migration-status', '--plan', preview.planId);
    assert.equal(JSON.parse(status.stdout!).state, 'applying');
    await f.reload();
  }
  assert.equal((await apply()).exitCode, 0);
  assert.equal((await apply()).exitCode, 0);
  assert.equal(f.writes.notes, 3);
  assert.equal(f.writes.metadata, 4);
  assert.deepEqual(f.metadata.get('archived-project'), {project:{source,id:projectId},unrelated:'archived'});
  assert.deepEqual(f.metadata.get('archived-area'), {area:{source,id:areaId},unrelated:'area'});
  assert.deepEqual(await f.rpc('newAreaThread', {source,id:areaId,requestId}), {threadId:f.creationThread});
  assert.deepEqual(await f.rpc('newAreaThread', {source,id:oldArea,requestId}), {threadId:f.creationThread});
  assert.equal(f.writes.spawns, 1);
  const renamedArea = 'Areas/Operations.md';
  const renamedProject = 'Projects/Permits renewed.md';
  f.move(oldArea, renamedArea);
  f.move(oldProject, renamedProject);
  const newId = 'project_' + randomUUID();
  f.docs.set(oldProject, {id:newId});
  const now = await f.rpc('browseInventoryV2', {includeAreas:true});
  assert.equal(now.identity, 'stable');
  assert.equal(now.projects.projects.find((p: any) => p.id === projectId).notePath, renamedProject);
  assert.equal(now.projects.projects.find((p: any) => p.id === projectId).areaId, areaId);
  assert.equal(now.areas.areas[0].notePath, renamedArea);
  assert.deepEqual(now.aliases.find((a: any) => a.from === oldProject), {kind:'project',from:oldProject,to:projectId});
  assert.deepEqual(now.aliases.find((a: any) => a.from === oldArea), {kind:'area',from:oldArea,to:areaId});
  const legacy = await f.rpc('browseInventory', {includeAreas:true});
  assert.equal(legacy.projects.projects.find((p: any) => p.id === renamedProject).areaId, renamedArea);
  assert.equal(legacy.areas.areas[0].id, renamedArea);
  const standard = await f.rpc('readAreaStandard', {source,id:areaId});
  assert.equal((await f.rpc('saveAreaStandard', {source,id:areaId,expectedHash:standard.hash,text:'Check quarterly',operationId:randomUUID()})).outcome,
    'saved_locally_pending_sync');
  f.faults.move = true;
  const move = await f.host.harness.behavior.callAgentTool('gtd_change_project', {source,id:projectId,status:'done'});
  assert.ok(typeof move !== 'string' && !move.isError && move.content[0].type === 'text');
  const moved = JSON.parse(move.content[0].text);
  assert.equal(moved.state, 'links_verified');
  await f.reload();
  const recovered = await f.host.harness.behavior.callAgentTool('gtd_check_project_change', {planId:moved.planId});
  assert.ok(typeof recovered !== 'string' && !recovered.isError && recovered.content[0].type === 'text');
  assert.equal(JSON.parse(recovered.content[0].text).state, 'links_verified');
  assert.equal(f.writes.moves, 1);
  assert.equal(f.writes.metadata, 4);
  const after = await f.rpc('browseInventoryV2', {includeAreas:true});
  assert.deepEqual(after.projects.projects.find((p: any) => p.id === projectId), {
    id: projectId, notePath: 'Projects/Done/Permits renewed.md', title:'Permits renewed', status:'done', areaId,
  });
  assert.deepEqual(f.docs.get(oldProject), {id:newId});
  const newArea = 'area_' + randomUUID();
  f.docs.set('Areas/Gardening.md', {id:newArea});
  const assigned = await f.host.harness.behavior.callAgentTool('gtd_change_project', {source,id:projectId,areaPath:newArea});
  assert.ok(typeof assigned !== 'string' && !assigned.isError && assigned.content[0].type === 'text');
  assert.equal(JSON.parse(assigned.content[0].text).state, 'verified');
  assert.equal(f.docs.get('Projects/Done/Permits renewed.md')!.area, newArea);
  const stableMs = await warmReads();
  t.diagnostic(`Generated fixture mean per inventory: legacy ${legacyMs.toFixed(2)}ms, stable ${stableMs.toFixed(2)}ms. One inventory RPC per call in each mode.`);
  const newLanding = await f.host.harness.behavior.callAgentTool('gtd_prepare_landing_note', {kind:'area',path:'Areas/Travel.md'});
  assert.ok(typeof newLanding !== 'string' && !newLanding.isError && newLanding.content[0].type === 'text');
  const prepared = JSON.parse(newLanding.content[0].text);
  assert.ok(stableIds.area.safeParse(prepared.id).success);
  assert.equal(prepared.text, `---\nid: ${prepared.id}\n---\n`);
});

test('stale previews, revoked access and independently changed links fail closed', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const stale = await f.preview();
  f.docs.get(oldProject)!.status = 'someday';
  assert.notEqual((await f.cli('migration-apply', '--plan', stale.planId)).exitCode, 0);
  assert.equal(f.writes.notes, 0);
  const plan = await f.preview();
  f.faults.access = true;
  assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  assert.equal(f.writes.notes, 0);
  f.faults.access = false;
  f.faults.note = true;
  assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  f.metadata.set('active-project', {project:{source,id:'Projects/Another.md'}});
  assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  assert.equal(f.writes.metadata, 0);
});

test('a verified rename takes precedence over an unrelated current occupant of the old path', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const hashBefore = hash(f.docs.get(oldProject)!);
  const renamed = 'Projects/Permits.md';
  const operationId = randomUUID();
  f.move(oldProject, renamed);
  f.docs.set(oldProject, { status:'someday' });
  f.moveReceipts.set(operationId, {vaultId:source,path:oldProject,destination:renamed,operationId,
    outcome:'moved_locally_pending_sync',legacy:{expectedHash:hashBefore}});
  const suspect = await f.cli('migration-preview', '--json', '--renames',
    JSON.stringify([{kind:'project',oldId:oldProject,operationId,baselineHash:'0'.repeat(64)}]));
  assert.equal(suspect.exitCode, 2);
  assert.equal(JSON.parse(suspect.stdout!).links.find((link: any) => link.threadId === 'active-project').decision, 'rename_unverified');
  const report = await f.preview('--renames', JSON.stringify([{kind:'project',oldId:oldProject,operationId,baselineHash:hashBefore}]));
  const link = report.links.find((link: any) => link.threadId === 'active-project');
  const original = report.rows.find((row: any) => row.notePath === renamed);
  const replacement = report.rows.find((row: any) => row.notePath === oldProject);
  assert.equal(link.decision, 'verified_rename');
  assert.equal(link.proposedId, original.proposedId);
  assert.deepEqual(report.bookmarks.find((alias: any) => alias.from === oldProject),
    {kind:'project',from:oldProject,to:original.proposedId,decision:'verified_rename'});
  assert.notEqual(link.proposedId, replacement.proposedId);
  assert.equal(report.decisions, 0);
  assert.equal(f.writes.notes + f.writes.metadata, 0);
});
