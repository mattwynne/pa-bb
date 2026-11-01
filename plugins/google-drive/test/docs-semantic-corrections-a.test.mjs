import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialize } from '../core/docs-semantic/model.mjs';
import { resolveSelector } from '../core/docs-semantic/selectors.mjs';
import { projectRegistries,resolveReadSelection } from '../core/docs-semantic/reader.mjs';
import { semanticScope as scope,semanticAccount as account } from '../features/docs/support/semantic-fixtures.mjs';
import { correctionDocument,correctionOwner,correctionRead,correctionWorld,correctionExample } from '../features/docs/support/a-correction-checks.mjs';
const build=document=>materialize({document,metadata:{id:'doc-a'},binding:{snapshotId:'snap-correction',subject:'subject-a',account,threadId:'thread-a',documentId:'doc-a',view:'inline'},reviewIncluded:true});
const body=d=>d.tabs[0].documentTab.body.content;
const heading={section:{headingId:'final',includeHeading:false}};
for(const example of ['terminalUnknown','absentInlineStyle','descendantStyles','wrongPropertyEnum','unknownDimension'])test(`A corrections application/memory ${example}`,()=>correctionExample(example));

for(const mode of ['exactEnd','pastObservedEnd','noStart','emptyTerminal','unknownLastChild','mappedTail','emptyKnown']){
  function arrange(d){
    const b=body(d);
    if(mode==='emptyKnown'||mode==='emptyTerminal')b.pop();
    if(mode==='unknownLastChild')b.at(-1).paragraph.elements.push({startIndex:21,futureInline:{label:'must retain'}});
    else if(mode!=='emptyKnown')b.push({...(mode==='noStart'?{}:{startIndex:mode==='pastObservedEnd'?30:mode==='emptyTerminal'?17:21}),...(mode==='mappedTail'?{endIndex:22}:{}),futureBlock:{label:'must retain'}});
  }
  const resolved=['mappedTail','emptyKnown'].includes(mode);
  test(`A1 pure terminal ${mode}`,()=>{
    const d=correctionDocument();arrange(d);const s=build(d),r=resolveSelector(s,scope,heading);
    assert.equal(r.status,resolved?'resolved':'unresolved');
    if(!resolved)assert.equal(r.reason,'sectionExtents');
    if(mode==='emptyKnown')assert.deepEqual(r.nodes,[]);
    if(mode!=='noStart')assert.equal(resolveSelector(s,scope,{section:{headingId:'start',includeHeading:false}}).status,'resolved');
  });
  test(`A1 application terminal ${mode}`,()=>correctionWorld(async w=>{
    arrange(w.document);const original=structuredClone(w.document),i=await w.inspect();assert.ok(i.snapshotId);
    const p=await w.call('docs_read',correctionRead(i.snapshotId,{selector:heading}));
    assert.equal(p.complete,resolved);
    if(!resolved)assert.equal(p.selection.status,'unresolved');
    assert.equal(w.observe().deliveries,resolved?1:0);
    assert.deepEqual(w.store.semanticSnapshots.get(i.snapshotId,correctionOwner,0).evidence,original);
    if(mode==='mappedTail')assert.ok(p.records.some(r=>r.kind==='opaque'&&r.providerEvidence.futureBlock.label==='must retain'));
    if(mode==='emptyKnown')assert.deepEqual(p.records,[]);
    if(mode!=='noStart'){
      const early=await w.call('docs_read',correctionRead(i.snapshotId,{selector:{section:{headingId:'start',includeHeading:false}}}));
      assert.equal(early.complete,true);assert.equal(early.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'One\n');
    }
  }));
}
// The literal list is independently pinned to ParagraphElement's TextStyle refs.
const styleKinds=['textRun','inlineObjectElement','person','richLink','dateElement','dropdown','footnoteReference','pageBreak','columnBreak','horizontalRule','autoText'];
test('A2 independently enumerated inline classes match pinned TextStyle ownership',()=>{
  const {schemas}=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/docs-discovery.json',import.meta.url)));
  const actual=Object.entries(schemas.ParagraphElement.properties).filter(([,property])=>schemas[property.$ref]?.properties?.textStyle?.$ref==='TextStyle').map(([name])=>name);
  assert.deepEqual(actual.sort(),[...styleKinds].sort());
});
function setInline(d,kind,direct,context='normal'){
  const p=body(d)[0].paragraph;
  p.elements=[{startIndex:1,endIndex:2,[kind]:{...(kind==='textRun'?{content:'S'}:{}),...(direct?{textStyle:{italic:true,bold:false}}:{})}},{startIndex:2,endIndex:7,textRun:{content:'tart\n'}}];
  if(context==='missing')d.tabs[0].documentTab.namedStyles.styles.splice(1,1);
  if(context==='table')d.tabs[0].documentTab.body.content=[{startIndex:0,endIndex:22,table:{rows:1,columns:1,tableRows:[{startIndex:0,endIndex:22,tableCells:[{startIndex:0,endIndex:22,content:body(d)}]}]}}];
}
function checkInline(n,direct,context='normal'){
  assert.ok(n.style);
  if(direct)assert.deepEqual(n.style.properties.bold,{value:false,provenance:'direct'});
  else if(context!=='missing')assert.deepEqual(n.style.properties.bold,{value:true,provenance:'named',source:'HEADING_1'});
  if(context==='missing'){
    assert.equal(n.style.missingNamedStyle,'HEADING_1');assert.equal(n.style.properties.fontSize,undefined);
  }else{
    assert.deepEqual(n.style.properties.fontSize,{value:{magnitude:9,unit:'PT'},provenance:'named',source:'NORMAL_TEXT'});
    assert.equal(n.style.propertyEvidence.fontSize.effectiveStatus,context==='table'?'unknownTableParent':'observed');
  }
  assert.notEqual(n.style.rendering,'verified');
}
for(const kind of styleKinds)for(const direct of [false,true])for(const context of ['normal','missing','table']){
  test(`A2 pure ${kind} direct=${direct} ${context}`,()=>{
    const d=correctionDocument();setInline(d,kind,direct,context);const s=build(d);
    const node=Object.values(s.nodes).find(n=>n.kind===(kind==='textRun'?'text':kind));checkInline(node,direct,context);
  });
  test(`A2 application ${kind} direct=${direct} ${context}`,()=>correctionWorld(async w=>{
    setInline(w.document,kind,direct,context);const i=await w.inspect();assert.ok(i.snapshotId);
    const result=await w.call('docs_read',correctionRead(i.snapshotId,{selector:{heading:{headingId:'start'}}}));
    assert.equal(result.complete,true);assert.equal(result.coverage.editReady,false);
    const node=result.records.find(n=>n.kind===(kind==='textRun'?'text':kind));checkInline(node,direct,context);
    const [receipt]=w.store.semanticSnapshots.deliveries(i.snapshotId,correctionOwner,0,[result.coverage.deliveryToken]);
    assert.equal(receipt.nodeAspects[node.id].includes('styles'),context!=='missing');
  }));
}
for(const kind of ['equation','futureInline'])test(`A2 unsupported style ownership ${kind}`,()=>correctionWorld(async w=>{
  setInline(w.document,kind,true);const pure=build(w.document),node=Object.values(pure.nodes).find(n=>n.kind===(kind==='equation'?'equation':'opaqueInline'));
  assert.equal(node.style,undefined);
  const i=await w.inspect(),p=await w.call('docs_read',correctionRead(i.snapshotId,{selector:{heading:{headingId:'start'}}}));
  const record=p.records.find(n=>n.kind===node.kind);assert.equal(record.style,undefined);
  if(kind==='equation')assert.deepEqual(record.properties.textStyle,{italic:true,bold:false});
}));

