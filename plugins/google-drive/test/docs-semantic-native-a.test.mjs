import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticWorld,semanticAccount as account,semanticScope as scope } from '../features/docs/support/semantic-world.mjs';
import { businessDocument } from '../features/docs/support/scope-a-checks.mjs';
import { readSemanticJson } from '../adapters/docs-semantic.mjs';
import { footprint,evaluateWitness } from '../core/docs-semantic/coverage.mjs';
const owner={subject:'subject-a',account,threadId:'thread-a'};
async function world(fn,options={}) {
  const w=new SemanticWorld();
  try {await w.init(options);w.document=businessDocument();await fn(w);}finally{await w.close();}
}
const readArgs=(snapshotId,extra={})=>({account,snapshotId,scope,format:'structured',styles:true,review:true,...extra});
async function drain(w,name,first) {
  const records=[],losses=[],receipts=[];let page=first,count=0;
  do {
    assert.equal(page.outcome,undefined,JSON.stringify(page));
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=65536);
    const [receipt]=w.store.semanticSnapshots.deliveries(page.snapshotId,owner,0,[page.coverage.deliveryToken]);
    assert.deepEqual(receipt.losses,page.losses);assert.deepEqual(receipt.nodes,page.coverage.delivered.nodes);
    records.push(...page.records);losses.push(...page.losses);receipts.push(receipt);
    if(!page.nextCursor)break;
    page=await w.call(name,{account,snapshotId:page.snapshotId,cursor:page.nextCursor});
    assert.ok(++count<200);
  }while(true);
  assert.equal(page.complete,true);
  assert.equal(new Set(records.map(r=>r.node??r.id)).size,records.length);
  return {records,losses,receipts};
}
test('selected section continuation freezes resolved membership and rejects replacement options',()=>world(async w=>{
  const snapshotId=(await w.inspect()).snapshotId;
  const first=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}}}));
  assert.ok(first.nextCursor);
  const row=w.host.bb.storage.database().prepare('SELECT state FROM docs_semantic_cursors WHERE id=?').get(first.nextCursor);
  const state=JSON.parse(row.state);assert.ok(state.selection.runs.length);assert.equal(state.request.selector,undefined);
  for(const extra of [{scope},{selector:{node:'other'}},{styles:false},{registries:['objects']}])await assert.rejects(()=>w.call('docs_read',{account,snapshotId,cursor:first.nextCursor,...extra}),/arguments are invalid/);
  const {records,receipts}=await drain(w,'docs_read',first);
  assert.equal(records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'Our plan\n');
  assert.ok(receipts.every(r=>r.selection.selectedFootprint));
  assert.ok(!records.some(r=>r.kind==='segment'||r.text==='Other\n'));
},{pageBytes:4800}));
test('section inside a rich cell never claims whole table, row, cell or segment delivery',()=>world(async w=>{
  const content=w.document.tabs[0].documentTab.body.content;
  w.document.tabs[0].documentTab.body.content=[{startIndex:0,endIndex:40,table:{rows:1,columns:1,tableRows:[{startIndex:0,endIndex:40,tableCells:[{startIndex:0,endIndex:40,content}]}]}}];
  const snapshotId=(await w.inspect()).snapshotId;
  const result=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}}}));
  assert.equal(result.complete,true);assert.equal(result.records.map(r=>r.kind).join(','),'paragraph,text,text');
  const snapshot=w.store.semanticSnapshots.get(snapshotId,owner,0);
  assert.deepEqual(result.selection.ancestorsNotDelivered.map(id=>snapshot.nodes[id].kind),['tableCell','tableRow','table','segment']);
  const cell=result.selection.ancestorsNotDelivered[0];
  const deliveries=w.store.semanticSnapshots.deliveries(snapshotId,owner,0,[result.coverage.deliveryToken]);
  const wholeCell=footprint(snapshot,{nodes:[cell],destructive:true});
  const witness=evaluateWitness(snapshot,wholeCell,{deliveries});
  assert.equal(witness.witnessSatisfied,false);assert.equal(witness.authoringAuthority,'notEstablished');
  assert.ok(witness.missingNodes.includes(cell));
  const selectedCell=await w.call('docs_read',readArgs(snapshotId,{selector:{node:cell}}));
  assert.equal(selectedCell.records[0].kind,'tableCell');
  assert.equal(selectedCell.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'\nMarket\nOur plan\nMoney!\nOther\n');
  assert.ok(!selectedCell.records.some(r=>['table','tableRow','segment'].includes(r.kind)));
}));
test('nested heading sections stop at the next peer-or-higher, exact paths do not substring-match',()=>world(async w=>{
  const content=w.document.tabs[0].documentTab.body.content;
  content[2].paragraph.paragraphStyle={namedStyleType:'HEADING_2',headingId:'submarket'};
  const snapshotId=(await w.inspect()).snapshotId;
  const result=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{path:['Market'],includeHeading:false}}}));
  assert.equal(result.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'Our plan\n');
  const sub=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{path:['Market','Our plan'],includeHeading:true}}}));
  assert.equal(sub.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'Our plan\n');
  const missing=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{path:['Mark'],includeHeading:false}}}));
  assert.equal(missing.selection.status,'missing');assert.equal(missing.complete,false);
  const reversed=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'finance',includeHeading:false,before:{headingId:'market'}}}}));
  assert.equal(reversed.category,'scope');
}));
test('unresolved selected extent is explicit while disjoint unknown content does not veto selection',()=>world(async w=>{
  delete w.document.tabs[0].documentTab.body.content[4].endIndex;
  const snapshotId=(await w.inspect()).snapshotId;
  const good=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}}}));
  assert.equal(good.complete,true);
  delete w.document.tabs[0].documentTab.body.content[2].endIndex;
  const next=(await w.inspect()).snapshotId;
  const bad=await w.call('docs_read',readArgs(next,{selector:{section:{headingId:'market',includeHeading:false}}}));
  assert.equal(bad.selection.status,'unresolved');assert.equal(bad.complete,false);
}));
test('registry records page once with actual identity/aspects, references never become node contents',()=>world(async w=>{
  const tab=w.document.tabs[0].documentTab;
  for(let i=0;i<50;i++)tab.inlineObjects[`obj-${i}`]={objectId:`obj-${i}`,inlineObjectProperties:{embeddedObject:{title:`Unreferenced ${i}`,futureDrawing:{data:'x'.repeat(100)}}}};
  const snapshotId=(await w.inspect()).snapshotId;
  const first=await w.call('docs_read',readArgs(snapshotId,{registries:['objects','ranges','styles','lists']}));
  assert.ok(first.nextCursor);
  const {records,receipts}=await drain(w,'docs_read',first);
  assert.equal(records.filter(r=>r.kind==='inlineObjectDefinition').length,51);
  assert.deepEqual(records.filter(r=>r.kind==='namedRange').map(r=>r.value.namedRangeId),['range-a','range-b']);
  const snapshot=w.store.semanticSnapshots.get(snapshotId,owner,0);
  assert.ok(receipts.every(r=>r.nodes.every(id=>!snapshot.nodes[id])));
  const styles=records.filter(r=>r.kind==='namedStyle');assert.equal(styles.length,2);
  for(const style of styles)assert.ok(receipts.some(r=>r.nodeAspects[style.id]?.includes('styles')));
},{pageBytes:6000}));
test('registry selection distinguishes referenced definitions, missing references and disjoint ranges',()=>world(async w=>{
  w.document.tabs[0].documentTab.body.content[2].paragraph.bullet.listId='missing-list';
  const snapshotId=(await w.inspect()).snapshotId;
  const result=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}},registries:['styles','lists','objects','ranges']}));
  assert.deepEqual(result.records.filter(r=>r.kind==='namedRange').map(r=>r.value.namedRangeId),['range-a']);
  assert.ok(!result.records.some(r=>r.kind==='inlineObjectDefinition'));
  const unresolved=result.records.find(r=>r.kind==='registryReference'&&r.providerId==='missing-list');
  assert.equal(unresolved.status,'unresolved');assert.deepEqual(unresolved.targets,[]);
  assert.ok(result.losses.some(l=>l.node===unresolved.id&&l.kind==='unresolvedReference'));
}));
test('unknown data is retained internally, omitted with losses, and available only as selected diagnostics',()=>world(async w=>{
  w.document.tabs[0].documentTab.body.content[2].paragraph.futureState={value:'original unknown'};
  const snapshotId=(await w.inspect()).snapshotId;
  const normal=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}}}));
  const p=normal.records.find(r=>r.kind==='paragraph');
  assert.ok(normal.losses.some(l=>l.node===p.id&&l.kind==='unknownFieldOmitted'));
  assert.deepEqual(normal.coverage.delivered.nodeAspects[p.id],[]);
  assert.ok(!JSON.stringify(normal.records).includes('original unknown'));
  const diagnostics=await w.call('docs_read',readArgs(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}},registries:['diagnostics']}));
  assert.deepEqual(diagnostics.records.find(r=>r.kind==='unknownField').value,{value:'original unknown'});
  assert.deepEqual(diagnostics.coverage.delivered.aspects,[]);
}));
test('indivisible registry definition refuses before any delivery rather than dropping bytes',()=>world(async w=>{
  w.document.tabs[0].documentTab.inlineObjects.logo.inlineObjectProperties.embeddedObject.futureDrawing={text:'x'.repeat(70000)};
  const snapshotId=(await w.inspect()).snapshotId;
  const result=await w.call('docs_read',readArgs(snapshotId,{registries:['objects']}));
  assert.equal(result.category,'budget');assert.equal(w.host.bb.storage.database().prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,0);
}));
test('native streamed overrun without Content-Length and malformed/deep evidence create no snapshots',async()=>{
  class StreamWorld extends SemanticWorld {
    async fetch(url,init){
      const response=await super.fetch(url,init); // exact closed URL/method/auth checks survive exceptions
      if(!String(url).startsWith('https://docs.googleapis.com/'))return response;
      if(this.case==='malformed')return new Response('{"unterminated"');
      if(this.case==='streamOverrun')return new Response(new ReadableStream({start(controller){
        controller.enqueue(new Uint8Array(8*1048576));controller.enqueue(new Uint8Array(1));controller.close();
      }}));
      return response;
    }
  }
  for(const fault of ['streamOverrun','malformed','depth']){
    const w=new StreamWorld();
    try {
      w.case=fault;await w.init();w.document=businessDocument();
      if(fault==='depth'){
        let value={};w.document.future=value;
        for(let i=0;i<33;i++){value.next={};value=value.next;}
      }
      const failed=await w.inspect();assert.equal(failed.category,fault==='malformed'?'corrupt':'budget');
      assert.equal(w.store.semanticSnapshots.stats().snapshots,0);w.assertInitialWire();
      assert.doesNotMatch(JSON.stringify(w.host.harness.logEntries),/PRIVATE_|unterminated|Our plan/);
    }finally{await w.close();}
  }
});
test('strict UTF-8 stream decoder exact and one-over byte boundaries without Content-Length',async()=>{
  for(const length of [63,64,65]){
    const bytes=Buffer.from('"'+'x'.repeat(length-2)+'"');
    const response=new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,13));controller.enqueue(bytes.subarray(13));controller.close();}}));
    assert.equal(response.headers.get('content-length'),null);
    if(length<=64)assert.equal((await readSemanticJson(response,64)).document.length,length-2);
    else await assert.rejects(()=>readSemanticJson(response,64),/budget/);
  }
});
