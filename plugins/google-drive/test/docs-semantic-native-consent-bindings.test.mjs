import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorld,pending,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
for(const policyNow of [1000,1701000])test(`actual native visible head/seal/effective expiry binds exact final payload/hash/timeout after policy clock=${policyNow}`,async()=>{
 const w=await nativeWorld();try{
  const get=w.settings.get.bind(w.settings);let first=true;w.settings.get=async()=>{const value=await get();if(first){first=false;w.now=policyNow;}return value;};
  const request=w.h.bb.ui.requestInput.bind(w.h.bb.ui);let actual;w.h.bb.ui.requestInput=(p,opts)=>{actual={payload:p.payload,timeoutMs:p.timeoutMs,at:w.now};return request(p,opts);};
  const running=w.run(),form=await pending(w),saved=w.store.semanticExecutions.byId(owner,keys[0]),expected=Math.min(policyNow+600000,saved.header.deadline),visible=form.payload.limits;
  assert.equal(w.posts,0);assert.ok(visible.includes(`Immutable plan head (SHA-256): ${saved.header.headHash}`));assert.ok(visible.includes(`Seal expiry (UTC): ${new Date(saved.header.deadline).toISOString()}`));assert.ok(visible.includes(`Effective card/consent expiry (UTC): ${new Date(expected).toISOString()}`));assert.equal(actual.timeoutMs,expected-actual.at);assert.deepEqual(form.payload,actual.payload);assert.equal(form.payload.selections[0].paragraphs[0].text,'A😀x\n');assert.match(visible,/Effective BEFORE bold\/provenance\/source/);assert.ok(Buffer.byteLength(JSON.stringify(form.payload))<=48000);
  if(policyNow===1000)assert.ok(expected<saved.header.deadline);else assert.equal(expected,saved.header.deadline);
  w.h.harness.behavior.submitInteraction(form.id,{approved:true});assert.equal(parse(await running).state,'verified');const consent=w.store.semanticExecutions.byId(owner,keys[0]).record.consent;assert.equal(consent.deadline,expected);assert.equal(consent.payloadHash,draftHash(form.payload));assert.equal(consent.kind,'owner_approved');assert.equal(w.posts,1);
 }finally{await w.close();}
});
for(const boundary of ['choice','preparation'])test(`actual effective card deadline never extends through delayed ${boundary}`,async()=>{
 const w=await nativeWorld();try{const running=w.run(),form=await pending(w),expiry=601000;
  assert.ok(form.payload.limits.includes(new Date(expiry).toISOString()));
  if(boundary==='choice')w.now=expiry+1;else w.hook=async u=>{if(u.pathname.endsWith('/tokeninfo'))w.now=expiry+1;};
  w.h.harness.behavior.submitInteraction(form.id,{approved:true});const result=parse(await running);assert.equal(result.submission,'not_sent');assert.equal(result.claim,'released');assert.equal(w.posts,0);const r=w.store.semanticExecutions.byId(owner,keys[0]).record;if(boundary==='preparation'){assert.equal(r.consent.deadline,expiry);assert.equal(r.consent.payloadHash,draftHash(form.payload));}else assert.equal(r.consent,null);
 }finally{await w.close();}
});
