import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withWitnessWorld } from '../features/docs/support/witness-c-checks.mjs';
import { paragraph,node,scope,expectedTarget,binding } from '../features/docs/support/witness-c-vectors.mjs';
import { inspectNamedStyleEvidence,compareNamedStyleEvidence } from '../core/docs-semantic/named-style-evidence.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function documentOf(content) {
  return {documentId:'doc-a',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Dependency checks'},documentTab:{body:{content}}}]};
}
function observedNode(s,id,parent,kind,start,end) {
  return {node:node(s,id),kind,parent:node(s,parent),extent:{start,end},properties:{},storedStyle:{},
    terminatingNewline:kind==='text'?{start:end-1,end,text:'\n'}:null,list:null,positionedObjectIds:[],review:{},unknownFields:[]};
}
function insertion(s,{root=2,run=3,start=1,end=6,tail=[]}={}) {
  const effect={kind:'insertText',at:'end',text:'!'},selector={node:node(s,root)};
  const entries=[[root,1,'paragraph',start,end],[run,root,'text',start,end],...tail];
  return {snapshotId:s.binding.snapshotId,scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[root]}),
    dependencies:{nodes:entries.map(e=>observedNode(s,...e)),registryRecords:[],registryLosses:[]},
    changes:[{kind:'insertText',node:node(s,root),index:end-1,text:'!',inheritFrom:node(s,run)},...entries.map(([id,,kind,a,b])=>({
      kind:'extentShift',node:node(s,id),before:{start:a,end:b},after:{start:a>=end-1&&id!==root?a+1:a,end:b+1}}))],effect}};
}
function deletion(s,whole=true) {
  const effect={kind:'destructiveScope',action:'delete'},selector={node:node(s,whole?2:3)};
  const entries=whole?[[2,1,'paragraph',1,6],[3,2,'text',1,6]]:[[3,2,'text',1,6]];
  const original=paragraph(1,'Keep\n');
  return {snapshotId:s.binding.snapshotId,scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[whole?2:3]}),
    dependencies:{nodes:entries.map(e=>observedNode(s,...e)),registryRecords:[],registryLosses:[],boundaries:whole?[{
      node:node(s,4),kind:'paragraph',extent:{start:6,end:11},style:{explicit:{},properties:{}},list:null,review:{},
      terminator:{node:node(s,5),extent:{start:10,end:11},text:'\n'},unknownFields:[]}]:[]},
    changes:entries.map(([id,,kind,start,end])=>({kind:'removeOriginal',node:node(s,id),sourceKind:kind,extent:{start,end},removedStyle:{},
      list:null,positionedObjectIds:[],review:{},unknownFields:[]})),effect},
    originalRecords:whole?[{node:node(s,2),providerEvidence:original},{node:node(s,3),providerEvidence:original.paragraph.elements[0]}]:[{node:node(s,3),providerEvidence:original.paragraph.elements[0]}]};
}
for(const location of ['later-start','no-start','unresolved-paragraph','segment-rule','other-tab','other-segment','bounded-earlier'])test(`C1 insertion suffix classification ${location}`,()=>{
  const document=documentOf([paragraph(1,'Keep\n')]),body=document.tabs[0].documentTab;
  const unknown={startIndex:30,futureBlock:{label:'original unknown'}};
  if(location==='later-start')body.body.content.push(unknown);
  if(location==='no-start')body.body.content.push({futureBlock:{label:'original unknown'}});
  if(location==='unresolved-paragraph')body.body.content.push({startIndex:30,paragraph:{paragraphStyle:{},elements:[]}});
  if(location==='segment-rule')body.body.futureCoordinates={mode:'unknown'};
  if(location==='other-tab')document.tabs.push({tabProperties:{tabId:'tab-b',title:'Other'},documentTab:{body:{content:[unknown]}}});
  if(location==='other-segment')body.headers={head:{content:[unknown]}};
  if(location==='bounded-earlier')body.body.content=[{startIndex:0,endIndex:5,paragraph:{paragraphStyle:{},elements:[{startIndex:0,futureInline:{label:'before'}}]}},paragraph(10,'Keep\n')];
  return withWitnessWorld(({snapshot:s,service,owner,world})=>{
    const request=insertion(s,location==='bounded-earlier'?{root:4,run:5,start:10,end:15}:{});
    const result=service.evaluate(owner,request),allowed=['other-tab','other-segment','bounded-earlier'].includes(location);
    assert.equal(result.witnessSatisfied,allowed,JSON.stringify(result.missingAspects));
    if(!allowed){assert.ok(result.missingAspects.includes('unresolvedInsertionDependency'));assert.ok(result.footprint.nodes.includes(node(s,location==='segment-rule'?1:4)));}
    assert.equal(result.editReady,false);assert.equal(result.authoringAuthority,'notEstablished');
    assert.deepEqual(world.store.semanticSnapshots.get(s.binding.snapshotId,owner,0).evidence,document);
  },{document});
});
test('C1 disclosing an unresolved suffix still cannot certify an exact insertion effect',()=>{
  const document=documentOf([paragraph(1,'Keep\n'),{startIndex:30,futureBlock:{label:'original unknown'}}]);
  return withWitnessWorld(({snapshot:s,service,owner})=>{
    const request=insertion(s);
    request.presentation.dependencies.nodes.push({node:node(s,4),kind:'opaque',parent:node(s,1),extent:null,properties:{},storedStyle:null,terminatingNewline:null,list:null,positionedObjectIds:[],review:{},unknownFields:[]});
    const result=service.evaluate(owner,request);
    assert.equal(result.witnessSatisfied,false);assert.ok(result.missingAspects.includes('unresolvedInsertionDependency'));
    assert.ok(!result.missingAspects.includes('effectPresentation'));
  },{document});
});
test('C1 mapped suffix is presented exactly through the stored-owner facade',()=>withWitnessWorld(({snapshot:s,service,owner})=>{
  const request=insertion(s,{tail:[[4,1,'paragraph',30,35],[5,4,'text',30,35]]});
  assert.equal(service.evaluate(owner,request).witnessSatisfied,true);
  request.presentation.changes.pop();assert.equal(service.evaluate(owner,request).witnessSatisfied,false);
},{document:documentOf([paragraph(1,'Keep\n'),paragraph(30,'Tail\n')])}));
for(const whole of [true,false])test(`C2 ${whole?'whole paragraph':'terminator run'} physical removal roots`,()=>withWitnessWorld(({snapshot:s,service,owner})=>{
  const result=service.evaluate(owner,deletion(s,whole));assert.equal(result.witnessSatisfied,whole);
  if(!whole)assert.ok(result.missingAspects.includes('unsupportedDestructiveRoot'));
},{document:documentOf([paragraph(1,'Keep\n'),paragraph(6,'Next\n')])}));
test('C2 a downstream unknown beyond the adjacent paragraph is not disjoint from deletion',()=>{
  const document=documentOf([paragraph(1,'Keep\n'),paragraph(6,'Next\n'),{startIndex:30,futureBlock:{label:'shifted'}}]);
  return withWitnessWorld(({snapshot:s,service,owner})=>{
    const result=service.evaluate(owner,deletion(s));assert.equal(result.witnessSatisfied,false);assert.ok(result.missingAspects.includes('unresolvedDestructiveDependency'));
  },{document});
});

