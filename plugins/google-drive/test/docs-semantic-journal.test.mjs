import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,openSync,closeSync,ftruncateSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { publicationGuard,readJournal,JOURNAL_LIMITS,childTimeout,assertCompletedChild } from '../features/docs/coverage/execution-journal.mjs';
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
