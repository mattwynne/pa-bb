import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { canonicalIds, scopeKey, stableIds } from '../core/identity.ts';

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
  const faults = { note: false, area: false, move: false, thread: false, spawn: false, access: false, partial: false };
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
        return { source: provenance, folders: folders.filter(include), incomplete: faults.partial && input.folders?.length !== 0,
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
  const newId = 'project-' + randomUUID();
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
  const moveDb = f.host.bb.storage.database();
  const persisted = () => (moveDb.prepare('SELECT plan FROM project_change_plans WHERE id=?').get(moved.planId) as {plan:string}).plan;
  const pendingMove = JSON.parse(persisted());
  delete pendingMove.settled;
  moveDb.prepare('UPDATE project_change_plans SET plan=? WHERE id=?').run(JSON.stringify(pendingMove), moved.planId);
  const recovered = await f.host.harness.behavior.callAgentTool('gtd_check_project_change', {planId:moved.planId});
  assert.ok(typeof recovered !== 'string' && !recovered.isError && recovered.content[0].type === 'text');
  assert.equal(JSON.parse(recovered.content[0].text).state, 'links_verified');
  assert.deepEqual(JSON.parse(persisted()), pendingMove);
  assert.equal(f.writes.moves, 1);
  assert.equal(f.writes.metadata, 4);
  const after = await f.rpc('browseInventoryV2', {includeAreas:true});
  assert.deepEqual(after.projects.projects.find((p: any) => p.id === projectId), {
    id: projectId, notePath: 'Projects/Done/Permits renewed.md', title:'Permits renewed', status:'done', areaId,
  });
  assert.deepEqual(f.docs.get(oldProject), {id:newId});
  const newArea = 'area-' + randomUUID();
  f.docs.set('Areas/Gardening.md', {id:newArea});
  const assigned = await f.host.harness.behavior.callAgentTool('gtd_change_project', {source,id:projectId,areaPath:newArea});
  assert.ok(typeof assigned !== 'string' && !assigned.isError && assigned.content[0].type === 'text');
  assert.equal(JSON.parse(assigned.content[0].text).state, 'verified');
  assert.equal(f.docs.get('Projects/Done/Permits renewed.md')!.area, newArea);
  const stableMs = await warmReads();
  t.diagnostic(`Generated fixture mean per inventory: legacy ${legacyMs.toFixed(2)}ms, stable ${stableMs.toFixed(2)}ms. One inventory RPC per call in each mode.`);
  for (const [kind, path] of [['project', 'Projects/Travel.md'], ['area', 'Areas/Travel.md']] as const) {
    const newLanding = await f.host.harness.behavior.callAgentTool('gtd_prepare_landing_note', {kind,path});
    assert.ok(typeof newLanding !== 'string' && !newLanding.isError && newLanding.content[0].type === 'text');
    const prepared = JSON.parse(newLanding.content[0].text);
    assert.ok(canonicalIds[kind].safeParse(prepared.id).success);
    assert.equal(prepared.text, `---\nid: ${prepared.id}\n---\n`);
  }
});

test('stale previews, revoked access and independently changed links fail closed', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const stale = await f.preview();
  f.docs.get(oldProject)!.status = 'someday';
  assert.notEqual((await f.cli('migration-apply', '--plan', stale.planId)).exitCode, 0);
  assert.equal(f.host.harness.inspection.logEntries.at(-1)?.message, 'GTD identity_migration preflight_review_changed');
  assert.equal(f.writes.notes, 0);
  const plan = await f.preview();
  f.faults.access = true;
  assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  assert.equal(f.host.harness.inspection.logEntries.at(-1)?.message, 'GTD identity_migration preflight_source_unavailable');
  assert.equal(f.writes.notes, 0);
  f.faults.access = false;
  f.faults.note = true;
  assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  f.metadata.set('active-project', {project:{source,id:'Projects/Another.md'}});
  assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  assert.equal(f.writes.metadata, 0);
});

