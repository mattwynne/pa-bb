import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticDocsAdapter,readSemanticJson } from '../adapters/docs-semantic.mjs';
import { createSemanticReadService } from '../core/docs-semantic/application.mjs';
import { createMemorySnapshots } from '../features/docs/support/memory-snapshots.mjs';
import { semanticVector } from '../features/docs/support/semantic-fixtures.mjs';
import { digest } from '../core/docs-semantic/common.mjs';
const record={subject:'s',email:'a@example.test'};
for(const [view,wire]of [['inline','SUGGESTIONS_INLINE'],['acceptedPreview','PREVIEW_SUGGESTIONS_ACCEPTED'],['rejectedPreview','PREVIEW_WITHOUT_SUGGESTIONS']])test(`real read adapter exact ${view} request and raw observation`,async()=>{
  const calls=[],document={raw:'PRIVATE_DOCUMENT'};const adapter=createSemanticDocsAdapter({verifiedAccess:async r=>{assert.equal(r,record);return 'PRIVATE_TOKEN';},fetchImpl:async(url,init)=>{calls.push(String(url));assert.equal(init.headers.authorization,'Bearer PRIVATE_TOKEN');assert.equal(init.method,undefined);assert.equal(init.body,undefined);return Response.json(document);}});
  const observation=await adapter.read(record,'doc/id',view);assert.deepEqual(observation.document,document);assert.equal(observation.responseDigest,digest(JSON.stringify(document)));assert.equal(observation.responseBytes,Buffer.byteLength(JSON.stringify(document)));assert.equal(observation.reviewIncluded,view==='inline');assert.deepEqual(calls,[`https://docs.googleapis.com/v1/documents/doc%2Fid?includeTabsContent=true&suggestionsViewMode=${wire}${view==='inline'?'&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED':''}`]);
});
test('real adapter does not decide fallback or hide denied observation',async()=>{let n=0;const a=createSemanticDocsAdapter({verifiedAccess:async()=>'',fetchImpl:async()=>{n++;return new Response('PRIVATE_BODY',{status:403});}});await assert.rejects(a.read(record,'doc','inline'),e=>e.semanticCode==='denied'&&e.status===403);assert.equal(n,1);});
test('real metadata adapter encodes exact bounded field selection',async()=>{const a=createSemanticDocsAdapter({verifiedAccess:async()=>'',fetchImpl:async url=>{assert.equal(String(url),'https://www.googleapis.com/drive/v3/files/doc%2Fid?fields=id%2Cname%2CmimeType%2CmodifiedTime%2Cversion%2Ctrashed%2Ccapabilities%28canEdit%29&supportsAllDrives=true');return Response.json({id:'doc/id'});}});assert.deepEqual(await a.metadata(record,'doc/id'),{id:'doc/id'});});
for(const [name,response,category]of [
  ['declared overrun',()=>new Response('x',{headers:{'content-length':'8388609'}}),'budget'],
  ['stream overrun',()=>new Response('12345'),'budget'],
  ['invalid UTF8',()=>new Response(Buffer.from([255])),'corrupt'],
  ['invalid JSON',()=>new Response('PRIVATE_INVALID'),'corrupt'],
  ['denied',()=>new Response('PRIVATE_ERROR',{status:403}),'denied'],
  ['unavailable',()=>new Response('PRIVATE_ERROR',{status:500}),'unavailable'],
])test(`real decoder ${name} closed safe failure`,async()=>{await assert.rejects(readSemanticJson(response(),name==='stream overrun'?4:8388608),e=>e.semanticCode===category&&!JSON.stringify(e).includes('PRIVATE_'));});
for(const failure of [403,500])test(`real application chooses only inline denial fallback: ${failure}`,async()=>{
  const calls=[],memory=createMemorySnapshots(),account='a@example.test',store={byEmail:async()=>record,semanticSnapshots:memory.port};
  const docs={authority:async()=>{},metadata:async()=>semanticVector.metadata,read:async(r,id,view,signal,options)=>{calls.push(options);if(calls.length===1)throw Object.assign(new Error('PRIVATE_ERROR'),{status:failure});return{document:semanticVector.document,responseDigest:'digest',responseBytes:123,reviewIncluded:false};}};
  const service=createSemanticReadService({store,docs,clock:()=>0,ids:()=> 'snapshot'}),args={account,document:'doc-a',scope:{tabs:{ids:['tab-a']},segments:[{kind:'body'}]}};
  if(failure===500)await assert.rejects(service.inspect(args,'thread'),/PRIVATE_ERROR/);else{const result=await service.inspect(args,'thread');assert.equal(result.coverage.missingReviewCoverage,true);}
  assert.deepEqual(calls,failure===403?[{includeReview:true},{includeReview:false}]:[{includeReview:true}]);
});
