import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticWorld,semanticAccount as account,semanticScope as scope } from '../features/docs/support/semantic-world.mjs';
const shell=content=>({documentId:'doc-a',revisionId:'r-large',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Large synthetic'},documentTab:{body:{content}}}]});
function paragraph(start,text,headingId){return {startIndex:start,endIndex:start+text.length,paragraph:{...(headingId?{paragraphStyle:{headingId,namedStyleType:'HEADING_1'}}:{}),elements:[{startIndex:start,endIndex:start+text.length,textRun:{content:text}}]}};}
async function collect(w,tool,first){
  const records=[],losses=[];let page=first,pages=0;
  while(true){
    assert.equal(page.outcome,undefined,JSON.stringify(page));assert.ok(Buffer.byteLength(JSON.stringify(page))<=65536);
    records.push(...page.records);losses.push(...page.losses);pages++;
    if(!page.nextCursor)break;
    assert.equal(page.complete,false);assert.ok(pages<100);
    page=await w.call(tool,{account,snapshotId:page.snapshotId,cursor:page.nextCursor});
  }
  assert.equal(page.complete,true);assert.equal(new Set(records.map(r=>r.id)).size,records.length);
  return {records,losses,pages};
}
test('large default inspect switches to exact paged summaries instead of overflowing or claiming a truncated outline',async()=>{
  const w=new SemanticWorld();
  try{
    await w.init();let offset=1;const content=[];
    for(let i=0;i<500;i++){const text=`Heading ${i}\n`;content.push(paragraph(offset,text,`h-${i}`));offset+=text.length;}
    w.document=shell(content);
    const first=await w.inspect();assert.ok(first.nextCursor);
    const {records,pages}=await collect(w,'docs_inspect',first);assert.ok(pages>1);
    const headings=records.filter(r=>r.kind==='headingSummary');assert.equal(headings.length,500);
    assert.deepEqual(headings.map(h=>h.heading.providerId),Array.from({length:500},(_,i)=>`h-${i}`));
    assert.equal(records.find(r=>r.kind==='documentSummary').counts.selectedNodes,1001);
  }finally{await w.close();}
});
test('many registry ranges over a large selected section use bounded interval lookup and page every definition',async()=>{
  const w=new SemanticWorld();
  try{
    await w.init();const content=[paragraph(1,'H\n','h')];
    for(let i=0;i<500;i++)content.push(paragraph(3+2*i,'x\n'));
    content.push(paragraph(1003,'E\n','e'));w.document=shell(content);
    const ranges={};
    for(let i=0;i<1200;i++)ranges[`Label${i}`]={name:`Label${i}`,namedRanges:[{name:`Label${i}`,namedRangeId:`r-${i}`,ranges:[{startIndex:3,endIndex:5}]}]};
    ranges.Empty={namedRanges:[{name:'Empty',namedRangeId:'empty-span',ranges:[{startIndex:4,endIndex:4}]}]};
    ranges.Unknown={namedRanges:[{name:'Unknown',namedRangeId:'unknown-span',ranges:[]}]};
    w.document.tabs[0].documentTab.namedRanges=ranges;
    const snapshotId=(await w.inspect()).snapshotId;assert.ok(snapshotId);
    const first=await w.call('docs_read',{account,snapshotId,scope,format:'structured',selector:{section:{headingId:'h',includeHeading:false}},registries:['ranges']});
    const {records,losses,pages}=await collect(w,'docs_read',first);assert.ok(pages>1);
    assert.equal(records.length,1202);assert.equal(records.at(-2).providerId,'empty-span');assert.equal(records.at(-2).scopeRelation,'intersects');
    assert.equal(records.at(-1).scopeRelation,'unresolved');assert.equal(losses.length,1);assert.equal(losses[0].kind,'unresolvedRegistryScope');
  }finally{await w.close();}
});
test('frozen continuation retains explicit tab and segment order rather than sorting membership',async()=>{
  for(const selectedScope of [
    {tabs:{ids:['tab-z','tab-a']},segments:[{kind:'body'}]},
    {tabs:{ids:['tab-a']},segments:[{kind:'header',id:'header-a'},{kind:'body'}]},
  ]){
    const w=new SemanticWorld();
    try{
      await w.init({pageBytes:1600});w.document=shell([paragraph(1,'A\n')]);
      w.document.tabs[0].documentTab.headers={'header-a':{headerId:'header-a',content:[paragraph(0,'Z\n')]}};
      w.document.tabs.push({tabProperties:{tabId:'tab-z',title:'Last tab'},documentTab:{body:{content:[paragraph(1,'Z\n')]}}});
      const snapshotId=(await w.inspect()).snapshotId;assert.ok(snapshotId);
      let page=await w.call('docs_read',{account,snapshotId,scope:selectedScope,format:'text'});const text=[];
      while(true){
        assert.equal(page.outcome,undefined,JSON.stringify(page));text.push(...page.records.map(r=>r.text));
        if(!page.nextCursor)break;
        page=await w.call('docs_read',{account,snapshotId,cursor:page.nextCursor});
      }
      assert.equal(text.join(''),'Z\nA\n');
    }finally{await w.close();}
  }
});
