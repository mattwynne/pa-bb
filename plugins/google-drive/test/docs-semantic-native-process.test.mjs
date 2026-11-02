import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {validDraftDocument,boldAfter,boldRequest,draftOwner as owner} from './docs-semantic-draft-fixtures.mjs';
const childFile=fileURLToPath(new URL('./docs-semantic-native-child.mjs',import.meta.url));
async function fixture(options={}){
 const dir=await mkdtemp(join(tmpdir(),'semantic-process-')),dbPath=join(dir,'execution.db'),h=createFakePluginHost({pluginId:'semantic-process-observer'}),Db=h.bb.storage.database().constructor;
 const state={posts:0,follow:0,document:validDraftDocument(),intentVisible:false,writeLockFree:false};
 const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const server=createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://fixture');
  if(u.pathname==='/follow'){state.follow++;return json(res,{});}
  if(u.pathname.endsWith('/userinfo'))return json(res,{sub:owner.subject,email:owner.account,email_verified:true});
  if(u.pathname.endsWith('/tokeninfo')){if(options.tokenRedirect){res.writeHead(options.tokenRedirect,{location:'/follow'});res.end();return;}return json(res,{scope:'https://www.googleapis.com/auth/drive.file'});}
  if(u.pathname.endsWith(':batchUpdate')){
   state.posts++;const chunks=[];for await(const c of req)chunks.push(c);assert.deepEqual(JSON.parse(Buffer.concat(chunks)),boldRequest);
   const observer=new Db(dbPath);try{const r=JSON.parse(observer.prepare('SELECT record FROM docs_semantic_execution').get().record);state.intentVisible=r.stage.submission==='unknown'&&r.stage.intentPersisted;observer.exec('BEGIN IMMEDIATE; ROLLBACK');state.writeLockFree=true;}finally{observer.close();}
   if(options.redirect){res.writeHead(options.redirect,{location:'/follow'});res.end();return;}
   state.document=boldAfter();if(options.lost){res.destroy();return;}
   return json(res,{documentId:'draft-doc',replies:[{}],writeControl:{requiredRevisionId:'r2'}});
  }
  if(u.pathname.startsWith('/v1/documents/'))return options.denyAfter&&state.posts?json(res,{error:'Denied'},403):json(res,state.document);
  const id=decodeURIComponent(u.pathname.split('/').at(-1));
  if(u.pathname.startsWith('/drive/v3/files/'))return json(res,id==='draft-doc'?{id,mimeType:'application/vnd.google-apps.document',trashed:false,name:'Synthetic',parents:['foreign-folder'],capabilities:{canEdit:true}}:id==='root'?{id:'root-concrete',mimeType:'application/vnd.google-apps.folder',trashed:false}:{id,mimeType:'application/vnd.google-apps.folder',trashed:false,parents:['root-concrete']});
  return json(res,{},404);
 }catch(error){state.serverError=error;res.destroy();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 async function run(mode){
  const env={...process.env,TMPDIR:dir};delete env.NODE_OPTIONS;
  const child=spawn(process.execPath,[childFile,base,dbPath,mode],{env,stdio:['ignore','pipe','pipe','pipe']});
  let stdout='',stderr='',events='';child.stdout.on('data',c=>{stdout+=c;});child.stderr.on('data',c=>{stderr+=c;});child.stdio[3].on('data',c=>{events+=c;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),30000);const [code,signal]=await once(child,'exit');clearTimeout(timer);
  assert.equal(state.serverError,undefined);assert.ok(stdout.length+stderr.length+events.length<65536);return {pid:child.pid,code,signal,stdout,stderr,events:events.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
 }
 return {dir,dbPath,Db,state,run,close:async()=>{server.closeAllConnections();server.close();await once(server,'close');await h.harness.lifecycle.dispose();await rm(dir,{recursive:true,force:true});}};
}
for(const boundary of ['afterIntent','beforeResponseCommit','afterResponseCommit'])test(`actual SIGKILL ${boundary}: real HTTP/file-SQLite reopen never replays, source survives expiry`,async()=>{
 const f=await fixture();try{
  const killed=await f.run(boundary);assert.equal(killed.signal,'SIGKILL',killed.stderr);assert.equal(killed.code,null);assert.equal(killed.events[0].pid,killed.pid);assert.equal(killed.events[0].stage,boundary);
  const count=boundary==='afterIntent'?0:1;assert.equal(f.state.posts,count);if(count){assert.equal(f.state.intentVisible,true);assert.equal(f.state.writeLockFree,true);}
  const reopened=await f.run('reopen');assert.equal(reopened.code,0,reopened.stderr);assert.equal(reopened.signal,null);const receipt=reopened.events[0];assert.notEqual(receipt.pid,killed.pid);assert.equal(receipt.stage,'reopened');assert.equal(receipt.ordinaryExpired,true);assert.equal(receipt.beforeRevision,'r1');assert.equal(receipt.result.submission,boundary==='afterResponseCommit'?'acknowledged':'unknown');assert.equal(receipt.result.claim,'held');assert.equal(receipt.result.thisCall.providerMutationCount,0);assert.equal(f.state.posts,count);
  assert.equal(receipt.observation.submission,receipt.result.submission);assert.equal(receipt.observation.claim,'held');assert.equal(receipt.observation.thisCall.providerMutationCount,0);if(boundary==='beforeResponseCommit')assert.equal(receipt.observation.observation.kind,'observed_matching');
 }finally{await f.close();}
});
for(const status of [307,308])test(`actual redirect ${status} cannot repeat captured native POST or follow endpoint`,async()=>{
 const f=await fixture({redirect:status});try{const run=await f.run('none');assert.equal(run.code,0,run.stderr);assert.equal(f.state.posts,1);assert.equal(f.state.follow,0);assert.equal(run.events[0].result.submission,'unknown');assert.equal(run.events[0].result.claim,'held');assert.equal(run.events[0].result.thisCall.providerMutationCount,1);assert.equal(f.state.intentVisible,true);assert.equal(f.state.writeLockFree,true);}finally{await f.close();}
});
for(const failure of ['lost','denyAfter'])test(`actual server ${failure}: submission facts survive response/readback failure`,async()=>{
 const f=await fixture({[failure]:true});try{const run=await f.run('none');assert.equal(run.code,0,run.stderr);assert.equal(f.state.posts,1);assert.equal(run.events[0].result.submission,failure==='lost'?'unknown':'acknowledged');assert.equal(run.events[0].result.claim,'held');const reopened=await f.run('reopen');assert.equal(reopened.code,0,reopened.stderr);assert.equal(reopened.events[0].result.submission,run.events[0].result.submission);assert.equal(f.state.posts,1);}finally{await f.close();}
});
test('actual credential tokeninfo redirect refuses before native intent/POST',async()=>{
 const f=await fixture({tokenRedirect:307});try{const run=await f.run('none');assert.equal(run.code,0,run.stderr);assert.equal(f.state.posts,0);assert.equal(f.state.follow,0);assert.equal(run.events[0].result.submission,'not_sent');assert.equal(run.events[0].result.claim,'released');}finally{await f.close();}
});
