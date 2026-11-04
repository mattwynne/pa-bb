import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryService,decodeRecoveryRow} from '../core/docs-semantic/recovery.mjs';
import {catalogHandle,CATALOG_NAMESPACES} from '../core/docs-semantic/draft-catalog.mjs';
import {operationStatusSchema} from '../docs-operation-status-tools.mjs';
const key='11111111-1111-1111-8111-111111111111',account='history@example.test',subject='history-subject';
const row=(namespace,extra={})=>({namespace,operationId:key,subject,state:'writing',resource:'old-doc',receipt:JSON.stringify({operationId:key,subject,documentId:'old-doc',state:'reviewing',...extra}),writer:null,execution:null});
function core(rows){let calls=0;const service=createRecoveryService({store:{byEmail:async()=>({subject,email:account}),discover:(s,k)=>{assert.equal(s,subject);assert.equal(k,key);return rows;}},reads:new Proxy({},{get:()=>()=>{calls++;throw Error('No provider lookup permitted');}})});return {run:input=>service.status(input?.recoveryHandle?{account,...input}:{account,operationId:key,...input},{threadId:'other-thread'}),get calls(){return calls;}};}
test('K6 exact strict union preserves historical UUID lookup vocabulary only',()=>{
 for(const id of [key,'00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff'])assert.ok(operationStatusSchema.safeParse({account,operationId:id}).success);
 assert.ok(operationStatusSchema.safeParse({account,recoveryHandle:catalogHandle('docs_image_operations',key)}).success);
 for(const input of [{account,operationId:key,planHash:'a'.repeat(64)},{account,operationId:key,force:true},{account,operationId:key,resume:true},{account,operationId:key,receiptKind:'arbitrary-module'},{account,operationId:key,recoveryHandle:catalogHandle('semantic',key)},{account,recoveryHandle:catalogHandle('semantic',key)+'='},{account,recoveryHandle:Buffer.from(JSON.stringify(['arbitrary',key])).toString('base64url')}])assert.equal(operationStatusSchema.safeParse(input).success,false);
});
test('SQL history and absent/null/false flags are preserved, not translated to stage submission',async()=>{
 for(const extra of [{},{writeAttempted:null},{writeAttempted:false}]){
  const w=core([row('drive_formatting_operations',extra)]),result=await w.run();assert.equal(result.status,'writing');assert.equal(result.legacyFacts.json.state,'reviewing');assert.equal(result.legacyFacts.sql.state,'writing');assert.equal(Object.hasOwn(result.legacyFacts.json,'writeAttempted'),Object.hasOwn(extra,'writeAttempted'));if(Object.hasOwn(extra,'writeAttempted'))assert.equal(result.legacyFacts.json.writeAttempted,extra.writeAttempted);
  assert.equal(result.stages,undefined);assert.equal(result.submission,undefined);assert.equal(result.observation.kind,'unsupported');assert.equal(result.retrySafe,false);assert.equal(result.thisCall.providerMutationCount,0);assert.equal(w.calls,0);assert.ok(Object.isFrozen(result.legacyFacts));
 }
});
test('all matching namespaces survive corrupt/version ambiguity before any provider lookup',async()=>{
 const a=row('drive_formatting_operations',{version:2}),b=row('docs_image_operations');b.receipt='{corrupt';const w=core([a,b]),result=await w.run();assert.equal(result.status,'ambiguous');assert.equal(result.candidates.length,2);assert.deepEqual(result.candidates.map(c=>c.status),['unsupported','unsupported']);assert.equal(w.calls,0);
 const selected=await w.run({recoveryHandle:catalogHandle('drive_formatting_operations',key)}); // mutually exclusive request union
 assert.equal(selected.observation.kind,'unsupported');
});
test('canonical handle and explicit closed receiptKind select exactly a namespace without a first-match verifier',async()=>{
 const w=core([row('drive_formatting_operations'),row('docs_image_operations')]);const r=await w.run({receiptKind:'docs_image_operations'});assert.equal(r.receiptKind,'docs_image_operations');assert.equal(r.observation.kind,'unsupported');assert.equal(w.calls,0);
 const service=createRecoveryService({store:{byEmail:async()=>({subject,email:account}),discover:()=>[row('drive_formatting_operations'),row('docs_image_operations')]},reads:{}});
 assert.equal((await service.status({account,recoveryHandle:catalogHandle('docs_image_operations',key)},{threadId:'other'})).receiptKind,'docs_image_operations');
});
test('unknown and corrupt other-subject rows reveal nothing and invoke no provider',async()=>{
 for(const rows of [[],[{...row('drive_formatting_operations'),subject:'other',receipt:'PRIVATE_CORRUPT'}]]){const w=core(rows),r=await w.run();assert.equal(r.status,'unknown');assert.deepEqual(r.candidates,[]);assert.equal(w.calls,0);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|old-doc/);}
});
test('all seven historical namespaces have bounded metadata, missing native kind is decoder-only',async()=>{
 const fixtures=CATALOG_NAMESPACES.map(namespace=>{
  if(namespace==='semantic')return {...row(namespace),state:null,resource:null,receipt:JSON.stringify({operationId:key,subject,version:1,state:'draft'})};
  if(namespace==='docs_creations')return {...row(namespace),state:null,resource:null,receipt:JSON.stringify({operationId:key,subject,requestHash:'a'.repeat(64),outcome:'verified',documentId:'old-doc',writeAttempted:false,titleHash:'a'.repeat(64)})};
  if(namespace==='drive_sharing_operations')return row(namespace,{fileId:'old-doc'});
  if(namespace==='drive_sheets_edits')return row(namespace,{spreadsheetId:'old-doc'});
  if(namespace==='drive_filing_operations')return row(namespace,{resource:'old-doc',kind:'task'});
  return row(namespace);
 });
 const w=core(fixtures),r=await w.run();assert.equal(r.status,'ambiguous');assert.equal(r.candidates.length,7);assert.ok(r.candidates.every(c=>c.createdAt===null));assert.ok(Buffer.byteLength(JSON.stringify(r))<65536);assert.equal(w.calls,0);
 const native=decodeRecoveryRow(fixtures[1]);assert.equal(native.candidate.receiptKind,'docs_creations:document');assert.equal(Object.hasOwn(native.legacyFacts.json,'kind'),false);assert.equal(Object.hasOwn(native.legacyFacts.json,'populateAcknowledged'),false);
 for(const p of [{kind:'document',sharedVersion:1,claimState:'writing'},{kind:'upload',mode:'binary',claimState:'uncertain'},{kind:'copy'},{kind:'spreadsheet'}]){
  const d=decodeRecoveryRow({...fixtures[1],receipt:JSON.stringify({operationId:key,subject,requestHash:'a'.repeat(64),outcome:'uncertain',...p})});assert.notEqual(d.codec,'unsupported');
 }
});
