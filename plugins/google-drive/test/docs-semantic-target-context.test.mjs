import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {contextWorld,tableBytes,owner,FOLDER,DOC} from './docs-semantic-target-context-fixtures.mjs';
import {CONTEXT_LIMITS} from '../core/docs-semantic/target-context.mjs';
import {compareParagraphBold} from '../core/docs-semantic/verification/paragraph-bold.mjs';
import {boldAfter} from './docs-semantic-draft-fixtures.mjs';

test('real inspect/model -> published immutable draft/pin -> real HTTP ancestry, unmarked/non-owned positive; zero local mutations',async()=>{
 const w=await contextWorld();try{
  const before=tableBytes(w.db),r=await w.inspect();
  assert.equal(r.kind,'paragraphBoldTargetContext');assert.equal(r.binding.operationId,w.draft.operationId);assert.equal(r.binding.headHash,w.draft.draftHash);
  assert.deepEqual(r.binding.initialRevision,{kind:'docs',id:'r1',subject:owner.subject});
  assert.equal(r.initialEvidence,'validatedDraftPin');assert.equal(r.currentDocsRevision,'notObserved');
  assert.equal(r.ancestry.status,'observed');assert.equal(r.ancestry.boundary.id,'root-concrete');
  assert.deepEqual(w.calls.map(c=>c.id),['draft-doc','root','foreign-folder']);
  assert.ok(w.calls.every(c=>c.fields==='id,mimeType,trashed,parents,driveId,appProperties'));
  assert.deepEqual(r.resources,[{id:'draft-doc',role:'accessStable'},{id:'draft-doc',role:'contentWrite'},{id:'foreign-folder',role:'accessStable'},{id:'root-concrete',role:'accessStable'}]);
  assert.equal(r.origin.policy,'unresolved');assert.equal(r.origin.observations[0].kind,'unmarked');assert.deepEqual(r.localCoordination.blockers,[]);
  assert.equal(r.seal,'absent');assert.equal(r.claim,'none');assert.equal(r.thisCall.providerMutationCount,0);assert.equal(r.ephemeral,true);
  assert.equal(r.guarantees.atomicWithGoogle,false);assert.equal(r.guarantees.lease,false);assert.ok(Object.isFrozen(r.observations[0].metadata));
  assert.throws(()=>{r.resources.push({});});
  assert.equal(r.observations[0].responseDigest,createHash('sha256').update(JSON.stringify(w.files['draft-doc'])).digest('hex'));
  assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('real reader -> published plan -> independently authored raw after passes independent verifier without transport binding leakage',async()=>{
 const w=await contextWorld();try{
  const before=tableBytes(w.db),snapshot=w.store.semanticSnapshots.readPinned('context-snapshot',owner,w.input.operationId,w.now),plan=w.store.semanticDrafts.byId(owner,w.input.operationId).plan;
  assert.ok(snapshot.binding.responseDigest);assert.ok(snapshot.binding.responseBytes>0);assert.equal(Object.hasOwn(plan.binding,'responseDigest'),false);
  assert.deepEqual(compareParagraphBold({plan,before:snapshot,after:boldAfter()}),{matched:true,changesMatched:true,preservationMatched:true,attribution:'notEstablished'});
  for(const field of ['account','subject','documentId','threadId']){const wrong=structuredClone(snapshot);wrong.binding[field]='counterfeit';assert.throws(()=>compareParagraphBold({plan,before:wrong,after:boldAfter()}));}
  const wrongAfter=boldAfter();wrongAfter.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content='Lost\\n';assert.equal(compareParagraphBold({plan,before:snapshot,after:wrongAfter}).matched,false);
  assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('ordinary snapshot TTL elapsed but exact published draft pin live is supported without extending authority',async()=>{
 const w=await contextWorld();try{w.now=600001;assert.throws(()=>w.store.semanticSnapshots.get('context-snapshot',owner,w.now));const before=tableBytes(w.db);assert.equal((await w.inspect()).ancestry.status,'observed');assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
for(const fault of ['subject','account','thread','head','cancelled','expired','missingPin','corruptPin'])test(`before-I/O ${fault} rejected from actual saved draft`,async()=>{
 const w=await contextWorld();try{
  let identity=owner,input=w.input;
  if(fault==='subject')identity={...owner,subject:'another'};
  if(fault==='account')identity={...owner,account:'other@example.test'};
  if(fault==='thread')identity={...owner,threadId:'other'};
  if(fault==='head')input={...input,planHash:'0'.repeat(64)};
  if(fault==='cancelled')w.drafts.cancel(owner,{draftId:w.input.operationId,expectedDraftHash:w.input.planHash});
  if(fault==='expired')w.now=1800001;
  if(fault==='missingPin')w.db.exec('DELETE FROM docs_semantic_pins');
  if(fault==='corruptPin')w.db.exec("UPDATE docs_semantic_pins SET expires=1800000");
  const before=tableBytes(w.db);await assert.rejects(w.inspect(identity,input));assert.equal(w.calls.length,0);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
for(const boundary of ['authority','target','root','ancestor'])for(const fault of ['removal','subject','cancel','head','expiry','signal'])test(`${boundary} await rechecks ${fault}`,async()=>{
 const w=await contextWorld();try{
  const controller=new AbortController();let fired=false;
  const mutate=()=>{if(fired)return;fired=true;
   if(fault==='removal')w.db.exec('DELETE FROM drive_accounts');
   if(fault==='subject')w.db.exec("UPDATE drive_accounts SET subject='changed'");
   if(fault==='cancel')w.drafts.cancel(owner,{draftId:w.input.operationId,expectedDraftHash:w.input.planHash});
   if(fault==='head')w.db.exec("UPDATE docs_semantic_drafts SET digest='changed-head'");
   if(fault==='expiry')w.now=1800001;
   if(fault==='signal')controller.abort();
  };
  if(boundary==='authority')w.authHook=async()=>mutate();
  else w.hook=async id=>{if(id===({target:'draft-doc',root:'root',ancestor:'foreign-folder'})[boundary])mutate();};
  await assert.rejects(w.inspect(owner,w.input,controller.signal));assert.equal(fired,true);
  assert.equal(w.calls.length,({authority:0,target:1,root:2,ancestor:3})[boundary]);
  assert.ok(w.diagnostics.every(args=>args.length===2&&!JSON.stringify(args).includes(owner.account)));
 }finally{await w.close();}
});
for(const fault of ['wrongId','trashed','wrongType','multipleParents','duplicateParents','cycle','driveMismatch','malformedMarker','ambiguousMarkers'])test(`bounded actual context metadata rejects ${fault} without another GET`,async()=>{
 const w=await contextWorld();try{
  const m=w.files['draft-doc'];
  if(fault==='wrongId')m.id='wrong';if(fault==='trashed')m.trashed=true;if(fault==='wrongType')m.mimeType=FOLDER;
  if(fault==='multipleParents')m.parents=['one','two'];if(fault==='duplicateParents')m.parents=['one','one'];if(fault==='cycle')m.parents=['draft-doc'];
  if(fault==='driveMismatch')w.files['foreign-folder'].driveId='unexpected-drive';
  if(fault==='malformedMarker')m.appProperties={paCopyCreation:'bad'};
  if(fault==='ambiguousMarkers')m.appProperties={paDocsCreation:w.input.operationId,paCopyCreation:w.input.operationId};
  const before=tableBytes(w.db);await assert.rejects(w.inspect());
  assert.equal(w.calls.length,fault==='driveMismatch'?3:1);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('arbitrary parentless folder is unresolved, not My Drive root; root omits parents legitimately',async()=>{
 const w=await contextWorld();try{w.files['foreign-folder'].parents=[];const r=await w.inspect();assert.equal(r.ancestry.status,'unresolved');assert.equal(r.ancestry.reason,'unprovenBoundary');assert.equal(r.resources.some(r=>r.id==='root-concrete'),false);}finally{await w.close();}
});
test('shared drive ancestry is useful but independent boundary is explicitly unavailable; no new grant/admin read',async()=>{
 const w=await contextWorld();try{w.files['draft-doc'].driveId='shared-drive';w.files['draft-doc'].parents=['shared-drive'];w.files['shared-drive']={id:'shared-drive',mimeType:FOLDER,trashed:false,driveId:'shared-drive'};const r=await w.inspect();assert.equal(r.ancestry.status,'unresolved');assert.equal(r.ancestry.reason,'sharedDriveBoundaryNotIndependentlyObserved');assert.deepEqual(w.calls.map(c=>c.id),['draft-doc','shared-drive']);assert.ok(r.missingPrerequisites.includes('ancestryBoundary'));}finally{await w.close();}
});
test('early response cap and redacted errors never expose provider secrets or fetch another parent',async()=>{
 const w=await contextWorld();try{w.files['draft-doc']=new Response('PRIVATE_SECRET'.repeat(6000));const before=tableBytes(w.db);await assert.rejects(w.inspect(),/budget/);assert.equal(w.calls.length,1);assert.deepEqual(tableBytes(w.db),before);assert.equal(JSON.stringify(w.diagnostics).includes('PRIVATE'),false);}finally{await w.close();}
});
test('depth/resource envelope checked on actual growing rights before next GET',async()=>{
 const w=await contextWorld();try{
  w.files['draft-doc'].parents=['p-0'];for(let i=0;i<40;i++)w.files[`p-${i}`]={id:`p-${i}`,mimeType:FOLDER,trashed:false,parents:[`p-${i+1}`]};
  await assert.rejects(w.inspect(),/budget|capacity/);assert.ok(w.calls.length<=CONTEXT_LIMITS.calls);assert.equal(w.calls.at(-1).id,'p-29');
 }finally{await w.close();}
});
for(const fault of ['account','subject','head','expiry','pin','signal'])test(`final synchronous local capture rechecks ${fault} before returning`,async()=>{
 const w=await contextWorld();try{
  const controller=new AbortController(),read=w.store.writers.readTargetContextFacts;
  w.store.writers.readTargetContextFacts=input=>{const raw=read(input);
   if(fault==='account')w.db.exec('DELETE FROM drive_accounts');
   if(fault==='subject')w.db.exec("UPDATE drive_accounts SET subject='changed'");
   if(fault==='head')w.db.exec("UPDATE docs_semantic_drafts SET digest='changed'");
   if(fault==='expiry')w.now=1800001;
   if(fault==='pin')w.db.exec('DELETE FROM docs_semantic_pins');
   if(fault==='signal')controller.abort();
   return raw;
  };
  await assert.rejects(w.inspect(owner,w.input,controller.signal));assert.equal(w.calls.length,3);
 }finally{await w.close();}
});
test('aggregate raw-byte budget refuses next GET even when large whitespace leaves a small parsed graph',async()=>{
 const w=await contextWorld();try{
  w.files['draft-doc'].parents=['p0'];w.files.p0={id:'p0',mimeType:FOLDER,trashed:false,parents:['p1']};w.files.p1={id:'p1',mimeType:FOLDER,trashed:false,parents:['p2']};w.files.p2={id:'p2',mimeType:FOLDER,trashed:false,parents:['root-concrete']};
  for(const id of Object.keys(w.files)){const text=JSON.stringify(w.files[id]);w.files[id]=new Response(text+' '.repeat(60000-text.length));}
  await assert.rejects(w.inspect(),/budget/);assert.deepEqual(w.calls.map(c=>c.id),['draft-doc','root','p0','p1']);
 }finally{await w.close();}
});
test('result observation envelope refuses oversized parsed metadata before root GET',async()=>{
 const w=await contextWorld();try{w.files['draft-doc'].unexpected='x'.repeat(59000);await assert.rejects(w.inspect(),/budget/);assert.equal(w.calls.length,1);}finally{await w.close();}
});
test('4KiB future full grant envelope enforced as real long IDs grow, not impossible maximum reserved upfront',async()=>{
 const w=await contextWorld();try{const ids=Array.from({length:25},(_,i)=>`${i}-`+'x'.repeat(250));w.files['draft-doc'].parents=[ids[0]];ids.forEach((id,i)=>w.files[id]={id,mimeType:FOLDER,trashed:false,parents:[ids[i+1]??'root-concrete']});await assert.rejects(w.inspect(),/capacity/);assert.ok(w.calls.length<20);}finally{await w.close();}
});
