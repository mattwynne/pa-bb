import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createBoldSealService} from '../core/docs-semantic/bold-seal.mjs';
import {createFilingAdapter} from '../adapters/filing.mjs';
import {createFilingService} from '../core/filing.mjs';
import {createUploadService} from '../core/upload.mjs';
import {createUploadAdapter} from '../adapters/upload.mjs';
import {createUploadSource} from '../adapters/upload-source.mjs';
import {officeFixture} from './office-fixtures.mjs';
import {contextWorld,tableBytes,owner,keys,DOC,FOLDER} from './docs-semantic-target-context-fixtures.mjs';
async function world(){const w=await contextWorld();w.seals=createBoldSealService({store:w.store,docs:w.docs,clock:()=>w.now});w.seal=()=>w.seals.sealBold(owner,w.input);return w;}
const attempt=async fn=>{try{return await fn();}catch(error){return {error};}};
function rawProvider(w,{onMutation=async()=>{},upload=false,folderResult=null}={}){
 let mutations=0,readbacks=0;
 const fetchImpl=async(url,options={})=>{
  const u=new URL(url),id=u.pathname.split('/').at(-1);
  if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/drive'});
  if(['POST','PATCH','DELETE'].includes(options.method)){
   mutations++;await onMutation();if(upload)return Response.json({id:'draft-doc'});if(folderResult)return Response.json({id:folderResult});throw Error('SYNTHETIC_LOST_FILING_REPLY');
  }
  if(u.pathname.endsWith('/permissions'))return Response.json({permissions:[{id:'owner-permission',type:'user',role:'owner',emailAddress:owner.account}]});
  if(u.searchParams.has('q'))return Response.json({files:[]});
  if(u.hostname==='docs.googleapis.com'){readbacks++;return Response.json({private:'unavailable'},{status:403});}
  const key=id==='root'?'root-concrete':id,m=key==='root-concrete'?w.files.root:w.files[key]??{parents:['root-concrete']};
  return Response.json({id:key,name:upload&&key==='draft-doc'?'Uploaded.docx':'Synthetic',mimeType:key==='draft-doc'||key==='unrelated-doc'?DOC:FOLDER,trashed:false,parents:m.parents,owners:[{me:true,emailAddress:owner.account}],capabilities:{canAddChildren:true,canMoveItemWithinDrive:true},appProperties:upload&&key==='draft-doc'?{paLocalUpload:keys[1]}:undefined});
 };
 const filing=createFilingAdapter({verifiedAccess:async()=> 'SYNTHETIC',fetchImpl});
 return {filing,fetchImpl,mutations:()=>mutations,readbacks:()=>readbacks};
}
function filingRoute(w,kind,{target='draft-doc'}={}){
 const p=rawProvider(w),service=createFilingService({store:w.store,operations:w.store.filing,filing:p.filing,clock:()=>w.now,requireApproval:async()=>true,approve:async()=>({outcome:'submitted',value:{approved:true}})});
 const common={account:owner.account,operationId:keys[1],preview:false};
 const move={...common,fileId:target,expectedParentId:target==='draft-doc'?'foreign-folder':'root-concrete',folderId:'destination-folder'};
 const run=()=>kind==='task'?service.task({...common,items:[{kind:'move',operationId:keys[2],fileId:move.fileId,expectedParentId:move.expectedParentId,folderId:move.folderId}]}):kind==='folder'?service.createFolder({...common,parentId:'foreign-folder',name:'New sibling'}):service.move(move);
 return {...p,run};
}
for(const kind of ['move','task'])for(const oldFirst of [true,false])test(`actual filing ${kind} child ${oldFirst?'first blocks seal':'after seal stops real claim/start with zero PATCH'}`,async()=>{
 const w=await world();try{const route=filingRoute(w,kind);if(oldFirst){await route.run();assert.equal(route.mutations(),1);const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);}else{await w.seal();await attempt(route.run);assert.equal(route.mutations(),0);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}}finally{await w.close();}
});
for(const kind of ['folder','move'])test(`actual unrelated ${kind} under common ancestry remains allowed after semantic seal`,async()=>{
 const w=await world();try{const route=filingRoute(w,kind,{target:'unrelated-doc'});await w.seal();await route.run();assert.equal(route.mutations(),1);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}finally{await w.close();}
});
for(const marker of [false,true])for(const contextIds of ['intact','empty','missing'])test(`actual unresolved folder create RESULT matching visited ancestor blocks seal, marker=${marker}, contextIds=${contextIds}`,async()=>{
 const w=await world();try{const raw=rawProvider(w,{folderResult:'foreign-folder'}),service=createFilingService({store:w.store,operations:w.store.filing,filing:raw.filing,clock:()=>w.now});await service.createFolder({account:owner.account,operationId:keys[1],parentId:'root',name:'New birth',preview:false});assert.equal(raw.mutations(),1);const op=await w.store.filing.get(keys[1]);assert.equal(op.fileId,'foreign-folder');assert.equal(op.state,'uncertain');
  if(contextIds!=='intact'){const row=w.db.prepare('SELECT receipt FROM drive_filing_operations WHERE operation_id=?').get(keys[1]),changed=JSON.parse(row.receipt);if(contextIds==='empty')changed.contextIds=[];else delete changed.contextIds;w.db.prepare('UPDATE drive_filing_operations SET receipt=? WHERE operation_id=?').run(JSON.stringify(changed),keys[1]);const expected=structuredClone(op);if(contextIds==='empty')expected.contextIds=[];else delete expected.contextIds;assert.deepEqual(await w.store.filing.get(keys[1]),expected);}
  const capture=w.store.writers.readTargetContextFacts({resourceIds:['draft-doc','foreign-folder','root-concrete'].sort(),markerKeys:[]});assert.ok(capture.legacy.some(row=>row.key===keys[1]),'provider RESULT pointer is selected independently of optional context');
  if(marker)w.files['foreign-folder'].appProperties={paFilingCreation:keys[1]};
  const {createBoldTargetContextService}=await import('../core/docs-semantic/bold-target-context.mjs');const context=await createBoldTargetContextService({store:w.store,docs:w.docs,clock:()=>w.now}).inspectBoldTargetContext(owner,w.input);assert.equal(context.localCoordination.blockers.length,0);
  const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);
 }finally{await w.close();}
});
for(const contextIds of ['intact','empty','missing'])test(`actual unrelated unresolved folder result/common-root read-read still permits seal, contextIds=${contextIds}`,async()=>{
 const w=await world();try{const raw=rawProvider(w,{folderResult:'unrelated-folder'}),service=createFilingService({store:w.store,operations:w.store.filing,filing:raw.filing,clock:()=>w.now});await service.createFolder({account:owner.account,operationId:keys[1],parentId:'root',name:'New unrelated birth',preview:false});assert.equal(raw.mutations(),1);const op=await w.store.filing.get(keys[1]);assert.equal(op.fileId,'unrelated-folder');assert.equal(op.state,'uncertain');if(contextIds!=='intact'){const changed=structuredClone(op);if(contextIds==='empty')changed.contextIds=[];else delete changed.contextIds;w.db.prepare('UPDATE drive_filing_operations SET receipt=? WHERE operation_id=?').run(JSON.stringify(changed),keys[1]);}assert.equal((await w.seal()).state,'sealed');assert.equal((await w.store.filing.get(keys[1])).fileId,'unrelated-folder');
 }finally{await w.close();}
});
for(const oldFirst of [true,false])test(`actual captured DOCX import ${oldFirst?'returned ID first blocks seal':'late returned ID retains ACK and does zero readback after blocked attach'}`,async()=>{
 const w=await world(),dir=await mkdtemp(join(tmpdir(),'semantic-upload-'));try{
  const bytes=officeFixture('docx_to_doc'),sha=createHash('sha256').update(bytes).digest('hex');await writeFile(join(dir,'synthetic.docx'),bytes);
  const raw=rawProvider(w,{upload:true,onMutation:async()=>{if(!oldFirst)await w.seal();}}),source=createUploadSource({location:async()=>dir}),adapter=createUploadAdapter({verifiedAccess:async()=> 'SYNTHETIC',fetchImpl:raw.fetchImpl});
  const service=createUploadService({store:w.store,source,upload:adapter,assessment:raw.filing,clock:()=>w.now});
  const args={account:owner.account,operationId:keys[1],source:{host:'bb-server',threadId:'thr_synthetic',path:'synthetic.docx'},expectedSha256:sha,folderId:'foreign-folder',name:'Uploaded.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',mode:'docx_to_doc'};
  await service.submit({...args,preview:true});const r=await service.submit({...args,preview:false},undefined,async()=>({outcome:'submitted',value:{approved:true}}));assert.equal(raw.mutations(),1);assert.notEqual(r.outcome,'verified');const op=await w.store.getCreation(keys[1]);assert.equal(op.acknowledged,true);assert.equal(op.fileId,'draft-doc');
  if(oldFirst){const before=tableBytes(w.db);await assert.rejects(w.seal(),/conflict/);assert.deepEqual(tableBytes(w.db),before);}else{assert.equal(raw.readbacks(),0);assert.equal(w.store.writers.get('semantic',w.input.operationId).disposition,'held');}
 }finally{await rm(dir,{recursive:true,force:true});await w.close();}
});