function dependencyFixture(d){
  const t=d.tabs[0].documentTab;
  t.body.content[1].paragraph.paragraphStyle={namedStyleType:'HEADING_2',headingId:'sibling'};
  t.body.content[0].paragraph.bullet={listId:'other-list'};
  t.body.content[0].paragraph.positionedObjectIds=['other-object'];
  t.lists={'other-list':{listProperties:{nestingLevels:[]}}};
  t.positionedObjects={'other-object':{positionedObjectProperties:{embeddedObject:{title:'not selected'}}}};
  t.body.content[0].paragraph.commentIds=['elsewhere'];
  t.commentAnchors={elsewhere:{anchorId:'elsewhere-anchor',ranges:[{tabId:'tab-a',startIndex:7,endIndex:11}]}};
  d.comments=[{commentId:'elsewhere',anchorId:'elsewhere-anchor',content:'Unselected review evidence'}];
}
function checkDependencies(s,p,node){
  assert.deepEqual(p.records.filter(r=>r.kind==='namedStyle').map(r=>r.providerId),['NORMAL_TEXT','HEADING_1']);
  const refs=p.records.filter(r=>r.kind==='registryReference');assert.equal(refs.length,2);
  assert.ok(refs.every(r=>r.ownerNode===node&&r.category==='styles'&&r.status==='resolved'));
  assert.ok(refs.every(r=>r.dependencyOwner===s.nodes[node].parent&&r.dependencyEvidenceDigest===s.nodes[s.nodes[node].parent].evidence.digest));
  assert.ok(p.records.every(r=>r.category==='styles'));
  assert.ok(p.delivered.nodes.every(id=>!s.nodes[id]));
}
test('A3 pure descendant dependencies exclude parent objects, lists and sibling style',()=>{
  const d=correctionDocument();dependencyFixture(d);const s=build(d),node=Object.values(s.nodes).find(n=>n.text==='Start\n').id;
  const selected=resolveReadSelection(s,scope,{node});
  const p=projectRegistries(s,selected,['styles','lists','objects','review']);checkDependencies(s,{...p,delivered:{nodes:Object.keys(p.nodeAspects)}},node);
});
test('A3 application descendant diagnostic receipt cannot deliver parent or text',()=>correctionWorld(async w=>{
  dependencyFixture(w.document);const i=await w.inspect(),s=w.store.semanticSnapshots.get(i.snapshotId,correctionOwner,0),node=Object.values(s.nodes).find(n=>n.text==='Start\n').id;
  const p=await w.call('docs_read',correctionRead(i.snapshotId,{selector:{node},registries:['styles','lists','objects','review']}));
  checkDependencies(s,{...p,delivered:p.coverage.delivered},node);
  const [receipt]=w.store.semanticSnapshots.deliveries(i.snapshotId,correctionOwner,0,[p.coverage.deliveryToken]);
  assert.ok(receipt.nodes.every(id=>!s.nodes[id]));assert.equal(receipt.nodeAspects[node],undefined);
}));

