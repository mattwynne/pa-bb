import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {planParagraphBold} from '../core/docs-semantic/planner/paragraph-bold.mjs';
import {createDocsFormatService} from '../core/docs-format.mjs';
import {createSemanticSnapshotStore} from '../adapters/docs-semantic-store.mjs';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createBbStore} from '../adapters/bb-store.mjs';
import {createDraftJournal,SEMANTIC_DRAFT_MIGRATION} from '../adapters/docs-draft-store.mjs';
import {createDraftService} from '../core/docs-semantic/drafts.mjs';
import {materialize} from '../core/docs-semantic/model.mjs';
import {reservation,DRAFT_LIMITS,draftHash,bytes} from '../core/docs-semantic/draft-policy.mjs';
import {LEGACY_KEY_TABLES} from '../core/docs-semantic/draft-catalog.mjs';
import {exerciseDraftJournal} from '../features/docs/support/draft-journal-contract.mjs';
import {draftOwner as owner,draftBinding as binding,validDraftDocument,operationKeys as keys} from './docs-semantic-draft-fixtures.mjs';
const snapshot=()=>materialize({document:validDraftDocument(),metadata:{id:binding.documentId,capabilities:{canEdit:true}},binding,reviewIncluded:true});
const input=s=>({requestId:'sqlite-bold',snapshotId:binding.snapshotId,mode:'direct',command:{op:'paragraphBold',node:Object.values(s.nodes).find(n=>n.kind==='paragraph').id,bold:true}});
function init(h,{limits=DRAFT_LIMITS,diagnose=()=>{}}={}){const db=h.bb.storage.database();assert.notEqual(db.name,':memory:');const store=createBbStore(db,h.bb.storage.migrate),s=snapshot();store.semanticSnapshots.put(s,0);const journal=createDraftJournal(db,{snapshots:store.semanticSnapshots,limits}),service=createDraftService({snapshots:store.semanticSnapshots,journal,clock:()=>1,ids:()=>keys[0],limits,diagnose});return {db,store,s,journal,service};}
const host=()=>createFakePluginHost({pluginId:'semantic-draft-internal-contract'});
const rehashPlan=p=>{const {integrity,...body}=p;p.integrity=draftHash(body);return p;};
test('R1 actual SQL publication rejects a self-hashed A-command/B-target with no pin/head/revision',async()=>{
 const h=host();try{const {db,s,store}=init(h),paragraphs=Object.values(s.nodes).filter(n=>n.kind==='paragraph'),request=input(s);store.semanticDrafts.reserve(reservation(owner,request,keys[0],1));const wrong=structuredClone(planParagraphBold(s,{...request.command,node:paragraphs[1].id},{createdAt:1}));wrong.command=request.command;rehashPlan(wrong);assert.throws(()=>store.semanticDrafts.publish(keys[0],owner,wrong,1),/corrupt/);assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_pins').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_draft_revisions').get().n,0);assert.equal(store.semanticDrafts.byId(owner,keys[0]).record.state,'planning');
 }finally{await h.harness.lifecycle.dispose();}
});
for(const state of ['draft','cancelled'])for(const fault of ['snapshot','request','inner','effect'])test(`R6 ${state} ${fault} semantic corruption fails status/catalog after physical reopen`,async()=>{
 const h=host();try{let {db,s,service}=init(h);const r=service.plan(owner,input(s));if(state==='cancelled')service.cancel(owner,{draftId:r.draftId,expectedDraftHash:r.draftHash});const row=JSON.parse(db.prepare('SELECT receipt FROM docs_semantic_drafts').get().receipt);
 if(fault==='snapshot')row.snapshotId='other';else if(fault==='request')row.requestHash=draftHash({...input(s),command:{...input(s).command,bold:false}});else{const p=structuredClone(r.proposal);if(fault==='inner')p.integrity='0'.repeat(64);else{p.effect.changes[0].before=true;rehashPlan(p);}row.headHash=draftHash(p);db.prepare('INSERT INTO docs_semantic_draft_revisions VALUES (?,?,?)').run(r.operationId,row.headHash,JSON.stringify(p));}
 db.prepare('UPDATE docs_semantic_drafts SET receipt=?,digest=? WHERE operation_id=?').run(JSON.stringify(row),draftHash(row),r.operationId);const retained=db.prepare('SELECT * FROM docs_semantic_drafts').all();db.close();db=h.bb.storage.database();const store=createBbStore(db,h.bb.storage.migrate);service=createDraftService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>2});assert.throws(()=>service.status(owner,{draftId:r.draftId}),/corrupt/);assert.equal(service.operationStatus(owner,{operationId:r.operationId}).status,'unsupported');assert.deepEqual(db.prepare('SELECT * FROM docs_semantic_drafts').all(),retained);
 }finally{await h.harness.lifecycle.dispose();}
});
test('R3 actual v7 formatting preview and SQL-only claim transition preserve historical lookup and handle',async()=>{
 const h=host();try{const {db,store,service}=init(h);await store.addAccount({subject:owner.subject,email:owner.account,refreshToken:'SYNTHETIC_UNUSED'});const id='a0000000-0000-7000-8000-000000000099',document=validDraftDocument();document.tabs[0].documentTab.body.content.unshift({endIndex:1,sectionBreak:{}});const formatter=createDocsFormatService({store,drive:{getFile:async()=>({id:binding.documentId,trashed:false,mimeType:'application/vnd.google-apps.document'})},docs:{inspect:async()=>document},clock:()=>1});assert.equal((await formatter.format({account:owner.account,operationId:id,document:binding.documentId,expectedRevisionId:'r1',ranges:[{tabId:'tab-a',startIndex:1,endIndex:6,textStyle:{bold:true}}],preview:true})).outcome,'proposed');assert.equal(await store.claimFormatting(id,binding.documentId),true);const raw=db.prepare('SELECT * FROM drive_formatting_operations').get(),c=service.operationStatus(owner,{operationId:id});assert.equal(c.status,'candidate');assert.equal(c.candidates[0].status,'reviewing');assert.equal(JSON.parse(raw.receipt).state,'proposed');assert.equal(service.operationStatus(owner,{recoveryHandle:c.candidates[0].recoveryHandle}).status,'candidate');assert.equal(service.operationStatus({...owner,subject:'other'},{recoveryHandle:c.candidates[0].recoveryHandle}).status,'unknown');assert.deepEqual(db.prepare('SELECT * FROM drive_formatting_operations').get(),raw);
 }finally{await h.harness.lifecycle.dispose();}
});
test('R3 actual missing-kind/hash-only and shared-v1 creation envelopes remain legacy, without invented acknowledgement',async()=>{
 const h=host();try{const {db,store,service}=init(h),sha=x=>createHash('sha256').update(x).digest('hex'),old={operationId:keys[1],subject:owner.subject,destinationId:'root-a',requestHash:sha(JSON.stringify(['root','Title','Text'])),titleHash:sha('Title'),textHash:sha('Text\n'),documentId:'doc-a',outcome:'verified',writeAttempted:true};await store.reserveCreation(old);await store.reserveCreation({...old,operationId:keys[2],kind:'document',sharedVersion:1,claimState:'uncertain',outcome:'uncertain',createAcknowledged:true,populateAcknowledged:false});const before=db.prepare('SELECT * FROM docs_creations').all();for(const id of [keys[1],keys[2]]){const c=service.operationStatus(owner,{operationId:id});assert.equal(c.status,'candidate');assert.equal(c.candidates[0].historicalEvidenceVersion,'legacy');assert.equal(c.candidates[0].providerVerification,'notRun');}assert.deepEqual(db.prepare('SELECT * FROM docs_creations').all(),before);assert.equal(Object.hasOwn(JSON.parse(before[0].receipt),'acknowledged'),false);
 }finally{await h.harness.lifecycle.dispose();}
});
for(const bad of [0,false,'','different'])test(`R3 malformed historical operation identity ${JSON.stringify(bad)} cannot be a supported candidate`,async()=>{
 const h=host();try{const {db,service}=init(h);db.prepare('INSERT INTO drive_formatting_operations VALUES (?,?,?,?,?)').run(keys[1],owner.subject,'doc-a','uncertain',JSON.stringify({operationId:bad,subject:owner.subject,documentId:'doc-a',state:'uncertain'}));const before=db.prepare('SELECT * FROM drive_formatting_operations').get();assert.equal(service.operationStatus(owner,{operationId:keys[1]}).status,'unsupported');assert.deepEqual(db.prepare('SELECT * FROM drive_formatting_operations').get(),before);
 }finally{await h.harness.lifecycle.dispose();}
});
for(const outcome of ['created','not_created','verification_unavailable','incomplete','verified','mismatch'])test(`R3 real retained creation-store ${outcome} metadata remains recognized`,async()=>{
 const h=host();try{const {store,service}=init(h),kind=outcome==='mismatch'?'copy':'document';await store.reserveCreation({operationId:keys[1],subject:owner.subject,kind,requestHash:'1'.repeat(64),titleHash:'2'.repeat(64),textHash:'3'.repeat(64),destinationId:'root',outcome,...(outcome==='not_created'?{}:kind==='copy'?{fileId:'copied-file'}:{documentId:'created-doc'})});assert.equal(service.operationStatus(owner,{operationId:keys[1]}).status,'candidate');
 }finally{await h.harness.lifecycle.dispose();}
});
test('R5 failing diagnostic port cannot interrupt SQL publication rollback or rejection persistence',async()=>{
 const h=host();try{const {db,s,service}=init(h,{diagnose:()=>{throw Error('PRIVATE_LOGGER_FAILURE');}});db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON docs_semantic_draft_revisions BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_FAILURE'); END;");const r=service.plan(owner,input(s));assert.equal(r.state,'rejected');assert.equal(r.error,'storage');assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_pins').get().n,0);assert.equal(service.status(owner,{requestId:'sqlite-bold'}).state,'rejected');
 }finally{await h.harness.lifecycle.dispose();}
});
test('same logical contract on real file SQLite; immutable revision and tombstone survive actual close/reopen',async()=>{
 const h=host();try{let db=h.bb.storage.database(),store=createBbStore(db,h.bb.storage.migrate);const proof=exerciseDraftJournal({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,snapshot:snapshot(),owner,keys});assert.equal(proof.state,'cancelled');
 const original=db.prepare('SELECT * FROM docs_semantic_drafts').all(),revision=db.prepare('SELECT * FROM docs_semantic_draft_revisions').all();assert.equal(revision.length,1);
 assert.throws(()=>db.prepare('UPDATE docs_semantic_draft_revisions SET plan=?').run('{}'),/Immutable/);assert.throws(()=>db.exec('DELETE FROM docs_semantic_drafts'),/Retained/);
 db.close();db=h.bb.storage.database();store=createBbStore(db,h.bb.storage.migrate);assert.deepEqual(db.prepare('SELECT * FROM docs_semantic_drafts').all(),original);assert.deepEqual(db.prepare('SELECT * FROM docs_semantic_draft_revisions').all(),revision);
 const service=createDraftService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>1800001,ids:()=>{throw Error('never regenerate');}});assert.equal(service.status(owner,{draftId:proof.key}).state,'cancelled');assert.equal(service.plan(owner,{...input(snapshot()),requestId:'shared-contract'}).state,'cancelled');
 }finally{await h.harness.lifecycle.dispose();}
});
for(const faultTable of ['docs_semantic_pins','docs_semantic_draft_revisions'])test(`pin + revision + head rollback on actual ${faultTable} failure`,async()=>{
 const h=host();try{const {db,s,service}=init(h);const rowsBefore=db.prepare('SELECT * FROM docs_semantic_snapshots').all();db.exec(`CREATE TRIGGER fault_revision BEFORE INSERT ON ${faultTable} BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_SENTINEL'); END;`);const result=service.plan(owner,input(s));assert.equal(result.state,'rejected');assert.equal(result.error,'storage');assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_pins').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_draft_revisions').get().n,0);assert.deepEqual(db.prepare('SELECT * FROM docs_semantic_snapshots').all(),rowsBefore);assert.equal(service.status(owner,{requestId:'sqlite-bold'}).operationId,keys[0]);
 }finally{await h.harness.lifecycle.dispose();}
});
test('failed publication and failed rejection save retain recoverable planning reservation without resume after reopen',async()=>{
 const h=host();try{const logs=[],{db,s,service}=init(h,{diagnose:(...args)=>logs.push(args)});db.exec("CREATE TRIGGER fault_publish BEFORE INSERT ON docs_semantic_draft_revisions BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_SENTINEL'); END; CREATE TRIGGER fault_reject BEFORE UPDATE ON docs_semantic_drafts BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_SENTINEL'); END;");assert.throws(()=>service.plan(owner,input(s)),/storage/);assert.ok(!JSON.stringify(logs).includes('PRIVATE'));assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_pins').get().n,0);db.close();const store=createBbStore(h.bb.storage.database(),h.bb.storage.migrate),recover=createDraftService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>2,ids:()=>{throw Error('no new key');}});const result=recover.plan(owner,input(s));assert.equal(result.state,'planning');assert.equal(result.submission,'not_sent');assert.equal(result.operationId,keys[0]);assert.equal(h.bb.storage.database().prepare('SELECT count(*) n FROM docs_semantic_draft_revisions').get().n,0);
 }finally{await h.harness.lifecycle.dispose();}
});
for(const table of LEGACY_KEY_TABLES)test(`global key: ${table} blocks semantic admission even for another subject; old rows unchanged`,async()=>{
 const h=host();try{const {db,s,service}=init(h);const receipt=JSON.stringify({operationId:keys[0],subject:'foreign',state:'uncertain',PRIVATE:'retained'});const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name),values=columns.map(c=>c==='operation_id'?keys[0]:c==='subject'?'foreign':c==='state'?'uncertain':c==='receipt'?receipt:'legacy-resource');db.prepare(`INSERT INTO ${table} VALUES (${columns.map(()=>'?').join(',')})`).run(...values);const before=db.prepare(`SELECT * FROM ${table}`).all();assert.throws(()=>service.plan(owner,input(s)),/key_conflict/);assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(),before);assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_drafts').get().n,0);assert.deepEqual(service.operationStatus(owner,{operationId:keys[0]}).candidates,[]);
 }finally{await h.harness.lifecycle.dispose();}
});
test('reciprocal guards reject actual legacy reservation consumers after semantic draft and cancelled tombstone',async()=>{
 const h=host();try{const {store,s,service,db}=init(h),result=service.plan(owner,input(s));service.cancel(owner,{draftId:result.draftId,expectedDraftHash:result.draftHash});const op={operationId:keys[0],subject:'another-subject',documentId:'doc',fileId:'file',spreadsheetId:'sheet',resource:'file:file',state:'proposed'};
 for(const call of [()=>store.reserveCreation(op),()=>store.reserveSharing(op),()=>store.reserveFormatting(op),()=>store.images.reserve(op),()=>store.sheetsEdits.reserve(op),()=>store.filing.reserve(op)])await assert.rejects(call,/key conflict/);
 for(const table of LEGACY_KEY_TABLES)assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
 }finally{await h.harness.lifecycle.dispose();}
});
test('same-subject catalog ambiguity/corruption is read-only and handles never select another subject',async()=>{
 const h=host();try{const {db,service}=init(h),key=keys[1],receipt=JSON.stringify({operationId:key,subject:owner.subject,createdAt:7,state:'uncertain'});db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(key,owner.subject,receipt);db.prepare('INSERT INTO drive_formatting_operations VALUES (?,?,?,?,?)').run(key,owner.subject,'legacy-doc','uncertain',receipt);db.prepare('INSERT INTO docs_image_operations VALUES (?,?,?,?,?)').run(keys[2],owner.subject,'image-doc','uncertain','{invalid PRIVATE');
 const changes=db.totalChanges??db.prepare('SELECT total_changes() n').get().n,ambiguous=service.operationStatus(owner,{operationId:key});assert.equal(ambiguous.status,'ambiguous');assert.equal(ambiguous.candidates.length,2);assert.equal(ambiguous.thisCall.providerMutationCount,0);for(const c of ambiguous.candidates){const selected=service.operationStatus(owner,{recoveryHandle:c.recoveryHandle});assert.equal(selected.candidates.length,1);assert.equal(selected.candidates[0].receiptKind,c.receiptKind);assert.equal(service.operationStatus({...owner,subject:'other'},{recoveryHandle:c.recoveryHandle}).status,'unknown');}
 assert.equal(service.operationStatus(owner,{operationId:keys[2]}).status,'unsupported');assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.ok(!JSON.stringify(service.operationStatus(owner,{operationId:keys[2]})).includes('PRIVATE'));
 }finally{await h.harness.lifecycle.dispose();}
});
test('tampered semantic record/revision fails closed; catalog says unsupported and never repairs it',async()=>{
 const h=host();try{const {db,s,service}=init(h);const r=service.plan(owner,input(s));db.prepare('UPDATE docs_semantic_drafts SET digest=? WHERE operation_id=?').run('corrupt',r.operationId);assert.throws(()=>service.status(owner,{draftId:r.draftId}),/corrupt/);assert.equal(service.operationStatus(owner,{operationId:r.operationId}).status,'unsupported');assert.equal(db.prepare('SELECT digest FROM docs_semantic_drafts').get().digest,'corrupt');
 }finally{await h.harness.lifecycle.dispose();}
});
test('two real SQLite connections serialize same-request admission; changed hash conflicts without another key',async()=>{
 const h=host();let second;try{const {db,s,journal}=init(h),r=reservation(owner,input(s),keys[0],1);assert.equal(journal.reserve(r).created,true);second=new Database(db.name);const other=createDraftJournal(second,{snapshots:createSemanticSnapshotStore(second)});assert.equal(other.reserve({...r,operationId:keys[1]}).created,false);assert.throws(()=>other.reserve({...r,operationId:keys[2],requestHash:'0'.repeat(64)}),/request_conflict/);assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_drafts').get().n,1);
 }finally{second?.close();await h.harness.lifecycle.dispose();}
});
test('catalog oversized/unknown records stay bounded unsupported and same-subject reads never mutate',async()=>{
 const h=host();try{const {db,service}=init(h);const receipt=JSON.stringify({operationId:keys[1],subject:owner.subject,state:'uncertain',sharedVersion:2});db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[1],owner.subject,receipt);assert.equal(service.operationStatus(owner,{operationId:keys[1]}).status,'unsupported');db.prepare('INSERT INTO docs_creations VALUES (?,?,?)').run(keys[2],owner.subject,'x'.repeat(DRAFT_LIMITS.catalogBytes+1));assert.equal(service.operationStatus(owner,{operationId:keys[2]}).status,'unsupported');assert.throws(()=>service.operationStatus(owner,{recoveryHandle:'not-a-handle'}),/invalid/);
 }finally{await h.harness.lifecycle.dispose();}
});
test('exact encoded admission capacity; one-byte/count overflow cannot evict a retained reservation',async()=>{
 const h=host();try{const {db,store,s}=init(h),candidate=reservation(owner,input(s),keys[0],1),limit=bytes(candidate),journal=createDraftJournal(db,{snapshots:store.semanticSnapshots,limits:{...DRAFT_LIMITS,totalBytes:limit}});assert.equal(journal.reserve(candidate).created,true);assert.equal(journal.reserve({...candidate,operationId:keys[1]}).created,false);assert.throws(()=>journal.reserve({...candidate,operationId:keys[1],requestId:'another',requestHash:draftHash('other')}),/capacity/);assert.equal(db.prepare('SELECT count(*) n FROM docs_semantic_drafts').get().n,1);
 }finally{await h.harness.lifecycle.dispose();}
});
