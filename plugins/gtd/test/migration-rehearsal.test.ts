// Rehearse boundaries with disposable source and BB metadata. The source changes
// below stand in for separately verified Obsidian saves/moves, not a live runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { migrationPreview } from '../core/migration-preview.ts';
import type { ProjectPage } from '../core/model.ts';

const old = 'Projects/Active/Service heater.md', done = 'Projects/Done/Service heater.md';
const dir = 'Projects/Notebook', readme = `${dir}/README.md`;
const nested = 'Areas/Work/Writing.md';
const select = { vaultId: 'one', projectsFolder: 'Projects', areasFolder: 'Areas' };
async function fixture() {
  const docs = new Map<string, Record<string, string>>([[old, { area: nested }], [readme, {}], ['Areas/Work.md', {}], [nested, {}], [`${dir}/Minutes.md`, {title:'Supporting material'}]]);
  const dirs = ['Projects', 'Projects/Active', 'Projects/Done', dir, 'Areas', 'Areas/Work'];
  const metadata = {project: {source: 'one', id: old}, unrelated: 'keep', creationRequest: 'unmodified'};
  let lostReply = false, writes = 0;
  const host = createFakePluginHost({pluginId:'gtd',agentSkillIds:['gtd-projects'],settings:select,sdk:{plugins:{callRpc:async (a:any) => {
    if (a.method === 'vaultLocations') return {vaults:[{id:'one',root:'',name:'Synthetic'}],incomplete:false};
    if (a.method === 'vaultInventory') {
      const source = { vaultId: 'one', name: 'Synthetic', cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null };
      if (a.input.folders?.length === 0) return { source, folders: [], notes: [], incomplete: false };
      return { source, notes:[...docs].map(([path, properties])=>({path,properties,malformed:false})),
        folders:dirs, incomplete:false };
    }
    if (a.method === 'noteEvidence') return {hash:'1'.repeat(64), receipt:null, properties: docs.get(a.input.path)};
    assert.fail('Unexpected Obsidian call');
  }}, threads:{list:async a=>!a?.offset&&!a?.archived?[makeThreadResponse({id:'thread-1'})]:[],experimental_listPluginMetadata:async()=>({threads:[{threadId:'thread-1',metadata:structuredClone(metadata)}]}),updatePluginMetadata:async (input:any)=>{
    assert.equal(input.threadId,'thread-1'); assert.deepEqual(Object.keys(input.set),['project']);writes++;metadata.project=input.set.project;
    if(lostReply)throw new Error('synthetic reply lost after metadata commit');return metadata;
  }}}});
  await plugin(host.bb);
  return {host,docs,metadata, writes:()=>writes,loseReply:()=>{lostReply=true;},preview:()=>migrationPreview(host.bb,select,new AbortController().signal),
    move(from:string,to:string){assert.ok(docs.has(from)&&!docs.has(to));docs.set(to,docs.get(from)!);docs.delete(from);},
    list:async()=>await host.harness.behavior.callRpc('listProjects',{}) as ProjectPage,
    associate:(id:string)=>host.harness.behavior.callRpc('associate',{threadId:'thread-1',project:{source:'one',id}})};
}
test('migration preview omits folder-only projects and supporting notes', async t=>{
  const f=await fixture();t.after(()=>f.host.harness.lifecycle.dispose());
  const before=await f.list();assert.equal(before.coverage,'complete');assert.equal(before.projects.length,1);
  assert.equal((await f.preview()).rows.find(r=>r.oldId===dir+'/')?.notePath,undefined);
  f.move(readme,dir+'/Overview.md');
  const after=await f.list();assert.equal(after.coverage,'complete');assert.equal(after.projects.length,1);
  assert.equal(after.projects.find(p=>p.id===dir+'/'),undefined);
  assert.deepEqual(f.docs.get(dir+'/Minutes.md'),{title:'Supporting material'});assert.equal(f.writes(),0);
});
test('interrupt after stamping IDs and after move: re-preview evidence, preserve deferred Area, reconcile lost association reply without replay',async t=>{
  const f=await fixture();t.after(()=>f.host.harness.lifecycle.dispose());
  const first=await f.preview(), reserved=first.rows.find(r=>r.oldId===old)!.proposedId!;
  assert.equal(first.links[0].id,old);assert.equal(first.links[0].threadId,'thread-1');assert.equal(first.rows.find(r=>r.oldId===old)?.decisions.includes('nested_or_missing_area'),true);
  // Test-only partial save then restart the preview. No real migration API exists.
  f.docs.get(old)!.id=reserved;
  assert.equal((await f.preview()).rows.find(r=>r.oldId===old)!.existingId,reserved);assert.equal((await f.list()).projects.some(p=>p.id===old),true);
  await assert.rejects(f.associate(done));assert.equal(f.writes(),0);
  f.move(old,done);
  const interrupted=await f.preview();assert.equal(interrupted.links[0].decision,'unmatched_legacy_reference');assert.equal(f.metadata.project.id,old);
  const row=interrupted.rows.find(r=>r.oldId===done)!;assert.equal(row.existingId,reserved);assert.equal(row.declaration,nested);assert.equal(row.proposedAreaId,undefined);
  // An operator independently verifies the move receipt; the API itself does
  // not prove old→new lineage and does not compare-and-swap the old thread link.
  f.loseReply();await assert.rejects(f.associate(done));
  const reconciled=await f.preview();assert.equal(reconciled.links[0].id,done);assert.equal(reconciled.links[0].threadId,'thread-1');assert.equal(f.writes(),1);
  assert.deepEqual(f.metadata,{project:{source:'one',id:done},unrelated:'keep',creationRequest:'unmodified'});
  assert.equal(f.docs.get(done)!.area,nested);assert.equal(f.host.harness.inspection.sdk.callsTo('threads.spawn').length,0);
});
