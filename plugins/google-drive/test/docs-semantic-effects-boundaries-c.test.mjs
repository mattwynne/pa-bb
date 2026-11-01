import test from 'node:test';
import assert from 'node:assert/strict';
import { withWitnessWorld,readTokens } from '../features/docs/support/witness-c-checks.mjs';
import { documentVector,node,scope,styleRequest,literalRequest,broadRequest,paragraph,expectedTarget,normalDependencies } from '../features/docs/support/witness-c-vectors.mjs';
import { compareReadEvidence,inspectEffectEvidence,resolveTargetEvidence } from '../core/docs-semantic/coverage.mjs';
import { materialize } from '../core/docs-semantic/model.mjs';

test('C independently counted multiple literal occurrences do not require full document delivery',()=>{
  const document=documentVector();document.tabs[0].documentTab.body.content[1]=paragraph(7,'Old Old\n',{bold:false},{namedStyleType:'NORMAL_TEXT'});
  return withWitnessWorld(({snapshot:s})=>{
    const selector={text:{literal:'Old',cardinality:{all:2}}},effect={kind:'replaceLiteral',replacement:'New',stylePolicy:'preservePositions'};
    const matches=[{start:7,end:10},{start:11,end:14}].map(extent=>({snapshotId:s.binding.snapshotId,node:node(s,4),tabId:'tab-a',segment:{kind:'body'},extent,text:'Old',context:'Old Old\n',runs:[node(s,5)]}));
    const dependencies=normalDependencies(s,[4,5]);for(const n of dependencies.nodes){n.extent={start:7,end:15};if(n.terminatingNewline)n.terminatingNewline={start:14,end:15,text:'\n'};}
    const request={scope,selector,effect,presentation:{target:expectedTarget(s,selector,{count:2,matches,selectedMatches:matches}),dependencies,
      changes:matches.map(m=>({kind:'literalReplacement',node:node(s,4),extent:m.extent,before:'Old',after:'New',runs:[node(s,5)],stylePolicy:'preservePositions'})),effect}};
    assert.equal(compareReadEvidence(s,request).witnessSatisfied,true);
    assert.equal(resolveTargetEvidence(s,{scope,selector:{text:{literal:'Old',cardinality:{exactly:1}}}}).status,'ambiguous');
    const wrong=structuredClone(request);wrong.selector.text.cardinality.all=3;
    assert.deepEqual(compareReadEvidence(s,wrong).missingAspects,['targetEnumeration']);
    const omitted=structuredClone(request);omitted.presentation.target.matches.pop();
    assert.ok(compareReadEvidence(s,omitted).missingAspects.includes('effectPresentation'));
  },{document});
});
for(const change of ['preimage','context','extent','count','dependency','change','effectBoolean'])test(`C narrow witness rejects fabricated ${change}`,()=>withWitnessWorld(({snapshot:s})=>{
  const request=literalRequest(s);
  if(change==='preimage')request.presentation.target.matches[0].text='Other';
  if(change==='context')request.presentation.target.matches[0].context='Other';
  if(change==='extent')request.presentation.target.matches[0].extent.end=12;
  if(change==='count')request.presentation.target.count=9;
  if(change==='dependency')request.presentation.dependencies.nodes.pop();
  if(change==='change')request.presentation.changes=[];
  if(change==='effectBoolean')request.presentation={complete:true,effectsPreviewed:true};
  assert.equal(compareReadEvidence(s,request).witnessSatisfied,false);
}));
test('C normalized target maps retain independent source UTF-16 boundaries rather than normalized coordinates',()=>{
  const document=documentVector();document.tabs[0].documentTab.body.content[1]=paragraph(7,'Cafe\u0301 😀\n',{bold:false},{namedStyleType:'NORMAL_TEXT'});
  return withWitnessWorld(({snapshot:s})=>{
    const target=resolveTargetEvidence(s,{scope,selector:{text:{literal:'é',normalization:'nfc'}}});
    assert.deepEqual(target.sourceMaps,[{node:node(s,4),extent:{start:10,end:12},normalizedText:'é',
      boundaries:[{normalizedOffset:0,sourceOffset:10},{normalizedOffset:1,sourceOffset:12}],
      runs:[{node:node(s,5),extent:{start:10,end:12},text:'e\u0301'}]}]);
    assert.equal(target.matches[0].context,'Cafe\u0301 😀\n');
  },{document});
});
test('C unsupported unequal-width literal and newline changes are explicit missing contracts',()=>withWitnessWorld(({snapshot:s})=>{
  const request=literalRequest(s);request.effect.replacement='Longer replacement';
  assert.ok(compareReadEvidence(s,request).missingAspects.includes('unsupportedLiteralShape'));
  request.effect.replacement='Line\n';assert.throws(()=>compareReadEvidence(s,request),/unsupported/);
}));
test('C complete originals and disclosed hyperlink removal support a rich section beside an unrelated logo',()=>{
  const document=documentVector();document.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.link={url:'https://example.test/terms'};
  return withWitnessWorld(({snapshot:s})=>{
    const request=broadRequest(s),link={url:'https://example.test/terms'};
    request.presentation.changes[1].removedStyle.link=link;
    request.presentation.dependencies.nodes[1].storedStyle.link=link;
    request.originalRecords[0].providerEvidence.paragraph.elements[0].textRun.textStyle.link=link;
    assert.equal(compareReadEvidence(s,request).witnessSatisfied,true);
    delete request.presentation.changes[1].removedStyle.link;
    assert.ok(compareReadEvidence(s,request).missingAspects.includes('effectPresentation'));
  },{document});
});
test('C intersecting opaque removal remains unsupported even with complete actual originals',()=>{
  const document=documentVector();document.tabs[0].documentTab.body.content[1].paragraph.elements=[
    {startIndex:7,endIndex:8,futureInline:{payload:{startIndex:77,privateContent:'synthetic'}}}];
  return withWitnessWorld(({snapshot:s})=>{
    const request=broadRequest(s),facts=inspectEffectEvidence(s,{scope,selector:request.selector,effect:request.effect});
    assert.ok(facts.missingAspects.includes('unsupportedDestructiveElement'));
    assert.equal(compareReadEvidence(s,{scope,selector:request.selector,effect:request.effect,presentation:{target:facts.target,dependencies:facts.dependencies,changes:facts.changes,effect:request.effect}}).witnessSatisfied,false);
  },{document});
});
test('C list bullet dependencies cannot be hidden by a metadata bold summary',()=>{
  const document=documentVector();document.tabs[0].documentTab.body.content[1].paragraph.bullet={listId:'list-a',nestingLevel:0};
  document.tabs[0].documentTab.lists={'list-a':{listProperties:{nestingLevels:[{glyphType:'DECIMAL'}]}}};
  return withWitnessWorld(({snapshot:s})=>{
    const result=compareReadEvidence(s,styleRequest(s));assert.ok(result.missingAspects.includes('unsupportedListEffect'));assert.equal(result.witnessSatisfied,false);
  },{document});
});
test('C unknown fields are not repaired by graph omission or names resembling coordinates',()=>withWitnessWorld(({snapshot:s})=>{
  for(const alter of [model=>delete model.nodes[node(s,5)],model=>model.nodes[node(s,5)].kind='opaqueInline',model=>model.nodes[node(s,4)].children=[],model=>model.nodes[node(s,5)].evidence.path=['tabs',0,'documentTab','inlineObjects']]){
    const model=structuredClone(s);alter(model);assert.throws(()=>compareReadEvidence(model,styleRequest(s)),/corrupt/);
  }
}));
test('C effect inputs are bounded and cannot substitute approval or generated-stage flags',()=>withWitnessWorld(({snapshot:s})=>{
  const request=styleRequest(s);
  assert.throws(()=>compareReadEvidence(s,{...request,approved:true}),/invalid/);
  assert.throws(()=>compareReadEvidence(s,{...request,effect:{kind:'style',family:'text',set:{link:{url:'https://example.test'}}}}),/unsupported/);
  assert.throws(()=>compareReadEvidence(s,{...request,presentation:{text:'x'.repeat(65536)}}),/budget/);
  const cycle={};cycle.self=cycle;assert.throws(()=>compareReadEvidence(s,{...request,presentation:cycle}),/budget/);
}));
test('C missing review diagnostics do not impose unrelated prose on independent boolean style evidence',()=>{
  const document=documentVector();delete document.commentsViewMode;
  return withWitnessWorld(({snapshot:s})=>{
    assert.equal(s.missingReviewCoverage,true);
    const result=compareReadEvidence(s,styleRequest(s));assert.equal(result.witnessSatisfied,true);assert.equal(result.globalDiagnostics.missingReviewCoverage,true);
    assert.ok(compareReadEvidence(s,literalRequest(s)).missingAspects.includes('review'));
  },{document});
});
for(const view of ['acceptedPreview','rejectedPreview'])test(`C ${view} cannot become current editor evidence`,()=>withWitnessWorld(({snapshot:s})=>{
  const document=structuredClone(s.evidence);document.suggestionsViewMode=view==='acceptedPreview'?'PREVIEW_SUGGESTIONS_ACCEPTED':'PREVIEW_WITHOUT_SUGGESTIONS';
  const model=materialize({document,metadata:s.metadata,binding:{...s.binding,view},reviewIncluded:true});
  const result=compareReadEvidence(model,styleRequest(model));assert.ok(result.missingAspects.includes('currentEditorRevision'));assert.equal(result.witnessSatisfied,false);
}));
test('C unknown terminal section bounds remain incomplete rather than excluding the tail',()=>{
  const document=documentVector();document.tabs[0].documentTab.body.content=[paragraph(1,'Terms\n',{}, {namedStyleType:'HEADING_1',headingId:'terms'}),{startIndex:7,paragraph:{elements:[]}}];
  return withWitnessWorld(({snapshot:s})=>{
    const target=resolveTargetEvidence(s,{scope,selector:{section:{headingId:'terms',includeHeading:false}}});
    assert.equal(target.status,'unresolved');assert.equal(target.enumeration,'incomplete');assert.equal(target.witnessSatisfied,false);
  },{document});
});
test('C noneditor metadata cannot promote a retained revision to current edit evidence',()=>withWitnessWorld(({snapshot:s})=>{
  const snapshot=materialize({document:s.evidence,metadata:{...s.metadata,capabilities:{canEdit:false}},binding:s.binding,reviewIncluded:true});
  const result=compareReadEvidence(snapshot,styleRequest(snapshot));assert.ok(result.missingAspects.includes('currentEditorRevision'));assert.equal(result.witnessSatisfied,false);
}));
test('C actual paged section receipts accumulate only one coherent immutable read',()=>withWitnessWorld(async({snapshot:s,world,owner,service})=>{
  const {originalRecords,...request}=broadRequest(s),read=await readTokens(world,s,request.selector);
  assert.ok(read.tokens.length>1,JSON.stringify(read.pages.map(p=>p.records.length)));
  assert.equal(service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:read.tokens}).witnessSatisfied,true);
  assert.equal(service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:[read.tokens[0]]}).witnessSatisfied,false);
  assert.throws(()=>service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:[read.tokens.at(-1)]}),/scope/);
  const other=await readTokens(world,s,request.selector);
  assert.throws(()=>service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:[read.tokens[0],other.tokens.at(-1)]}),/conflict/);
},{pageBytes:2400}));
test('C diagnostic registry delivery and section delivery never transfer to full parent content',()=>withWitnessWorld(async({snapshot:s,world,owner,service})=>{
  const {originalRecords,...request}=broadRequest(s),diagnostic=await readTokens(world,s,request.selector,{registries:['styles']});
  assert.equal(service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:diagnostic.tokens}).witnessSatisfied,false);
  const section=await readTokens(world,s,request.selector),broader={...request,selector:{node:node(s,1)}};
  assert.equal(service.evaluate(owner,{snapshotId:s.binding.snapshotId,...broader,deliveryTokens:section.tokens}).witnessSatisfied,false);
}));
