// Original offline fixtures and JSON/UTF-8 wire oracle; no ledger promotion.
import assert from 'node:assert/strict';
import {SemanticWorld,semanticAccount,semanticScope,semanticVector} from './semantic-world.mjs';
export function contradictoryDocument(kind){
  const d=structuredClone(semanticVector.document),body=d.tabs[0].documentTab.body.content;
  const unresolved=(node,start)=>{delete node.endIndex;node.startIndex=start;};
  if(kind==='nextSibling')unresolved(body[0],1000);
  else if(kind==='descendant')body[0]={startIndex:1000,paragraph:{elements:[{startIndex:1,endIndex:7,textRun:{content:'Hidden'}}]}};
  else if(kind==='precedingSibling')unresolved(body[2],1);
  else if(kind==='nestedParagraph')unresolved(body[4].table.tableRows[0].tableCells[0].content[0],1000);
  else if(kind==='row')unresolved(body[4].table.tableRows[0],40);
  else if(kind==='cell')unresolved(body[4].table.tableRows[0].tableCells[0],1000);
  else if(kind==='table')unresolved(body[4],40);
  else if(kind==='toc')body[0]={startIndex:1000,tableOfContents:{content:[{startIndex:1,endIndex:7,paragraph:{elements:[{startIndex:1,endIndex:7,textRun:{content:'Hidden'}}]}}]}};
  else if(kind==='inlineSibling')body[2].paragraph.elements[0]={startIndex:18,futureInline:{value:'unknown'}};
  else if(kind==='missingStartDescendant')body[0]={paragraph:{elements:[{startIndex:2,endIndex:8,textRun:{content:'Hidden'}}]}};
  else if(kind==='invalidStart')unresolved(body[0],-1);
  else if(kind==='rowSiblings')body.splice(0,body.length,{startIndex:1,endIndex:20,table:{rows:2,columns:1,tableRows:[
    {startIndex:15,tableCells:[{startIndex:16,content:[]}]},
    {startIndex:10,endIndex:20,tableCells:[{startIndex:11,endIndex:20,content:[]}]}]}});
  else if(kind==='cellSiblings')body.splice(0,body.length,{startIndex:1,endIndex:20,table:{rows:1,columns:2,tableRows:[
    {startIndex:2,endIndex:20,tableCells:[{startIndex:15,content:[]},{startIndex:10,endIndex:20,content:[]}]}]}});
  else assert.fail(`Unknown contradiction ${kind}`);
  return d;
}
export async function structuralBoundary(kind){
  const w=new SemanticWorld();try{
    await w.init();w.document=contradictoryDocument(kind);const result=await w.inspect();
    assert.equal(result.outcome,'unavailable',kind);assert.equal(result.category,'extent',kind);
    assert.equal(w.store.semanticSnapshots.stats().snapshots,0);
    assert.doesNotMatch(JSON.stringify(w.host.harness.logEntries),/Hidden|1000|PRIVATE_/);
  }finally{await w.close();}
}
export function terminalDocument(length){
  return {documentId:'doc-a',revisionId:'rev-a',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{
    tabProperties:{tabId:'tab-a',title:'Boundary'},documentTab:{inlineObjects:{image:{inlineObjectProperties:{embeddedObject:{imageProperties:{contentUri:'https://example.test/not-fetched.png'}}}}},
      body:{content:[{startIndex:1,endIndex:length+3,paragraph:{elements:[{startIndex:1,endIndex:2,inlineObjectElement:{inlineObjectId:'image'}},
        {startIndex:2,endIndex:length+3,textRun:{content:'X'.repeat(length)+'\n'}}]}}]}}}]};
}
// This expected envelope is authored directly from fixture facts, without
// project(), jsonBytes(), or the packer's additive calculator producing it.
function wireOracle(snapshotId,length,tokenLength){
  const node=`${snapshotId}:4`,aspects=['content','styles','review'];
  return {snapshotId,view:'inline',revision:{kind:'docs',id:'rev-a',subject:'subject-a'},
    records:[{kind:'text',node,text:'X'.repeat(length)+'\n',extent:{start:2,end:length+3},style:{explicit:{},properties:{},absent:'unknown'},review:{}}],
    losses:[{node:`${snapshotId}:3`,kind:'omittedImage'}],complete:true,nextCursor:null,
    coverage:{materialized:'complete',delivered:{nodes:[node],aspects,nodeAspects:{[node]:aspects}},missingAspects:[],missingReviewCoverage:false,
      readProof:'scope_and_aspect_only',editReady:false,deliveryToken:'d'.repeat(tokenLength)},
    limitations:['API structure is not rendered fidelity','Read delivery is not authoring authorization'],thisCall:{providerMutationCount:0}};
}
export async function terminalBoundary(tokenLength=128,delta=0){
  // Fixed-width UUID snapshot identity: wire size is independent of its value.
  const initial=64000,oracleSize=Buffer.byteLength(JSON.stringify(wireOracle('00000000-0000-4000-8000-000000000000',initial,tokenLength)));
  const length=initial+65536+delta-oracleSize;
  const w=new SemanticWorld();let call=0;
  try{
    await w.init({snapshotIds:()=>['d','c','e','f','g','h'][call++].repeat(tokenLength)});w.document=terminalDocument(length);
    const inspected=await w.inspect();assert.ok(inspected.snapshotId);
    const expected=wireOracle(inspected.snapshotId,length,tokenLength);assert.equal(Buffer.byteLength(JSON.stringify(expected)),65536+delta);
    const input={account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope,format:'text',styles:true,review:true,omitImages:true};
    const first=await w.call('docs_read',input),db=w.host.bb.storage.database();
    if(delta<=0){
      assert.deepEqual(first,expected);assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,1);
      const [receipt]=w.store.semanticSnapshots.deliveries(inspected.snapshotId,{subject:'subject-a',account:semanticAccount,threadId:'thread-a'},0,[first.coverage.deliveryToken]);
      assert.deepEqual(receipt.losses,expected.losses);assert.equal(receipt.complete,true);
    }else if(first.outcome==='unavailable'){
      assert.equal(first.category,'budget');assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,0);
    }else{
      // A one-over complete envelope may have a valid smaller nonterminal page
      // with shorter tokens. It must NOT be falsely completed or truncated.
      assert.equal(first.complete,false);assert.ok(Buffer.byteLength(JSON.stringify(first))<=65536);
      const last=await w.call('docs_read',{account:semanticAccount,snapshotId:inspected.snapshotId,cursor:first.nextCursor});
      assert.equal(last.complete,true);assert.ok(Buffer.byteLength(JSON.stringify(last))<=65536);
      assert.deepEqual([...first.records,...last.records],expected.records);assert.deepEqual([...first.losses,...last.losses],expected.losses);
    }
  }finally{await w.close();}
}
