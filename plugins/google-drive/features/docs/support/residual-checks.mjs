// Supplemental offline regression facts, never ledger delivery evidence.
import assert from 'node:assert/strict';
import {SemanticWorld,semanticAccount,semanticScope,semanticVector} from './semantic-world.mjs';
import {footprint,evaluateWitness,previewWitness} from '../../../core/docs-semantic/coverage.mjs';
import {evidenceAt} from '../../../core/docs-semantic/common.mjs';
const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
const args=snapshotId=>({account:semanticAccount,snapshotId,scope:semanticScope,format:'structured',styles:true,review:true});
export function paragraphDocument(count=100,annotations=false){
  return {documentId:'doc-a',revisionId:'rev-a',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{
    tabProperties:{tabId:'tab-a',title:'Simple'},documentTab:{body:{content:Array.from({length:count},(_,i)=>({startIndex:1+i*5,endIndex:6+i*5,paragraph:{
      ...(annotations&&i%10===0?{futureContent:{text:`Unknown ${i}`}}:{}),
      elements:[{startIndex:1+i*5,endIndex:6+i*5,textRun:{content:'Text\n',...(annotations?{textStyle:{bold:true},suggestedInsertionIds:[`suggest-${i}`]}:{})}}]}}))}}}]};
}
export async function paginationResidual({annotations=true,longTokens=false}={}){
  const w=new SemanticWorld();let counter=0;
  try{
    await w.init(longTokens?{snapshotIds:()=>`${++counter}`.padStart(128,'x')}:{});w.document=paragraphDocument(100,annotations);
    const inspected=await w.inspect();assert.ok(inspected.snapshotId);assert.equal(inspected.counts.nodes,201);
    const pages=[],tokens=new Set(),cursors=new Set();let input=args(inspected.snapshotId),offset=0;
    while(input){
      const page=await w.call('docs_read',input);assert.notEqual(page.outcome,'unavailable');assert.ok(Buffer.byteLength(JSON.stringify(page))<=65536);
      const token=page.coverage.deliveryToken;assert.equal(token.length,longTokens?128:36);assert.ok(!tokens.has(token));tokens.add(token);
      if(page.nextCursor){assert.equal(page.nextCursor.length,longTokens?128:36);assert.ok(!cursors.has(page.nextCursor));cursors.add(page.nextCursor);}
      const [receipt]=w.store.semanticSnapshots.deliveries(inspected.snapshotId,owner,0,[token]);
      assert.deepEqual(receipt.nodes,page.records.map(r=>r.id));assert.deepEqual(receipt.nodeAspects,page.coverage.delivered.nodeAspects);
      assert.deepEqual(receipt.aspects,page.coverage.delivered.aspects);assert.deepEqual(receipt.losses,page.losses);
      assert.equal(receipt.complete,page.complete);assert.equal(receipt.offset,offset);offset+=page.records.length;
      const db=w.host.bb.storage.database();assert.ok(Buffer.byteLength(db.prepare('SELECT data FROM docs_semantic_delivery WHERE id=?').get(token).data)<=65536);
      if(page.nextCursor)assert.ok(Buffer.byteLength(db.prepare('SELECT state FROM docs_semantic_cursors WHERE id=?').get(page.nextCursor).state)<=65536);
      pages.push(page);input=page.nextCursor?{account:semanticAccount,snapshotId:inspected.snapshotId,cursor:page.nextCursor}:null;
      assert.ok(pages.length<20,'bounded progress');
    }
    assert.ok(pages.length>1);assert.equal(pages.at(-1).complete,true);
    const records=pages.flatMap(p=>p.records);assert.equal(records.length,201);assert.equal(new Set(records.map(n=>n.id)).size,201);
    assert.equal(records.filter(n=>n.kind==='segment').length,1);
    for(let i=0;i<100;i++){
      const paragraph=records.filter(n=>n.kind==='paragraph'&&n.extent.start===1+i*5),text=records.filter(n=>n.kind==='text'&&n.extent.start===1+i*5);
      assert.equal(paragraph.length,1);assert.equal(text.length,1);assert.equal(text[0].text,'Text\n');
      if(annotations){assert.equal(text[0].style.explicit.bold,true);assert.deepEqual(text[0].review.suggestedInsertionIds,[`suggest-${i}`]);}
    }
    const losses=pages.flatMap(p=>p.losses);assert.equal(losses.length,annotations?10:0);assert.equal(new Set(losses.map(l=>l.node)).size,losses.length);
    assert.equal(w.host.bb.storage.database().prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,pages.length);
    const replay=await w.call('docs_read',{account:semanticAccount,snapshotId:inspected.snapshotId,cursor:pages[0].nextCursor});assert.equal(replay.outcome,'unavailable');
  }finally{await w.close();}
}
export async function extentResidual(kind='otherTab'){
  const w=new SemanticWorld();
  try{
    await w.init();w.document=structuredClone(semanticVector.document);
    const body=w.document.tabs[0].documentTab.body.content;
    if(kind==='otherTab'||kind==='dependency')delete w.document.tabs[1].documentTab.body.content[0].endIndex;
    if(kind==='otherSegment')delete w.document.tabs[0].documentTab.headers['header-a'].content[0].endIndex;
    if(kind==='laterSibling')delete body[8].endIndex;
    if(kind==='otherContainer')delete body[4].table.tableRows[0].tableCells[0].content[0].endIndex;
    if(kind==='target'||kind==='ancestor')delete body[1].endIndex;
    if(kind==='earlierUnbounded')delete body[0].endIndex;
    const inspected=await w.inspect(),page=await w.call('docs_read',args(inspected.snapshotId));assert.equal(page.complete,true);
    const s=w.store.semanticSnapshots.get(inspected.snapshotId,owner,0);assert.equal(s.unresolvedExtents,true);
    assert.equal(s.currentEditEvidence,true,'native revision/view provenance is not global extent completeness');
    const target=page.records.find(n=>n.kind===(kind==='ancestor'?'text':'paragraph')&&n.extent?.start===1)
      ??page.records.find(n=>n.kind==='paragraph'&&n.extent===null);
    const dependency=Object.values(s.nodes).find(n=>n.tabId==='tab-b'&&n.kind==='paragraph');
    const fp=footprint(s,{nodes:[target.id],dependencies:kind==='dependency'?[dependency.id]:[],destructive:true,aspects:['content','styles','review']});
    const original=fp.nodes.map(node=>({node,providerEvidence:evidenceAt(s,s.nodes[node].evidence.path)}));
    const deliveries=w.store.semanticSnapshots.deliveries(inspected.snapshotId,owner,0,[page.coverage.deliveryToken]);
    const expected=['otherTab','otherSegment','laterSibling','otherContainer'].includes(kind);
    for(const evidence of [{deliveries},{preview:previewWitness(s,fp,original)}]){
      const result=evaluateWitness(s,fp,evidence);assert.equal(result.witnessSatisfied,expected,kind);assert.equal(result.editReady,false);
      assert.equal(result.missingAspects.includes('unresolvedExtents'),!expected,kind);
    }
  }finally{await w.close();}
}
