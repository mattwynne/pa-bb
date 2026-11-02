import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorld,pending,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';

test('actual SDK strict native schema accepts ONLY account/key/head, never approved/force/body/resources',async()=>{
 const w=await nativeWorld();try{for(const extra of [{approved:true},{force:true},{requireApproval:false},{requests:[]},{resourceIds:['draft-doc']},{subject:owner.subject},{threadId:'forged'}])await assert.rejects(w.h.harness.behavior.callAgentTool(w.handler.definition.name,{...w.args,...extra},{threadId:owner.threadId}));assert.equal(w.posts,0);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);}finally{await w.close();}
});
test('real read-only tokeninfo cannot obtain widened grant or send the actual native batch',async()=>{
 const w=await nativeWorld({approval:false,readonly:true});try{const r=parse(await w.run());assert.equal(w.posts,0);assert.equal(r.submission,'not_sent');assert.equal(r.claim,'released');assert.equal(r.reason,'preflight');assert.ok(w.calls.some(c=>c.path==='/tokeninfo'));assert.ok(!w.calls.some(c=>c.path.endsWith('/auth')));}finally{await w.close();}
});
test('actual duplicate during native review creates no second form/capability/POST; exact owner completes once',async()=>{
 const w=await nativeWorld();try{const first=w.run(),form=await pending(w);const duplicate=parse(await w.run());assert.equal(duplicate.state,'reviewing');assert.equal(duplicate.approval,'intent_pending');assert.equal(duplicate.thisCall.providerMutationCount,0);assert.equal(w.h.harness.inspection.pendingInteractions.length,1);assert.equal(w.posts,0);w.h.harness.behavior.submitInteraction(form.id,{approved:true});assert.equal(parse(await first).state,'verified');assert.equal(w.posts,1);}finally{await w.close();}
});
test('actual SDK timeout is cancellation, not consent; same key cannot open a new native form',async()=>{
 const w=await nativeWorld();try{const request=w.h.bb.ui.requestInput.bind(w.h.bb.ui);w.h.bb.ui.requestInput=(payload,options)=>request({...payload,timeoutMs:20},options);const r=parse(await w.run());assert.equal(r.submission,'not_sent');assert.equal(r.claim,'released');assert.equal(w.posts,0);assert.equal(parse(await w.run()).submission,'not_sent');assert.equal(w.h.harness.inspection.pendingInteractions.length,0);}finally{await w.close();}
});
test('explicit no-effect cancellation during actual native review stays cancelled when old choice later arrives',async()=>{
 const w=await nativeWorld();try{const first=w.run(),form=await pending(w);assert.equal(w.store.semanticExecutions.cancelNotSent(owner,w.input).record.status,'not_submitted');w.h.harness.behavior.submitInteraction(form.id,{approved:true});const r=parse(await first);assert.equal(r.submission,'not_sent');assert.equal(r.claim,'released');assert.equal(w.posts,0);assert.equal(w.store.semanticExecutions.byId(owner,keys[0]).record.status,'not_submitted');}finally{await w.close();}
});
