import test from 'node:test';
import assert from 'node:assert/strict';
import { withWitnessWorld,readTokens } from '../features/docs/support/witness-c-checks.mjs';
import { styleRequest,broadRequest,node } from '../features/docs/support/witness-c-vectors.mjs';
import { createReadEvidenceService } from '../core/docs-semantic/read-evidence-service.mjs';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createSemanticSnapshotStore } from '../adapters/docs-semantic-store.mjs';
import { LIMITS } from '../core/docs-semantic/common.mjs';

test('C pinned read witness survives real SQLite reopen and ordinary expiry without acquiring new coverage',()=>withWitnessWorld(({world,snapshot:s,owner,service})=>{
  const request={snapshotId:s.binding.snapshotId,...styleRequest(s)},handle=service.retain(owner,{request,expires:900000});
  assert.equal(handle.retainedEvidenceOnly,true);assert.equal(handle.binding.subject,owner.subject);
  assert.equal(handle.references.target.nodes[0],node(s,5));
  const db=world.host.bb.storage.database();assert.notEqual(db.name,':memory:');db.close();
  const snapshots=createBbStore(world.host.bb.storage.database(),world.host.bb.storage.migrate).semanticSnapshots;
  const reopened=createReadEvidenceService({snapshots,clock:()=>world.clock});world.clock=600001;
  const before=snapshots.stats(),result=reopened.consume(owner,handle);
  assert.equal(result.witnessSatisfied,true);assert.equal(result.currentReadAuthority,false);assert.equal(result.retainedEvidenceOnly,true);
  assert.equal(result.authoringAuthority,'notEstablished');assert.equal(result.editReady,false);
  assert.deepEqual(result.references,handle.references);assert.deepEqual(snapshots.stats(),before);
  assert.throws(()=>reopened.evaluate(owner,request),/snapshot/);
  assert.throws(()=>reopened.retain(owner,{request,expires:1000000}),/snapshot/);
  assert.throws(()=>reopened.consume(owner,{...handle,expires:1000000}),/conflict/);
  world.clock=899999;assert.equal(reopened.consume(owner,handle).witnessSatisfied,true);
  world.clock=900000;assert.throws(()=>reopened.consume(owner,handle),/snapshot/);
}));
for(const changed of ['subject','account','threadId'])test(`C retained witness refuses changed owner ${changed}`,()=>withWitnessWorld(({snapshot:s,owner,service})=>{
  const handle=service.retain(owner,{request:{snapshotId:s.binding.snapshotId,...styleRequest(s)},expires:900000});
  assert.throws(()=>service.consume({...owner,[changed]:'other'},handle),/snapshot/);
}));
for(const change of ['pin','token','digest','target','subject','revision','unknownInput'])test(`C retained handle refuses altered ${change}`,()=>withWitnessWorld(({snapshot:s,owner,service})=>{
  const handle=structuredClone(service.retain(owner,{request:{snapshotId:s.binding.snapshotId,...styleRequest(s)},expires:900000}));
  if(change==='pin')handle.pinId='other';
  if(change==='token')handle.witnessToken='other';
  if(change==='digest')handle.witnessDigest='0'.repeat(64);
  if(change==='target')handle.references.target.nodes=[node(s,7)];
  if(change==='subject')handle.binding.subject='other';
  if(change==='revision')handle.binding.revision.id='r-other';
  if(change==='unknownInput')handle.selector={node:node(s,7)};
  assert.throws(()=>service.consume(owner,handle),/snapshot|conflict|invalid/);
}));
for(const change of ['pinDeadline','witnessRecord','sourceDelivery','unsealedHistorical'])test(`C retained storage refuses ${change}`,()=>withWitnessWorld(async({world,snapshot:s,owner,service})=>{
  const {originalRecords,...request}=broadRequest(s),read=await readTokens(world,s,request.selector);
  const handle=service.retain(owner,{request:{snapshotId:s.binding.snapshotId,...request,deliveryTokens:read.tokens},expires:900000});
  const db=world.host.bb.storage.database();
  if(change==='pinDeadline')db.prepare('UPDATE docs_semantic_pins SET expires=1000000 WHERE owner=?').run(handle.pinId);
  if(change==='witnessRecord'||change==='sourceDelivery')db.prepare('UPDATE docs_semantic_delivery SET data=? WHERE id=?').run('{"PRIVATE_BODY":true}',change==='witnessRecord'?handle.witnessToken:read.tokens[0]);
  if(change==='unsealedHistorical')db.prepare('DELETE FROM docs_semantic_integrity WHERE snapshot=?').run(s.binding.snapshotId);
  world.clock=600001;
  assert.throws(()=>service.consume(owner,handle),change==='unsealedHistorical'?/unsupported/:/corrupt/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_pins').get().n,1);
}));
test('C retained capacity failure rolls back both the pin and witness record',()=>withWitnessWorld(({world,snapshot:s,owner})=>{
  const db=world.host.bb.storage.database(),base=world.store.semanticSnapshots,old=base.stats();
  const snapshots=createSemanticSnapshotStore(db,{limits:{...LIMITS,poolBytes:old.bytes+2000}});
  const service=createReadEvidenceService({snapshots,clock:()=>0});
  assert.throws(()=>service.retain(owner,{request:{snapshotId:s.binding.snapshotId,...styleRequest(s)},expires:900000}),/budget/);
  assert.deepEqual(base.stats(),old);assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_pins').get().n,0);
}));
test('C retained deadlines use existing immutable maximum and cannot mint authoring from booleans',()=>withWitnessWorld(({snapshot:s,owner,service})=>{
  const request={snapshotId:s.binding.snapshotId,...styleRequest(s)};
  assert.throws(()=>service.retain(owner,{request,expires:1800001}),/budget/);
  assert.throws(()=>service.evaluate(owner,{...request,deliveries:[],approved:true}),/invalid/);
  assert.equal(service.retain(owner,{request,expires:1800000}).expires,1800000);
}));
test('C safe facade failures contain fixed categories, not private error messages or arguments',()=>withWitnessWorld(({snapshot:s,owner,world})=>{
  const service=createReadEvidenceService({snapshots:{get(){throw Object.assign(new Error('PRIVATE_MESSAGE'),{code:'PRIVATE_CODE',cause:'PRIVATE_CAUSE'});}},
    diagnose:(stage,error)=>world.logs.push({stage,message:error.message,category:error.semanticCode})});
  assert.throws(()=>service.evaluate(owner,{snapshotId:s.binding.snapshotId,...styleRequest(s)}),/unavailable/);
  assert.deepEqual(world.logs,[{stage:'docs_read_evidence',message:'Docs semantic unavailable',category:'unavailable'}]);
  assert.ok(!JSON.stringify(world.logs).includes('PRIVATE_'));
}));
