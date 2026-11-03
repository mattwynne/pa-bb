import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createBbStore} from '../adapters/bb-store.mjs';
import {createGoogleAdapter} from '../adapters/google.mjs';
import {createSemanticReadService} from '../core/docs-semantic/application.mjs';
import {createDraftService} from '../core/docs-semantic/drafts.mjs';
import {createBoldApplyHandler} from '../docs-semantic-apply-tools.mjs';
import {draftOwner as owner,validDraftDocument,boldAfter,boldRequest,operationKeys as keys} from './docs-semantic-draft-fixtures.mjs';
export {owner,keys};
export const parse=result=>{assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);};
export async function pending(w){for(let n=0;n<500;n++){if(w.h.harness.inspection.pendingInteractions.length)return w.h.harness.inspection.pendingInteractions[0];await new Promise(r=>setTimeout(r,2));}throw Error('Native form did not arrive');}
export async function nativeWorld(options={}){
 const h=createFakePluginHost({pluginId:'semantic-native-edit',settings:{requireDocsApproval:options.approval??true}}),hostDb=h.bb.storage.database(),db=options.dbPath?new (hostDb.constructor)(options.dbPath):hostDb,store=createBbStore(db,h.bb.storage.migrate);
 if(options.dbPath)h.bb.onDispose(()=>{if(db.open)db.close();});
 assert.notEqual(db.name,':memory:');
 const w={h,db,store,now:1000,document:options.document??validDraftDocument(),posts:0,afterGets:0,calls:[],trace:[],hook:async()=>{},checkpoint:()=>{}};
 const settings=h.bb.settings.define({requireDocsApproval:{type:'boolean',default:true,label:'Docs approval'}});w.settings=settings;
 if(!await store.bySubject(owner.subject))await store.addAccount({subject:owner.subject,email:owner.account,refreshToken:'SYNTHETIC_REFRESH',accessToken:'SYNTHETIC_TOKEN',expiresAt:Date.now()+600000});
 const files={
  'draft-doc':{id:'draft-doc',name:'Synthetic Doc',mimeType:'application/vnd.google-apps.document',trashed:false,parents:['foreign-folder'],capabilities:{canEdit:true}},
  'foreign-folder':{id:'foreign-folder',mimeType:'application/vnd.google-apps.folder',trashed:false,parents:['root-concrete']},
  root:{id:'root-concrete',mimeType:'application/vnd.google-apps.folder',trashed:false}
 };
 w.fetchImpl=async(url,init={})=>{
  const u=new URL(url),id=decodeURIComponent(u.pathname.split('/').at(-1));w.calls.push({host:u.hostname,path:u.pathname,method:init.method??'GET'});
  if(u.pathname.endsWith(':batchUpdate')){w.posts++;w.trace.push('FETCH');assert.equal(w.db.inTransaction,false);assert.deepEqual(JSON.parse(init.body),options.wire??boldRequest);const saved=store.semanticExecutions.byId(owner,keys[0]);assert.equal(saved.record.stage.submission,'unknown');assert.equal(saved.record.stage.intentPersisted,true);}
  await w.hook(u,init);
  if(options.network)return options.network(u,init,w);
  if(u.pathname.endsWith('/userinfo'))return Response.json({sub:owner.subject,email:owner.account,email_verified:true});
  if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:options.readonly?'https://www.googleapis.com/auth/drive.readonly':'https://www.googleapis.com/auth/drive.file'});
  if(u.pathname.endsWith(':batchUpdate')){
   if(options.batchNetwork)return options.batchNetwork(u,init,w);
   if(options.reject)return Response.json({error:'SYNTHETIC_REJECTION'},{status:options.reject});
   w.document=structuredClone(options.after??boldAfter());if(options.afterRevision)w.document.revisionId=options.afterRevision;if(options.changeOther)w.document.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content='Other\n';
   if(options.afterInvoke)await options.afterInvoke(w);
   if(options.lost)throw Error('PRIVATE_SYNTHETIC_LOST_RESPONSE');
   return Response.json(options.malformed?{documentId:'wrong',replies:[]}:{documentId:'draft-doc',replies:Array.from({length:options.replyCount??1},()=>options.invalidReply?null:options.unexpectedReply?{deleteContentRange:{}}:{}),writeControl:{requiredRevisionId:'r2',...(options.writeMode?{writeMode:options.writeMode}:{})},...(options.save?{commentUpdateState:options.save}:{}),...(options.suggestions?{suggestionResponses:[{id:'unexpected'}]}:{})});
  }
  if(u.hostname==='docs.googleapis.com'){
   if(w.posts){w.afterGets++;assert.equal(store.semanticExecutions.byId(owner,keys[0]).record.stage.submission,options.lost||options.malformed||options.unattributed?'unknown':'acknowledged');if(options.denyAfter)return Response.json({private:'DENIED'},{status:403});}
   return Response.json(w.document);
  }
  if(u.pathname.includes('/drive/v3/files/'))return Response.json(files[id]);
  throw Error('Unexpected closed HTTP fixture route');
 };
 w.adapter=createGoogleAdapter({store,getClient:async()=>({clientId:'SYNTHETIC',clientSecret:'SYNTHETIC'}),fetchImpl:w.fetchImpl});
 w.drafts=createDraftService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>w.now,ids:()=>keys[0]});
 if(!options.reopen){
 const reader=createSemanticReadService({store,docs:w.adapter.semanticDocs,clock:()=>w.now,ids:()=> 'native-snapshot'}),inspected=await reader.inspect({account:owner.account,document:'draft-doc',scope:{tabs:{all:true},segments:[{kind:'body'}]}},owner.threadId);
 const snapshot=store.semanticSnapshots.get(inspected.snapshotId,owner,w.now),node=Object.values(snapshot.nodes).filter(n=>n.kind==='paragraph')[options.paragraphIndex??0].id;w.snapshotId=inspected.snapshotId;w.node=node;
 w.drafts=createDraftService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>w.now,ids:()=>keys[0]});w.draft=options.sdkPlan?null:w.drafts.plan(owner,{requestId:'native-bold',snapshotId:inspected.snapshotId,mode:'direct',command:{op:'paragraphBold',node,bold:true}});if(!options.sdkPlan)assert.equal(w.draft.state,'draft');
 }else{const saved=store.semanticDrafts.byId(owner,keys[0]);w.draft={operationId:saved.record.operationId,draftHash:saved.record.headHash};}
 let planningSequence=0;
 w.handler=createBoldApplyHandler({bb:h.bb,settings,store,adapter:w.adapter,clock:()=>w.now,checkpoint:stage=>w.checkpoint(stage),planningIds:()=>keys[planningSequence++]});h.bb.agents.registerTool(w.handler.definition);h.bb.agents.registerTool(w.handler.statusDefinition);h.bb.agents.registerTool(w.handler.planDefinition);
 if(options.sdkPlan&&!options.reopen){try{const planned=await h.harness.behavior.callAgentTool(w.handler.planDefinition.name,{account:owner.account,requestId:'native-text',snapshotId:w.snapshotId,node:w.node,oldText:options.oldText,newText:options.newText},{threadId:owner.threadId});w.planResult=planned;w.draft=planned.isError&&options.allowPlanFailure?null:parse(planned);}catch(error){if(!options.allowPlanFailure){await h.harness.lifecycle.dispose();throw error;}w.planFailure=error;w.draft=null;}}
 w.args=w.draft?{account:owner.account,operationId:w.draft.operationId,planHash:w.draft.draftHash}:null;w.input=w.draft?{operationId:w.draft.operationId,planHash:w.draft.draftHash}:null;
 w.run=()=>h.harness.behavior.callAgentTool(w.handler.definition.name,w.args,{threadId:owner.threadId});w.close=()=>h.harness.lifecycle.dispose();return w;
}
