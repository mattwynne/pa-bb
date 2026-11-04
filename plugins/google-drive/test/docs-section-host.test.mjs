// Real production registration + SDK/SQLite + HTTP adapter, no Google port.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import {createBbStore} from '../adapters/bb-store.mjs';
import {sectionVector} from './docs-section-fixtures.mjs';
async function setup(options={}) {
 const v=sectionVector(),h=createFakePluginHost({pluginId:'google-drive',settings:{clientId:'SYNTHETIC',clientSecret:'SYNTHETIC',requireDocsApproval:options.approval??false}}),db=h.bb.storage.database(),original=globalThis.fetch;
 if(options.ltr) {
  for(const p of v.after.tabs[0].documentTab.body.content.slice(2,4))p.paragraph.paragraphStyle.direction='LEFT_TO_RIGHT';
  if(options.ltr==='explicit')for(const p of v.before.tabs[0].documentTab.body.content.slice(2,4))p.paragraph.paragraphStyle.direction='LEFT_TO_RIGHT';
 }
 if(options.inherit || options.styleFault) {
  if(options.styleFault!=='unknown')for(const d of [v.before,v.after])d.tabs[0].documentTab.namedStyles={styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:true}}]};
  for(const p of v.after.tabs[0].documentTab.body.content.slice(2,4))p.paragraph.elements[0].textRun.textStyle=options.styleFault==='effective'?{bold:false}:{};
  if(options.styleFault==='parent')v.after.tabs[0].documentTab.namedStyles.styles[0].textStyle.bold=false;
 }
 let doc=structuredClone(v.before),posts=0,wireError;
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);assert.equal(db.inTransaction,false);
  if(u.pathname.endsWith('/userinfo'))return Response.json({sub:options.subject?'changed':'section-subject',email:v.args.account,email_verified:true});
  if(u.pathname.endsWith('/tokeninfo'))return Response.json({scope:'https://www.googleapis.com/auth/'+(options.scope?'drive.readonly':'drive.file')});
  if(u.pathname==='/drive/v3/files/doc-section')return Response.json({id:'doc-section',trashed:false,mimeType:'application/vnd.google-apps.document'});
  if(u.pathname==='/v1/documents/doc-section')return Response.json(doc);
  if(u.pathname==='/v1/documents/doc-section:batchUpdate'){
   posts++;
   try{assert.deepEqual(JSON.parse(init.body),v.wire);assert.equal(owner().disposition,'held');assert.equal(owner().submission,'unknown');}catch(e){wireError=e;throw e;}
   doc=structuredClone(v.after);if(options.lost)throw Error('PRIVATE_SENTINEL_LOST');if(options.drift)doc.inlineObjects.logo.changed=true;
   return Response.json({documentId:'doc-section',replies:[{},{},{},{}],writeControl:{requiredRevisionId:'r2'}});
  }
  throw Error('Closed synthetic HTTP route');
 };
 const owner=()=>JSON.parse(db.prepare("SELECT record FROM docs_writer_owners WHERE namespace='legacyReplacement'").get().record);
 await plugin(h.bb);const store=createBbStore(db,()=>{});await store.addAccount({subject:'section-subject',email:v.args.account,accessToken:'SYNTHETIC_ACCESS',refreshToken:'SYNTHETIC_REFRESH',expiresAt:Date.now()+600000});
 return {...h,v,db,owner,get posts(){return posts;},mutate:fn=>fn(doc),async call(args={}){const r=await h.harness.behavior.callAgentTool('gdocs_replace_section',{...v.args,...args});if(wireError)throw wireError;return r;},async close(){globalThis.fetch=original;await h.harness.lifecycle.dispose();}};
}
const value=r=>{assert.notEqual(r.isError,true,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
async function pending(h){for(let i=0;i<100;i++){const f=h.harness.inspection.pendingInteractions[0];if(f)return f;await new Promise(r=>setImmediate(r));}throw Error('No review');}
test('section production inspect -> preview -> complete approval -> single batch -> independent preserved readback',async()=>{
 const h=await setup({approval:true});try{
  assert.notEqual(h.db.name,':memory:');
  const inspected=value(await h.harness.behavior.callAgentTool('gdocs_inspect_for_edit',{account:h.v.args.account,document:h.v.args.document}));assert.deepEqual(inspected.tabs[0].headings,[{text:'Focus',level:1},{text:'Tail',level:1}]);
  const preview=value(await h.call());assert.equal(preview.outcome,'preview');assert.equal(preview.proposal.heading,'Focus');assert.equal(preview.proposal.oldText,'Old.\nMore.');assert.equal(preview.proposal.startIndex,7);assert.equal(preview.proposal.endIndex,17);assert.equal(h.posts,0);
  const done=h.call({preview:false}),form=await pending(h);assert.equal(form.payload.kind,'section');assert.equal(form.payload.newText,'Fresh 😀.\nSecond.');assert.equal(form.payload.heading,'Focus');assert.match(form.payload.formatting,/paragraph count may change/);assert.equal(h.posts,0);
  h.harness.behavior.submitInteraction(form.id,{approved:true});assert.equal(value(await done).outcome,'verified');assert.equal(h.posts,1);assert.equal(h.owner().disposition,'released');assert.equal(h.owner().submission,'acknowledged');
 }finally{await h.close();}
});
for(const ltr of ['explicit','materialized'])test('production section '+ltr+' LTR and equal-known-parent omission verifies one acknowledged batch',async()=>{
 const h=await setup({ltr,inherit:true});try{assert.equal(value(await h.call({preview:false})).outcome,'verified');assert.equal(h.posts,1);assert.equal(h.owner().submission,'acknowledged');assert.equal(h.owner().disposition,'released');}finally{await h.close();}
});
for(const styleFault of ['effective','parent','unknown'])test('production section style '+styleFault+' drift stays acknowledged/held and current-r2 valid section cannot replay',async()=>{
 const h=await setup({styleFault});try{assert.equal(value(await h.call({preview:false})).outcome,'verification_unavailable');assert.equal(h.owner().submission,'acknowledged');assert.equal(h.owner().disposition,'held');
  const retry=await h.call({expectedRevisionId:'r2',newText:'Another body.',preview:false});assert.equal(retry.isError,true);assert.match(retry.content[0].text,/Another local operation is holding/);assert.equal(h.posts,1);
 }finally{await h.close();}
});
for(const fault of ['revision','subject','scope','cancel','decline'])test('section approval boundary '+fault+' cannot submit',async()=>{
 const options={approval:true},h=await setup(options);try{const done=h.call({preview:false}),form=await pending(h);
  if(fault==='revision')h.mutate(d=>{d.revisionId='changed';});if(fault==='subject')options.subject=true;if(fault==='scope')options.scope=true;
  if(fault==='cancel')h.harness.behavior.cancelInteraction(form.id);else h.harness.behavior.submitInteraction(form.id,{approved:fault!=='decline'});
  const r=await done;if(['revision','subject','scope'].includes(fault))assert.equal(r.isError,true);else assert.equal(value(r).outcome,fault==='cancel'?'cancelled':'declined');assert.equal(h.posts,0);
 }finally{await h.close();}
});
for(const fault of ['lost','drift'])test('section '+fault+' stays held; matching current revision never grants replay',async()=>{
 const h=await setup({[fault]:true});try{assert.equal(value(await h.call({preview:false})).outcome,fault==='lost'?'uncertain':'verification_unavailable');assert.equal(h.owner().disposition,'held');assert.equal(h.owner().submission,fault==='lost'?'unknown':'acknowledged');
  assert.equal((await h.call({expectedRevisionId:'r2',newText:'Again.',preview:false})).isError,true);assert.equal(h.posts,1);
  assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries),/PRIVATE_SENTINEL|SYNTHETIC_ACCESS|section@example|Old\.|Fresh/);
 }finally{await h.close();}
});
test('section malformed Unicode and unsupported structure refuse before claim/POST',async()=>{
 const h=await setup();try{assert.equal((await h.call({newText:'bad\ud800',preview:false})).isError,true);h.mutate(d=>{d.tabs[0].documentTab.body.content[2].paragraph.bullet={listId:'x'};});assert.equal((await h.call({preview:false})).isError,true);assert.equal(h.posts,0);assert.equal(h.db.prepare('SELECT count(*) n FROM docs_writer_owners').get().n,0);}finally{await h.close();}
});