test('migration readiness reports scoped legacy blockers and stays read-only', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const migration = await f.preview();
  const db = f.host.bb.storage.database();
  const config = {vaultId:source, projectsFolder:'Projects', areasFolder:'Areas'};
  const scope = JSON.stringify([source, 'Projects']);
  const otherScope = JSON.stringify(['unrelated', 'Projects']);
  const planId = randomUUID(), cleanupOperationId = randomUUID(), dateOperationId = randomUUID();
  const deferral = db.prepare('INSERT INTO project_deferrals VALUES (?,?,?,?,?,0,?)');
  deferral.run(scope, oldProject, oldProject, 1, null, JSON.stringify({date:'2026-11-30',dateAttempt:dateOperationId}));
  deferral.run(otherScope, 'Projects/PRIVATE_OTHER.md', oldProject, 1, null, '{}');
  db.prepare('INSERT INTO project_reactivations VALUES (?,?,?,?)').run(scope, oldProject, planId,
    JSON.stringify({cleanupId:cleanupOperationId}));
  const legacyPlan = {config,source,id:oldProject,owner:oldProject,expectedHash:hash(f.docs.get(oldProject)!),
    areaPath:'Areas/Other.md',threads:[],direct:true,noteAttempted:true};
  db.prepare('INSERT INTO project_change_plans (id,created,plan) VALUES (?,?,?)').run(planId, 1, JSON.stringify(legacyPlan));
  const readiness = async () => {
    const result = await f.cli('migration-status', '--plan', migration.planId, '--readiness');
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stdout!, /PRIVATE_OTHER/);
    const status = JSON.parse(result.stdout!);
    assert.equal(status.state, 'review');
    return status.readiness;
  };
  const assertBlocked = async (stage: string) => {
    const result = await f.cli('migration-apply', '--plan', migration.planId);
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Permits|permits/);
    assert.equal(f.host.harness.inspection.logEntries.at(-1)?.message, 'GTD identity_migration preflight_' + stage);
  };
  const first = await readiness();
  assert.equal(first.stage, 'deferrals');
  assert.deepEqual(first.counts, {deferrals:1, reactivations:1, projectChanges:1});
  assert.deepEqual(first.deferrals, [{projectId:oldProject,deferUntil:'2026-11-30',movePlanId:null,dateOperationId}]);
  assert.deepEqual(first.reactivations, [{planId,cleanupOperationId}]);
  assert.equal(first.projectChanges[0].state, 'not_checked');
  await assertBlocked('deferrals');
  db.prepare('DELETE FROM project_deferrals WHERE scope=?').run(scope);
  assert.equal((await readiness()).stage, 'reactivations');
  await assertBlocked('reactivations');
  db.prepare('DELETE FROM project_reactivations WHERE scope=?').run(scope);
  const last = await readiness();
  assert.equal(last.stage, 'project_changes');
  assert.deepEqual(last.projectChanges, [{planId,moveOperationId:null,folderOperationId:null,
    propertyOperationId:planId, ready:false,state:'not_verified',moveOutcome:null}]);
  await assertBlocked('project_changes');
  f.faults.access = true;
  assert.equal((await readiness()).stage, 'legacy_evidence');
  await assertBlocked('legacy_evidence');
  f.faults.access = false;
  f.docs.set('Areas/Other.md', {});
  f.docs.get(oldProject)!.area = 'Areas/Other.md';
  assert.equal((await readiness()).stage, 'legacy_checks_passed');
  assert.deepEqual((db.prepare('SELECT plan FROM project_change_plans WHERE id=?').get(planId) as {plan:string}).plan, JSON.stringify(legacyPlan));
  assert.deepEqual(JSON.parse((await f.cli('migration-status', '--plan', migration.planId)).stdout!),
    {planId:migration.planId,state:'review',notes:{},threads:{}});
  assert.equal(f.writes.notes + f.writes.moves + f.writes.metadata + f.writes.spawns, 0);
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

