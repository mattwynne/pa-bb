import test from 'node:test';
import assert from 'node:assert/strict';
// Additional connections use the real SQLite class supplied by the public host
// database handle; no new package dependency/import or SDK allowlist exception.
import {createBbStore} from '../adapters/bb-store.mjs';
import {createBoldSealService} from '../core/docs-semantic/bold-seal.mjs';
import {createDraftService} from '../core/docs-semantic/drafts.mjs';
import {compareParagraphBold} from '../core/docs-semantic/verification/paragraph-bold.mjs';
import {SEAL_LIMITS} from '../core/docs-semantic/seal-policy.mjs';
import {contextWorld,tableBytes,owner,keys} from './docs-semantic-target-context-fixtures.mjs';
import {boldAfter} from './docs-semantic-draft-fixtures.mjs';
async function world(){const w=await contextWorld();w.seals=createBoldSealService({store:w.store,docs:w.docs,clock:()=>w.now,diagnose:(...args)=>w.diagnostics.push(args)});w.seal=()=>w.seals.sealBold(owner,w.input);return w;}
test('actual inspect/model -> published draft/pin -> real context/current HTTP read -> same-ID atomic semantic seal',async()=>{
 const w=await world();try{
  const head=w.store.semanticDrafts.byId(owner,w.input.operationId),pins=w.db.prepare('SELECT * FROM docs_semantic_pins').all(),before=w.store.semanticSnapshots.stats();
  const r=await w.seal();assert.equal(r.state,'sealed');assert.equal(r.claim,'held');assert.equal(r.operationId,w.draft.operationId);assert.equal(r.draftHash,w.draft.draftHash);assert.equal(r.execution,'sealedNoDispatcher');assert.equal(r.approval,'intent_pending');assert.deepEqual(r.stage,{stageId:'bold-1',submission:'not_sent',intentPersisted:false,verification:'not_run'});
  assert.deepEqual(w.calls.map(c=>c.id),['draft-doc','root','foreign-folder','draft-doc']);
  const saved=w.store.semanticDrafts.byId(owner,w.input.operationId);assert.deepEqual(saved.record,head.record);assert.deepEqual(saved.plan,head.plan);assert.equal(saved.execution.header.origin,'unresolved');
  const writer=w.store.writers.get('semantic',w.input.operationId);assert.equal(writer.kind,'content');assert.equal(writer.operationKind,'paragraphBold/1');assert.equal(writer.submission,'not_sent');assert.equal(writer.phase,'claimed');assert.equal(writer.semanticHeaderDigest,saved.execution.record.headerDigest);
  assert.deepEqual(writer.grants.map(({id,role})=>({id,role})),saved.execution.header.resources);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,1);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution_refs').get().n,1);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_writer_events').get().n,0);assert.deepEqual(w.db.prepare('SELECT * FROM docs_semantic_pins').all(),pins);
  assert.ok(w.store.semanticSnapshots.stats().bytes>=before.bytes+SEAL_LIMITS.futureCredit);
  const retained=w.store.semanticExecutions.evidence(owner,w.input);assert.deepEqual(retained.evidence,JSON.parse(JSON.stringify(retained.evidence)));assert.equal(compareParagraphBold({plan:saved.plan,before:retained,after:boldAfter()}).matched,true);
  const status=w.drafts.status(owner,{draftId:w.input.operationId});assert.equal(status.claim,'held');assert.equal(status.state,'sealed');assert.equal(status.execution,'sealedNoDispatcher');
  const input={requestId:head.record.requestId,snapshotId:head.record.snapshotId,mode:head.plan.mode,command:head.plan.command};assert.equal(w.drafts.plan(owner,input).state,'sealed');
  const catalog=w.drafts.operationStatus(owner,{operationId:w.input.operationId});assert.equal(catalog.status,'candidate');assert.equal(catalog.candidates.length,1);assert.equal(catalog.candidates[0].status,'sealed');assert.equal(catalog.execution,'sealedNoDispatcher');
  const bytes=tableBytes(w.db),calls=w.calls.length;assert.equal((await w.seal()).state,'sealed');assert.deepEqual(tableBytes(w.db),bytes);assert.equal(w.calls.length,calls);
  assert.throws(()=>w.drafts.cancel(owner,{draftId:w.input.operationId,expectedDraftHash:w.input.planHash}),/sealed/);assert.throws(()=>w.db.prepare('UPDATE docs_semantic_drafts SET digest=?').run('changed'),/Sealed/);
 }finally{await w.close();}
});
test('full raw and model survive pin/draft expiry, sweep and physical reopen; ordinary authorities still expire',async()=>{
 const w=await world();try{
  const original=w.store.semanticSnapshots.readPinned('context-snapshot',owner,w.input.operationId,w.now);await w.seal();const charged=w.store.semanticSnapshots.stats().bytes;
  w.now=1800002;w.store.semanticSnapshots.sweep(w.now);
  assert.throws(()=>w.store.semanticSnapshots.get('context-snapshot',owner,w.now));assert.throws(()=>w.store.semanticSnapshots.readPinned('context-snapshot',owner,w.input.operationId,w.now));
  assert.deepEqual(w.store.semanticExecutions.evidence(owner,w.input),original);assert.ok(w.store.semanticSnapshots.stats().bytes>=SEAL_LIMITS.futureCredit);assert.ok(w.store.semanticSnapshots.stats().bytes<=charged);
  const before=tableBytes(w.db);w.db.close();w.db=w.h.bb.storage.database();w.store=createBbStore(w.db,w.h.bb.storage.migrate);assert.deepEqual(tableBytes(w.db),before);assert.deepEqual(w.store.semanticExecutions.evidence(owner,w.input),original);
  const drafts=createDraftService({snapshots:w.store.semanticSnapshots,journal:w.store.semanticDrafts,clock:()=>w.now});const unchanged=tableBytes(w.db);assert.equal(drafts.status({...owner,threadId:'recovery-thread'},{draftId:w.input.operationId}).claim,'held');assert.deepEqual(tableBytes(w.db),unchanged);
 }finally{await w.close();}
});
for(const table of ['docs_semantic_execution','docs_semantic_execution_refs','docs_writer_owners','docs_writer_resources'])for(const timing of ['BEFORE','AFTER'])test(`${timing} INSERT ${table} failure rolls back header/ref/pool/grants/head`,async()=>{
 const w=await world();try{const before=tableBytes(w.db),stats=w.store.semanticSnapshots.stats();w.db.exec(`CREATE TRIGGER injected_seal_failure ${timing} INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_SENTINEL'); END;`);await assert.rejects(w.seal());assert.deepEqual(tableBytes(w.db),before);assert.deepEqual(w.store.semanticSnapshots.stats(),stats);assert.equal(JSON.stringify(w.diagnostics).includes('PRIVATE'),false);}finally{await w.close();}
});
test('generic writer APIs cannot extend a genuine semantic seal or release/advance it outside the atomic controller',async()=>{
 const w=await world();try{await w.seal();const h=w.store.semanticExecutions.byId(owner,w.input.operationId).header,op={operationId:h.operationId,subject:owner.subject,documentId:h.documentId,contextIds:h.resources.filter(g=>g.role==='accessStable').map(g=>g.id),semanticHeaderDigest:w.store.writers.get('semantic',h.operationId).semanticHeaderDigest};
  const before=tableBytes(w.db);
  for(const changed of [{...op,documentId:'another-document'},{...op,contextIds:[...op.contextIds,'undeclared-ancestor']},{...op,contextIds:[]},{...op,semanticHeaderDigest:'0'.repeat(64)}])assert.throws(()=>w.store.writers.acquire('semantic',changed,'content'));
  assert.throws(()=>w.store.writers.fact('semantic',h.operationId,{kind:'intent',stage:'content'}));assert.throws(()=>w.store.writers.start('semantic',op,'content'));assert.throws(()=>w.store.writers.finishLegacy('semantic',op,{kind:'knownNotSent'}));assert.throws(()=>w.store.writers.cancelSemantic(h.operationId,owner,op.semanticHeaderDigest));assert.deepEqual(tableBytes(w.db),before);
  assert.equal(w.store.writers.acquire('semantic',op,'content'),true);assert.deepEqual(tableBytes(w.db),before);assert.equal(w.seals.status(owner,w.input).claim,'held');
 }finally{await w.close();}
});
for(const fault of ['document','ancestor','kind'])test(`new semantic acquisition also derives fixed rights from the actual inserted header, rejects ${fault} DTO atomically`,async()=>{
 const w=await world();try{const acquire=w.store.writers.acquire,before=tableBytes(w.db);w.store.writers.acquire=(namespace,op,kind,commit)=>acquire(namespace,namespace==='semantic'?{...op,...fault==='document'?{documentId:'undeclared-doc'}:fault==='ancestor'?{contextIds:[...op.contextIds,'undeclared-parent']}:{} }:op,namespace==='semantic'&&fault==='kind'?'replacement':kind,commit);await assert.rejects(w.seal());assert.deepEqual(tableBytes(w.db),before);w.store.writers.acquire=acquire;assert.equal((await w.seal()).claim,'held');}finally{await w.close();}
});
test('private known-not-sent cancellation releases only exact semantic rights; header/evidence/key remain',async()=>{
 const w=await world();try{await w.seal();const evidence=w.store.semanticExecutions.evidence(owner,w.input);assert.throws(()=>w.seals.cancelNotSent({...owner,threadId:'other'},w.input),/owner/);assert.throws(()=>w.seals.cancelNotSent({...owner,account:'wrong@example.test'},w.input),/owner/);
  const r=w.seals.cancelNotSent(owner,w.input);assert.equal(r.state,'cancelled');assert.equal(r.claim,'released');assert.equal(r.stage.submission,'not_sent');assert.deepEqual(w.store.writers.resources('semantic',w.input.operationId),[]);assert.deepEqual(w.store.semanticExecutions.evidence(owner,w.input),evidence);assert.equal(w.drafts.status(owner,{draftId:w.input.operationId}).claim,'released');
  const before=tableBytes(w.db);assert.equal(w.seals.cancelNotSent(owner,w.input).state,'cancelled');assert.deepEqual(tableBytes(w.db),before);assert.equal((await w.seal()).state,'cancelled');
 }finally{await w.close();}
});
test('two real connections observe one same-head seal; seal/cancel/head races have one winner',async()=>{
 const w=await world();let other;try{other=new (w.db.constructor)(w.db.name);const second=createBbStore(other,(_db,migrations)=>{assert.equal(migrations.length,13);});await w.seal();assert.equal(second.semanticExecutions.byId(owner,w.input.operationId).record.status,'sealed');assert.throws(()=>second.semanticDrafts.cancel(w.input.operationId,owner,w.input.planHash,w.now),/sealed/);assert.throws(()=>other.prepare('UPDATE docs_semantic_drafts SET digest=? WHERE operation_id=?').run('changed',w.input.operationId),/Sealed/);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,1);
 }finally{other?.close();await w.close();}
});
test('two connections race DIFFERENT real draft heads for one actual provider resource; exactly one seal/rights/ref winner',async()=>{
 const w=await world();let other;try{
  other=new (w.db.constructor)(w.db.name);const second=createBbStore(other,()=>{}),head=w.store.semanticDrafts.byId(owner,w.input.operationId);
  const drafts=createDraftService({snapshots:second.semanticSnapshots,journal:second.semanticDrafts,clock:()=>w.now,ids:()=>keys[3]}),d=drafts.plan(owner,{requestId:'racing-real-draft',snapshotId:head.record.snapshotId,mode:'direct',command:head.plan.command});assert.equal(d.state,'draft');
  let arrived=0,release;const barrier=new Promise(resolve=>{release=resolve;});w.hook=async(_id,u)=>{if(u.hostname==='docs.googleapis.com'){arrived++;if(arrived===2)release();await barrier;}};
  const otherService=createBoldSealService({store:second,docs:w.docs,clock:()=>w.now});
  const results=await Promise.allSettled([w.seal(),otherService.sealBold(owner,{operationId:d.operationId,planHash:d.draftHash})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(arrived,2);
  assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,1);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution_refs').get().n,1);assert.equal(w.db.prepare("SELECT count(*) n FROM docs_writer_owners WHERE namespace='semantic'").get().n,1);
 }finally{other?.close();await w.close();}
});
test('second connection cancel during real provider await wins over the pending seal, atomically',async()=>{
 const w=await world();let other;try{other=new (w.db.constructor)(w.db.name);const second=createBbStore(other,()=>{});w.hook=async(_id,u)=>{if(u.hostname==='docs.googleapis.com')second.semanticDrafts.cancel(w.input.operationId,owner,w.input.planHash,w.now);};await assert.rejects(w.seal());assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution_refs').get().n,0);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_writer_resources').get().n,0);assert.equal(second.semanticDrafts.byId(owner,w.input.operationId).record.state,'cancelled');}finally{other?.close();await w.close();}
});
test('cancel winner prevents later seal without acquiring any execution resources',async()=>{
 const w=await world();try{w.drafts.cancel(owner,{draftId:w.input.operationId,expectedDraftHash:w.input.planHash});const before=tableBytes(w.db);await assert.rejects(w.seal());assert.deepEqual(tableBytes(w.db),before);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);}finally{await w.close();}
});
test('unknown/partial counterfeit stage facts cannot be cancelled or release held resources',async()=>{
 const w=await world();try{await w.seal();w.db.prepare('UPDATE docs_semantic_execution SET record=?').run(JSON.stringify({stage:{submission:'unknown',intentPersisted:true}}));const before=tableBytes(w.db);assert.throws(()=>w.seals.cancelNotSent(owner,w.input));assert.deepEqual(tableBytes(w.db),before);assert.ok(w.db.prepare('SELECT count(*) n FROM docs_writer_resources').get().n>0);}finally{await w.close();}
});
