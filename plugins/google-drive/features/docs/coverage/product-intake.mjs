// Product evidence boundary; synthetic auditEvidence algorithm controls do not
// pass here. Native/core execution is observed on a separate runner-owned channel.
import assert from 'node:assert/strict';
import { fixtureFile, digest } from './audit.mjs';
import { expand } from './expand.mjs';
import { isApplicationOutcome,currentApplicationBoundary } from './execution-adapters.mjs';
import { compareCompanions } from './companions.mjs';
import { implementedRoute, compareExecution, compareInventory, adapterBindings } from './execution-adapters.mjs';
export function assertProductIntake({manifest,registry,results,fixtures,root,receipts=[],inventory,runId,fingerprint,companions}) {
  // Preserve synthetic refusal before every other join (including missing driver).
  for(const result of results){const f=fixtures[result.fixtureId];assert.ok(f,'product fixture missing');assert.ok(!fixtureFile(root,f).auditControlOnly,'synthetic auditControlOnly fixture forbidden on product intake');}
  // Reject unsupported delivery declarations before expensive expansion/trace
  // comparison. This same mandatory join covers empty/missing execution runs.
  for(const [key,state] of Object.entries(manifest.expansion.deliveryOverrides))if(state.status!=='planned')
    assert.ok(results.some(r=>r.key===key&&!r.pickle?.tags.some(t=>t.name==='@bridgeCandidate')),'semantic delivery lacks implemented invocation/readback adapter');
  const records=new Map(expand(manifest).map(r=>[r.caseId,r]));
  const registered=new Set();
  for(const [operation,registration] of Object.entries(registry.operations)){
    assert.ok(Object.keys(registration.variants??{}).length,'registry has no implemented semantic driver / production registered schema');
    for(const [variant,binding] of Object.entries(registration.variants)){
      const record=[...records.values()].find(r=>r.operation===operation&&r.semanticVariant===variant);
      assert.ok(record,'registry has no implemented semantic driver / production registered schema');implementedRoute({...record,...binding,outcomeVariant:undefined});
      assert.ok(results.some(r=>r.key.startsWith(`${record.ledgerId}/${operation}/${variant}/`)),'registry-only without actual execution');registered.add(`${operation}/${variant}`);
    }
  }
  if(results.length)compareInventory(inventory);
  const used=new Set(),localInvocationIds=new Set(),nativeInvocationIds=new Set(),connections=new Set(),databaseFiles=new Set();
  for(const result of results){
    const record=records.get(result.caseId);assert.ok(record,'phantom scenario');implementedRoute(record);
    const candidate=Boolean(result.pickle?.tags.some(t=>t.name==='@bridgeCandidate'));
    if(!candidate)assert.ok(registered.has(`${record.operation}/${record.semanticVariant}`),'result-only without registry');
    const receipt=receipts.find(r=>r.ref===result.ref);assert.ok(receipt,'missing actual adapter invocation record');
    assert.ok(!used.has(receipt.ref),'duplicate execution reuse');used.add(receipt.ref);
    for(const field of ['caseId','key','driver','schema','requestedMode','observedOutcome','fixtureId','fixtureDigest','runId','sourceDigest'])assert.equal(receipt[field],result[field],`execution ${field} binding`);
    assert.equal(receipt.runId,runId,'stale execution run');assert.equal(receipt.sourceDigest,fingerprint,'stale execution source');
    assert.equal(result.key,record.key);assert.equal(result.observedOutcome,record.outcomeVariant);assert.equal(result.driver,record.driver);assert.equal(result.schema,record.schema);assert.equal(result.requestedMode,record.requestedMode);
    assert.equal(receipt.pickleId,result.pickle.id,'execution pickle');assert.equal(receipt.uri,result.pickle.uri,'execution feature');
    assert.deepEqual(receipt.astNodeIds,result.pickle.astNodeIds,'execution AST/Examples');assert.equal(receipt.testCaseStartedId,result.testCaseStartedId,'execution instance');
    assert.deepEqual(receipt.inventory,inventory,'actual inventory drift');
    const fixture=fixtures[result.fixtureId];assert.equal(fixture.caseId,record.caseId,'fixture case identity');assert.equal(receipt.fixtureDigest,fixture.sha256,'execution fixture bytes');assert.deepEqual(receipt.fixtureProvenance,fixture.provenance,'execution fixture provenance');
    const data=fixtureFile(root,fixture);assert.equal(data.caseId,record.caseId,'fixture identity');
    assert.equal(digest(JSON.stringify(receipt.trace)),result.executionDigest,'execution observation digest');
    compareExecution({...record,bridgeCandidate:candidate},data,receipt.trace);
    if(isApplicationOutcome({...record,bridgeCandidate:candidate})){
      assert.deepEqual(receipt.trace.boundary,currentApplicationBoundary(record),'core evidence cannot be relabelled native');
      for(const call of receipt.trace.events){assert.ok(!localInvocationIds.has(call.id),'reused application invocation');localInvocationIds.add(call.id);}
    }else if((['C005','C009'].includes(record.ledgerId)||['docs_read.structure','docs_read.richCell','docs_read.opaque','docs_read.segment','docs_read.view','docs_read.reviewView','docs_find.literal','docs_find.normalization','selector.cardinality'].includes(record.operation))&&!candidate){
      const storage=receipt.trace.localCalls[0].result;
      assert.ok(!connections.has(storage.connectionId)&&!databaseFiles.has(storage.fileDigest),`reused actual ${record.ledgerId} storage connection`);
      connections.add(storage.connectionId);databaseFiles.add(storage.fileDigest);
    }
    for(const event of receipt.trace.events??[])if(event.storage){const a=event.storage[0],file=a.databases.find(d=>d.name==='main').fileDigest;assert.ok(!connections.has(a.connectionId)&&!databaseFiles.has(file),'reused actual discovery storage connection');connections.add(a.connectionId);databaseFiles.add(file);}
    for(const call of [...(receipt.trace.localCalls??[]),...(receipt.trace.selectorCalls??[])]){assert.ok(!localInvocationIds.has(call.id),'reused actual local invocation');localInvocationIds.add(call.id);}
    for(const call of [...(receipt.trace.nativeCalls??[]),...(receipt.trace.events??[]).flatMap(e=>e.nativeCalls??[])]){assert.ok(!nativeInvocationIds.has(call.id),'reused actual native schema invocation');nativeInvocationIds.add(call.id);}
    if(candidate)assert.equal(manifest.expansion.deliveryOverrides[record.key]?.status??'planned','planned','candidate cannot promote delivery');
  }
  assert.equal(used.size,receipts.length,'orphan/interrupted/replayed execution record');
  assert.equal(new Set(receipts.map(r=>r.ref)).size,receipts.length,'duplicate execution reference');
  // Still unwired. Future E/integration must compare actual serving variants and
  // preserve auditEvidence's full closure before changing this closed boundary.
  assert.deepEqual(registry.exposed,[],'no implemented semantic variant may be exposed');
  assert.deepEqual(manifest.expansion.variantExposure,{},'no implemented semantic exposure adapter');
  if(results.some(r=>isApplicationOutcome(records.get(r.caseId)??{})||records.get(r.caseId)?.ledgerId==='C021'))compareCompanions(root,companions,fingerprint,runId);
  return {bridgeCandidates:results.filter(r=>r.pickle?.tags.some(t=>t.name==='@bridgeCandidate')).length,implementedAdapterVariants:Object.keys(adapterBindings()).length};
}
