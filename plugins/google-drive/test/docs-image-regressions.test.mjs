// Independent-review regressions use synthetic provider data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createDocsAdapter } from '../adapters/docs.mjs';
import { createDocsImageService } from '../core/docs-image.mjs';
import { document, account, record } from './docs-fixtures.mjs';
const operationId='33333333-3333-4333-8333-333333333333';
const args={account,document:'doc-a',operationId,tabId:'tab-a',index:1,uri:'https://example.test/logo.png',widthPt:144,expectedRevisionId:'rev-a',preview:false};
const asset={mimeType:'image/png',width:400,height:100,bytes:4096,sha256:'a'.repeat(64)};
async function fixture(options={}){
 const h=createFakePluginHost({pluginId:'image-regressions'}),store=createBbStore(h.bb.storage.database(),h.bb.storage.migrate);await store.addAccount({ ...record, refreshToken: 'synthetic-refresh' });
 let doc=document(options.text||'Text\n'),writes=0,auth=0,now=0,policy=options.noCard?false:true;
 const drive={getFile:async()=>{if(writes&&options.readback==='metadata')throw Object.assign(new Error('PRIVATE_READBACK'),{docsCode:'authorization_failed'});return{id:'doc-a',trashed:false,mimeType:'application/vnd.google-apps.document'};}};
 const docs=createDocsAdapter({verifiedAccess:async()=>'PRIVATE',fetchImpl:async(url,init)=>{
  if(String(url).includes('tokeninfo')){auth++;if(auth===2){if(options.expire)now=600001;if(options.reenable)policy=true;}return Response.json({scope:'https://www.googleapis.com/auth/documents'});}
  if(String(url).endsWith(':batchUpdate')){writes++;const d=doc.tabs[0].documentTab,p=d.body.content[1];p.endIndex++;p.paragraph.elements[0].startIndex++;p.paragraph.elements[0].endIndex++;p.paragraph.elements.unshift({startIndex:1,endIndex:2,inlineObjectElement:{inlineObjectId:'new'}});d.inlineObjects={new:{objectId:'new',inlineObjectProperties:{embeddedObject:{imageProperties:{sourceUri:args.uri},size:{width:{magnitude:144,unit:'PT'},height:{magnitude:36,unit:'PT'}}}}}};doc.revisionId='rev-b';return Response.json({documentId:'doc-a',replies:[{insertInlineImage:{objectId:'new'}}],writeControl:{requiredRevisionId:'rev-b'}});}
  if(writes&&options.readback==='inspect')return new Response('PRIVATE',{status:403});
  return Response.json(doc);
 }});
 const ports={store,drive,docs,assets:{inspect:async()=>asset},clock:()=>now,approvalRequired:async()=>policy};
 return{h,store,ports,service:createDocsImageService(ports),get doc(){return doc;},get writes(){return writes;},close:()=>h.harness.lifecycle.dispose()};
}
test('post-write metadata401/403 and inspect403 remain uncertain, attempted and durably blocked',async()=>{
 for(const readback of ['metadata','inspect']){const f=await fixture({readback});try{
  const r=await f.service.insert(args,undefined,async()=>({outcome:'submitted',value:{approved:true}}));
  assert.equal(r.providerAcknowledged,true);assert.equal(r.writeAttempted,true);assert.equal(r.outcome,'uncertain');assert.equal(f.writes,1);assert.equal(await f.store.images.active('doc-a'),operationId);
  assert.equal((await createDocsImageService(f.ports).status({account,operationId})).outcome,'verification_unavailable');assert.equal(await f.store.images.active('doc-a'),operationId);
 }finally{await f.close();}}
});
test('final async auth boundary rechecks expiry and re-enabled standing-consent policy before the only POST',async()=>{
 for(const opts of [{expire:true},{reenable:true}]){const f=await fixture({...opts,noCard:true});try{
  const r=await f.service.insert(args,undefined,()=>{throw new Error('NO_CARD_EXPECTED');});assert.equal(r.writeAttempted,false);assert.equal(f.writes,0);assert.equal(await f.store.images.active('doc-a'),null);
 }finally{await f.close();}}
});
test('preflight reserves one UTF-16 unit at the 50k bound and stops at 100 existing inline images',async()=>{
 const f=await fixture({text:'x'.repeat(49999)+'\n'});try{await assert.rejects(()=>f.service.insert(args),/bounded/);assert.equal(f.writes,0);}finally{await f.close();}
 const g=await fixture();try{
  const d=g.doc.tabs[0].documentTab,p=d.body.content[1];
  for(let n=0;n<100;n++){const id=`old-${n}`;d.inlineObjects||={};d.inlineObjects[id]={objectId:id,inlineObjectProperties:{embeddedObject:{imageProperties:{sourceUri:args.uri}}}};p.paragraph.elements.unshift({startIndex:0,endIndex:0,inlineObjectElement:{inlineObjectId:id}});}
  let index=1;for(const e of p.paragraph.elements){e.startIndex=index;index+=e.textRun?e.textRun.content.length:1;e.endIndex=index;}p.endIndex=index;
  await assert.rejects(()=>g.service.insert(args),/bounded/);assert.equal(g.writes,0);
 }finally{await g.close();}
});
