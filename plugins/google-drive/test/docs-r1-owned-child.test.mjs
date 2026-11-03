import test from 'node:test';
import assert from 'node:assert/strict';
import {runR1Child,r1GroupExists,requestWindowsR1Stop,windowsR1CleanupEstablished} from './docs-r1-owned-child.mjs';
const posixOnly={skip:process.platform==='win32'?'real POSIX group regressions; Windows technical contract below is separate':false,timeout:10000};
const absent=pid=>assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
const assertClean=result=>{assert.equal(result.cleanupEstablished,true);assert.equal(result.cleanup.platform,'posix-owned-group');assert.equal(result.cleanup.groupEmpty,true);assert.equal(r1GroupExists(result.pid),false);absent(result.pid);};

test('R1 owned lifecycle clean close and deadline drain include a real grandchild',posixOnly,async()=>{
  const clean=await runR1Child({cwd:process.cwd(),deadline:Date.now()+3000,args:['-e','console.log("clean");']});
  assert.equal(clean.status,0);assert.equal(clean.signal,null);assertClean(clean);
  const script=`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
console.log(JSON.stringify({parent:process.pid,grandchild:child.pid}));
process.on('SIGTERM',()=>{child.kill('SIGTERM');child.once('close',()=>process.exit(0));});
setInterval(()=>{},1000);`;
  let failure;
  try {await runR1Child({cwd:process.cwd(),deadline:Date.now()+2500,args:['-e',script]});}catch(e){failure=e;}
  assert.match(failure?.message??'',/shared deadline exceeded/);
  const ids=JSON.parse(failure.result.stdout.trim());assert.equal(ids.parent,failure.result.pid);assert.ok(ids.grandchild>0);
  assertClean(failure.result);absent(ids.grandchild);
  console.log(JSON.stringify({lifecycle:'clean-and-deadline-tree',clean,timeout:{...failure.result,ids}}));
  await assert.rejects(runR1Child({cwd:process.cwd(),deadline:Date.now()+2500,args:['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`]}),e=>{
    assert.match(e.message,/shared deadline exceeded/);assert.equal(e.result.signal,'SIGKILL');assertClean(e.result);console.log(JSON.stringify({lifecycle:'forced-kill',...e.result}));return true;
  });
});
test('R1 legal raw-byte bounded stdout and stderr complete normally',posixOnly,async()=>{
  const run=await runR1Child({cwd:process.cwd(),deadline:Date.now()+3000,args:['-e',`const b=Buffer.from('é'.repeat(100000));process.stdout.write(b);process.stderr.write(b);`]});
  assert.equal(run.status,0);assertClean(run);assert.equal(run.output.limitBytes,1048576);assert.equal(run.outputError,undefined);
  for(const stream of ['stdout','stderr']){assert.deepEqual(run.output[stream],{seen:200000,retained:200000});assert.equal(run[stream].length,100000);}
  console.log(JSON.stringify({lifecycle:'bounded-both-streams',pid:run.pid,cleanup:run.cleanup,elapsedMs:run.elapsedMs,output:run.output}));
});
for(const stream of ['stdout','stderr'])test(`R1 ${stream} overflow rejects and drains a real owned child and grandchild`,posixOnly,async()=>{
  const script=`const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
process.on('SIGTERM',()=>{child.kill('SIGTERM');child.once('close',()=>process.exit(0));});
console.log(JSON.stringify({parent:process.pid,grandchild:child.pid}));
process.${stream}.write(Buffer.alloc(1048576+65536,120));
setInterval(()=>{},1000);`;
  let failure;
  try{await runR1Child({cwd:process.cwd(),deadline:Date.now()+3500,args:['-e',script]});}catch(e){failure=e;}
  assert.match(failure?.message??'',new RegExp(`output limit exceeded: ${stream} bytes=\\d+ limit=1048576`));assert.doesNotMatch(failure.message,/deadline/);
  const run=failure.result,ids=JSON.parse(run.stdout.split('\n')[0]);assert.equal(ids.parent,run.pid);assert.ok(ids.grandchild>0);
  assertClean(run);absent(ids.grandchild);assert.equal(run.status,0,'TERM-handling root exit0 must STILL reject overflow');assert.equal(run.signal,null);
  assert.equal(run.outputError.stream,stream);assert.equal(run.outputError.limitBytes,1048576);assert.ok(run.outputError.observedBytes>1048576);
  for(const name of ['stdout','stderr']){assert.ok(run.output[name].retained<=1048576);assert.ok(Buffer.byteLength(run[name])<=1048576);}
  assert.ok(run.output[stream].seen>1048576);
  console.log(JSON.stringify({lifecycle:'overflow',stream,pid:run.pid,ids,status:run.status,signal:run.signal,cleanup:run.cleanup,cleanupEstablished:run.cleanupEstablished,elapsedMs:run.elapsedMs,output:run.output,outputError:run.outputError}));
});
test('R1 Windows fixed taskkill live-root and uncertain-cleanup technical contract (not Windows runtime)',()=>{
  let calls=0;
  const invoke=(command,args,options)=>{calls++;assert.equal(command,'taskkill');assert.deepEqual(args,['/PID','12345','/T','/F']);assert.equal(options.shell,false);assert.equal(options.timeout,1000);assert.equal(options.maxBuffer,65536);assert.equal(options.killSignal,'SIGKILL');return {pid:12346,status:0,signal:null,stdout:'terminated',stderr:''};};
  const acknowledged=requestWindowsR1Stop({pid:12345,exited:false},invoke,1200);assert.equal(calls,1);assert.equal(acknowledged.acknowledged,true);
  const afterExit=requestWindowsR1Stop({pid:12345,exited:true},invoke,1200);assert.equal(afterExit.attempted,false);assert.equal(calls,1,'no taskkill after EXIT, even if close/pipes lag');
  for(const state of [{pid:undefined,exited:false},{pid:-1,exited:false}])assert.equal(requestWindowsR1Stop(state,invoke,1200).attempted,false);
  assert.equal(requestWindowsR1Stop({pid:12345,exited:false},invoke,0).attempted,false);assert.equal(calls,1);
  for(const reply of [{status:1,signal:null},{status:null,signal:'SIGKILL'},{status:0,signal:null,error:{code:'ETIMEDOUT'}}]){
    const failed=requestWindowsR1Stop({pid:12345,exited:false},()=>reply,500);assert.equal(failed.acknowledged,false);assert.equal(windowsR1CleanupEstablished({rootClosed:true,taskkill:failed}),false);
  }
  assert.equal(windowsR1CleanupEstablished({rootClosed:true}),false,'natural root close alone cannot certify descendants');
  assert.equal(windowsR1CleanupEstablished({rootClosed:false,taskkill:acknowledged}),false);
  assert.equal(windowsR1CleanupEstablished({rootClosed:true,taskkill:afterExit}),false);
  assert.equal(windowsR1CleanupEstablished({rootClosed:true,taskkill:acknowledged}),true);
  assert.equal(windowsR1CleanupEstablished({rootClosed:true,completionProof:true}),true,'normal path needs actual caller completion proof');
  console.log(JSON.stringify({windowsTechnicalContractOnly:true,fixedArgs:acknowledged.args,noShell:true,afterExitNoInvocation:true,uncertainCleanupRejected:true}));
});