const typedCases=[
  ['fontSize',{magnitude:9,unit:'PT'},true],['fontSize',{magnitude:9,unit:'UNIT_UNSPECIFIED'},false],['fontSize',{magnitude:9,unit:'FUTURE_UNIT'},false],
  ['fontSize',{magnitude:9},false],['bold','ALIGNMENT_UNSPECIFIED',false],['bold','BASELINE_OFFSET_UNSPECIFIED',false],['bold','SPACING_MODE_UNSPECIFIED',false],['bold',true,true],
  ['borderTop',{color:{color:{rgbColor:{red:0}}},width:{magnitude:1,unit:'PT'},padding:{magnitude:1,unit:'PT'},dashStyle:'SOLID'},true],
  ['borderTop',{color:{},width:{magnitude:1,unit:'PT'},padding:{magnitude:1,unit:'FUTURE_UNIT'},dashStyle:'DASH'},false],
  ['borderTop',{color:{},width:{magnitude:1,unit:'PT'},padding:{magnitude:1,unit:'PT'},dashStyle:'FUTURE_DASH'},false],
  ['tabStops',[{offset:{magnitude:1,unit:'PT'},alignment:'START'}],true],
  ['tabStops',[{offset:{magnitude:1,unit:'UNIT_UNSPECIFIED'},alignment:'START'}],false],
  ['tabStops',[{offset:{magnitude:1,unit:'PT'},alignment:'FUTURE_TAB'}],false],
];
for(const [key,value,known] of typedCases){
  const paragraph=['borderTop','tabStops'].includes(key);
  function arrange(d){const p=body(d)[0].paragraph;if(paragraph)p.paragraphStyle[key]=value;else p.elements[0].textRun.textStyle={[key]:value};}
  function check(n){assert.deepEqual(n.style.properties[key].value,value);assert.equal(n.style.propertyEvidence[key].effectiveStatus,known?'observed':'partialOrUnknown');}
  test(`A4 pure typed ${key} ${JSON.stringify(value)}`,()=>{
    const d=correctionDocument();arrange(d);const s=build(d),node=Object.values(s.nodes).find(n=>paragraph?n.kind==='paragraph':n.text==='Start\n');check(node);
  });
  test(`A4 application typed ${key} ${JSON.stringify(value)}`,()=>correctionWorld(async w=>{
    arrange(w.document);const i=await w.inspect(),p=await w.call('docs_read',correctionRead(i.snapshotId,{selector:{heading:{headingId:'start'}}}));
    assert.equal(p.complete,true);check(p.records.find(n=>paragraph?n.kind==='paragraph':n.text==='Start\n'));
    assert.equal(w.observe().deliveries,1);
  }));
}
test('A4 valid owning sentinels preserve named inheritance',()=>correctionWorld(async w=>{
  const p=body(w.document)[0].paragraph;p.paragraphStyle.alignment='ALIGNMENT_UNSPECIFIED';p.paragraphStyle.spacingMode='SPACING_MODE_UNSPECIFIED';p.elements[0].textRun.textStyle={baselineOffset:'BASELINE_OFFSET_UNSPECIFIED'};
  const snapshotId=(await w.inspect()).snapshotId;
  const read=await w.call('docs_read',correctionRead(snapshotId,{selector:{heading:{headingId:'start'}}}));
  assert.equal(read.complete,true);
  for(const s of [build(w.document),w.store.semanticSnapshots.get(snapshotId,correctionOwner,0),{nodes:Object.fromEntries(read.records.map(record=>[record.id,record]))}]){
    const paragraph=Object.values(s.nodes).find(n=>n.kind==='paragraph'),text=Object.values(s.nodes).find(n=>n.text==='Start\n');
    assert.deepEqual(paragraph.style.properties.alignment,{value:'START',provenance:'named',source:'HEADING_1'});
    assert.deepEqual(paragraph.style.properties.spacingMode,{value:'COLLAPSE_LISTS',provenance:'named',source:'NORMAL_TEXT'});
    assert.deepEqual(text.style.properties.baselineOffset,{value:'SUPERSCRIPT',provenance:'named',source:'HEADING_1'});
  }
}));
for(const [key,value,known] of [
  ['pageSize',{width:{magnitude:72,unit:'PT'},height:{magnitude:100,unit:'PT'}},true],
  ['pageSize',{width:{magnitude:72,unit:'FUTURE_UNIT'},height:{magnitude:100,unit:'PT'}},false],
  ['pageSize',{width:{magnitude:72},height:{magnitude:100,unit:'PT'}},false],
  ['pageSize',{width:{unit:'PT'},height:{magnitude:100,unit:'PT'}},false],
  ['documentFormat',{documentMode:'PAGES'},true],['documentFormat',{documentMode:'DOCUMENT_MODE_UNSPECIFIED'},false],['documentFormat',{documentMode:'FUTURE_MODE'},false],
])test(`A4 layout nested enum ${JSON.stringify(value)}`,()=>correctionWorld(async w=>{
  w.document.tabs[0].documentTab.documentStyle={[key]:value};
  const pure=build(w.document).tabs[0].documentStyle.properties[key];assert.equal(pure.effective.status,known?'storedApiValue':'partialOrUnknown');
  const i=await w.inspect(),p=await w.call('docs_read',correctionRead(i.snapshotId,{registries:['styles']}));
  const property=p.records.find(r=>r.kind==='documentStyle').style.properties[key];
  assert.deepEqual(property.stored,value);assert.equal(property.effective.status,known?'storedApiValue':'partialOrUnknown');
}));
