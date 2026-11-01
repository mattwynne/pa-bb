import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../../../adapters/bb-store.mjs';
import { createSemanticSnapshotStore } from '../../../adapters/docs-semantic-store.mjs';
import { createGoogleAdapter } from '../../../adapters/google.mjs';
import { registerSemanticReadTools } from '../../../docs-semantic-registration.mjs';
export const semanticVector=JSON.parse(readFileSync(new URL('../coverage/fixtures/snapshot-vector.json',import.meta.url)));
export const semanticAccount='writer@example.test';
export const semanticScope={tabs:{ids:['tab-a']},segments:[{kind:'body'}]};
const metadataUrl='https://www.googleapis.com/drive/v3/files/doc-a?fields=id%2Cname%2CmimeType%2CmodifiedTime%2Cversion%2Ctrashed%2Ccapabilities%28canEdit%29&supportsAllDrives=true';
const documentUrl='https://docs.googleapis.com/v1/documents/doc-a?includeTabsContent=true&suggestionsViewMode=';
export class SemanticWorld {
  constructor(){this.calls=[];this.faults=[];this.clock=0;this.identity='subject-a';this.fault='none';this.logs=[];}
  async init({snapshotIds,...options}={}) {
    this.host=createFakePluginHost({pluginId:'docs-semantic-offline'});this.store=createBbStore(this.host.bb.storage.database(),this.host.bb.storage.migrate);
    assert.ok(existsSync(this.host.bb.storage.database().name));assert.notEqual(this.host.bb.storage.database().name,':memory:');
    if(snapshotIds)this.store.semanticSnapshots=createSemanticSnapshotStore(this.host.bb.storage.database(),{ids:snapshotIds});
    await this.store.addAccount({subject:'subject-a',email:semanticAccount,refreshToken:'PRIVATE_REFRESH',accessToken:'PRIVATE_TOKEN',expiresAt:9000000});
    this.adapter=createGoogleAdapter({store:this.store,getClient:async()=>{throw new Error('PRIVATE_UNEXPECTED_REFRESH');},clock:()=>this.clock,fetchImpl:this.fetch.bind(this)});
    registerSemanticReadTools(this.host.bb,this.store,this.adapter,{clock:()=>this.clock,...options});
  }
  async fetch(url,init={}) {
    const request={url:String(url),method:init.method??'GET'};this.calls.push(request);
    try {
      assert.equal(request.method,'GET','read must never mutate');assert.equal(init.body,undefined);assert.equal(init.headers?.authorization,'Bearer PRIVATE_TOKEN');
      if(request.url==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:this.identity,email:semanticAccount,email_verified:true});
      if(request.url===metadataUrl)return Response.json(this.metadata??semanticVector.metadata);
      const viewUrls=[documentUrl+'SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED',documentUrl+'SUGGESTIONS_INLINE',documentUrl+'PREVIEW_SUGGESTIONS_ACCEPTED',documentUrl+'PREVIEW_WITHOUT_SUGGESTIONS'];
      assert.ok(viewUrls.includes(request.url),'unexpected HTTP');
      if(this.fault==='deniedComments'&&request.url.endsWith('commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED'))return new Response('PRIVATE_BODY',{status:403});
      if(this.fault==='providerDenied')return new Response('PRIVATE_BODY',{status:403});
      if(this.fault==='overrun')return new Response('PRIVATE_BODY',{headers:{'content-length':String(8*1048576+1)}});
      if(this.fault==='invalidUtf8')return new Response(Buffer.from([0xff]));
      if(this.fault==='transport')throw Object.assign(new Error('PRIVATE_MESSAGE'),{cause:'PRIVATE_CAUSE',code:'PRIVATE_CODE'});
      return Response.json(this.document??semanticVector.document);
    }catch(error){if(this.fault==='transport'&&error.message==='PRIVATE_MESSAGE')throw error;this.faults.push('HTTP contract');throw error;}
  }
  async call(name,args,threadId='thread-a') {
    const result=await this.host.harness.behavior.callAgentTool(name,args,{threadId});
    const value=JSON.parse(result.content[0].text);this.last={result,value};return value;
  }
  inspect(extra={}){return this.call('docs_inspect',{account:semanticAccount,document:'doc-a',scope:semanticScope,...extra});}
  async close(){try{assert.deepEqual(this.faults,[],'unacknowledged semantic HTTP contract fault');assert.ok(this.calls.every(c=>c.method==='GET'),'zero provider mutation');}finally{await this.host?.harness.lifecycle.dispose();}}
  assertInitialWire(){assert.deepEqual(this.calls,[
    {url:'https://openidconnect.googleapis.com/v1/userinfo',method:'GET'},
    {url:'https://openidconnect.googleapis.com/v1/userinfo',method:'GET'},
    {url:metadataUrl,method:'GET'},
    {url:'https://openidconnect.googleapis.com/v1/userinfo',method:'GET'},
    {url:documentUrl+'SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED',method:'GET'},
  ]);}
}
