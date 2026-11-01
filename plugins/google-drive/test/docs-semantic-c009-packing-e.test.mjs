// Supplemental C009 prerequisite regressions, not normal ledger/fixture credit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SemanticWorld,semanticAccount,semanticScope,semanticVector} from '../features/docs/support/semantic-world.mjs';
import {closeAmbientNetwork} from '../features/docs/support/offline-network.mjs';
import {READ_WORK_BYTES} from '../adapters/docs-semantic-store.mjs';
const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
function document(headingSize,{padding=true}={}){
 let offset=1;
 const texts=['small heading\n','PRIVATE_PACKING_TEXT_'+('X'.repeat(headingSize))+'\n',...(padding?['p'.repeat(200000)+'\n']:[])];
 const content=texts.map((text,i)=>{const startIndex=offset;offset+=text.length;return {startIndex,endIndex:offset,paragraph:{paragraphStyle:i<2?{headingId:'h'+i,namedStyleType:'HEADING_1'}:{},elements:[{startIndex,endIndex:offset,textRun:{content:text}}]}};});
 return {documentId:'doc-a',revisionId:'rev-packing',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Main',index:0},documentTab:{body:{content}}}]};
}
const limits=[{name:'3000-byte seam',options:{pageBytes:3000},page:3000,heading:5000},{name:'default production page',options:{},page:65536,heading:70000}];
async function fixture(limit,run){
 const restore=closeAmbientNetwork(),w=new SemanticWorld();
 try{await w.init(limit.options);await run(w,w.host.bb.storage.database());assert.ok(!JSON.stringify(w.host.harness.logEntries).includes('PRIVATE_'));}
 finally{try{await w.close();}finally{restore();}}
}
const facts=db=>Object.fromEntries(['cursors','delivery','read_work','integrity'].map(t=>[t,db.prepare('SELECT * FROM docs_semantic_'+t+' ORDER BY rowid').all()]));
const pageFacts=f=>({cursors:f.cursors,delivery:f.delivery,integrity:f.integrity.filter(r=>r.kind!=='work')});
for(const limit of limits)for(const tool of ['docs_inspect','docs_read'])test(`${tool} real packing failures charge once until durable cap (${limit.name})`,{timeout:180000},t=>fixture(limit,async(w,db)=>{
 // Extra real paragraph bounds test iterations; no altered cap, synthetic
 // charge, store error, SQL write or counterfeit projection induces refusal.
 w.document=document(limit.heading);
 let first=await w.inspect(tool==='docs_inspect'?{include:['outline']}:{});assert.ok(first.snapshotId,JSON.stringify(first));const snapshotId=first.snapshotId;
 if(tool==='docs_read')first=await w.call(tool,{account:semanticAccount,snapshotId,scope:semanticScope,format:'text'});
 assert.equal(first.complete,false);assert.ok(first.nextCursor);assert.ok(bytes(first)<=limit.page);
 const before=facts(db),cursor=before.cursors.find(r=>r.id===first.nextCursor),state=JSON.parse(cursor.state);
 assert.equal(cursor.expires,300000);assert.equal(state.offset>0,true);
 const work=f=>f.read_work.find(r=>r.id===state.readId).bytes;
 // Initial and continuation project the same immutable evidence: one charge
 // per attempt must equal the initial page's charge, never a caller-added fee.
 const charge=work(before);assert.ok(charge>0);
 const fittingCharges=Math.floor((READ_WORK_BYTES-charge)/charge);
 assert.ok(fittingCharges>=3&&fittingCharges<1000,'bounded genuine retries must reach the unchanged 256 MiB cap');
 const args={account:semanticAccount,snapshotId,cursor:first.nextCursor};let previous=charge;
 for(let attempt=1;attempt<=fittingCharges+1;attempt++){
  w.clock=attempt;const result=await w.call(tool,args);assert.equal(result.category,'budget',JSON.stringify(result));assert.equal(w.last.result.isError,true);
  const after=facts(db);assert.deepEqual(pageFacts(after),pageFacts(before),'no consumption/publication/renewal on failed packing or charge');
  const expected=previous+(attempt<=fittingCharges?charge:0);assert.equal(work(after),expected,'each failed packing is charged exactly once; over-cap charge is refused atomically');
  assert.ok(work(after)<=READ_WORK_BYTES);assert.deepEqual(after.read_work.filter(r=>r.id!==state.readId),before.read_work.filter(r=>r.id!==state.readId));previous=expected;
 }
 assert.ok(READ_WORK_BYTES-previous<charge);
 t.diagnostic(JSON.stringify({tool,pageBytes:limit.page,initialBytes:charge,failedPackingsCharged:fittingCharges,bytesPerPacking:charge,finalBytes:previous,remainingBytes:READ_WORK_BYTES-previous,cap:READ_WORK_BYTES}));
 const saturated=facts(db);w.clock=299999;assert.equal((await w.call(tool,args)).category,'budget');assert.deepEqual(facts(db),saturated);
 w.clock=300000;assert.equal((await w.call(tool,args)).category,'snapshot');assert.deepEqual(facts(db),saturated);
}));
for(const limit of limits)test(`initial complete inspection charges exactly one actual projection (${limit.name})`,()=>fixture(limit,async(w,db)=>{
 w.document=document(10,{padding:false});const result=await w.inspect({include:['outline']});assert.equal(result.complete,true,JSON.stringify(result));assert.equal(result.nextCursor,null);
 const snapshot=w.store.semanticSnapshots.get(result.snapshotId,owner,0),f=facts(db);assert.equal(f.read_work.length,1);assert.equal(f.delivery.length,1);assert.equal(f.cursors.length,0);
 // Full successful native delivery provides the complete diagnostic projection,
 // independent of the projector implementation (no production helper oracle).
 const projection={records:result.records,losses:result.losses,nodeAspects:result.coverage.delivered.nodeAspects,aspects:[],missingAspects:['content','styles','review'],projection:'diagnostic'};
 assert.equal(f.read_work[0].bytes,bytes(snapshot)+bytes(projection));
}));
for(const limit of limits)for(const explicit of [false,true])test(`initial ${explicit?'explicit':'summary-overflow'} inspection packing failure durably charges without publication (${limit.name})`,()=>fixture(limit,async(w,db)=>{
 w.document=document(10,{padding:false});w.metadata={...semanticVector.metadata,name:'PRIVATE_METADATA_'+('M'.repeat(limit.page-700))};
 assert.ok(bytes(w.metadata)<65536,'metadata GET must succeed below its independent wire cap');
 const result=await w.inspect(explicit?{include:['outline']}:{});assert.equal(result.category,'budget');assert.equal(w.last.result.isError,true);
 const rows=db.prepare('SELECT id,expires FROM docs_semantic_snapshots').all();assert.equal(rows.length,1);assert.equal(rows[0].expires,600000);
 const f=facts(db);assert.equal(f.delivery.length,0);assert.equal(f.cursors.length,0);assert.equal(f.read_work.length,1);
 const snapshot=w.store.semanticSnapshots.get(rows[0].id,owner,0);assert.ok(f.read_work[0].bytes>bytes(snapshot),'actual projection was charged before packing refused');
 assert.equal(f.integrity.filter(r=>r.kind==='work').length,1);assert.equal(f.read_work[0].snapshot,rows[0].id);
}));
test('small summary remains non-paged and does not double-charge a diagnostic read',()=>fixture(limits[1],async(w,db)=>{
 w.document=document(10,{padding:false});const result=await w.inspect();assert.ok(result.snapshotId);assert.equal(result.coverage.delivered,'summary');
 const f=facts(db);assert.deepEqual(f.cursors,[]);assert.deepEqual(f.delivery,[]);assert.deepEqual(f.read_work,[]);assert.deepEqual(f.integrity.map(r=>r.kind),['snapshot']);
}));
