import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoldSealService} from '../core/docs-semantic/bold-seal.mjs';
import {createSealStore} from '../adapters/docs-seal-store.mjs';
import {createSemanticSnapshotStore} from '../adapters/docs-semantic-store.mjs';
import {LIMITS} from '../core/docs-semantic/common.mjs';
import {SEAL_LIMITS} from '../core/docs-semantic/seal-policy.mjs';
import {contextWorld,tableBytes,owner,keys} from './docs-semantic-target-context-fixtures.mjs';
import {validDraftDocument} from './docs-semantic-draft-fixtures.mjs';
const H='1'.repeat(64);
async function world(){const w=await contextWorld();w.seals=createBoldSealService({store:w.store,docs:w.docs,clock:()=>w.now,diagnose:(...args)=>w.diagnostics.push(args)});w.seal=()=>w.seals.sealBold(owner,w.input);return w;}
for(const fault of ['subject','account','thread','head','cancel','expiry','pin'])test(`actual seal validates ${fault} before provider I/O`,async()=>{
 const w=await world();try{let who=owner,input=w.input;if(fault==='subject')who={...owner,subject:'wrong'};if(fault==='account')who={...owner,account:'wrong@example.test'};if(fault==='thread')who={...owner,threadId:'wrong'};if(fault==='head')input={...input,planHash:'0'.repeat(64)};if(fault==='cancel')w.drafts.cancel(owner,{draftId:input.operationId,expectedDraftHash:input.planHash});if(fault==='expiry')w.now=1800001;if(fault==='pin')w.db.exec('DELETE FROM docs_semantic_pins');const before=tableBytes(w.db);await assert.rejects(w.seals.sealBold(who,input));assert.equal(w.calls.length,0);assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
for(const fault of ['revision','content','account','subject','expiry','pin','head','signal'])test(`after real fresh Docs read ${fault} drift stops seal`,async()=>{
 const w=await world();try{const controller=new AbortController();w.hook=async(_id,u)=>{if(u.hostname!=='docs.googleapis.com')return;
  if(fault==='revision'){w.readDocument=validDraftDocument();w.readDocument.revisionId='r2';}
  if(fault==='content'){w.readDocument=validDraftDocument();w.readDocument.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content='Drift\n';}
  if(fault==='account')w.db.exec('DELETE FROM drive_accounts');if(fault==='subject')w.db.exec("UPDATE drive_accounts SET subject='changed'");if(fault==='expiry')w.now=1800001;if(fault==='pin')w.db.exec('DELETE FROM docs_semantic_pins');if(fault==='head')w.db.exec("UPDATE docs_semantic_drafts SET digest='changed'");if(fault==='signal')controller.abort();
 };await assert.rejects(w.seals.sealBold(owner,w.input,controller.signal));assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution_refs').get().n,0);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_writer_resources').get().n,0);
 }finally{await w.close();}
});
test('current raw result obligation appearing AFTER ephemeral context is re-decoded in seal transaction',async()=>{
 const w=await world();try{w.hook=async(_id,u)=>{if(u.hostname==='docs.googleapis.com')await w.store.reserveCreation({operationId:keys[1],subject:owner.subject,kind:'copy',sourceId:'other-source',destinationId:'root-concrete',mimeType:'application/vnd.google-apps.document',copyBindingVersion:1,copySource:{id:'other-source',mimeType:'application/vnd.google-apps.document',trashed:false,canCopy:true},fileId:'draft-doc',acknowledged:true,outcome:'uncertain',requestHash:H,titleHash:H});};await assert.rejects(w.seal(),/conflict/);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);assert.equal((await w.store.getCreation(keys[1])).acknowledged,true);}finally{await w.close();}
});
for(const delta of [-1,8192])test(`actual finite pool admission future credit delta ${delta}: rollback or small-doc positive`,async()=>{
 const w=await world();try{const bytes=w.store.semanticSnapshots.stats().bytes,small=createSemanticSnapshotStore(w.db,{limits:{...LIMITS,poolBytes:bytes+SEAL_LIMITS.futureCredit+delta}});w.store.semanticExecutions=createSealStore(w.db,{snapshots:small,writers:w.store.writers,draft:()=>w.store.semanticDrafts});const before=tableBytes(w.db);if(delta<0){await assert.rejects(w.seal(),/budget/);assert.deepEqual(tableBytes(w.db),before);}else{assert.equal((await w.seal()).state,'sealed');assert.ok(small.stats().bytes<=bytes+SEAL_LIMITS.futureCredit+delta);}}finally{await w.close();}
});
for(const declaration of [{copyBindingVersion:1},{copyBindingVersion:null},{copySource:null},{kind:'document',copyBindingVersion:1},{kind:'copy',copyBindingVersion:2}])test(`seal preserves C-B1 positive syntactic superset ${JSON.stringify(declaration)}`,async()=>{
 const w=await world();try{const p={operationId:keys[1],subject:owner.subject,outcome:'verified',...declaration};w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[1],owner.subject,JSON.stringify(p));const before=tableBytes(w.db);await assert.rejects(w.seal(),/unsupported/);assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
for(const fault of ['rightRemoved','rightExtra','rightKind','header','ref','refMissing','model'])test(`retained genuine semantic seal corruption ${fault} never unlocks or repairs`,async()=>{
 const w=await world();try{await w.seal();
  if(fault==='rightRemoved')w.db.exec("DELETE FROM docs_writer_resources WHERE role='contentWrite'");
  if(fault==='rightExtra')w.db.prepare('INSERT INTO docs_writer_resources VALUES (?,?,?,?,?)').run('semantic',w.input.operationId,'extra','accessStable','grant');
  if(fault==='rightKind')w.db.exec("UPDATE docs_writer_resources SET grant_kind='pending'");
  if(fault==='header'){w.db.exec('DROP TRIGGER semantic_execution_identity_no_update');w.db.exec("UPDATE docs_semantic_execution SET digest='changed'");}
  if(fault==='ref'){w.db.exec('DROP TRIGGER semantic_execution_ref_identity_no_update');w.db.exec("UPDATE docs_semantic_execution_refs SET digest='changed'");}
  if(fault==='refMissing'){w.db.exec('DROP TRIGGER semantic_execution_ref_no_delete; DELETE FROM docs_semantic_execution_refs');}
  if(fault==='model')w.db.exec("UPDATE docs_semantic_snapshots SET model_digest='changed'");
  const before=tableBytes(w.db);assert.throws(()=>w.seals.cancelNotSent(owner,w.input));assert.throws(()=>w.seals.status(owner,w.input));assert.deepEqual(tableBytes(w.db),before);assert.ok(w.db.prepare('SELECT count(*) n FROM docs_writer_resources').get().n>0);
  const catalog=w.drafts.operationStatus(owner,{operationId:w.input.operationId});assert.equal(catalog.status,'unsupported');assert.equal(catalog.execution,'retainedSealUnsupported');
 }finally{await w.close();}
});
for(const fault of ['missingRef','missingRefTable','badHeader'])test(`sweep cannot erase original full source for retained execution ${fault}`,async()=>{
 const w=await world();try{await w.seal();const source=w.db.prepare('SELECT * FROM docs_semantic_snapshots').all(),raw=w.db.prepare('SELECT * FROM docs_semantic_evidence').all();
  if(fault==='missingRef'){w.db.exec('DROP TRIGGER semantic_execution_ref_no_delete; DELETE FROM docs_semantic_execution_refs');}
  if(fault==='missingRefTable')w.db.exec('DROP TABLE docs_semantic_execution_refs');
  if(fault==='badHeader'){w.db.exec('DROP TRIGGER semantic_execution_identity_no_update');w.db.prepare('UPDATE docs_semantic_execution SET header=?').run('{}');}
  w.now=1800002;if(fault==='missingRef')w.store.semanticSnapshots.sweep(w.now);else assert.throws(()=>w.store.semanticSnapshots.sweep(w.now));
  assert.deepEqual(w.db.prepare('SELECT * FROM docs_semantic_snapshots').all(),source);assert.deepEqual(w.db.prepare('SELECT * FROM docs_semantic_evidence').all(),raw);assert.ok(w.db.prepare('SELECT count(*) n FROM docs_writer_resources').get().n>0);
 }finally{await w.close();}
});
for(const kind of ['sharedBoundary','sheetMime'])test(`unsupported ${kind} refuses first seal without fabricated coverage`,async()=>{
 const w=await world();try{if(kind==='sharedBoundary'){w.files['draft-doc'].driveId='shared-drive';w.files['draft-doc'].parents=['shared-drive'];w.files['shared-drive']={id:'shared-drive',driveId:'shared-drive',mimeType:'application/vnd.google-apps.folder',trashed:false};}else w.files['draft-doc'].mimeType='application/vnd.google-apps.spreadsheet';const before=tableBytes(w.db);await assert.rejects(w.seal());assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
test('ordinary snapshot expiry with live draft pin can produce genuine seal, no new read authority',async()=>{
 const w=await world();try{w.now=600001;assert.equal((await w.seal()).state,'sealed');assert.throws(()=>w.store.semanticSnapshots.get('context-snapshot',owner,w.now));}finally{await w.close();}
});
