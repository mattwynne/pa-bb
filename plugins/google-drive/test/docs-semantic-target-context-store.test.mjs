import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocsFormatService} from '../core/docs-format.mjs';
import {contextWorld,tableBytes,owner,keys,DOC,FOLDER} from './docs-semantic-target-context-fixtures.mjs';
import {validDraftDocument} from './docs-semantic-draft-fixtures.mjs';
const H='1'.repeat(64);
async function actualFormatting(w,id='draft-doc'){
 const document=validDraftDocument();document.documentId=id;document.tabs[0].documentTab.body.content.unshift({endIndex:1,sectionBreak:{}});
 const format=createDocsFormatService({store:w.store,drive:{getFile:async()=>({id,trashed:false,mimeType:DOC})},docs:{inspect:async()=>document},clock:()=>w.now});
 const result=await format.format({account:owner.account,operationId:keys[1],document:id,expectedRevisionId:'r1',ranges:[{tabId:'tab-a',startIndex:1,endIndex:6,textStyle:{bold:true}}],preview:true});
 assert.equal(result.outcome,'proposed');assert.equal(await w.store.claimFormatting(keys[1],id),true);
 return JSON.parse(w.db.prepare('SELECT receipt FROM drive_formatting_operations WHERE operation_id=?').get(keys[1]).receipt);
}
test('actual formatter preview+SQL claim appearing between GETs surfaces at final raw cut; SQL state beats lagging JSON',async()=>{
 const w=await contextWorld();try{
  let afterWriter;
  w.hook=async id=>{if(id==='root'){await actualFormatting(w);afterWriter=tableBytes(w.db);}};
  const r=await w.inspect();
  assert.equal(w.db.prepare('SELECT state FROM drive_formatting_operations').get().state,'reviewing');
  assert.equal(JSON.parse(w.db.prepare('SELECT receipt FROM drive_formatting_operations').get().receipt).state,'proposed');
  assert.ok(r.localCoordination.blockers.some(b=>b.namespace==='drive_formatting_operations'&&b.source==='legacyFacts'));
  assert.ok(r.localCoordination.blockers.some(b=>b.source==='physicalRights'));
  assert.deepEqual(tableBytes(w.db),afterWriter);assert.equal(r.guarantees.atomicWithGoogle,false);
 }finally{await w.close();}
});
test('sharing observed ancestor conflicts; unrelated formatting and read/read contexts do not',async()=>{
 const w=await contextWorld();try{
  await actualFormatting(w,'unrelated-doc');
  const creator={operationId:keys[2],subject:owner.subject,kind:'document',destinationId:'foreign-folder',outcome:'reserved'};
  await w.store.reserveCreation(creator);assert.equal(await w.store.beginNativeCreation(creator),true);
  const first=await w.inspect();assert.equal(first.localCoordination.blockers.length,0);
  const sharing={operationId:keys[3],subject:'other-subject',fileId:'root-concrete',state:'proposed'};
  await w.store.reserveSharing(sharing);assert.equal(await w.store.claimSharing(sharing.operationId,sharing.fileId),true);
  const before=tableBytes(w.db),r=await w.inspect();
  assert.ok(r.localCoordination.blockers.some(b=>b.namespace==='drive_sharing_operations'&&b.resources.some(g=>g.id==='root-concrete'&&g.role==='accessMutation')));
  assert.ok(!JSON.stringify(r).includes('other-subject'));assert.ok(!JSON.stringify(r).includes(sharing.operationId));assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('actual native ACK survives blocked attachment: held known ID without grant is in raw cut and core blockers',async()=>{
 const w=await contextWorld();try{
  const op={operationId:keys[2],subject:owner.subject,kind:'document',destinationId:'foreign-folder',outcome:'reserved',requestHash:H,titleHash:H,textHash:H};
  await w.store.reserveCreation(op);assert.equal(await w.store.beginNativeCreation(op),true);assert.equal(await w.store.startNativeCreation(op),true);
  await actualFormatting(w);
  assert.equal(await w.store.attachNativeCreated({...op,documentId:'draft-doc',outcome:'created'},{id:'draft-doc'}),false);
  const held=w.store.writers.get('docs_creations',op.operationId);assert.equal(held.createAcknowledged,true);assert.equal(held.createdId,'draft-doc');assert.ok(!held.grants.some(g=>g.id==='draft-doc'));
  const before=tableBytes(w.db),raw=w.store.writers.readTargetContextFacts({resourceIds:['draft-doc','foreign-folder','root-concrete'],markerKeys:[]});
  assert.ok(raw.owners.some(r=>r.key===op.operationId&&r.resources.every(g=>g.id!=='draft-doc')));
  const r=await w.inspect();assert.ok(r.localCoordination.blockers.some(b=>b.namespace==='docs_creations'&&b.source==='heldKnownId'));
  assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
for(const fault of ['removedRight','extraRight','changedRole','missingEvent','badGenesis','orphan'])test(`raw C1 integrity fails closed without writes: ${fault}`,async()=>{
 const w=await contextWorld();try{
  await actualFormatting(w);
  if(fault==='removedRight')w.db.prepare("DELETE FROM docs_writer_resources WHERE role='contentWrite'").run();
  if(fault==='extraRight')w.db.prepare('INSERT INTO docs_writer_resources VALUES (?,?,?,?,?)').run('drive_formatting_operations',keys[1],'extra','accessStable','grant');
  if(fault==='changedRole')w.db.exec("UPDATE docs_writer_resources SET grant_kind='pending'");
  if(fault==='missingEvent'){await w.store.startFormattingWrite({...JSON.parse(w.db.prepare('SELECT receipt FROM drive_formatting_operations').get().receipt),state:'writing'});w.db.exec('DROP TRIGGER writer_event_no_delete; DELETE FROM docs_writer_events');}
  if(fault==='badGenesis'){w.db.exec('DROP TRIGGER writer_owner_identity_no_update');w.db.prepare('UPDATE docs_writer_owners SET initial_record=?').run('{}');}
  if(fault==='orphan')w.db.prepare('INSERT INTO docs_writer_resources VALUES (?,?,?,?,?)').run('drive_formatting_operations',keys[2],'draft-doc','contentWrite','grant');
  const before=tableBytes(w.db);await assert.rejects(w.inspect(),/corrupt/);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
for(const binding of [{copyBindingVersion:1},{copyBindingVersion:null},{copySource:null},{kind:'document',copyBindingVersion:1},{kind:'copy',copyBindingVersion:2}])test(`C-B1 positive declaration selected even lost pointers/wrong kind/state: ${JSON.stringify(binding)}`,async()=>{
 const w=await contextWorld();try{
  const receipt={operationId:keys[1],subject:'PRIVATE_OTHER_SUBJECT',outcome:'verified',...binding};
  w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[1],receipt.subject,JSON.stringify(receipt));
  const before=tableBytes(w.db);await assert.rejects(w.inspect(),/unsupported/);assert.deepEqual(tableBytes(w.db),before);assert.equal(JSON.stringify(w.diagnostics).includes('PRIVATE'),false);
 }finally{await w.close();}
});
for(const marker of ['paDocsCreation','paCopyCreation','paLocalUpload','paFilingCreation'])test(`all applicable marker namespaces classified from same capture: ${marker}`,async()=>{
 const w=await contextWorld();try{
  const filing=marker==='paFilingCreation',target=filing?'foreign-folder':'draft-doc',kind=({paDocsCreation:'document',paCopyCreation:'copy',paLocalUpload:'upload',paFilingCreation:'folder'})[marker];
  w.files[target].appProperties={[marker]:keys[2]};
  const receipt={operationId:keys[2],subject:'PRIVATE_OTHER_SUBJECT',kind,destinationId:'root-concrete',requestHash:H,titleHash:H,textHash:H,outcome:'verified',...(filing?{fileId:target,resource:`folder:${target}`,fingerprint:H,destinationFingerprint:H,state:'verified'}:kind==='document'?{documentId:target}:kind==='upload'?{fileId:target,nameHash:H,sha256:H,mode:'docx_to_doc',resultMime:DOC,claimState:'verified',acknowledged:true}:{fileId:target,mimeType:DOC,acknowledged:true})};
  if(filing)w.db.prepare('INSERT INTO drive_filing_operations VALUES (?,?,?,?,?)').run(keys[2],receipt.subject,receipt.resource,'verified',JSON.stringify(receipt));
  else w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[2],receipt.subject,JSON.stringify(receipt));
  const before=tableBytes(w.db),r=await w.inspect();assert.ok(r.origin.observations.some(o=>o.marker===marker&&o.kind==='historicalMarker'&&o.scope==='legacyOnly'));
  assert.equal(r.origin.policy,'unresolved');assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('paSheetsCreation is recognized but cannot certify a Docs bold target: genuine retained Sheets marker/type mismatch refuses',async()=>{
 const w=await contextWorld();try{
  w.files['draft-doc'].appProperties={paSheetsCreation:keys[2]};
  const receipt={operationId:keys[2],subject:owner.subject,kind:'spreadsheet',destinationId:'root-concrete',requestHash:H,titleHash:H,contentHash:H,spreadsheetId:'draft-doc',outcome:'verified'};
  w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[2],owner.subject,JSON.stringify(receipt));const before=tableBytes(w.db);await assert.rejects(w.inspect());assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('unknown native marker remains observation only: no observeNativeMarker event/grant/ACK',async()=>{
 const w=await contextWorld();try{
  const op={operationId:keys[2],subject:owner.subject,kind:'document',destinationId:'foreign-folder',outcome:'reserved',requestHash:H,titleHash:H,textHash:H};
  await w.store.reserveCreation(op);await w.store.beginNativeCreation(op);await w.store.startNativeCreation(op);
  w.files['draft-doc'].appProperties={paDocsCreation:keys[2]};
  const before=tableBytes(w.db),r=await w.inspect();assert.equal(r.origin.observations[0].kind,'nativeObservation');assert.deepEqual(tableBytes(w.db),before);
  assert.equal(w.store.writers.get('docs_creations',op.operationId).createAcknowledged,false);assert.deepEqual(w.store.writers.get('docs_creations',op.operationId).observedIds,[]);
 }finally{await w.close();}
});
test('actual native observed result blocked attachment remains held known-ID evidence, never ACK',async()=>{
 const w=await contextWorld();try{
  const op={operationId:keys[2],subject:owner.subject,kind:'document',destinationId:'foreign-folder',outcome:'reserved'};
  await w.store.reserveCreation(op);await w.store.beginNativeCreation(op);await w.store.startNativeCreation(op);await actualFormatting(w);
  await w.store.stopNativeCreation({...op,documentId:'draft-doc'});
  const held=w.store.writers.get('docs_creations',op.operationId);assert.equal(held.createAcknowledged,false);assert.equal(held.createdId,null);assert.deepEqual(held.observedIds,['draft-doc']);assert.ok(!held.grants.some(g=>g.id==='draft-doc'));
  const before=tableBytes(w.db),r=await w.inspect();assert.ok(r.localCoordination.blockers.some(b=>b.namespace==='docs_creations'&&b.source==='heldKnownId'));assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('same UUID in historical producer namespaces does not merge identities or grant delegation',async()=>{
 const w=await contextWorld();try{
  const op={operationId:keys[2],subject:owner.subject,kind:'document',destinationId:'foreign-folder',documentId:'draft-doc',outcome:'verified',requestHash:H,titleHash:H,textHash:H};
  await w.store.reserveCreation(op);
  const filing={operationId:keys[2],subject:'FOREIGN_SUBJECT',kind:'move',resource:'file:draft-doc',fileId:'draft-doc',state:'proposed'};
  w.db.prepare('INSERT INTO drive_filing_operations VALUES (?,?,?,?,?)').run(keys[2],filing.subject,filing.resource,'uncertain',JSON.stringify(filing));
  w.files['draft-doc'].appProperties={paDocsCreation:keys[2]};
  const before=tableBytes(w.db),r=await w.inspect();assert.equal(r.origin.observations[0].kind,'historicalMarker');assert.ok(r.localCoordination.blockers.some(b=>b.namespace==='drive_filing_operations'));assert.equal(r.claim,'none');assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
test('mixed-case provider IDs and actual UUID marker keys are accepted by raw read grammar',async()=>{
 const w=await contextWorld();try{const before=tableBytes(w.db),facts=w.store.writers.readTargetContextFacts({resourceIds:['Doc_A','Folder-2'],markerKeys:[keys[1]]});assert.deepEqual(facts.resourceIds,['Doc_A','Folder-2']);assert.equal(facts.markers[0].key,keys[1]);assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
for(const table of ['drive_formatting_operations','docs_image_operations','drive_sheets_edits','drive_sharing_operations','drive_filing_operations','docs_creations'])test(`actual retained ${table} SQL row participates in final observation`,async()=>{
 const w=await contextWorld();try{
  const sharing=table==='drive_sharing_operations',filing=table==='drive_filing_operations',creation=table==='docs_creations';
  const receipt={operationId:keys[2],subject:'FOREIGN_SUBJECT',state:'proposed',...(filing?{kind:'move',resource:'file:draft-doc',fileId:'draft-doc'}:sharing?{fileId:'draft-doc'}:table==='drive_sheets_edits'?{spreadsheetId:'draft-doc'}:{documentId:'draft-doc'}),...(creation?{kind:'document',destinationId:'foreign-folder',outcome:'created'}:{})};
  if(creation)w.db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[2],receipt.subject,JSON.stringify(receipt));
  else w.db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?)`).run(keys[2],receipt.subject,filing?'file:draft-doc':'draft-doc','uncertain',JSON.stringify(receipt));
  const before=tableBytes(w.db),r=await w.inspect();assert.ok(r.localCoordination.blockers.some(b=>b.namespace===table&&b.source==='legacyFacts'));assert.deepEqual(tableBytes(w.db),before);assert.equal(JSON.stringify(r).includes(receipt.subject),false);
 }finally{await w.close();}
});
test('raw capture is stable/digest-bound and read-only with no ordinary writers',async()=>{
 const w=await contextWorld();try{const input={resourceIds:['draft-doc','foreign-folder','root-concrete'],markerKeys:[]},before=tableBytes(w.db);assert.deepEqual(w.store.writers.readTargetContextFacts(input),w.store.writers.readTargetContextFacts(input));assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
test('legacy candidate pressure refuses rather than truncates same-cut facts',async()=>{
 const w=await contextWorld();try{
  const insert=w.db.prepare('INSERT INTO drive_sharing_operations VALUES (?,?,?,?,?)');w.db.transaction(()=>{for(let i=0;i<1025;i++)insert.run(`pressure-${i}`,owner.subject,'draft-doc','verified',JSON.stringify({state:'verified'}));})();
  const before=tableBytes(w.db);await assert.rejects(w.inspect(),/capacity/);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
