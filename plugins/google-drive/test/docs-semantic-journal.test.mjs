import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,openSync,closeSync,ftruncateSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { publicationGuard,readJournal,JOURNAL_LIMITS,childTimeout,assertCompletedChild } from '../features/docs/coverage/execution-journal.mjs';
import { createInventoryContext,referenceReceipt,decodeCurrentJournal,decodeHistoricalJournal } from '../features/docs/coverage/inventory-envelope.mjs';
test('journal exact byte/count/UTF8/truncation bounds and timeout configuration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'journal-contract-')),p=join(dir,'journal');try{
  const bytes='{"n":1}\n',limits={recordBytes:Buffer.byteLength(bytes),totalBytes:Buffer.byteLength(bytes)*367,records:367},publish=publicationGuard(limits);for(let i=0;i<367;i++)publish({n:1});assert.throws(()=>publish({n:1}),/aggregate|count/);
  writeFileSync(p,bytes.repeat(367));assert.equal(readJournal(p,limits).length,367);assert.ok(JOURNAL_LIMITS.records>=367);assert.throws(()=>readJournal(p,{...limits,records:366}),/count/);assert.throws(()=>readJournal(p,{...limits,recordBytes:limits.recordBytes-1}),/record byte/);
  writeFileSync(p,'{}');assert.throws(()=>readJournal(p),/truncated/);writeFileSync(p,Buffer.from([255,10]));assert.throws(()=>readJournal(p),/encoded data/);
  const fd=openSync(p,'w');try{ftruncateSync(fd,JOURNAL_LIMITS.totalBytes+1);}finally{closeSync(fd);}assert.throws(()=>readJournal(p),/aggregate/);
  assert.equal(childTimeout({}),300000);assert.equal(childTimeout({DOCS_ACCEPTANCE_TIMEOUT_MS:'600000'}),600000);for(const value of ['0','-1','1.5','NaN','600001','Infinity'])assert.throws(()=>childTimeout({DOCS_ACCEPTANCE_TIMEOUT_MS:value}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
for(const mode of ['complete','truncated','timeout','failed'])test(`actual child channel ${mode}: completion and publication are separate`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'journal-process-')),p=join(dir,'journal'),fd=openSync(p,'wx');try{
  const module=new URL('../features/docs/coverage/execution-journal.mjs',import.meta.url).href;
  const code=`import{writeSync}from'node:fs';import{publicationGuard}from ${JSON.stringify(module)};const receipt={actualChild:process.pid,mode:${JSON.stringify(mode)}};publicationGuard()(receipt);writeSync(3,JSON.stringify(receipt)+${JSON.stringify(mode==='truncated'?'':'\n')});${mode==='timeout'?'setInterval(()=>{},1000);':mode==='failed'?'process.exitCode=1;':''}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe',fd],timeout:mode==='timeout'?1000:10000,killSignal:'SIGKILL'});
  assert.ok(readFileSync(p).length,'actual publication before completion check');
  if(mode==='complete'){assertCompletedChild(child);assert.equal(readJournal(p)[0].actualChild,child.pid);}
  else if(mode==='truncated'){assertCompletedChild(child);assert.throws(()=>readJournal(p),/truncated/);}
  else {assert.throws(()=>assertCompletedChild(child),mode==='timeout'?/timed out; no coverage credit/:/failed; no coverage credit/);assert.equal(readJournal(p)[0].actualChild,child.pid);}
 }finally{closeSync(fd);rmSync(dir,{recursive:true,force:true});}
});

// Synthetic envelope contracts are not product receipts or acceptance evidence.
const inventory={schemas:{synthetic:{type:'object'}},bindings:{synthetic:true},padding:'x'.repeat(1024)};
function originalReceipt(overrides={}){return {ref:'receipt-1',runId:'run-1',sourceDigest:'source-1',caseId:'C001.synthetic.success',key:'C001/synthetic/read/success',driver:'synthetic',schema:'synthetic',requestedMode:'read',observedOutcome:'success',fixtureId:'fixture-1',fixtureDigest:'fixture-digest',fixtureProvenance:{source:'synthetic journal test'},pickleId:'pickle-1',astNodeIds:['ast-1'],uri:'synthetic.feature',testCaseStartedId:'instance-1',inventory,trace:{events:[{id:'observed-1',result:'actual synthetic observation'}]},...overrides};}
function channel(receipt=originalReceipt(),producerPid=process.pid){const context=createInventoryContext({inventory:receipt.inventory,runId:receipt.runId,sourceDigest:receipt.sourceDigest,producerPid});return [context,referenceReceipt(receipt,context)];}
const expected={inventory,runId:'run-1',sourceDigest:'source-1',childPid:process.pid};
const encodedBytes=value=>Buffer.byteLength(JSON.stringify(value))+1;
test('strict inventory references preserve original observations with one frozen retained inventory',()=>{
 const raw=channel(),first=structuredClone(raw[1]);first.ref='receipt-2';const decoded=decodeCurrentJournal([...raw,first],expected);
 assert.equal(decoded.physicalRecords,3);assert.equal(decoded.receipts.length,2);assert.deepEqual(decoded.receipts[0],originalReceipt());
 assert.equal(decoded.receipts[0].inventory,decoded.receipts[1].inventory);assert.equal(decoded.context.inventory,decoded.receipts[0].inventory);assert.ok(Object.isFrozen(decoded.receipts[0].inventory.schemas.synthetic));
 assert.equal(decoded.receipts[0].trace,raw[1].trace,'trace retained, not reconstructed');assert.equal(decoded.maxLogicalReceiptBytes,encodedBytes(originalReceipt()));
 assert.equal(decoded.logicalReceiptBytes,2*encodedBytes(originalReceipt()));assert.equal(decoded.physicalBytes,[...raw,first].reduce((n,r)=>n+encodedBytes(r),0));
 const privateReceipt=structuredClone(decoded.receipts[0]);privateReceipt.inventory.schemas.synthetic.type='counterfeit';assert.notDeepEqual(privateReceipt.inventory,decoded.receipts[1].inventory);assert.equal(decoded.receipts[1].inventory.schemas.synthetic.type,'object');
 const many=decodeCurrentJournal([raw[0],...Array.from({length:100},(_,i)=>({...raw[1],ref:`receipt-${i}`}))],expected);assert.ok(many.receipts.every(r=>r.inventory===many.context.inventory));
});
test('current decoder rejects unknown/mixed/omitted/context identity/value/run/source/PID records',()=>{
 function rejects(change,reason){const rows=structuredClone(channel());change(rows);assert.throws(()=>decodeCurrentJournal(rows,expected),reason);}
 rejects(r=>r.splice(0,1),/inventory context fields/);rejects(r=>r.reverse(),/inventory context fields/);rejects(r=>r.push(r[0]),/current execution reference fields/);rejects(r=>r.splice(1),/unreferenced inventory context/);
 rejects(r=>r[0].extra=true,/inventory context fields/);rejects(r=>r[0].kind='unknown',/context kind/);rejects(r=>r[0].version=2,/context version/);
 rejects(r=>r[0].inventory.padding='changed',/inventory value digest/);rejects(r=>r[0].ref='wrong',/context identity/);
 for(const [field,value,reason]of [['runId','old',/stale inventory context run/],['sourceDigest','old',/stale inventory context source/],['producerPid',process.pid+1,/actual child PID/]])rejects(r=>{r[0]=createInventoryContext({...r[0],[field]:value});},reason);
 rejects(r=>{r[0]=createInventoryContext({...r[0],inventory:{...inventory,padding:'counterfeit'}});r[1].inventoryRef=r[0].ref;},/actual inventory drift/);
 for(const [field,value,reason]of [['inventoryRef','wrong',/inventory reference/],['producerPid',process.pid+1,/actual producer PID/],['runId','old',/stale execution context run/],['sourceDigest','old',/stale execution context source/],['kind','unknown',/execution kind/],['version',2,/execution version/]])rejects(r=>r[1][field]=value,reason);
 rejects(r=>r[1].inventory=inventory,/current execution reference fields/);rejects(r=>delete r[1].inventoryRef,/current execution reference fields/);rejects(r=>r[1].extra=true,/current execution reference fields/);rejects(r=>delete r[1].trace,/current execution reference fields/);rejects(r=>r[1].trace=null,/execution required trace/);
 rejects(r=>r[1]=originalReceipt(),/current execution reference fields/);assert.throws(()=>decodeCurrentJournal([],expected),/missing first/);assert.throws(()=>decodeCurrentJournal(channel(),{...expected,childPid:undefined}),/actual spawned child PID required/);
});
test('historical compatibility is explicit, exact, and never accepted as current context',()=>{
 const old=[originalReceipt()];assert.equal(decodeHistoricalJournal(old),old);assert.throws(()=>decodeCurrentJournal(old,expected),/inventory context fields/);assert.throws(()=>decodeHistoricalJournal(channel()),/historical embedded execution fields/);
 assert.throws(()=>decodeHistoricalJournal([{...old[0],inventoryRef:'mixed'}]),/historical embedded execution fields/);
});
test('physical context/reference and hydrated logical exact/one-byte/count bounds remain independent',()=>{
 const rows=channel(),physical=rows.reduce((n,r)=>n+encodedBytes(r),0),logical=encodedBytes(originalReceipt()),limits={recordBytes:logical,totalBytes:physical,records:2};
 assert.ok(rows.every(r=>encodedBytes(r)<logical));assert.equal(decodeCurrentJournal(rows,expected,limits).maxLogicalReceiptBytes,logical);
 const guard=publicationGuard(limits);rows.forEach(guard);assert.throws(()=>guard(rows[1]),/aggregate|count/);
 assert.throws(()=>decodeCurrentJournal(rows,expected,{...limits,totalBytes:physical-1}),/aggregate/);assert.throws(()=>decodeCurrentJournal(rows,expected,{...limits,records:1}),/count/);
 const tooSmall={...limits,recordBytes:logical-1};assert.throws(()=>decodeCurrentJournal(rows,expected,tooSmall),/logical receipt byte limit/);assert.throws(()=>referenceReceipt(originalReceipt(),rows[0],tooSmall),/logical receipt byte limit/);
 const dir=mkdtempSync(join(tmpdir(),'envelope-bounds-')),p=join(dir,'journal');try{
  writeFileSync(p,rows.map(r=>JSON.stringify(r)+'\n').join(''));assert.equal(readJournal(p,limits).length,2);assert.throws(()=>readJournal(p,{...limits,totalBytes:physical-1}),/aggregate/);assert.throws(()=>readJournal(p,{...limits,records:1}),/count/);
  const largest=Math.max(...rows.map(encodedBytes)),physicalLimits={...limits,recordBytes:largest};assert.equal(readJournal(p,physicalLimits).length,2);assert.throws(()=>readJournal(p,{...physicalLimits,recordBytes:largest-1}),/record byte/);
  const rawGuard=publicationGuard(physicalLimits);rows.forEach(rawGuard);assert.throws(()=>{const g=publicationGuard({...physicalLimits,recordBytes:largest-1});rows.forEach(g);},/record byte/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
for(const mode of ['complete','truncated','failed','timeout','signal'])test(`actual child inventory envelope ${mode} joins spawned PID and retains completion gate`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'envelope-child-')),p=join(dir,'journal'),fd=openSync(p,'wx');try{
  const module=new URL('../features/docs/coverage/inventory-envelope.mjs',import.meta.url).href;
  const code=`import{writeSync}from'node:fs';import{publicationGuard}from ${JSON.stringify(new URL('../features/docs/coverage/execution-journal.mjs',import.meta.url).href)};import{createInventoryContext,referenceReceipt}from ${JSON.stringify(module)};const receipt=${JSON.stringify(originalReceipt())};const context=createInventoryContext({inventory:receipt.inventory,runId:receipt.runId,sourceDigest:receipt.sourceDigest});const guard=publicationGuard();for(const row of [context,referenceReceipt(receipt,context)]){guard(row);writeSync(3,JSON.stringify(row)+'\\n');}${mode==='truncated'?"writeSync(3,'{}');":mode==='failed'?'process.exitCode=1;':mode==='timeout'?'setInterval(()=>{},1000);':mode==='signal'?"process.kill(process.pid,'SIGKILL');":''}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe',fd],timeout:mode==='timeout'?1000:10000,killSignal:'SIGKILL'});
  assert.ok(readFileSync(p).length,'child actually published');
  if(mode==='complete'){
   assertCompletedChild(child);const raw=readJournal(p),proof=decodeCurrentJournal(raw,{...expected,childPid:child.pid});assert.equal(proof.context.producerPid,child.pid);assert.equal(raw[1].producerPid,child.pid);assert.deepEqual(proof.receipts[0],originalReceipt());assert.throws(()=>decodeCurrentJournal(raw,{...expected,childPid:child.pid+1}),/actual child PID/);
  }else if(mode==='truncated'){assertCompletedChild(child);assert.throws(()=>readJournal(p),/truncated/);}
  else{assert.throws(()=>assertCompletedChild(child),mode==='timeout'?/timed out/:/failed/);assert.equal(readJournal(p).length,2,'complete-looking envelope is not completion proof');}
 }finally{closeSync(fd);rmSync(dir,{recursive:true,force:true});}
});
test('hydrated application trace still rejects independent semantic corruption after a recomputed digest',async()=>{
 const {executeApplication,compareApplication}=await import('../features/docs/coverage/application-execution.mjs');
 const {expand}=await import('../features/docs/coverage/expand.mjs');const {digest}=await import('../features/docs/coverage/audit.mjs');
 const manifest=JSON.parse(readFileSync(new URL('../features/docs/coverage/obligations.json',import.meta.url))),record=expand(manifest).find(r=>r.caseId==='C013.exact__read.success');
 const fixture=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/c013/C013.exact__read.success.json',import.meta.url))),trace=await executeApplication(record,fixture);
 const receipt=originalReceipt({trace}),decoded=decodeCurrentJournal(channel(receipt),expected);assert.ok(compareApplication(record,fixture,decoded.receipts[0].trace));
 const corrupted=structuredClone(decoded.receipts[0]);corrupted.trace.events=[];const recomputed=digest(JSON.stringify(corrupted.trace));assert.notEqual(recomputed,digest(JSON.stringify(trace)));assert.throws(()=>compareApplication(record,fixture,corrupted.trace),/missing actual application invocation/);
 corrupted.trace=structuredClone(trace);corrupted.trace.providerAfter.metadata.counterfeit=true;assert.throws(()=>compareApplication(record,fixture,corrupted.trace));
});