test('unassigned underscore reservations receive repeatable hyphen IDs and old reviews require a fresh plan', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const db = f.host.bb.storage.database();
  const scope = scopeKey({vaultId:source, projectsFolder:'Projects', areasFolder:'Areas'});
  const oldIds = { project: 'project_' + randomUUID(), area: 'area_' + randomUUID() };
  db.exec('CREATE TABLE migration_proposals_v1 (scope TEXT, kind TEXT, old_id TEXT, proposal TEXT NOT NULL UNIQUE, PRIMARY KEY(scope, kind, old_id))');
  db.prepare('INSERT INTO migration_proposals_v1 VALUES (?,?,?,?)').run(scope, 'project', oldProject, oldIds.project);
  db.prepare('INSERT INTO migration_proposals_v1 VALUES (?,?,?,?)').run(scope, 'area', oldArea, oldIds.area);
  const {planId, decisions, ...preview} = await f.preview();
  assert.equal(decisions, 0);
  const canonical = Object.fromEntries(preview.rows.map((row: any) => [row.kind, row.proposedId]));
  assert.ok(canonicalIds.project.safeParse(canonical.project).success);
  assert.ok(canonicalIds.area.safeParse(canonical.area).success);
  const oldPreview = JSON.parse(JSON.stringify(preview).replaceAll(canonical.project, oldIds.project).replaceAll(canonical.area, oldIds.area));
  oldPreview.version = 2;
  const oldPlanId = randomUUID();
  db.prepare("INSERT INTO identity_runs VALUES (?,?,'review',?)").run(oldPlanId, scope,
    JSON.stringify({preview:oldPreview, renames:[], notes:{}, threads:{}}));
  const rejected = await f.cli('migration-apply', '--plan', oldPlanId);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr!, /Run bb gtd migration-preview/);
  assert.ok(f.host.harness.inspection.logEntries.some(entry => entry.message === 'GTD identity_migration outdated_review'));
  assert.deepEqual(db.prepare('SELECT proposal FROM migration_proposals_v1 ORDER BY kind').all(),
    [{proposal:oldIds.area}, {proposal:oldIds.project}]);
  assert.equal(f.writes.notes + f.writes.metadata, 0);
  assert.equal(JSON.parse((await f.cli('migration-status', '--plan', oldPlanId)).stdout!).state, 'review');
  await f.reload();
  assert.deepEqual((await f.preview()).rows, preview.rows);
  assert.equal((await f.cli('migration-apply', '--plan', planId)).exitCode, 0);
  assert.equal(f.docs.get(oldProject)!.id, canonical.project);
  assert.equal(f.docs.get(oldProject)!.area, canonical.area);
  assert.deepEqual(f.metadata.get('archived-area')!.area, {source, id:canonical.area});
});