test('C2 preceding boundary child review cannot disappear behind its paragraph summary',()=>{
  const previous=paragraph(1,'Keep\n');
  previous.paragraph.elements[0].textRun.suggestedTextStyleChanges={pending:{textStyle:{bold:true}}};
  const original=paragraph(6,'Next\n');
  return withWitnessWorld(({snapshot:s,owner,service})=>{
    const effect={kind:'destructiveScope',action:'delete'},selector={node:node(s,4)},entries=[[4,1,'paragraph',6,11],[5,4,'text',6,11]];
    const request={snapshotId:s.binding.snapshotId,scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[4]}),
      dependencies:{nodes:entries.map(e=>observedNode(s,...e)),registryRecords:[],registryLosses:[],boundaries:[{
        node:node(s,2),kind:'paragraph',extent:{start:1,end:6},style:{explicit:{},properties:{}},list:null,review:{},
        terminator:{node:node(s,3),extent:{start:5,end:6},text:'\n'},unknownFields:[]}]},
      changes:entries.map(([id,,kind,start,end])=>({kind:'removeOriginal',node:node(s,id),sourceKind:kind,extent:{start,end},removedStyle:{},list:null,positionedObjectIds:[],review:{},unknownFields:[]})),effect},
      originalRecords:[{node:node(s,4),providerEvidence:original},{node:node(s,5),providerEvidence:original.paragraph.elements[0]}]};
    const result=service.evaluate(owner,request);assert.equal(result.witnessSatisfied,false);assert.ok(result.missingAspects.includes('unprovenBoundaryEffect'));
    assert.ok(!result.missingAspects.includes('effectPresentation'));
  },{document:documentOf([previous,original])});
});
function topologyDocument() {
  const first={startIndex:3,endIndex:8,content:[paragraph(4,'AB\n')]},second={startIndex:8,endIndex:14,content:[paragraph(9,'XYZ\n')]};
  const row={startIndex:2,endIndex:15,tableCells:[first,second]},table={startIndex:1,endIndex:15,table:{rows:1,columns:2,tableRows:[row]}};
  return {document:documentOf([table,paragraph(15,'Next\n')]),table,row,first,second};
}
for(const kind of ['table','tableRow','tableCell'])test(`C2 physical topology root ${kind}`,()=>{
  const f=topologyDocument();
  return withWitnessWorld(({snapshot:s,service,owner})=>{
    const all=[[2,1,'table',1,15,f.table],[3,2,'tableRow',2,15,f.row],[4,3,'tableCell',3,8,f.first],
      [5,4,'paragraph',4,7,f.first.content[0]],[6,5,'text',4,7,f.first.content[0].paragraph.elements[0]],
      [7,3,'tableCell',8,14,f.second],[8,7,'paragraph',9,13,f.second.content[0]],[9,8,'text',9,13,f.second.content[0].paragraph.elements[0]]];
    const root={table:2,tableRow:3,tableCell:4}[kind],entries=all.filter(([id])=>id>=root&&(kind!=='tableCell'||id<=6));
    const effect={kind:'destructiveScope',action:'delete'},selector={node:node(s,root)};
    const boundaries=kind==='table'?[{node:node(s,10),kind:'paragraph',extent:{start:15,end:20},style:{explicit:{},properties:{}},list:null,review:{},
      terminator:{node:node(s,11),extent:{start:19,end:20},text:'\n'},unknownFields:[]}]:kind==='tableCell'?[
      {node:node(s,7),kind:'tableCell',extent:{start:8,end:14},style:null,list:null,review:{},terminator:null,unknownFields:[]}]:[];
    const request={snapshotId:s.binding.snapshotId,scope,selector,effect,presentation:{target:expectedTarget(s,selector,{nodes:[root]}),
      dependencies:{nodes:entries.map(([id,parent,kind,a,b])=>({...observedNode(s,id,parent,kind,a,b),storedStyle:['paragraph','text'].includes(kind)?{}:null})),registryRecords:[],registryLosses:[],boundaries},
      changes:entries.map(([id,,kind,start,end])=>({kind:'removeOriginal',node:node(s,id),sourceKind:kind,extent:{start,end},removedStyle:{},list:null,positionedObjectIds:[],review:{},unknownFields:[]})),effect},
      originalRecords:entries.map(([id,,,,,raw])=>({node:node(s,id),providerEvidence:raw}))};
    const result=service.evaluate(owner,request);assert.equal(result.witnessSatisfied,kind==='table',JSON.stringify(result.missingAspects));
    if(kind!=='table')assert.ok(result.missingAspects.includes('unsupportedDestructiveRoot'));
    assert.ok(!result.missingAspects.includes('effectPresentation'));
  },{document:f.document});
});
// Complete independent property witness, including the actual inheritance owner
// and registry identities. Only the immutable page hash comes from the producer;
// no producer-produced usage is substituted for this expected presentation.
function namedExpected(s,original,mode) {
  const reg=`${s.binding.snapshotId}:registry:1`,ref=i=>`${s.binding.snapshotId}:reference:${i}`;
  const parentReview=mode==='parent-review'?{suggestedParagraphStyleChanges:original.paragraph.suggestedParagraphStyleChanges}:{};
  const unknown=mode==='parent-unknown'?[{path:['tabs',0,'documentTab','body','content',0,'paragraph'],field:'futureInheritanceRule',digest:hash(original.paragraph.futureInheritanceRule)}]:[];
  const reference={id:ref(1),definitionKind:'namedStyle',providerId:'NORMAL_TEXT',targets:[reg],status:'resolved',dependencyOwner:null,dependencyEvidenceDigest:null};
  const refs=[reference];
  if(mode==='parent-review')refs.push({id:ref(2),definitionKind:'suggestionThread',providerId:'pending',targets:[],status:'unresolved',dependencyOwner:null,dependencyEvidenceDigest:null});
  return [{node:node(s,3),kind:'text',tabId:'tab-a',segment:{kind:'body'},namedType:'NORMAL_TEXT',directOverride:null,before:false,after:true,
    affected:true,provenance:'named',source:'NORMAL_TEXT',inheritedSource:'NORMAL_TEXT',status:'observed',
    dependencies:[{id:ref(mode==='parent-review'?3:2),providerId:'NORMAL_TEXT',targets:[reg],status:'resolved',dependencyOwner:node(s,2),dependencyEvidenceDigest:hash(original)}],
    inheritanceOwners:[{node:node(s,2),kind:'paragraph',evidenceDigest:hash(original),namedStyleType:'NORMAL_TEXT',review:parentReview,unknownFields:unknown,references:refs}],
    review:{},unknownFields:[]}];
}
for(const mode of ['plain','parent-review','parent-unknown','unrelated-sibling','unrelated-tab'])test(`C3 exact inheritance-owner presentation ${mode}`,()=>{
  const original=paragraph(1,'Keep\n',{}, {namedStyleType:'NORMAL_TEXT'});
  if(mode==='parent-review')original.paragraph.suggestedParagraphStyleChanges={pending:{paragraphStyle:{namedStyleType:'HEADING_1'},paragraphStyleSuggestionState:{namedStyleTypeSuggested:true}}};
  if(mode==='parent-unknown')original.paragraph.futureInheritanceRule={selection:'unknown'};
  const document=documentOf([original]),body=document.tabs[0].documentTab;
  body.namedStyles={styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false}},{namedStyleType:'HEADING_1',textStyle:{bold:true}}]};
  if(mode==='unrelated-sibling'){
    // Unstyled opaque sibling is not an inheritance owner of the actual usage.
    body.body.content.push({startIndex:30,endIndex:31,futureBlock:{futureInheritanceRule:true}});
  }
  if(mode==='unrelated-tab')document.tabs.push({tabProperties:{tabId:'tab-b',title:'Other'},documentTab:{body:{content:[{startIndex:1,paragraph:{elements:[],futureInheritanceRule:true}}]}}});
  return withWitnessWorld(({snapshot:s,world,owner})=>{
    const request={tabId:'tab-a',namedType:'NORMAL_TEXT',family:'text',property:'bold',value:true};
    const page=inspectNamedStyleEvidence(s,request),usages=namedExpected(s,original,mode);
    assert.deepEqual(page.usages,usages);
    const expected={binding:binding(s),request,definition:{id:`${s.binding.snapshotId}:registry:1`,original:{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false}},property:'bold',before:false,after:true},
      usages,offset:0,total:1,nextOffset:null,witnessDigest:page.witnessDigest,complete:true,missingAspects:mode==='parent-review'?['unsupportedReviewEffect','unresolvedInheritanceDependency']:mode==='parent-unknown'?['unknownDependentFields']:[],
      materialized:'complete',delivered:'propertyPage',witnessSatisfied:false,indirect:true,contentDeletion:false,editReady:false,authoringAuthority:'notEstablished'};
    assert.deepEqual(page,expected);
    const result=compareNamedStyleEvidence(s,request,[expected]);assert.equal(result.witnessSatisfied,!['parent-review','parent-unknown'].includes(mode));
    if(mode==='parent-review')assert.ok(result.missingAspects.includes('unsupportedReviewEffect'));
    if(mode==='parent-unknown')assert.ok(result.missingAspects.includes('unknownDependentFields'));
    const truncated=structuredClone(expected);truncated.usages[0].inheritanceOwners=[];
    assert.equal(compareNamedStyleEvidence(s,request,[truncated]).witnessSatisfied,false);
    assert.deepEqual(world.store.semanticSnapshots.get(s.binding.snapshotId,owner,0).evidence,document);
  },{document});
});
