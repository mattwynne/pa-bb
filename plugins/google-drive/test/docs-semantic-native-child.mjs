// Owned process fixture, invokes the SAME actual native handler and adapters.
import {writeSync} from 'node:fs';
import {nativeWorld,parse,owner} from './docs-semantic-native-fixtures.mjs';
import {textVector} from './docs-semantic-text-vectors.mjs';
import {weightVector} from './docs-semantic-weight-vectors.mjs';
const [base,dbPath,mode,profile='bold']=process.argv.slice(2);
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Closed loopback required');
const reopened=mode==='reopen';
const vector=profile==='weight'?weightVector():profile==='text'?textVector():null;
const w=await nativeWorld({approval:false,dbPath,reopen:reopened,...vector?{document:vector.before,after:vector.after,wire:vector.wire,replyCount:3,sdkPlan:true,paragraphIndex:1,oldText:vector.oldText,newText:vector.newText}:{},network:async(u,init)=>{
 if(!['www.googleapis.com','docs.googleapis.com','openidconnect.googleapis.com','oauth2.googleapis.com'].includes(u.hostname))throw Error('Unexpected provider host');
 return fetch(new URL(u.pathname+u.search,base),init);
}});
w.checkpoint=stage=>{
 if(stage===mode){
  const facts=w.handler.service.status(owner,w.input);writeSync(3,JSON.stringify({pid:process.pid,stage,dbPath,submission:facts.submission,claim:facts.claim})+'\n');process.kill(process.pid,'SIGKILL');
 }
};
try{
 const result=parse(await w.run());
 if(reopened){
  w.now=1801001;w.store.semanticSnapshots.sweep(w.now);
  let ordinaryExpired=false;try{w.store.semanticSnapshots.readPinned('native-snapshot',owner,w.input.operationId,w.now);}catch{ordinaryExpired=true;}
  const retained=w.store.semanticExecutions.evidence(owner,w.input),observation=await w.handler.service.observe(owner,w.input);
  writeSync(3,JSON.stringify({pid:process.pid,stage:'reopened',result,ordinaryExpired,beforeRevision:retained.revision.id,observation})+'\n');
 }else writeSync(3,JSON.stringify({pid:process.pid,stage:'finished',result})+'\n');
}finally{await w.close();}
