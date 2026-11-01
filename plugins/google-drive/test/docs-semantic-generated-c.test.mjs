import test from 'node:test';
import assert from 'node:assert/strict';
import { withWitnessWorld,generatedDocuments,generatedRequest } from '../features/docs/support/witness-c-checks.mjs';
import { binding,node,paragraph } from '../features/docs/support/witness-c-vectors.mjs';
import { compareGeneratedEvidence } from '../core/docs-semantic/coverage.mjs';
async function generated(run,mutate=()=>{}) {
  const documents=generatedDocuments();mutate(documents);
  return withWitnessWorld(async({world,owner,snapshot:before})=>{
    world.document=documents.after;world.clock=1;
    const inspected=await world.inspect(),after=world.store.semanticSnapshots.get(inspected.snapshotId,owner,1);
    return run(before,after,generatedRequest(before,after,documents.table));
  },{document:documents.before});
}
for(const fault of ['shape','scope','type','predecessor','freshRevision','preservation','fabricatedStage','tableId','missingAnchor'])test(`C generated comparison rejects ${fault}`,()=>generated((before,after,request)=>{
  if(fault==='shape')request.expectedOriginal.table.columns=2;
  if(fault==='scope')request.binding.tabId='tab-other';
  if(fault==='type')request.binding.nodeKind='paragraph';
  if(fault==='predecessor')request.observation.predecessorRevision='r-other';
  if(fault==='freshRevision')request.observation.binding.revision.id='r-other';
  if(fault==='preservation')request.preservation[3].target=node(after,2);
  if(fault==='fabricatedStage')request.verifiedStage=true;
  if(fault==='tableId')request.binding={kind:'returnedId',tabId:'tab-a',segment:{kind:'body'},nodeKind:'table',idKind:'tableId',returnedId:'fake-table'};
  if(fault==='missingAnchor')delete request.binding.startIndex;
  assert.throws(()=>compareGeneratedEvidence(before,after,request),/conflict|scope|snapshot|unsupported|invalid/);
}));
test('C generated comparison retains unknown payload coordinate-like fields and catches their drift',()=>generated((before,after,request)=>{
  assert.throws(()=>compareGeneratedEvidence(before,after,request),/conflict/);
},docs=>{
  docs.before.tabs[0].documentTab.body.content[0].futurePayload={startIndex:100,endIndex:101};
  docs.after.tabs[0].documentTab.body.content[0].futurePayload={startIndex:200,endIndex:201};
}));
test('C generated comparison rejects altered preservation prose despite exact generated table',()=>generated((before,after,request)=>{
  assert.throws(()=>compareGeneratedEvidence(before,after,request),/conflict/);
},docs=>{docs.after.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.content='C\n';}));
test('C generated read binding is not borrowed across OAuth subjects or historical observations',()=>generated((before,after,request)=>{
  const other=structuredClone(after);other.binding.subject='different';
  // Canonical validation notices that the derived revision still belongs to the
  // original subject, before any expected fragment can grant evidence.
  assert.throws(()=>compareGeneratedEvidence(before,other,request),/corrupt|snapshot/);
  const history=structuredClone(after);history.binding.source='historical';
  assert.throws(()=>compareGeneratedEvidence(before,history,request),/snapshot/);
}));
test('C fresh generated observation may advance Drive version/time without borrowing them as Docs CAS',()=>{
  const docs=generatedDocuments();
  return withWitnessWorld(async({world,owner,snapshot:before})=>{
    world.document=docs.after;world.metadata={...before.metadata,version:'next-drive-version',modifiedTime:'2026-11-01T00:00:00Z'};world.clock=1;
    const inspected=await world.inspect(),after=world.store.semanticSnapshots.get(inspected.snapshotId,owner,1);
    const result=compareGeneratedEvidence(before,after,generatedRequest(before,after,docs.table));
    assert.equal(result.witnessSatisfied,true);assert.equal(result.driveObservations.docsCas,false);
    assert.deepEqual(result.driveObservations.observed,{version:'next-drive-version',modifiedTime:'2026-11-01T00:00:00Z'});
  },{document:docs.before});
});
test('C exact returned heading ID binding needs no redundant agent delivery but rejects ambiguous IDs',async()=>{
  const docs=generatedDocuments(),heading=paragraph(3,'New\n',{}, {namedStyleType:'HEADING_1',headingId:'returned-heading'});
  docs.after.tabs[0].documentTab.body.content=[paragraph(1,'A\n'),heading,paragraph(7,'B\n')];
  await withWitnessWorld(async({world,owner,snapshot:before})=>{
    world.document=docs.after;world.clock=1;const inspected=await world.inspect(),after=world.store.semanticSnapshots.get(inspected.snapshotId,owner,1);
    const request={kind:'generatedReadComparison',predecessor:{binding:binding(before)},observation:{binding:binding(after),predecessorRevision:'r1'},
      binding:{kind:'returnedId',tabId:'tab-a',segment:{kind:'body'},nodeKind:'paragraph',idKind:'headingId',returnedId:'returned-heading'},expectedOriginal:heading,
      preservation:[[1,1,'segment',null,null],[2,2,'paragraph',{start:1,end:3},{start:1,end:3}],[3,3,'text',{start:1,end:3},{start:1,end:3}],
        [4,6,'paragraph',{start:3,end:5},{start:7,end:9}],[5,7,'text',{start:3,end:5},{start:7,end:9}]].map(([a,b,kind,from,to])=>({source:node(before,a),target:node(after,b),kind,tabId:'tab-a',segment:{kind:'body'},before:from,after:to}))};
    assert.equal(compareGeneratedEvidence(before,after,request).witnessSatisfied,true);
    assert.equal(world.observe().deliveries,0);
    assert.throws(()=>compareGeneratedEvidence(before,after,{...request,binding:{...request.binding,returnedId:'missing'}}),/scope/);
    world.document=structuredClone(docs.after);world.document.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle={namedStyleType:'HEADING_1',headingId:'returned-heading'};
    const duplicate=await world.inspect(),observed=world.store.semanticSnapshots.get(duplicate.snapshotId,owner,1);
    assert.throws(()=>compareGeneratedEvidence(before,observed,{...request,observation:{binding:binding(observed),predecessorRevision:'r1'}}),/scope/);
  },{document:docs.before});
});
