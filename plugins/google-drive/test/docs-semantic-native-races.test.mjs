import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorld,pending,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {tableBytes} from './docs-semantic-target-context-fixtures.mjs';

test('actual FETCH precedes microtask queued after REAL committed intent; prepared capability is one-use',async()=>{
 const w=await nativeWorld({approval:false});try{let prepared;const prepare=w.adapter.semanticBatch.prepare;w.adapter.semanticBatch.prepare=async(...args)=>{prepared=await prepare(...args);return prepared;};const intent=w.store.semanticExecutions.persistIntent;w.store.semanticExecutions.persistIntent=(...args)=>{const r=intent(...args);w.trace.push('intent');queueMicrotask(()=>w.trace.push('microtask'));return r;};assert.equal(parse(await w.run()).state,'verified');assert.deepEqual(w.trace.slice(0,3),['intent','FETCH','microtask']);assert.throws(()=>prepared.dispatchOnce());assert.equal(w.posts,1);}finally{await w.close();}
});
test('actual synchronous observed account-veto after intent has zero FETCH and durable known-not-sent release',async()=>{
 const w=await nativeWorld({approval:false});try{w.checkpoint=stage=>{if(stage==='afterIntent')void w.store.removeAccount(owner.subject);};const r=parse(await w.run());assert.equal(w.posts,0);assert.equal(r.submission,'not_sent');assert.equal(r.stage.intentPersisted,true);assert.equal(r.reason,'veto');assert.equal(r.claim,'released');}finally{await w.close();}
});
test('fresh opaque capability requires exact head/origin on ALL stage entries; real owner decision still completes',async()=>{
 const w=await nativeWorld();try{let cap;const seal=w.store.semanticExecutions.sealForApply;w.store.semanticExecutions.sealForApply=(...args)=>{const r=seal(...args);cap=r.capability;return r;};const promise=w.run(),form=await pending(w);assert.ok(cap);assert.deepEqual(Object.keys(cap),[]);const before=tableBytes(w.db);
  for(const who of [owner,{...owner,threadId:'other'}])for(const input of [w.input,{...w.input,planHash:'0'.repeat(64)}]){if(who===owner&&input===w.input)continue;for(const call of [()=>w.store.semanticExecutions.recordNotSent(who,input,cap,'preflight'),()=>w.store.semanticExecutions.recordConsent(who,input,cap,{kind:'owner_approved',payloadHash:'0'.repeat(64),deadline:w.now+10}),()=>w.store.semanticExecutions.recordResponse(who,input,cap,{status:200,body:{}}),()=>w.store.semanticExecutions.recordUnavailable(who,input,cap,'transport'),()=>w.store.semanticExecutions.recordVerification(who,input,cap,null)])assert.throws(call);}
  assert.deepEqual(tableBytes(w.db),before);w.h.harness.behavior.submitInteraction(form.id,{approved:true});assert.equal(parse(await promise).state,'verified');assert.throws(()=>w.store.semanticExecutions.recordNotSent(owner,w.input,cap,'veto'));
 }finally{await w.close();}
});
test('once actual fetch entered, even the ORIGINAL live capability cannot assert a pre-invocation veto',async()=>{
 let capability;const w=await nativeWorld({approval:false,afterInvoke:async w=>{const before=tableBytes(w.db);assert.throws(()=>w.store.semanticExecutions.recordNotSent(owner,w.input,capability,'veto'));assert.deepEqual(tableBytes(w.db),before);}});try{const seal=w.store.semanticExecutions.sealForApply;w.store.semanticExecutions.sealForApply=(...args)=>{const r=seal(...args);capability=r.capability;return r;};assert.equal(parse(await w.run()).state,'verified');assert.equal(w.posts,1);}finally{await w.close();}
});
for(const change of ['loosen','account','cancel','signal','expiry'])test(`ACTUAL native form race ${change} cannot dispatch`,async()=>{
 const w=await nativeWorld();try{const controller=new AbortController(),promise=change==='signal'?w.h.harness.behavior.callAgentTool(w.handler.definition.name,w.args,{threadId:owner.threadId,signal:controller.signal}):w.run(),form=await pending(w);
  if(change==='tighten'||change==='loosen')await w.h.harness.behavior.setSettings({requireDocsApproval:false});
  if(change==='account')await w.store.removeAccount(owner.subject);
  if(change==='expiry')w.now=1801001;
  if(change==='cancel')w.h.harness.behavior.cancelInteraction(form.id);else if(change==='signal')controller.abort();else w.h.harness.behavior.submitInteraction(form.id,{approved:true});
  const r=parse(await promise);assert.equal(w.posts,0);assert.equal(r.submission,'not_sent');assert.equal(r.claim,'released');
 }finally{await w.close();}
});
for(const path of ['tokeninfo','context','currentDoc','finalPolicy'])for(const change of ['settings','account'])test(`observed ${change} invalidation at ${path} await stops before dispatch`,async()=>{
 const w=await nativeWorld({approval:false});try{let done=false,docReads=0,policyReads=0;const get=w.settings.get.bind(w.settings);
  if(path==='finalPolicy')w.settings.get=async()=>{policyReads++;if(policyReads===2&&!done){done=true;if(change==='settings')await w.h.harness.behavior.setSettings({requireDocsApproval:true});else await w.store.removeAccount(owner.subject);}return get();};
  else w.hook=async(u)=>{if(u.hostname==='docs.googleapis.com')docReads++;if(!done&&(path==='tokeninfo'&&u.pathname.endsWith('/tokeninfo')||path==='context'&&u.pathname.endsWith('/files/foreign-folder')||path==='currentDoc'&&u.hostname==='docs.googleapis.com'&&docReads===2)){done=true;if(change==='settings')await w.h.harness.behavior.setSettings({requireDocsApproval:true});else await w.store.removeAccount(owner.subject);}};
  const out=await w.run();assert.equal(done,true);assert.equal(w.posts,0);if(!out.isError){const r=parse(out);assert.equal(r.submission,'not_sent');}
 }finally{await w.close();}
});
test('ACK storage failure leaves durable unknown and performs ZERO GET, never retries',async()=>{
 const w=await nativeWorld({approval:false});try{w.db.exec("CREATE TRIGGER fail_ack BEFORE INSERT ON docs_semantic_stage_events WHEN json_extract(NEW.event,'$.kind')='response' BEGIN SELECT RAISE(ABORT,'PRIVATE_ACK_STORAGE'); END;");const r=parse(await w.run());assert.equal(r.submission,'unknown');assert.equal(r.claim,'held');assert.equal(w.posts,1);assert.equal(w.afterGets,0);assert.equal(w.db.prepare("SELECT count(*) n FROM docs_semantic_stage_evidence WHERE kind='reply'").get().n,0);assert.doesNotMatch(JSON.stringify(w.h.harness.inspection.logEntries),/PRIVATE|SYNTHETIC_TOKEN/);}finally{await w.close();}
});
test('account removal AFTER invocation cannot discard an attributable ACK; readback does not run',async()=>{
 const w=await nativeWorld({approval:false,afterInvoke:async w=>{await w.store.removeAccount(owner.subject);}});try{const r=parse(await w.run());assert.equal(r.submission,'acknowledged');assert.equal(r.response.revisionId,'r2');assert.equal(r.claim,'held');assert.equal(w.afterGets,0);assert.equal(w.store.semanticExecutions.byId(owner,keys[0]).record.stage.submission,'acknowledged');}finally{await w.close();}
});
test('dispose invalidates synchronously and DRAINS an actual ACK before closing the DB',async()=>{
 let disposing,ack=null;const w=await nativeWorld({approval:false,afterInvoke:async w=>{disposing=w.h.harness.lifecycle.dispose();}});try{w.checkpoint=stage=>{if(stage==='afterResponseCommit')ack=w.store.semanticExecutions.byId(owner,keys[0]).record.response;};await w.run();await disposing;assert.equal(ack?.revisionId,'r2');assert.equal(w.afterGets,0);assert.equal(w.posts,1);}finally{if(!disposing)await w.close();}
});
test('mechanical same-identity token rotation is NOT reconnect/config invalidation',async()=>{
 const w=await nativeWorld({approval:false});try{let rotated=false;w.hook=async u=>{if(!rotated&&u.pathname.endsWith('/tokeninfo')){rotated=true;await w.store.mergeToken(owner.subject,'SYNTHETIC_REFRESH',{accessToken:'SYNTHETIC_ROTATED',expiresAt:Date.now()+600000});}};assert.equal(parse(await w.run()).state,'verified');assert.equal(w.posts,1);}finally{await w.close();}
});
test('unknown + actual observed matching remains unknown/held with zero mutation',async()=>{
 const w=await nativeWorld({approval:false,lost:true});try{assert.equal(parse(await w.run()).submission,'unknown');const before=tableBytes(w.db),o=await w.handler.service.observe(owner,w.input);assert.equal(o.observation.kind,'observed_matching');assert.equal(o.submission,'unknown');assert.equal(o.claim,'held');assert.equal(o.thisCall.providerMutationCount,0);assert.equal(w.posts,1);assert.deepEqual(tableBytes(w.db),before);}finally{await w.close();}
});
