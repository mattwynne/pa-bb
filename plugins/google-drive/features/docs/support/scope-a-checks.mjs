import assert from 'node:assert/strict';
import { ApplicationWorld as SemanticWorld, semanticAccount as account, semanticScope as scope } from './application-world.mjs';

// Original inert business-shaped evidence. Offsets and expected content are
// authored here, not obtained from a production parser/projection.
export function businessDocument() {
  return {
    documentId:'doc-a', revisionId:'rev-business', suggestionsViewMode:'SUGGESTIONS_INLINE', commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Business'},documentTab:{
      documentStyle:{documentFormat:{documentMode:'PAGELESS'},marginTop:{magnitude:72,unit:'PT'},background:{color:{color:{rgbColor:{red:1}}}}},
      namedStyles:{styles:[
        {namedStyleType:'NORMAL_TEXT',textStyle:{fontSize:{magnitude:11,unit:'PT'},bold:false,weightedFontFamily:{fontFamily:'Arial',weight:400}},paragraphStyle:{spaceAbove:{magnitude:6,unit:'PT'}}},
        {namedStyleType:'HEADING_1',textStyle:{bold:true},paragraphStyle:{alignment:'CENTER'}},
      ]},
      lists:{'list-a':{listProperties:{nestingLevels:[{glyphFormat:'%0.',glyphType:'DECIMAL',startNumber:3}]}}},
      inlineObjects:{logo:{objectId:'logo',inlineObjectProperties:{embeddedObject:{title:'Synthetic logo',imageProperties:{contentUri:'https://example.test/inert.png'}}}}},
      positionedObjects:{drawing:{objectId:'drawing',positionedObjectProperties:{embeddedObject:{title:'Preserve drawing'}}}},
      namedRanges:{Shared:{name:'Shared',namedRanges:[
        {name:'Shared',namedRangeId:'range-a',ranges:[{tabId:'tab-a',startIndex:10,endIndex:14},{tabId:'tab-a',startIndex:14,endIndex:19}]},
        {name:'Shared',namedRangeId:'range-b',ranges:[{tabId:'tab-a',startIndex:26,endIndex:32}]},
      ]}},
      body:{content:[
        {startIndex:1,endIndex:3,paragraph:{elements:[{startIndex:1,endIndex:2,inlineObjectElement:{inlineObjectId:'logo'}},{startIndex:2,endIndex:3,textRun:{content:'\n'}}]}},
        {startIndex:3,endIndex:10,paragraph:{paragraphStyle:{namedStyleType:'HEADING_1',headingId:'market'},elements:[{startIndex:3,endIndex:10,textRun:{content:'Market\n'}}]}},
        {startIndex:10,endIndex:19,paragraph:{paragraphStyle:{namedStyleType:'NORMAL_TEXT'},bullet:{listId:'list-a',nestingLevel:0},elements:[
          {startIndex:10,endIndex:14,textRun:{content:'Our ',textStyle:{bold:true,weightedFontFamily:{fontFamily:'Lato'}}}},
          {startIndex:14,endIndex:19,textRun:{content:'plan\n',textStyle:{link:{url:'https://example.test/plan'}}}},
        ]}},
        {startIndex:19,endIndex:26,paragraph:{paragraphStyle:{namedStyleType:'HEADING_1',headingId:'finance'},elements:[{startIndex:19,endIndex:26,textRun:{content:'Money!\n'}}]}},
        {startIndex:26,endIndex:32,paragraph:{positionedObjectIds:['drawing'],elements:[{startIndex:26,endIndex:32,textRun:{content:'Other\n'}}]}},
      ]},
    }}],
  };
}
export async function scopeAExample(example) {
  const w=new SemanticWorld();
  try {
    await w.init(example==='pagedInspect'?{pageBytes:6000}:{});
    w.document=businessDocument();
    if(example==='ambiguousHeading')w.document.tabs[0].documentTab.body.content[3].paragraph.elements[0].textRun.content='Market\n';
    if(example==='richIntersection')w.document.tabs[0].documentTab.body.content[2]={startIndex:10,endIndex:19,futureLedger:{currency:'CAD',amount:42}};
    if(example==='emptySection')w.document.tabs[0].documentTab.body.content.splice(2,1);
    const view={acceptedPreview:'PREVIEW_SUGGESTIONS_ACCEPTED',rejectedPreview:'PREVIEW_WITHOUT_SUGGESTIONS'}[example];
    if(view){
      w.document.suggestionsViewMode=view;
      w.document.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.content=example==='acceptedPreview'?'New ':'Old ';
    }
    if(example==='pagedInspect') {
      w.document.tabs[0].documentTab.namedRanges={};
      for(let i=0;i<100;i++)w.document.tabs[0].documentTab.namedRanges[`Label ${i}`]={name:`Label ${i}`,namedRanges:[{name:`Label ${i}`,namedRangeId:`r-${i}`,ranges:[{startIndex:10,endIndex:19}]}]};
    }
    const before=structuredClone(w.document);
    const inspected=await w.inspect({...view?{view:example}:{},...example==='pagedInspect'?{include:['ranges']}: {}});
    assert.ok(inspected.snapshotId,JSON.stringify(inspected));
    if(!view)w.assertInitialPorts();
    else {
      assert.equal(w.calls.length,3);
      assert.deepEqual(w.calls.at(-1),{operation:'read',id:'doc-a',view:example,includeReview:false});
    }
    const snapshotId=inspected.snapshotId;
    const saved=w.store.semanticSnapshots.get(snapshotId,{subject:'subject-a',account,threadId:'thread-a'},0);
    assert.deepEqual(saved.evidence,before);
    assert.deepEqual(saved.tabs[0].registries.inlineObjects.logo,before.tabs[0].documentTab.inlineObjects.logo);
    assert.ok(Object.values(saved.nodes).some(node=>node.text==='Other\n'));
    if(example==='pagedInspect') {
      let page=inspected;const records=[];let pages=0;
      do {
        assert.ok(Buffer.byteLength(JSON.stringify(page))<=6000); records.push(...page.records);pages++;
        if(!page.nextCursor)break;
        page=await w.call('docs_inspect',{account,snapshotId,cursor:page.nextCursor});
      } while(pages<100);
      assert.equal(page.complete,true);assert.ok(pages>1);
      const ranges=records.filter(r=>r.kind==='namedRange');assert.equal(ranges.length,100);
      assert.equal(new Set(ranges.map(r=>r.id)).size,100);
    } else if(example==='registryDefinitions') {
      const page=await w.call('docs_read',{account,snapshotId,scope,format:'structured',registries:['styles','lists','objects','ranges','review']});
      assert.equal(page.complete,true);
      const ranges=page.records.filter(r=>r.kind==='namedRange');
      assert.deepEqual(ranges.map(r=>[r.value.namedRangeId,r.value.name,r.value.ranges.length]),[['range-a','Shared',2],['range-b','Shared',1]]);
      assert.equal(page.records.find(r=>r.kind==='inlineObjectDefinition').value.objectId,'logo');
      assert.equal(page.records.find(r=>r.kind==='listDefinition').value.listProperties.nestingLevels[0].startNumber,3);
      assert.ok(page.records.some(r=>r.kind==='registryReference'&&r.providerId==='logo'&&r.status==='resolved'));
    } else {
      let selector={section:{headingId:'market',includeHeading:example==='includeHeading'}};
      if(example==='ambiguousHeading')selector={section:{path:['Market'],includeHeading:false}};
      if(example==='missingEnd')selector.section.before={headingId:'not-present'};
      if(example==='siblingSpan') {
        const found=await w.call('docs_find',{account,snapshotId,scope,selector:{heading:{headingId:'market'}}});
        selector={span:{from:found.nodes[0],to:found.nodes[0]}};
      }
      const page=await w.call('docs_read',{account,snapshotId,scope,selector,format:'structured',styles:true,review:true});
      if(['ambiguousHeading','missingEnd'].includes(example)) {
        assert.equal(page.selection.status,example==='ambiguousHeading'?'ambiguous':'missing');assert.equal(page.complete,false);
        assert.equal(w.observe().deliveries,0);
      } else {
        assert.equal(page.complete,true,JSON.stringify(page));assert.equal(page.coverage.editReady,false);
        const expected=example==='includeHeading'?'Market\nOur plan\n':example==='siblingSpan'?'Market\n':example==='richIntersection'||example==='emptySection'?'':example==='acceptedPreview'?'New plan\n':example==='rejectedPreview'?'Old plan\n':'Our plan\n';
        assert.equal(page.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),expected);
        assert.ok(!page.records.some(r=>r.kind==='segment'||r.objectKind==='image'||r.text==='Other\n'||r.text==='Money!\n'));
        if(example==='richIntersection')assert.deepEqual(page.records.find(r=>r.kind==='opaque').providerEvidence.futureLedger,{currency:'CAD',amount:42});
        if(example==='emptySection')assert.equal(page.records.length,0);
        if(view){assert.equal(page.view,example);assert.equal(page.coverage.missingReviewCoverage,true);assert.ok(page.coverage.missingAspects.includes('review'));}
      }
    }
    assert.deepEqual(w.document,before); // provider fixture, logo and rich siblings are unchanged
  } finally { await w.close(); }
}
