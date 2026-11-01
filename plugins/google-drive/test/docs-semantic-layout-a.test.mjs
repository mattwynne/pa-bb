import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../core/docs-semantic/model.mjs';
import { SemanticWorld,semanticAccount as account,semanticScope as scope } from '../features/docs/support/semantic-world.mjs';
const binding={snapshotId:'layout-snapshot',subject:'subject-a',account:'writer@example.test',threadId:'thread-a',documentId:'doc-a',view:'inline',retrievedAt:0};
function document(mode='PAGES') {
  return {documentId:'doc-a',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Layout'},documentTab:{
    documentStyle:{documentFormat:{documentMode:mode},marginTop:{magnitude:72,unit:'PT'},defaultHeaderId:'header-default',marginHeader:{magnitude:36,unit:'PT'},useCustomHeaderFooterMargins:false},
    body:{content:[
      {startIndex:0,endIndex:1,sectionBreak:{sectionStyle:{marginTop:{magnitude:24,unit:'PT'},defaultHeaderId:'header-first'}}},
      {startIndex:1,endIndex:3,paragraph:{elements:[{startIndex:1,endIndex:3,textRun:{content:'A\n'}}]}},
      {startIndex:3,endIndex:4,sectionBreak:{sectionStyle:{}}},
      {startIndex:4,endIndex:6,paragraph:{elements:[{startIndex:4,endIndex:6,textRun:{content:'B\n'}}]}},
    ]},
  }}]};
}
const model=d=>materialize({document:d,metadata:{id:'doc-a'},binding,reviewIncluded:true});
test('section margins inherit actual document fields, while header IDs inherit the previous section',()=>{
  const m=model(document()),sections=Object.values(m.nodes).filter(n=>n.kind==='sectionBreak');
  assert.deepEqual(sections[0].style.properties.marginTop.value,{magnitude:24,unit:'PT'});
  assert.equal(sections[0].style.properties.marginTop.provenance,'direct');
  assert.deepEqual(sections[1].style.properties.marginTop.value,{magnitude:72,unit:'PT'});
  assert.equal(sections[1].style.properties.marginTop.provenance,'document');
  assert.equal(sections[1].style.properties.defaultHeaderId.value,'header-first');
  assert.deepEqual(sections[1].style.properties.defaultHeaderId.source,{node:sections[0].id});
  assert.equal(sections[1].style.properties.marginBottom,undefined);
});
test('pageless and disabled custom header margins distinguish stored values from applicability',()=>{
  const m=model(document('PAGELESS')),sections=Object.values(m.nodes).filter(n=>n.kind==='sectionBreak');
  assert.equal(sections[0].style.properties.marginTop.effective.status,'notApplicableInPageless');
  assert.deepEqual(sections[0].style.stored.marginTop,{magnitude:24,unit:'PT'});
  const paged=model(document());
  assert.equal(paged.tabs[0].documentStyle.properties.marginHeader.effective.status,'notAppliedWhenCustomMarginsDisabled');
});
test('partial section values never borrow nested members, and unknown stored properties remain unknown',()=>{
  const d=document();d.tabs[0].documentTab.body.content[2].sectionBreak.sectionStyle={marginTop:{magnitude:12},futureLayout:{mode:'unknown'}};
  const m=model(d),section=Object.values(m.nodes).filter(n=>n.kind==='sectionBreak')[1];
  assert.deepEqual(section.style.properties.marginTop.value,{magnitude:12});
  assert.equal(section.style.properties.marginTop.effective.status,'partialOrUnknown');
  assert.equal(section.style.properties.futureLayout.provenance,'unknown');
});
test('native structured read delivers actual section provenance through the adapter and SQLite',async()=>{
  const w=new SemanticWorld();
  try{
    await w.init();w.document=document();const snapshotId=(await w.inspect()).snapshotId;w.assertInitialWire();
    const result=await w.call('docs_read',{account,snapshotId,scope,format:'structured',styles:true});
    const sections=result.records.filter(r=>r.kind==='sectionBreak');
    assert.deepEqual(sections.map(s=>s.style.properties.marginTop.value),[{magnitude:24,unit:'PT'},{magnitude:72,unit:'PT'}]);
    assert.deepEqual(sections.map(s=>s.style.properties.marginTop.provenance),['direct','document']);
    assert.equal(result.coverage.editReady,false);
  }finally{await w.close();}
});
