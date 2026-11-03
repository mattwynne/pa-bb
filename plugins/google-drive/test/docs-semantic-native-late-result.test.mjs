import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleAdapter} from '../adapters/google.mjs';
import {createFilingService} from '../core/filing.mjs';
import {nativeWorld,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {textVector} from './docs-semantic-text-vectors.mjs';
for(const profile of ['bold','text'])for(const resultId of ['foreign-folder','unrelated-folder'])test(`actual ${profile} in-flight Filing POST returns ${resultId} AFTER native seal/preflight; fresh intent cut sees retained ID without optional context`,async()=>{
 const vector=profile==='text'?textVector():null;
 const w=await nativeWorld({approval:false,...vector?{document:vector.before,after:vector.after,wire:vector.wire,replyCount:3,sdkPlan:true,paragraphIndex:1,oldText:vector.oldText,newText:vector.newText}:{}});let release;const released=new Promise(r=>{release=r;}),entered={};entered.promise=new Promise(r=>{entered.resolve=r;});let filingPosts=0,filingPromise;
 try{
  const adjacent=createGoogleAdapter({store:w.store,getClient:async()=>({clientId:'SYNTHETIC',clientSecret:'SYNTHETIC'}),fetchImpl:async(url,init={})=>{
   const u=new URL(url),id=u.pathname.split('/').at(-1);
   if(u.pathname.endsWith('/userinfo'))return Response.json({sub:owner.subject,email:owner.account,email_verified:true});
   if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/drive'});
   if(init.method==='POST'){filingPosts++;entered.resolve();await released;return Response.json({id:resultId});}
   if(u.pathname.endsWith('/permissions'))return Response.json({permissions:[{id:'owner-permission',type:'user',role:'owner',emailAddress:owner.account}]});
   if(u.searchParams.has('q'))return Response.json({files:[]});
   return Response.json({id:id==='root'?'root-concrete':id,name:'Not the requested birth name',mimeType:'application/vnd.google-apps.folder',trashed:false,...(id==='root'?{}:{parents:['root-concrete']}),owners:[{me:true,emailAddress:owner.account}],capabilities:{canAddChildren:true}});
  }});
  const filing=createFilingService({store:w.store,operations:w.store.filing,filing:adjacent.filing,clock:()=>w.now});filingPromise=filing.createFolder({account:owner.account,operationId:keys[1],parentId:'root',name:'New birth',preview:false});await entered.promise;
  let observed=false;w.hook=async u=>{if(!observed&&u.pathname.endsWith('/tokeninfo')){observed=true;assert.equal(w.store.semanticExecutions.byId(owner,keys[0]).record.stage.submission,'not_sent');release();await filingPromise;const op=await w.store.filing.get(keys[1]);assert.equal(op.fileId,resultId);assert.equal(op.state,'uncertain');const changed=structuredClone(op);delete changed.contextIds;w.db.prepare('UPDATE drive_filing_operations SET receipt=? WHERE operation_id=?').run(JSON.stringify(changed),keys[1]);}};
  const r=parse(await w.run());assert.equal(observed,true);assert.equal(filingPosts,1);if(resultId==='foreign-folder'){assert.equal(w.posts,0);assert.equal(r.submission,'not_sent');assert.equal(r.claim,'released');assert.equal(r.reason,'preflight');}else{assert.equal(w.posts,1);assert.equal(r.state,'verified');}assert.equal((await w.store.filing.get(keys[1])).fileId,resultId);
 }finally{release();if(filingPromise)await filingPromise;await w.close();}
});
