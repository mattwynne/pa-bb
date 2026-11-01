import test from 'node:test';
import assert from 'node:assert/strict';
import {paginationResidual,extentResidual,paragraphDocument} from '../features/docs/support/residual-checks.mjs';
import {packReadProjection} from '../core/docs-semantic/reader.mjs';
import {SemanticWorld,semanticAccount,semanticScope} from '../features/docs/support/semantic-world.mjs';
for(const annotations of [false,true])test(`complete-envelope default-budget native pagination; annotations=${annotations}`,()=>paginationResidual({annotations}));
test('complete envelope includes actual 128-character receipt/cursor tokens',()=>paginationResidual({longTokens:true}));
for(const kind of ['otherTab','otherSegment','laterSibling','otherContainer','target','ancestor','dependency','earlierUnbounded'])test(`scoped extent evidence: ${kind}`,()=>extentResidual(kind));
test('packing accumulates unit sizes rather than rebuilding growing envelopes',()=>{
  const records=Array.from({length:1000},(_,i)=>({id:`record-${i}`,text:'x'}));
  const projection={records,losses:[],nodeAspects:Object.fromEntries(records.map(r=>[r.id,['content']]))};
  let builds=0;
  const packed=packReadProjection(projection,{},4096,page=>{
    builds++;
    const {records,losses,nodes,nodeAspects,complete,nextOffset,nextLossOffset}=page;
    return {result:{records,losses,complete,nextCursor:complete?null:'c'.repeat(128),coverage:{delivered:{nodes,nodeAspects},deliveryToken:'d'.repeat(128)}},
      delivery:{nodes,nodeAspects,losses,complete},nextState:complete?null:{offset:nextOffset,lossOffset:nextLossOffset}};
  });
  assert.ok(builds<=12);assert.ok(packed.result.records.length>1);assert.equal(packed.result.complete,false);
  assert.ok(Buffer.byteLength(JSON.stringify(packed.result))<=4096);assert.ok(Buffer.byteLength(JSON.stringify(packed.delivery))<=4096);
});
test('omission-only pages retain every loss and progress through single-use continuations',async()=>{
  const w=new SemanticWorld();try{
    await w.init();w.document=paragraphDocument(1000);const tab=w.document.tabs[0].documentTab;
    tab.inlineObjects={image:{inlineObjectProperties:{embeddedObject:{imageProperties:{contentUri:'https://example.test/not-fetched.png'}}}}};
    tab.body.content=Array.from({length:1000},(_,i)=>({startIndex:i+1,endIndex:i+2,paragraph:{elements:[{startIndex:i+1,endIndex:i+2,inlineObjectElement:{inlineObjectId:'image'}}]}}));
    const inspected=await w.inspect();assert.ok(inspected.snapshotId);
    let input={account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope,format:'text',styles:true,review:true,omitImages:true},pages=0;const losses=[];
    while(input){
      const page=await w.call('docs_read',input);assert.notEqual(page.outcome,'unavailable');assert.ok(Buffer.byteLength(JSON.stringify(page))<=65536);
      assert.deepEqual(page.records,[]);assert.deepEqual(page.coverage.delivered.nodes,[]);assert.deepEqual(page.coverage.delivered.aspects,[]);
      const [receipt]=w.store.semanticSnapshots.deliveries(inspected.snapshotId,{subject:'subject-a',account:semanticAccount,threadId:'thread-a'},0,[page.coverage.deliveryToken]);assert.deepEqual(receipt.losses,page.losses);
      losses.push(...page.losses);pages++;assert.ok(pages<10);
      input=page.nextCursor?{account:semanticAccount,snapshotId:inspected.snapshotId,cursor:page.nextCursor}:null;
      assert.equal(page.complete,input===null);
    }
    assert.ok(pages>1);assert.equal(losses.length,1000);assert.equal(new Set(losses.map(l=>l.node)).size,1000);assert.ok(losses.every(l=>l.kind==='omittedImage'));
  }finally{await w.close();}
});
test('indivisible oversized record refuses without publishing or consuming its valid continuation',async()=>{
  const w=new SemanticWorld();try{
    await w.init();w.document=paragraphDocument(1);const p=w.document.tabs[0].documentTab.body.content[0];p.endIndex=70002;p.paragraph.elements[0].endIndex=70002;p.paragraph.elements[0].textRun.content='x'.repeat(70000)+'\n';
    const inspected=await w.inspect();assert.ok(inspected.snapshotId);
    const first=await w.call('docs_read',{account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope,format:'structured',styles:true,review:true});assert.ok(first.nextCursor);
    const before=w.host.bb.storage.database().prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n;
    const next={account:semanticAccount,snapshotId:inspected.snapshotId,cursor:first.nextCursor};
    const db=w.host.bb.storage.database(),cursor=db.prepare('SELECT * FROM docs_semantic_cursors WHERE id=?').get(first.nextCursor);
    let work=db.prepare('SELECT sum(bytes) AS n FROM docs_semantic_read_work').get().n;
    // C009's native page transaction retains a valid token on packing failure.
    // Direct low-level consumeCursor semantics are tested separately in B.
    for(let attempt=0;attempt<2;attempt++){
      const failed=await w.call('docs_read',next);assert.equal(failed.category,'budget');
      assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,before);
      assert.deepEqual(db.prepare('SELECT * FROM docs_semantic_cursors WHERE id=?').get(first.nextCursor),cursor);
      const charged=db.prepare('SELECT sum(bytes) AS n FROM docs_semantic_read_work').get().n;
      assert.ok(charged>work,'failed packing work remains durably charged');work=charged;
    }
  }finally{await w.close();}
});
