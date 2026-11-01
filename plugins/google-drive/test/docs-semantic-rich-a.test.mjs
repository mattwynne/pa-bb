import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticWorld,semanticAccount as account,semanticScope as scope } from '../features/docs/support/semantic-world.mjs';
import { businessDocument } from '../features/docs/support/scope-a-checks.mjs';
const args=(snapshotId,extra={})=>({account,snapshotId,scope,format:'structured',styles:true,review:true,...extra});
async function run(fn){const w=new SemanticWorld();try{await w.init();w.document=businessDocument();await fn(w);}finally{await w.close();}}
test('equation, auto text, drawing, dropdown and TOC are original typed read data, not text placeholders',()=>run(async w=>{
  const tab=w.document.tabs[0].documentTab;
  tab.inlineObjects.drawing={objectId:'drawing',inlineObjectProperties:{embeddedObject:{futureDrawing:{retain:true}}}};
  tab.dropdownDefinitions={'def-a':{dropdownDefinitionId:'def-a',dropdownDefinitionProperties:{options:[{optionId:'choice-a',displayValue:'Ready'}]}}};
  tab.body.content[2].paragraph.elements=[
    {startIndex:10,endIndex:11,equation:{suggestedInsertionIds:['eq-suggestion']}},
    {startIndex:11,endIndex:12,autoText:{type:'PAGE_NUMBER',textStyle:{italic:true}}},
    {startIndex:12,endIndex:13,inlineObjectElement:{inlineObjectId:'drawing'}},
    {startIndex:13,endIndex:14,dropdown:{dropdownId:'instance-a',dropdownProperties:{dropdownDefinitionId:'def-a',selectedOptionId:'choice-a',displayValue:'Ready'}}},
    {startIndex:14,endIndex:19,textRun:{content:'tail\n'}},
  ];
  tab.body.content[4]={startIndex:26,endIndex:32,tableOfContents:{content:[{startIndex:26,endIndex:32,paragraph:{elements:[{startIndex:26,endIndex:32,textRun:{content:'Index\n'}}]}}]}};
  const original=structuredClone(w.document),snapshotId=(await w.inspect()).snapshotId;
  const read=await w.call('docs_read',args(snapshotId,{omitImages:true}));
  assert.equal(read.complete,true);
  assert.equal(read.records.find(r=>r.kind==='equation').review.suggestedInsertionIds[0],'eq-suggestion');
  assert.equal(read.records.find(r=>r.kind==='autoText').properties.type,'PAGE_NUMBER');
  assert.deepEqual(read.records.find(r=>r.kind==='autoText').style.properties.italic,{value:true,provenance:'direct'});
  assert.equal(read.records.find(r=>r.kind==='inlineObjectElement').properties.inlineObjectId,'drawing');
  assert.ok(read.records.some(r=>r.kind==='toc'));
  assert.equal(read.losses.filter(l=>l.kind==='omittedImage').length,1);
  const definitions=await w.call('docs_read',args(snapshotId,{registries:['objects','review']}));
  const ref=definitions.records.find(r=>r.kind==='registryReference'&&r.definitionKind==='dropdownDefinition');
  assert.equal(ref.providerId,'def-a');assert.equal(ref.status,'resolved');
  assert.ok(definitions.losses.some(l=>l.kind==='unresolvedReference'&&l.providerId==='eq-suggestion'));
  assert.deepEqual(w.document,original);
}));
test('scoped comment and suggestion diagnostics keep actual definitions separate from anchor references',()=>run(async w=>{
  const tab=w.document.tabs[0].documentTab;
  tab.commentAnchors={a:{anchorId:'a',ranges:[{tabId:'tab-a',startIndex:10,endIndex:14}]},b:{anchorId:'b',ranges:[{tabId:'tab-a',startIndex:26,endIndex:32}]}};
  w.document.comments=[{commentId:'comment-market',anchorId:'a',headPost:{content:'Keep this original'}},{commentId:'comment-other',anchorId:'b',headPost:{content:'Unselected original'}}];
  w.document.suggestions=[{suggestionId:'suggest-market',status:'OPEN',summaryText:'Bold proposal'}];
  tab.body.content[2].paragraph.elements[0].textRun.suggestedTextStyleChanges={'suggest-market':{textStyle:{bold:true},textStyleSuggestionState:{boldSuggested:true}}};
  const snapshotId=(await w.inspect()).snapshotId;
  const result=await w.call('docs_read',args(snapshotId,{selector:{section:{headingId:'market',includeHeading:false}},registries:['review']}));
  assert.deepEqual(result.records.filter(r=>r.kind==='commentThread').map(r=>r.value.commentId),['comment-market']);
  assert.equal(result.records.find(r=>r.kind==='suggestionThread').value.summaryText,'Bold proposal');
  assert.ok(result.records.some(r=>r.kind==='registryReference'&&r.providerId==='suggest-market'&&r.status==='resolved'));
  const denied=new SemanticWorld();
  try{
    await denied.init();denied.document=w.document;denied.fault='deniedComments';
    const id=(await denied.inspect()).snapshotId;
    const partial=await denied.call('docs_read',args(id,{registries:['review']}));
    assert.equal(partial.coverage.missingReviewCoverage,true);
    assert.ok(Object.values(partial.coverage.delivered.nodeAspects).every(aspects=>!aspects.includes('review')));
    assert.equal(denied.calls.filter(c=>c.url.startsWith('https://docs.googleapis.com/')).length,2);
  }finally{await denied.close();}
}));
test('provider nesting metadata and malformed inline value shapes are refused with valid neighbors',async()=>{
  for(const value of [0,1,-1,0.5])await run(async w=>{
    w.document.tabs[0].tabProperties.nestingLevel=value;
    const result=await w.inspect();
    if(value===0)assert.ok(result.snapshotId);else {assert.equal(result.category,'conflict');assert.equal(w.store.semanticSnapshots.stats().snapshots,0);}
  });
  for(const value of [null,[],false,'not an object'])await run(async w=>{
    w.document.tabs[0].documentTab.body.content[0].paragraph.elements[0].inlineObjectElement=value;
    const result=await w.inspect();assert.equal(result.category,'invalid');assert.equal(w.store.semanticSnapshots.stats().snapshots,0);
  });
});
test('explicit heading boundary chooses the exact requested endpoint, never a missing fallback',()=>run(async w=>{
  const snapshotId=(await w.inspect()).snapshotId;
  const result=await w.call('docs_read',args(snapshotId,{selector:{section:{headingId:'market',includeHeading:false,before:{path:['Money!']}}}}));
  assert.equal(result.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'Our plan\n');
  const missing=await w.call('docs_read',args(snapshotId,{selector:{section:{headingId:'market',includeHeading:false,before:{path:['Money']}}}}));
  assert.equal(missing.selection.status,'missing');assert.equal(missing.selection.boundary,'explicitEnd');assert.equal(missing.complete,false);
}));
