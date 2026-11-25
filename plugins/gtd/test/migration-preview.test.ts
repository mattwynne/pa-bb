import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { migrationPreview, planRows, stableIds } from '../core/migration-preview.ts';
const uid = '11111111-1111-4111-8111-111111111111';
test('identity preview keeps the existing layout and flags duplicate IDs, absent owners and nested Area decisions', () => {
  const owners = new Map<string, Record<string,unknown>>([['Projects/Test.md',{id:'project-'+uid,area:'Areas/Activity/child.md'}], ['Projects/Active/Test.md',{id:'project-'+uid}], ['Areas/Activity.md',{id:'unrelated'}]]);
  const rows = planRows([{id:'Projects/Test.md',title:'Not the filename',status:'active',areaId:'Areas/Activity/child.md'}, {id:'Projects/Active/Test.md', title:'Test',status:'active'}, {id:'Projects/Folder/',title:'Folder',status:'done'}], [{id:'Areas/Activity.md',title:'Activity'}], {owners,entries:new Set(owners.keys())}, kind=>kind+'_'+uid);
  assert.deepEqual(rows[0].decisions.sort(), ['ambiguous_identity','nested_or_missing_area']);
  assert.equal(rows[0].proposedPath,'Projects/Test.md'); assert.equal(rows[0].proposedId, 'project-'+uid);
  assert.ok(rows[2].decisions.includes('missing_landing_page')); assert.ok(rows[3].decisions.includes('invalid_existing_id')); assert.equal(rows[3].proposedId,null);
});
test('preview reserves repeatable proposals, reads active and archived links, and never dispatches note or metadata writes', async t => {
  let revoke = false; let metadataReads = 0;
  const host = createFakePluginHost({pluginId:'gtd',sdk:{plugins:{callRpc:async (a:any)=>{
    if (revoke && metadataReads) throw new Error('PRIVATE_SENTINEL');
    if (a.method === 'vaultInventory') {
      const source = { vaultId: 'one', name: 'Fixture', cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null };
      if (a.input.folders?.length === 0) return { source, folders: [], notes: [], incomplete: false };
      return { source, notes:[{path:'Projects/Example.md',properties:{area:'Areas/Finance.md'},malformed:false},{path:'Areas/Finance.md',properties:{id:'area-'+uid},malformed:false}],
        folders:['Projects','Areas'], incomplete:false };
    }
    if (a.method === 'noteEvidence') return {hash: '1'.repeat(64), receipt: null, properties: a.input.path.startsWith('Projects/') ? {area:'Areas/Finance.md'} : {id:'area-'+uid}};
    assert.fail(a.method);
  }},threads:{list: async (args:any)=>args.offset?[]:[{id:args.archived?'old':'new'}] as any, experimental_listPluginMetadata:async (args:any)=>{metadataReads++;return {threads:args.threadIds.map((threadId:string)=>({threadId,metadata:{project:{source:'one',id:'Projects/Example.md'},area:{source:'one',id:'Areas/Finance.md'}}}))};}}}});
  t.after(()=>host.harness.lifecycle.dispose());
  const preview=()=>migrationPreview(host.bb,{vaultId:'one',projectsFolder:'Projects',areasFolder:'Areas'},new AbortController().signal);
  const first=await preview();assert.deepEqual(await preview(),first);assert.equal(first.coverage,'complete'); assert.equal(first.rows[0].proposedAreaId,'area-'+uid);assert.ok(stableIds.project.safeParse(first.rows[0].proposedId).success);
  assert.deepEqual(first.threadsExamined,{active:1,archived:1});assert.ok(first.links.every(l=>l.proposedId===(l.kind==='project'?first.rows[0].proposedId:'area-'+uid)));assert.equal(first.links.length,4);
  revoke=true;metadataReads=0;await assert.rejects(preview());
});
