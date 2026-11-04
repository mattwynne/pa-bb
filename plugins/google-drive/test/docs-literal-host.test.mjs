// Actual production registration, real temporary file SQLite, real HTTP adapter.
// Provider responses and expected requests are independent handwritten fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import {createBbStore} from '../adapters/bb-store.mjs';
import {richLiteralVector} from './docs-literal-fixtures.mjs';
async function setup(options={}){
 const v=richLiteralVector(options.kind),h=createFakePluginHost({pluginId:'google-drive',settings:{clientId:'SYNTHETIC',clientSecret:'SYNTHETIC',requireDocsApproval:options.approval??false}}),db=h.bb.storage.database(),original=globalThis.fetch;
 if(options.font){v.before.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle={weightedFontFamily:{fontFamily:'Arial'}};for(const p of v.after.tabs[0].documentTab.body.content[1].paragraph.elements)p.textRun.textStyle={weightedFontFamily:{fontFamily:'Arial',weight:400}};v.wire.requests[2].updateTextStyle.textStyle={weightedFontFamily:{fontFamily:'Arial'}};}
 if(options.inherit){
  const stored=structuredClone(v.wire.requests[2].updateTextStyle.textStyle);
  for(const d of [v.before,v.after])d.tabs[0].documentTab.namedStyles.styles[0].textStyle=structuredClone(stored);
  v.after.tabs[0].documentTab.body.content[1].paragraph.elements[1].textRun.textStyle=options.styleFault==='effective'?{bold:false}:{};
  if(options.styleFault==='parent')v.after.tabs[0].documentTab.namedStyles.styles[0].textStyle.bold=false;
  if(options.styleFault==='outside')v.after.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle={};
 }
 if(options.unknownNeighbor)v.before.tabs[0].documentTab.body.content[1].paragraph.elements=[{startIndex:1,endIndex:10,textRun:{content:'Hello 😀 ',textStyle:{futureStyle:true}}},{startIndex:10,endIndex:15,textRun:{content:'old.\n',textStyle:{bold:true,italic:false,fontSize:{magnitude:12,unit:'PT'}}}}];
 let doc=structuredClone(v.before),posts=0,reads=0,wireError=null;const methods=[];
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url),method=init.method??'GET';methods.push(method);if(db.inTransaction){wireError=new Error('HTTP ran inside the SQL transaction');throw wireError;}
  if(u.pathname.endsWith('/userinfo'))return Response.json({sub:options.wrongSubject?'other':'rich-subject',email:v.args.account,email_verified:true});
  if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/'+(options.scope??'drive.file')});
  if(u.pathname==='/drive/v3/files/doc-rich')return Response.json({id:'doc-rich',trashed:false,mimeType:'application/vnd.google-apps.document'});
  if(u.pathname==='/v1/documents/doc-rich:batchUpdate'){
   posts++;try{assert.deepEqual(JSON.parse(init.body),v.wire);
   const saved=JSON.parse(db.prepare("SELECT record FROM docs_writer_owners WHERE namespace='legacyReplacement'").get().record);assert.equal(saved.submission,'unknown','intent precedes POST');assert.equal(saved.disposition,'held');
   }catch(error){wireError=error;throw error;}
   if(options.reject)return Response.json({private:'SYNTHETIC_PRIVATE_BODY'},{status:403});
   doc=structuredClone(v.after);if(options.lost)throw Error('SYNTHETIC_PRIVATE_LOST');if(options.drift)options.drift(doc);
   return Response.json({documentId:'doc-rich',replies:v.wire.requests.map(()=>({})),writeControl:{requiredRevisionId:'r2'}});
  }
  if(u.pathname==='/v1/documents/doc-rich'){const observed=structuredClone(doc);if(options.rotateUri)observed.inlineObjects.logo.inlineObjectProperties.embeddedObject.imageProperties.contentUri='https://google.test/expiring-'+(++reads);return Response.json(observed);}
  wireError=new Error('Closed synthetic HTTP route');throw wireError;
 };
 try{
  await plugin(h.bb);const store=createBbStore(db,()=>{});await store.addAccount({subject:'rich-subject',email:v.args.account,accessToken:'SYNTHETIC_ACCESS',refreshToken:'SYNTHETIC_REFRESH',expiresAt:Date.now()+600000});
  return {...h,db,v,methods,mutate:change=>change(doc),owner:()=>JSON.parse(db.prepare("SELECT record FROM docs_writer_owners WHERE namespace='legacyReplacement'").get().record),get posts(){return posts;},async call(name,args){const result=await h.harness.behavior.callAgentTool(name,args);if(wireError)throw wireError;return result;},async close(){globalThis.fetch=original;await h.harness.lifecycle.dispose();}};
 }catch(error){globalThis.fetch=original;await h.harness.lifecycle.dispose();throw error;}
}
const value=r=>{assert.notEqual(r.isError,true,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
async function pending(h){for(let i=0;i<100;i++){const form=h.harness.inspection.pendingInteractions[0];if(form)return form;await new Promise(r=>setImmediate(r));}throw Error('Review card did not open');}
test('production handlers inspect rich shape -> preview -> exact owner review -> one independent batch -> verified preserved result and released claim',async()=>{
 const h=await setup({approval:true});try{
  assert.notEqual(h.db.name,':memory:');const inspected=value(await h.call('gdocs_inspect_for_edit',h.v.args.account?{account:h.v.args.account,document:'doc-rich'}:{}));assert.equal(inspected.profile,'body-literal/1');assert.match(inspected.tabs[0].text,/Hello 😀 old/);
  assert.equal(value(await h.call('gdocs_replace_text',h.v.args)).outcome,'preview');assert.equal(h.posts,0);
  const done=h.call('gdocs_replace_text',{...h.v.args,preview:false}),form=await pending(h);assert.equal(form.rendererId,'docs-edit-approval');assert.equal(form.payload.oldText,'old');assert.equal(form.payload.newText,'newer');assert.equal(form.payload.expectedRevisionId,'r1');assert.equal('literal'in form.payload,false);assert.equal(h.posts,0);
  h.harness.behavior.submitInteraction(form.id,{approved:true});const result=value(await done);assert.equal(result.outcome,'verified');assert.equal(result.approval,'owner_approved');assert.equal(h.posts,1);assert.equal(h.owner().disposition,'released');assert.equal(h.owner().submission,'acknowledged');
 }finally{await h.close();}
});
test('production rich unknown neighboring style refuses before any writer claim or POST',async()=>{
 const h=await setup({unknownNeighbor:true});try{assert.equal((await h.call('gdocs_replace_text',{...h.v.args,preview:false})).isError,true);assert.equal(h.posts,0);assert.equal(h.db.prepare("SELECT count(*) n FROM docs_writer_owners WHERE namespace='legacyReplacement'").get().n,0);}finally{await h.close();}
});
test('production rich edit tolerates per-GET expiring logo URLs without treating them as a content/revision change',async()=>{
 const h=await setup({rotateUri:true});try{const r=value(await h.call('gdocs_replace_text',{...h.v.args,preview:false}));assert.equal(r.outcome,'verified');assert.equal(h.posts,1);assert.equal(h.owner().disposition,'released');}finally{await h.close();}
});
test('production rich partial direct font accepts only documented API weight400 normalization',async()=>{
 const h=await setup({font:true});try{const r=value(await h.call('gdocs_replace_text',{...h.v.args,preview:false}));assert.equal(r.outcome,'verified');assert.equal(h.posts,1);assert.equal(h.owner().disposition,'released');}finally{await h.close();}
});
test('production literal equal-known-parent omission only inside inserted text verifies',async()=>{
 const h=await setup({inherit:true});try{assert.equal(value(await h.call('gdocs_replace_text',{...h.v.args,preview:false})).outcome,'verified');assert.equal(h.posts,1);assert.equal(h.owner().submission,'acknowledged');assert.equal(h.owner().disposition,'released');}finally{await h.close();}
});
for(const styleFault of ['effective','parent','outside'])test('production literal '+styleFault+' style drift retains ACK hold and current-revision retry exclusion',async()=>{
 const h=await setup({inherit:true,styleFault});try{assert.equal(value(await h.call('gdocs_replace_text',{...h.v.args,preview:false})).outcome,'verification_unavailable');assert.equal(h.owner().submission,'acknowledged');assert.equal(h.owner().disposition,'held');
  const retry=await h.call('gdocs_replace_text',{...h.v.args,expectedRevisionId:'r2',oldText:'newer',newText:'fresh',preview:false});assert.equal(retry.isError,true);assert.match(retry.content[0].text,/Another local operation is holding/);assert.equal(h.posts,1);
 }finally{await h.close();}
});
for(const kind of ['shorter','delete','astral'])test('production rich '+kind+' uses independent wire and preserved provider observation',async()=>{
 const h=await setup({kind});try{const r=value(await h.call('gdocs_replace_text',{...h.v.args,preview:false}));assert.equal(r.outcome,'verified');assert.equal(h.posts,1);assert.equal(h.owner().disposition,'released');}finally{await h.close();}
});
for(const kind of ['lost','drift','foreignRevision','reject'])test('production rich '+kind+' retains facts and blocks blind uncertain replay',async()=>{
 const options=kind==='lost'?{lost:true}:kind==='drift'?{drift:d=>{d.inlineObjects.logo.changed=true;}}:kind==='foreignRevision'?{drift:d=>{d.revisionId='foreign-r3';}}:{reject:true};
 const h=await setup(options);try{
  const raw=await h.call('gdocs_replace_text',{...h.v.args,preview:false});
  if(kind==='reject')assert.equal(raw.isError,true);else assert.equal(value(raw).outcome,{lost:'uncertain',drift:'verification_unavailable',foreignRevision:'verification_unavailable'}[kind]);
  assert.equal(h.posts,1);assert.equal(h.owner().disposition,kind==='reject'?'released':'held');
  if(kind!=='reject'){const again=await h.call('gdocs_replace_text',{...h.v.args,expectedRevisionId:kind==='foreignRevision'?'foreign-r3':'r2',oldText:'newer',newText:'fresh',preview:false});assert.equal(again.isError,true);assert.match(again.content[0].text,/Another local operation is holding this document/);assert.equal(h.posts,1);assert.equal(h.owner().submission,kind==='lost'?'unknown':'acknowledged');}
  assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries),/SYNTHETIC_PRIVATE|SYNTHETIC_ACCESS|Hello|writer@example/);
 }finally{await h.close();}
});
for(const fault of ['scope','subject','revision','decline','cancel'])test('production rich '+fault+' at review boundary cannot silently authorize a POST',async()=>{
 const options={approval:true},h=await setup(options);try{
  const done=h.call('gdocs_replace_text',{...h.v.args,preview:false}),form=await pending(h);
  if(fault==='scope')options.scope='drive.readonly';if(fault==='subject')options.wrongSubject=true;if(fault==='revision')h.mutate(d=>{d.revisionId='new-revision';});
  if(fault==='cancel')h.harness.behavior.cancelInteraction(form.id);else h.harness.behavior.submitInteraction(form.id,{approved:fault!=='decline'});
  const result=await done;if(['scope','subject','revision'].includes(fault))assert.equal(result.isError,true);else assert.equal(value(result).outcome,fault==='decline'?'declined':'cancelled');assert.equal(h.posts,0);
  for(const row of h.db.prepare("SELECT record FROM docs_writer_owners WHERE namespace='legacyReplacement'").all())assert.equal(JSON.parse(row.record).disposition,'released');
 }finally{await h.close();}
});
for(const options of [{scope:'drive.readonly'},{wrongSubject:true}])test('production rich changed authorization refuses without POST or approval',async()=>{
 const h=await setup(options);try{assert.equal((await h.call('gdocs_replace_text',{...h.v.args,preview:false})).isError,true);assert.equal(h.posts,0);assert.equal(h.harness.inspection.pendingInteractions.length,0);}finally{await h.close();}
});
