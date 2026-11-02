import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorld,pending,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {tableBytes} from './docs-semantic-target-context-fixtures.mjs';
import {createBoldSealService} from '../core/docs-semantic/bold-seal.mjs';

test('actual SDK owner form -> genuine reader/draft/seal -> one exact native batch -> durable ACK -> independent r2 match/release',async()=>{
 const w=await nativeWorld();try{const promise=w.run(),form=await pending(w);assert.equal(w.posts,0);assert.equal(form.rendererId,'docs-format-approval');assert.equal(form.threadId,owner.threadId);assert.equal(form.payload.account,owner.account);assert.equal(form.payload.selections[0].paragraphs[0].text,'A😀x\n');assert.deepEqual(form.payload.selections[0].textStyle,{bold:true});assert.match(form.payload.limits,/Effective BEFORE bold\/provenance\/source/);w.h.harness.behavior.submitInteraction(form.id,{approved:true});const r=parse(await promise);assert.equal(r.state,'verified');assert.equal(r.submission,'acknowledged');assert.equal(r.claim,'released');assert.equal(r.approval,'owner_approved');assert.equal(r.thisCall.providerMutationCount,1);assert.equal(w.posts,1);assert.equal(w.afterGets,1);const saved=w.store.semanticExecutions.byId(owner,keys[0]);assert.equal(saved.record.response.revisionId,'r2');assert.equal(saved.record.stage.verification,'matched');const bytes=tableBytes(w.db);assert.equal(parse(await w.run()).thisCall.providerMutationCount,0);assert.equal(w.handler.service.status(owner,w.input).thisCall.providerMutationCount,0);assert.equal(parse(await w.h.harness.behavior.callAgentTool(w.handler.statusDefinition.name,w.args,{threadId:'status-reader'})).thisCall.providerMutationCount,0);assert.equal(w.posts,1);assert.deepEqual(tableBytes(w.db),bytes);
 }finally{await w.close();}
});
test('actual standing content policy uses no form and never claims owner approval',async()=>{
 const w=await nativeWorld({approval:false});try{const r=parse(await w.run());assert.equal(r.state,'verified');assert.equal(r.approval,'standing_content_consent');assert.equal(w.h.harness.inspection.pendingInteractions.length,0);assert.equal(w.posts,1);}finally{await w.close();}
});
for(const value of [{approved:false},{approved:true,extra:true}])test(`actual native submitted choice ${JSON.stringify(value)} never submits`,async()=>{
 const w=await nativeWorld();try{const promise=w.run(),form=await pending(w);w.h.harness.behavior.submitInteraction(form.id,value);const r=parse(await promise);assert.equal(r.state,'not_submitted');assert.equal(r.claim,'released');assert.equal(w.posts,0);}finally{await w.close();}
});
test('old v1 seal-only record is never activated into native execution by apply',async()=>{
 const w=await nativeWorld({approval:false});try{await createBoldSealService({store:w.store,docs:w.adapter.semanticDocs,clock:()=>w.now}).sealBold(owner,w.input);const before=tableBytes(w.db),r=parse(await w.run());assert.equal(r.execution,'sealedNoDispatcher');assert.equal(w.posts,0);assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
for(const options of [{lost:true},{malformed:true},{denyAfter:true},{afterRevision:'r3'},{changeOther:true},{save:'ALL_FAILED_UNKNOWN_REASON'},{suggestions:true},{unexpectedReply:true},{invalidReply:true},{writeMode:'SUGGEST'},{reject:403}])test(`actual native facts ${JSON.stringify(options)}`,async()=>{
 const w=await nativeWorld({approval:false,...options});try{const r=parse(await w.run());assert.equal(w.posts,1);if(options.reject){assert.equal(r.submission,'rejected');assert.equal(r.claim,'released');}else{assert.equal(r.claim,'held');assert.equal(r.state,'uncertain');assert.equal(r.submission,options.lost||options.malformed||options.invalidReply?'unknown':'acknowledged');}if(options.lost||options.malformed||options.invalidReply||options.unexpectedReply||options.writeMode||options.save||options.suggestions)assert.equal(w.afterGets,0);const count=w.posts;parse(await w.run());assert.equal(w.posts,count);assert.equal(w.handler.service.status(owner,w.input).thisCall.providerMutationCount,0);
 }finally{await w.close();}
});
