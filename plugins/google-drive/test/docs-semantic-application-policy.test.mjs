import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticReadService } from '../core/docs-semantic/application.mjs';
import { describeSemanticFailure,semanticFailureCategory } from '../core/docs-semantic/failures.mjs';
import { nextReadWork,checkPin,checkSnapshotAdmission } from '../core/docs-semantic/snapshot-policy.mjs';
import { createMemorySnapshots } from '../features/docs/support/memory-snapshots.mjs';
const account='a@example.test',args={account,document:'doc',scope:{tabs:{all:true},segments:[{kind:'body'}]}};
for(const fault of ['subject','removed','cancelled'])test(`real application rejects ${fault} across awaited authority before any read/publication`,async()=>{
  const memory=createMemorySnapshots();let record={subject:'one'},reads=0;
  const controller=new AbortController(),docs={authority:async()=>{await Promise.resolve();if(fault==='subject')record={subject:'two'};if(fault==='removed')record=null;if(fault==='cancelled')controller.abort();},metadata:async()=>{reads++;throw new Error('should not read');}};
  const service=createSemanticReadService({store:{byEmail:async()=>record,semanticSnapshots:memory.port},docs});
  await assert.rejects(service.inspect(args,'thread',controller.signal));assert.equal(reads,0);assert.deepEqual(memory.observe(),{snapshots:0,deliveries:0,cursors:0,pins:0,work:[]});
});
test('real core pin and work thresholds stay exact; no limit expansion',()=>{assert.equal(nextReadWork(268435455,1),268435456);assert.throws(()=>nextReadWork(268435456,1),/budget/);checkPin(0,1800000,undefined,31);assert.throws(()=>checkPin(0,1800001,undefined,0),/budget/);assert.throws(()=>checkPin(0,1800000,undefined,32),/budget/);assert.throws(()=>checkPin(0,10,11,1),/conflict/);});
test('core admission preserves four active snapshots per subject/thread',()=>{const b={snapshotId:'s',subject:'a',account,threadId:'t',documentId:'d',retrievedAt:0};checkSnapshotAdmission(b,0,3);assert.throws(()=>checkSnapshotAdmission(b,0,4),/budget/);assert.throws(()=>checkSnapshotAdmission(b,600000,0),/snapshot/);});
for(const code of ['invalid','denied','corrupt','cancelled','PRIVATE_CODE',undefined])test(`semantic failure policy is safe and honest: ${code}`,()=>{
  const e=Object.assign(new Error('PRIVATE_CONTENT'),{semanticCode:code,cause:'PRIVATE_SECRET',status:'PRIVATE_STATUS'}),result=describeSemanticFailure(e);assert.equal(result.outcome,'unavailable');assert.equal(result.category,['invalid','denied','corrupt','cancelled'].includes(code)?code:'unavailable');assert.deepEqual(result.thisCall,{providerMutationCount:0});assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);if(code==='cancelled')assert.equal(semanticFailureCategory(e,{cancellation:false}),'unavailable');
});
