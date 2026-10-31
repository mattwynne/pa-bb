import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createDocsAdapter } from '../adapters/docs.mjs';
import { document, account, record } from './docs-fixtures.mjs';
const generated = new URL('./image-tools.generated.mjs', import.meta.url);
await writeFile(generated, ts.transpileModule((await readFile(new URL('../docs-image-tools.ts', import.meta.url),'utf8')).replaceAll("'./", "'../"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
after(() => unlink(generated));
const { registerDocsImageTools } = await import('./image-tools.generated.mjs');
const operationId = '11111111-1111-4111-8111-111111111111';
const args = { account, document: 'doc-a', operationId, expectedRevisionId: 'rev-a', tabId: 'tab-a', index: 1, uri: 'https://example.test/logo.png', widthPt: 144 };
const parse = r => JSON.parse(r.content[0].text);
async function pending(h) { for (let i=0;i<100;i++) { if (h.harness.inspection.pendingInteractions.length) return h.harness.inspection.pendingInteractions[0]; await new Promise(r=>setTimeout(r,2)); } throw new Error('No synthetic form'); }
async function setup(options = {}) {
  const h = createFakePluginHost({pluginId:'image-host'}), store = createBbStore(h.bb.storage.database(), h.bb.storage.migrate);
  await store.addAccount({ ...record, refreshToken:'PRIVATE_REFRESH' }); let doc = document('Wordmark\n'), writes=0, calls=0, assets=0, policy=true;
  const adapter = { drive: { getFile: async()=>({id:'doc-a',trashed:false,mimeType:'application/vnd.google-apps.document'}) }, docs: createDocsAdapter({ verifiedAccess:async()=>'PRIVATE_TOKEN', fetchImpl:async(url,init)=>{
    calls++; const path=String(url);
    if (options.fail) throw Object.assign(new Error('PRIVATE_BODY'), {cause:'PRIVATE_CAUSE',code:'PRIVATE_CODE'});
    if (path.includes('tokeninfo')) return Response.json({scope: options.readonly?'https://www.googleapis.com/auth/drive.readonly':'https://www.googleapis.com/auth/documents'});
    if (path.includes(':batchUpdate')) {
      writes++; assert.equal(init.method,'POST'); assert.deepEqual(JSON.parse(init.body),{writeControl:{requiredRevisionId:'rev-a'},requests:[{insertInlineImage:{uri:args.uri,location:{tabId:'tab-a',index:1},objectSize:{width:{magnitude:144,unit:'PT'}}}}]});
      const data=doc.tabs[0].documentTab, p=data.body.content[1]; p.endIndex++; p.paragraph.elements[0].startIndex++; p.paragraph.elements[0].endIndex++;
      p.paragraph.elements.unshift({startIndex:1,endIndex:2,inlineObjectElement:{inlineObjectId:'logo'}});
      data.inlineObjects={logo:{objectId:'logo',inlineObjectProperties:{embeddedObject:{size:{width:{magnitude:144,unit:'PT'},height:{magnitude:36,unit:'PT'}},imageProperties:{sourceUri:args.uri,contentUri:'https://google.test/transient'}}}}}; doc.revisionId='rev-b';
      if(options.lost) throw new Error('PRIVATE_LOST');
      return Response.json({documentId:'doc-a',replies:[{insertInlineImage:{objectId:'logo'}}],writeControl:{requiredRevisionId:'rev-b'}});
    }
    return Response.json(doc);
  } }) };
  const assetPort={inspect:async()=>{assets++;return{mimeType:'image/png',width:400,height:100,bytes:4096,sha256:'a'.repeat(64)};}};
  const install = bb => registerDocsImageTools(bb,createBbStore(bb.storage.database(),bb.storage.migrate),adapter,async()=>policy,assetPort);
  await install(h.bb);
  return {...h,install,store, get writes(){return writes;}, get calls(){return calls;},get assets(){return assets;}, set policy(v){policy=v;}, close:()=>h.harness.lifecycle.dispose()};
}
test('native tool schema, exact owner review, adapter payload and durable recovery registration',async()=>{
  const h=await setup();try{
    const b=h.harness.behavior;
    assert.equal((await b.callRpc('docsImageCapabilities',null)).contract,'docs-inline-png-v1');
    assert.equal(parse(await b.callAgentTool('gdocs_inspect_images',{account,document:'doc-a'})).complete,true);
    assert.equal(parse(await b.callAgentTool('gdocs_insert_image',args)).outcome,'proposed');
    const done=b.callAgentTool('gdocs_insert_image',{...args,preview:false}), form=await pending(h);
    assert.equal(form.rendererId,'docs-image-approval');assert.equal(form.payload.uri,args.uri);assert.equal(form.payload.paragraphText,'Wordmark\n');assert.equal(h.writes,0);
    b.submitInteraction(form.id,{approved:true});assert.equal(parse(await done).outcome,'verified');assert.equal(h.writes,1);assert.equal(h.assets,2);
    assert.equal(parse(await b.callAgentTool('gdocs_image_status',{account,operationId})).outcome,'verified');
    await assert.rejects(()=>b.callAgentTool('gdocs_insert_image',{...args,approvalRequired:false}));
    assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries),/PRIVATE|writer@example|Wordmark|logo.png/);
  }finally{await h.close();}
});
test('synthetic native review makes zero Google and asset calls; malformed input cannot approve',async()=>{
  const h=await setup({fail:true});try{
    const done=h.harness.behavior.callAgentTool('gdocs_review_image_example',{}),form=await pending(h);assert.equal(form.payload.exampleOnly,true);
    h.harness.behavior.submitInteraction(form.id,{approved:true});assert.deepEqual(parse(await done),{outcome:'approved',exampleOnly:true,writeAttempted:false});assert.equal(h.calls,0);assert.equal(h.assets,0);
  }finally{await h.close();}
});
test('native disposal/abort/timeout/invalid approval never writes or resumes after reload',async()=>{
  for(const mode of ['abort','timeout','invalid','dispose']){const h=await setup(),controller=new AbortController();let replacement;try{
    if(mode==='timeout'){const request=h.bb.ui.requestInput.bind(h.bb.ui);h.bb.ui.requestInput=(p,o)=>request({...p,timeoutMs:20},o);}
    const done=h.harness.behavior.callAgentTool('gdocs_insert_image',{...args,preview:false},{signal:controller.signal}),form=await pending(h);
    if(mode==='abort')controller.abort();if(mode==='dispose')await h.harness.lifecycle.dispose();if(mode==='invalid')h.harness.behavior.submitInteraction(form.id,{approved:'yes'});
    assert.equal(parse(await done).writeAttempted,false);assert.equal(h.writes,0);
    if(mode!=='dispose'){replacement=await h.harness.lifecycle.reload(h.install);assert.equal(parse(await replacement.harness.behavior.callAgentTool('gdocs_insert_image',{...args,preview:false})).writeAttempted,false);assert.equal(replacement.harness.inspection.pendingInteractions.length,0);}
  }finally{await replacement?.harness.lifecycle.dispose();await h.close();}}
});
test('lost response survives native reload with unresolved claim; diagnostics are bounded',async()=>{
  for(const options of [{lost:true},{readonly:true},{fail:true}]){const h=await setup(options);let replacement;try{
    h.policy=false;const result=await h.harness.behavior.callAgentTool('gdocs_insert_image',{...args,preview:false});
    assert.doesNotMatch(JSON.stringify(result)+JSON.stringify(h.harness.inspection.logEntries),/PRIVATE|writer@example|Wordmark/);
    if(options.lost){assert.equal(parse(result).outcome,'uncertain');replacement=await h.harness.lifecycle.reload(h.install);assert.equal(parse(await replacement.harness.behavior.callAgentTool('gdocs_image_status',{account,operationId})).outcome,'observed_matching');assert.equal(h.writes,1);}
    else {assert.equal(h.writes,0);assert.equal(h.harness.inspection.pendingInteractions.length,0);assert.match(JSON.stringify(h.harness.inspection.logEntries),options.readonly?/docs_image_preflight.*scope_required/:/agent_tool gdocs_insert_image/);}
  }finally{await replacement?.harness.lifecycle.dispose();await h.close();}}
});
