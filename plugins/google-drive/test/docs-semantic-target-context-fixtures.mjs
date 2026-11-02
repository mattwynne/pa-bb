import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createBbStore} from '../adapters/bb-store.mjs';
import {createSemanticDocsAdapter} from '../adapters/docs-semantic.mjs';
import {createSemanticReadService} from '../core/docs-semantic/application.mjs';
import {createDraftService} from '../core/docs-semantic/drafts.mjs';
import {createBoldTargetContextService} from '../core/docs-semantic/bold-target-context.mjs';
import {draftOwner,validDraftDocument,operationKeys} from './docs-semantic-draft-fixtures.mjs';
export const DOC='application/vnd.google-apps.document',FOLDER='application/vnd.google-apps.folder';
export const owner=draftOwner,keys=operationKeys;
export function tableBytes(db){
 return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>({name,rows:db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()}));
}
export async function contextWorld(){
 const h=createFakePluginHost({pluginId:'semantic-target-context'}),db=h.bb.storage.database();
 assert.notEqual(db.name,':memory:');
 const store=createBbStore(db,h.bb.storage.migrate);await store.addAccount({subject:owner.subject,email:owner.account,refreshToken:'UNUSED_SYNTHETIC'});
 const w={h,db,store,now:0,calls:[],diagnostics:[],hook:async()=>{},authHook:async()=>{}};
 w.files={
  'draft-doc':{id:'draft-doc',mimeType:DOC,trashed:false,parents:['foreign-folder'],capabilities:{canEdit:true},owners:[{me:false}]},
  'foreign-folder':{id:'foreign-folder',mimeType:FOLDER,trashed:false,parents:['root-concrete'],owners:[{me:false}]},
  root:{id:'root-concrete',mimeType:FOLDER,trashed:false}
 };
 w.docs=createSemanticDocsAdapter({verifiedAccess:async record=>{assert.equal(record.subject,owner.subject);await w.authHook();return 'SYNTHETIC_TOKEN';},fetchImpl:async(url,options)=>{
  const u=new URL(url),id=decodeURIComponent(u.pathname.split('/').at(-1));
  assert.ok(!options.method||options.method==='GET');
  w.calls.push({url:u.href,id,fields:u.searchParams.get('fields')});
  await w.hook(id,u);
  if(u.hostname==='docs.googleapis.com')return Response.json(w.readDocument??validDraftDocument());
  const value=w.files[id];if(value instanceof Response)return value;
  if(!value)return new Response('PRIVATE_PROVIDER_ERROR',{status:404});
  return Response.json(value);
 }});
 w.reader=createSemanticReadService({store,docs:w.docs,clock:()=>w.now,ids:()=> 'context-snapshot'});
 const inspected=await w.reader.inspect({account:owner.account,document:'draft-doc',scope:{tabs:{all:true},segments:[{kind:'body'}]}},owner.threadId);
 const snapshot=store.semanticSnapshots.get(inspected.snapshotId,owner,w.now);
 const node=Object.values(snapshot.nodes).find(n=>n.kind==='paragraph').id;
 w.now=1;
 w.drafts=createDraftService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock:()=>w.now,ids:()=>keys[0]});
 w.draft=w.drafts.plan(owner,{requestId:'real-context',snapshotId:inspected.snapshotId,mode:'direct',command:{op:'paragraphBold',node,bold:true}});
 assert.equal(w.draft.state,'draft');
 w.input={operationId:w.draft.operationId,planHash:w.draft.draftHash};
 w.service=createBoldTargetContextService({store,docs:w.docs,clock:()=>w.now,diagnose:(...args)=>w.diagnostics.push(args)});
 w.inspect=(identity=owner,input=w.input,signal)=>w.service.inspectBoldTargetContext(identity,input,signal);
 w.calls=[];
 w.close=()=>h.harness.lifecycle.dispose();
 return w;
}