test('IDs already assigned with underscores keep their exact assignments, aliases, and thread links', async t => {
  const f = await fixture();
  t.after(() => f.host.harness.lifecycle.dispose());
  const projectId = 'project_' + randomUUID();
  const areaId = 'area_' + randomUUID();
  Object.assign(f.docs.get(oldProject)!, {id:projectId, area:areaId});
  f.docs.get(oldArea)!.id = areaId;
  f.metadata.get('archived-project')!.project = {source,id:projectId};
  f.metadata.get('archived-area')!.area = {source,id:areaId};
  const plan = await f.preview();
  assert.deepEqual(plan.rows.map((row: any) => [row.existingId, row.proposedId]), [[projectId,projectId], [areaId,areaId]]);
  assert.equal((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
  assert.equal(f.writes.notes, 0);
  assert.equal(f.writes.metadata, 1); // Only the active thread still holds its legacy path.
  const current = await f.rpc('browseInventoryV2', {includeAreas:true});
  assert.equal(current.projects.projects[0].id, projectId);
  assert.equal(current.projects.projects[0].areaId, areaId);
  assert.equal(current.areas.areas[0].id, areaId);
  assert.deepEqual(current.aliases.map((entry: any) => entry.to), [projectId, areaId]);
  const input = {source,id:areaId,requestId:randomUUID()};
  assert.deepEqual(await f.rpc('newAreaThread', input), {threadId:f.creationThread});
  assert.deepEqual(f.metadata.get(f.creationThread)!.area, {source,id:areaId});
});

test('stable ID validators check kind, separator, UUID version and variant', () => {
  const guid = '11111111-1111-4111-8111-111111111111';
  for (const kind of ['project', 'area'] as const) {
    assert.ok(canonicalIds[kind].safeParse(kind + '-' + guid).success);
    assert.ok(stableIds[kind].safeParse(kind + '_' + guid).success);
    assert.ok(!canonicalIds[kind].safeParse(kind + '_' + guid).success);
    for (const invalid of ['other-' + guid, kind + '-' + guid.slice(1), kind + '-' + guid + '-extra',
      kind + '-' + guid.replace('-4111-', '-7111-'), kind + '-' + guid.replace('-8111-', '-0111-')]) {
      assert.ok(!stableIds[kind].safeParse(invalid).success);
    }
  }
});

const nestedArea = ['[[Areas/Administration/Records]]'];
const movedProject = 'Projects/Inspections.md';
const oldMissingProject = 'Projects/Retired.md';
const explicitChoicesFixture = () => ({
  areaAssignments: [{projectPath:oldProject,expectedDeclaration:nestedArea,targetAreaPath:oldArea}],
  threadReassignments: [
    {threadId:'archived-project',kind:'project',expected:{source,id:oldMissingProject},targetPath:movedProject},
    {threadId:'archived-area',kind:'area',expected:{source,id:'Areas/Previous.md'},targetPath:oldArea},
  ],
});
async function setupChoices() {
  const f = await fixture();
  f.docs.get(oldProject)!.area = nestedArea;
  f.docs.set(movedProject, {});
  f.metadata.get('archived-project')!.project = {source,id:oldMissingProject};
  f.metadata.get('archived-area')!.area = {source,id:'Areas/Previous.md'};
  return f;
}

test('explicit review resolves a nested Area and reassigns the specified threads without claiming bookmark lineage', async t => {
  const f = await setupChoices();
  t.after(() => f.host.harness.lifecycle.dispose());
  const choices = explicitChoicesFixture();
  const baseline = await f.preview();
  assert.ok(baseline.decisions > 0);
  const preview = await f.preview('--choices', JSON.stringify(choices));
  assert.equal(preview.decisions, 0);
  assert.deepEqual(preview.explicitChoices, choices);
  const area = preview.rows.find((row: any) => row.notePath === oldArea);
  const project = preview.rows.find((row: any) => row.notePath === oldProject);
  const reassigned = preview.rows.find((row: any) => row.notePath === movedProject);
  assert.deepEqual(project.areaDecision, {kind:'explicit_assignment',targetPath:oldArea});
  assert.equal(project.proposedAreaId, area.proposedId);
  for (const choice of choices.threadReassignments) {
    const link = preview.links.find((link: any) => link.threadId === choice.threadId);
    assert.equal(link.decision, 'explicit_reassignment');
    assert.equal(link.targetPath, choice.targetPath);
    assert.ok(!preview.bookmarks.some((bookmark: any) => bookmark.from === choice.expected.id && bookmark.to));
  }
  assert.equal(f.writes.notes + f.writes.metadata, 0);
  await f.reload();
  const apply = () => f.cli('migration-apply', '--plan', preview.planId);
  f.faults.area = true;
  assert.notEqual((await apply()).exitCode, 0);
  await f.reload();
  const writesBeforeResume = {...f.writes};
  f.docs.get(movedProject)!.changed = 'Different target after interruption';
  assert.notEqual((await apply()).exitCode, 0);
  delete f.docs.get(movedProject)!.changed;
  f.metadata.get('archived-project')!.project = {source,id:reassigned.proposedId};
  assert.notEqual((await apply()).exitCode, 0);
  f.metadata.get('archived-project')!.project = {source,id:oldMissingProject};
  assert.equal(f.writes.notes, writesBeforeResume.notes);
  assert.equal(f.writes.metadata, writesBeforeResume.metadata);
  assert.equal((await apply()).exitCode, 0);
  assert.equal(f.docs.get(oldProject)!.area, area.proposedId);
  assert.deepEqual(f.metadata.get('archived-project'), {project:{source,id:reassigned.proposedId},unrelated:'archived'});
  assert.deepEqual(f.metadata.get('archived-area'), {area:{source,id:area.proposedId},unrelated:'area'});
  const result = await f.rpc('browseInventoryV2', {includeAreas:true});
  assert.equal(result.identity, 'stable');
  assert.ok(!result.aliases.some((bookmark: any) => bookmark.from === oldMissingProject || bookmark.from === 'Areas/Previous.md'));
});

test('explicit choices require exact current values, scope, canonical targets, unique reviews and complete coverage', async t => {
  const f = await setupChoices();
  t.after(() => f.host.harness.lifecycle.dispose());
  const testInvalid = async (change: (input: ReturnType<typeof explicitChoicesFixture>) => void, diagnostic: string) => {
    const choices = explicitChoicesFixture();
    change(choices);
    const result = await f.cli('migration-preview', '--json', '--choices', JSON.stringify(choices));
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(result), /Private_SENTINEL/i);
    assert.equal(f.host.harness.inspection.logEntries.at(-1)?.message, 'GTD identity_preview choice_' + diagnostic);
  };
  await testInvalid(c => { c.areaAssignments[0].expectedDeclaration = ['Private_SENTINEL']; }, 'area_assignment');
  await testInvalid(c => { c.areaAssignments[0].projectPath = movedProject; }, 'area_assignment');
  await testInvalid(c => { c.areaAssignments[0].targetAreaPath = 'Areas/Administration/Nested.md'; }, 'area_assignment');
  await testInvalid(c => { c.threadReassignments[0].expected.source = 'other'; }, 'thread_reassignment');
  await testInvalid(c => { c.threadReassignments[0].threadId = 'missing'; }, 'thread_reassignment');
  await testInvalid(c => { c.threadReassignments[0].expected.id = 'Projects/Private_SENTINEL.md'; }, 'thread_reassignment');
  await testInvalid(c => { c.threadReassignments[0].targetPath = oldArea; }, 'thread_reassignment');
  await testInvalid(c => { c.areaAssignments.push(c.areaAssignments[0]); }, 'duplicate');
  await testInvalid(c => { c.threadReassignments.push({...c.threadReassignments[0], targetPath:oldProject}); }, 'duplicate');
  f.faults.partial = true;
  await testInvalid(() => {}, 'coverage');
  assert.equal(f.writes.notes + f.writes.metadata, 0);
});

test('stale choice plans reject changed declarations, target versions or thread references before any external write', async t => {
  const f = await setupChoices();
  t.after(() => f.host.harness.lifecycle.dispose());
  const plan = await f.preview('--choices', JSON.stringify(explicitChoicesFixture()));
  const reject = async () => {
    assert.notEqual((await f.cli('migration-apply', '--plan', plan.planId)).exitCode, 0);
    assert.equal(f.writes.notes + f.writes.metadata, 0);
    assert.equal(JSON.parse((await f.cli('migration-status', '--plan', plan.planId)).stdout!).state, 'review');
  };
  delete f.docs.get(oldProject)!.area;
  await reject();
  f.docs.get(oldProject)!.area = nestedArea;
  f.docs.get(movedProject)!.changed = 'Independent change';
  await reject();
  delete f.docs.get(movedProject)!.changed;
  delete f.metadata.get('archived-area')!.area;
  await reject();
});

test('one thread choice does not migrate other threads or confer a bookmark alias at a reused old path', async t => {
  const f = await setupChoices();
  t.after(() => f.host.harness.lifecycle.dispose());
  f.docs.set(oldMissingProject, {});
  f.metadata.set('other-project', {project:{source,id:oldMissingProject}});
  const preview = await f.preview('--choices', JSON.stringify(explicitChoicesFixture()));
  assert.equal(preview.links.find((link: any) => link.threadId === 'other-project').decision, 'thread_lineage_unverified');
  assert.deepEqual(preview.bookmarks.find((bookmark: any) => bookmark.from === oldMissingProject), {
    kind: 'project', from: oldMissingProject, to: null, decision: 'bookmark_lineage_unverified',
  });
  assert.notEqual((await f.cli('migration-apply', '--plan', preview.planId)).exitCode, 0);
  assert.equal(f.writes.notes + f.writes.metadata, 0);
});

test('a receipt-based mapping and an explicit choice for the same reference conflict', async t => {
  const f = await setupChoices();
  t.after(() => f.host.harness.lifecycle.dispose());
  const operationId = randomUUID();
  const baselineHash = hash(f.docs.get(movedProject)!);
  f.moveReceipts.set(operationId, {vaultId:source,path:oldMissingProject,destination:movedProject,operationId,
    outcome:'moved_locally_pending_sync',legacy:{expectedHash:baselineHash}});
  const renames = JSON.stringify([{kind:'project',oldId:oldMissingProject,operationId,baselineHash}]);
  const receiptOnly = await f.preview('--renames', renames);
  assert.equal(receiptOnly.links.find((link: any) => link.threadId === 'archived-project').decision, 'verified_rename');
  const rejected = await f.cli('migration-preview', '--renames', renames, '--choices', JSON.stringify(explicitChoicesFixture()));
  assert.notEqual(rejected.exitCode, 0);
  assert.equal(f.host.harness.inspection.logEntries.at(-1)?.message, 'GTD identity_preview choice_conflict');
  assert.equal(f.writes.notes + f.writes.metadata, 0);
});
