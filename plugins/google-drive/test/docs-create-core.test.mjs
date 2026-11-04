// Real native creation service with in-memory external receipt storage and
// literal provider observations. No fake business-success/verifier port or SQL claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocsCreationService,creationError} from '../core/docs-create.mjs';
const input={account:'creator@example.test',operationId:'11111111-1111-4111-8111-111111111111',folderId:'root',title:'Synthetic notes',text:'Hello 😀\n\nQuestion?'};
function observation(text){let index=1;return {documentId:'created-doc',revisionId:text==='\n'?'blank-r1':'populated-r2',title:'Synthetic notes',suggestionsViewMode:'SUGGESTIONS_INLINE',tabs:[{tabProperties:{tabId:'main',title:'Main'},documentTab:{body:{content:[{endIndex:1,sectionBreak:{}},...text.match(/[^\n]*\n/g).map(content=>{const startIndex=index;index+=content.length;return {startIndex,endIndex:index,paragraph:{elements:[{startIndex,endIndex:index,textRun:{content}}]}};})]}}}]};}
function setup(options={}){
 const receipts=new Map(),trace=[];let creates=0,populates=0,doc=observation('\n');
 const store={byEmail:async()=>({subject:options.subject??'subject',email:input.account}),getCreation:async key=>structuredClone(receipts.get(key)),reserveCreation:async op=>{if(receipts.has(op.operationId))return false;receipts.set(op.operationId,structuredClone(op));return true;},updateCreation:async op=>receipts.set(op.operationId,structuredClone(op))};
 const core=createDocsCreationService({store,drive:{getFile:async(_r,id)=>id==='root'?{id:'root-concrete',trashed:false,mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:options.destination!==false}}:{id:'created-doc',trashed:false,mimeType:'application/vnd.google-apps.document',name:options.wrongTitle?'Unexpected title':input.title,parents:[options.wrongDestination?'foreign-folder':'root-concrete']}},docs:{inspect:async()=>structuredClone(doc)},creation:{prepare:async()=>{if(options.scope===false)throw creationError('scope_required');return {create:async args=>{creates++;trace.push('create');assert.deepEqual(args,{operationId:input.operationId,title:input.title,folderId:'root-concrete'});if(options.lostCreate)throw Error('PRIVATE_LOST');return {id:'created-doc'};},populate:async args=>{populates++;trace.push('populate');assert.deepEqual(args,{documentId:'created-doc',tabId:'main',revisionId:'blank-r1',text:input.text});doc=observation(options.wrongBody?'Not requested\n':input.text+'\n');if(options.lostPopulate)throw Error('PRIVATE_LOST_POPULATE');}};},find:async()=>({files:[{id:'created-doc'}]})},diagnose:stage=>trace.push(stage)});
 return {core,receipts,trace,get creates(){return creates;},get populates(){return populates;}};
}
test('existing native creation creates/populates once and independently verifies exact title/body/destination',async()=>{
 const w=setup(),result=await w.core.create(input);assert.equal(result.outcome,'verified');assert.equal(result.documentId,'created-doc');assert.deepEqual(w.trace,['create','populate']);
 const replay=await w.core.create(input);assert.equal(replay.receiptOnly,true);assert.equal(w.creates,1);assert.equal(w.populates,1);
 await assert.rejects(w.core.create({...input,text:'different'}),e=>e.creationCode==='operation_conflict');
});
for(const kind of ['lostCreate','lostPopulate'])test('existing creation '+kind+' preserves uncertain/partial receipt without blind replay',async()=>{
 const w=setup({[kind]:true}),r=await w.core.create(input);assert.equal(r.outcome,kind==='lostCreate'?'uncertain':'incomplete');assert.equal(r.retrySafe,false);const replay=await w.core.create(input);assert.equal(replay.receiptOnly,true);assert.equal(w.creates,1);assert.equal(w.populates,kind==='lostCreate'?0:1);if(kind==='lostPopulate')assert.equal(replay.documentId,'created-doc');
});
for(const fault of ['wrongBody','wrongTitle','wrongDestination'])test('creation independently rejects '+fault+' after acknowledged creation/population',async()=>{
 const w=setup({[fault]:true}),result=await w.core.create(input);assert.equal(result.outcome,'verification_unavailable');assert.equal(result.documentId,'created-doc');assert.equal(result.retrySafe,false);assert.equal((await w.core.create(input)).receiptOnly,true);assert.equal(w.creates,1);assert.equal(w.populates,1);
});
test('creation rejects invalid input, unavailable destination and missing grant before provider writes',async()=>{
 for(const patch of [{text:''},{text:'bad\u0001'},{title:'bad\n'},{operationId:'not-a-key'}]){const w=setup();await assert.rejects(w.core.create({...input,...patch}),e=>e.creationCode==='invalid_input');assert.equal(w.creates,0);}
 for(const options of [{destination:false},{scope:false}]){const w=setup(options);await assert.rejects(w.core.create(input),e=>['destination_rejected','scope_required'].includes(e.creationCode));assert.equal(w.creates,0);assert.equal(w.receipts.size,0);}
});
