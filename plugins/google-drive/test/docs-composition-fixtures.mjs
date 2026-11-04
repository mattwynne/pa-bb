// Technical ports and independently handwritten raw states/wire. No semantic answer stubs.
import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createBbStore} from '../adapters/bb-store.mjs';
import {createGoogleAdapter} from '../adapters/google.mjs';
import {createSemanticReadService} from '../core/docs-semantic/application.mjs';
import {createCompositionHandlers} from '../docs-composition-tools.mjs';
import {createOperationStatusHandler} from '../docs-operation-status-tools.mjs';
import {createCompositionService} from '../core/docs-semantic/compositions.mjs';
import {plainStyle,neighborStyle} from './docs-semantic-text-vectors.mjs';
import {draftOwner as owner,operationKeys as keys} from './docs-semantic-draft-fixtures.mjs';
export {owner,keys,plainStyle,neighborStyle};
import {mixedVector} from './docs-composition-vectors.mjs';
export {mixedVector,astralMixedVector} from './docs-composition-vectors.mjs';
export const parse=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return JSON.parse(r.content[0].text);};
export const tables=db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
export async function compositionWorld(opts={}){
 const vector=opts.vector??mixedVector(),h=createFakePluginHost({pluginId:'mixed-composition',settings:{requireDocsApproval:opts.approval??false}}),host=h.bb.storage.database(),db=opts.dbPath?new host.constructor(opts.dbPath):host,store=createBbStore(db,h.bb.storage.migrate);if(opts.dbPath)h.bb.onDispose(()=>{if(db.open)db.close();});
 const w={h,db,store,controller:new AbortController(),now:opts.now??1000,document:structuredClone(opts.document??vector.before),vector,calls:[],posts:0,trace:[],checkpoint:()=>{},hook:async()=>{},forbidden:[],statusPhase:false};
 if(!await store.bySubject(owner.subject))await store.addAccount({subject:owner.subject,email:owner.account,refreshToken:'PRIVATE_MIXED_REFRESH',accessToken:'PRIVATE_MIXED_ACCESS',expiresAt:Date.now()+3600000});
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url),method=init.method??'GET';w.calls.push({url:String(url),method,inTransaction:db.inTransaction,statusPhase:w.statusPhase});assert.equal(db.inTransaction,false,'ALL HTTP outside SQL transaction');if(w.statusPhase)assert.equal(method,'GET');await w.hook(u,init);
  if(u.pathname.endsWith('/userinfo'))return Response.json(String(init.headers?.authorization??'').includes('PRIVATE_OTHER_ACCESS')?{sub:'OTHER_SUBJECT',email:'other@example.test',email_verified:true}:{sub:owner.subject,email:owner.account,email_verified:true});
  if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/drive.file'});
  if(u.pathname.endsWith(':batchUpdate')){
   w.posts++;w.trace.push('POST');assert.deepEqual(JSON.parse(init.body),w.expectedWire??vector.wire,'literal independent complete wire');const saved=store.semanticExecutions.byId(owner,w.activeKey);assert.equal(saved.record.stage.submission,'unknown');assert.equal(saved.record.stage.intentPersisted,true);
   if(opts.reject)return Response.json({secret:'PRIVATE_PROVIDER_REJECT'},{status:opts.reject});w.document=structuredClone(opts.after??vector.after);if(opts.afterRevision)w.document.revisionId=opts.afterRevision;if(opts.extraEffect)opts.extraEffect(w.document);if(opts.lost)throw Error('PRIVATE_MIXED_LOST');
   return Response.json(opts.reply??{documentId:'draft-doc',replies:(w.expectedWire??vector.wire).requests.map(()=>({})),writeControl:{requiredRevisionId:'r2'},...(opts.save?{commentUpdateState:opts.save}:{})});
  }
  if(u.hostname==='docs.googleapis.com'){if((w.posts||opts.reopen)&&w.activeKey&&!opts.reject){const saved=store.semanticExecutions.byId(owner,w.activeKey);assert.equal(saved.record.stage.submission,opts.lost||opts.unattributed?'unknown':'acknowledged','durable ACK BEFORE GET');w.trace.push('GET_AFTER_'+saved.record.stage.submission);if(opts.denyAfter)return Response.json({secret:'PRIVATE_AFTER'},{status:403});}return Response.json(w.document);}
  if(u.pathname.includes('/drive/v3/files/')){const id=decodeURIComponent(u.pathname.split('/').at(-1));return Response.json(id==='draft-doc'?{id,name:'Mixed literal witness',mimeType:'application/vnd.google-apps.document',trashed:false,parents:['folder-a'],capabilities:{canEdit:true}}:id==='folder-a'?{id,mimeType:'application/vnd.google-apps.folder',trashed:false,parents:['root-a']}:{id:'root-a',mimeType:'application/vnd.google-apps.folder',trashed:false});}
  throw Error('Unexpected closed technical HTTP route');
 };
 w.fetchImpl=fetchImpl;w.adapter=createGoogleAdapter({store,getClient:async()=>({clientId:'SYNTHETIC',clientSecret:'SYNTHETIC'}),fetchImpl});let sequence=0;w.ids=()=>keys[sequence++];
 if(!opts.reopen){const reader=createSemanticReadService({store,docs:w.adapter.semanticDocs,clock:()=>w.now,ids:()=> 'composition-snapshot'});w.inspect=await reader.inspect({account:owner.account,document:'draft-doc',scope:{tabs:{all:true},segments:[{kind:'body'}]}},owner.threadId);}
 w.snapshotId=opts.snapshotId??'composition-snapshot';if(!opts.reopen){w.snapshot=store.semanticSnapshots.get(w.snapshotId,owner,w.now);w.nodes=Object.values(w.snapshot.nodes).filter(n=>n.kind==='paragraph');}
 const settings=h.bb.settings.define({requireDocsApproval:{type:'boolean',label:'Docs approval',default:true}});w.handlers=createCompositionHandlers({bb:h.bb,settings,store,adapter:w.adapter,clock:()=>w.now,ids:w.ids,checkpoint:stage=>w.checkpoint(stage)});for(const d of w.handlers.definitions)h.bb.agents.registerTool(d);
 w.core=createCompositionService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>w.now,ids:w.ids});
 w.rawCall=(name,input,threadId=owner.threadId)=>{if(name==='docs_apply')w.activeKey=input.operationId;return h.harness.behavior.callAgentTool(name,input,{threadId,signal:w.controller.signal});};w.call=async(name,input,thread)=>parse(await w.rawCall(name,input,thread));
 const prepare=db.prepare.bind(db),exec=db.exec.bind(db),pragma=db.pragma.bind(db);db.prepare=sql=>{if(w.statusPhase&&!/^\s*(SELECT|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)){w.forbidden.push('prepare');throw Error('FORBIDDEN prepare');}return prepare(sql);};db.exec=(...args)=>{if(w.statusPhase){w.forbidden.push('exec');throw Error('FORBIDDEN exec');}return exec(...args);};db.pragma=(...args)=>{if(w.statusPhase){w.forbidden.push('pragma');throw Error('FORBIDDEN pragma');}return pragma(...args);};
 const deny=key=>{w.forbidden.push(String(key));throw Error('FORBIDDEN store');},nested=(o,allowed)=>new Proxy(o,{get(t,k){return allowed.includes(k)?t[k].bind(t):deny(k);}}),reads=new Proxy(store,{get(t,k){if(k==='byEmail')return t[k].bind(t);if(k==='semanticDrafts')return nested(t[k],['byId']);if(k==='semanticExecutions')return nested(t[k],['byId','evidence']);return deny(k);}}),recovery=createOperationStatusHandler({bb:h.bb,db,store:reads,fetchImpl});h.bb.agents.registerTool(recovery.definition);
 w.status=async input=>{w.activeKey=input.operationId??w.activeKey;db.pragma('query_only=ON');assert.equal(db.pragma('query_only',{simple:true}),1);const before=tables(db),start=w.calls.length;let result;w.statusPhase=true;try{result=await w.call('docs_operation_status',{account:owner.account,...input},'OTHER_THREAD');return result;}finally{w.statusPhase=false;const current=tables(db),calls=w.calls.slice(start);assert.deepEqual(current,before);assert.deepEqual(w.forbidden,[]);assert.ok(calls.every(c=>c.method==='GET'&&c.inTransaction===false),'outside SUT finally: caught method/transaction errors cannot hide');db.pragma('query_only=OFF');}};
 w.close=()=>{w.controller.abort();return h.harness.lifecycle.dispose();};return w;
}
export const newDraft=(w,requestId)=>({kind:'new',requestId,destination:{snapshotId:w.snapshotId},mode:'direct'});
export const styleCommand=node=>({op:'text',target:{node},set:{bold:false}});
export const textCommand=node=>({op:'replace',target:{node},oldText:'old',newText:'newer'});
export const familyArgs=(w,draft,commands)=>({account:owner.account,draft,commands});
