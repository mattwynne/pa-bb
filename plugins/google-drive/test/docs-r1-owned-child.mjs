// R1 test-owned lifecycle, not a production process manager. Setup time is
// debited by the shared deadline; synchronous clone/hash/copy is NOT preemptible.
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const OUTPUT_LIMIT=1024*1024;
export function r1GroupExists(pid) {
  try { process.kill(-pid,0); return true; }
  catch(e) { if(e.code==='ESRCH') return false; throw e; }
}
// Pure technical control port permits fixed-argv/live-root tests on Linux.
// Runtime state below comes ONLY from this invocation's freshly spawned root.
export function requestWindowsR1Stop({pid,exited},invoke,remainingMs) {
  if(exited||!Number.isSafeInteger(pid)||pid<=0||!Number.isFinite(remainingMs)||remainingMs<1)
    return {attempted:false,acknowledged:false,reason:'root exited/unowned or cleanup budget exhausted'};
  const args=['/PID',String(pid),'/T','/F'];
  let p;
  try {p=invoke('taskkill',args,{shell:false,windowsHide:true,encoding:'utf8',timeout:Math.min(1000,Math.floor(remainingMs)),killSignal:'SIGKILL',maxBuffer:65536});}
  catch(e){return {attempted:true,acknowledged:false,command:'taskkill',args,error:e.code??e.message};}
  return {attempted:true,acknowledged:!p.error&&!p.signal&&p.status===0,command:'taskkill',args,status:p.status,signal:p.signal,error:p.error?.code??null,pid:p.pid,stdout:p.stdout??'',stderr:p.stderr??''};
}
export function windowsR1CleanupEstablished({rootClosed,taskkill,completionProof}) {
  return rootClosed===true&&(taskkill?.acknowledged===true||completionProof===true);
}
export async function runR1Child({cwd,deadline,args=['features/docs/coverage/runner.mjs'],confirmWindowsCompletion}) {
  const started=Date.now(),reserve=1500,available=deadline-started-reserve;
  if(available<=0) throw new Error('R1 shared deadline exhausted before spawn');
  const windows=process.platform==='win32';
  const child=spawn(process.execPath,args,{cwd,detached:!windows,stdio:['ignore','pipe','pipe'],shell:false});
  const result={pid:child.pid,status:null,signal:null,stdout:'',stderr:'',elapsedMs:0,cleanupEstablished:false,cleanup:{platform:windows?'windows-owned-tree':'posix-owned-group',rootClosed:false},output:{limitBytes:OUTPUT_LIMIT,stdout:{seen:0,retained:0},stderr:{seen:0,retained:0}}};
  let failure,closed=false,exited=false;
  const signal=s=>{if(child.pid)try{process.kill(-child.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};
  const fail=message=>{failure??=new Error(message);};
  const buffers={stdout:[],stderr:[]};
  for(const stream of ['stdout','stderr']) child[stream].on('data',b=>{
    const count=result.output[stream];count.seen+=b.length;
    const retain=Math.min(b.length,OUTPUT_LIMIT-count.retained);
    if(retain>0){buffers[stream].push(Buffer.from(b.subarray(0,retain)));count.retained+=retain;}
    if(count.seen>OUTPUT_LIMIT&&!result.outputError){
      result.outputError={stream,limitBytes:OUTPUT_LIMIT,observedBytes:count.seen};
      fail(`R1 child output limit exceeded: ${stream} bytes=${count.seen} limit=${OUTPUT_LIMIT}`);
    }
  }).on('error',e=>fail(`R1 child ${stream} error: ${e.code??e.message}`));
  const completion=new Promise(resolve=>{
    child.once('error',e=>{failure??=e;});
    child.once('exit',()=>{exited=true;}); // close may lag exit while descendants hold pipes
    child.once('close',(status,sig)=>{closed=true;result.status=status;result.signal=sig;resolve();});
  });
  const timer=setTimeout(()=>fail('R1 shared deadline exceeded'),available);
  while(!closed&&!failure) await Promise.race([completion,delay(10)]);
  clearTimeout(timer);
  result.stdout=Buffer.concat(buffers.stdout).toString('utf8');result.stderr=Buffer.concat(buffers.stderr).toString('utf8');
  if(windows) {
    if(failure) {
      // Never taskkill after a known root EXIT (PID could already be reused).
      result.cleanup.termination=requestWindowsR1Stop({pid:child.pid,exited:exited||child.exitCode!==null||child.signalCode!==null},spawnSync,deadline-Date.now()-300);
      while(!closed&&Date.now()<deadline-20) await delay(10);
      result.cleanupEstablished=windowsR1CleanupEstablished({rootClosed:closed,taskkill:result.cleanup.termination});
      result.cleanup.basis='acknowledged taskkill /T /F on live owned root plus root close; no POSIX group claim';
    } else {
      // Natural root close alone proves no Windows tree-cleanup fact. The R1
      // caller must validate its real Cucumber child/journal completion contract.
      try {result.cleanupEstablished=windowsR1CleanupEstablished({rootClosed:closed,completionProof:confirmWindowsCompletion?.(result)===true&&Date.now()<deadline});}
      catch(e){failure??=e;}
      result.cleanup.basis='caller-validated actual R1 Cucumber/journal completion, not OS-wide tree enumeration';
    }
  } else {
    if(failure || (child.pid&&r1GroupExists(child.pid))) {
      signal('SIGTERM');result.cleanup.termSent=true;
      const grace=Math.min(deadline-500,Date.now()+250);
      while(child.pid&&r1GroupExists(child.pid)&&Date.now()<grace) await delay(10);
      if(child.pid&&r1GroupExists(child.pid)){signal('SIGKILL');result.cleanup.killSent=true;}
    }
    while((!closed||(child.pid&&r1GroupExists(child.pid)))&&Date.now()<deadline-20) await delay(10);
    result.cleanup.groupEmpty=!!child.pid&&!r1GroupExists(child.pid);
    result.cleanupEstablished=closed&&result.cleanup.groupEmpty;
  }
  result.cleanup.rootClosed=closed;
  result.stdout=Buffer.concat(buffers.stdout).toString('utf8');result.stderr=Buffer.concat(buffers.stderr).toString('utf8');
  result.elapsedMs=Date.now()-started;
  if(!result.cleanupEstablished){
    result.cleanupError='R1 owned cleanup uncertain or failed within shared deadline';fail(result.cleanupError);
    // Do not leave pipe/handle waits unbounded after a failed close check.
    // Releasing local handles is NOT evidence that an unknown OS tree is gone.
    child.stdout.destroy();child.stderr.destroy();child.unref();result.cleanup.localHandlesReleased=true;
  }
  if(result.signal) fail(`R1 runner terminated by ${result.signal}`);
  if(failure){failure.result=result;throw failure;}
  return result;
}
