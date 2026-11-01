import assert from 'node:assert/strict';
import { materialize } from '../../../core/docs-semantic/model.mjs';
import { ApplicationWorld as SemanticWorld,semanticAccount as account,semanticScope as scope } from './application-world.mjs';
const owner={subject:'subject-a',account,threadId:'thread-a'};
// Original inert data and independently specified schema shapes; no projector is
// used to construct expected classifications, values, paths or inheritance.
export function containerDocument(){return {
  documentId:'doc-a',revisionId:'container-evidence',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
  tabs:[{tabProperties:{tabId:'tab-a',title:'Container contracts'},documentTab:{
    documentStyle:{marginTop:{magnitude:72,unit:'PT'}},
    namedStyles:{styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:true,fontSize:{magnitude:18,unit:'PT'},weightedFontFamily:{fontFamily:'Parent',weight:700}},paragraphStyle:{alignment:'END'}}]},
    body:{content:[{startIndex:0,endIndex:1,sectionBreak:{sectionStyle:{}}},
      {startIndex:1,endIndex:6,paragraph:{paragraphStyle:{namedStyleType:'NORMAL_TEXT'},elements:[{startIndex:1,endIndex:6,textRun:{content:'Data\n'}}]}}]},
  }}],
};}
const dimension={magnitude:24,unit:'PT'};
const tabEntry={offset:dimension,alignment:'CENTER'};
const columnEntry={width:dimension,paddingEnd:{magnitude:6,unit:'PT'}};
export const containerCases=[];
function add(id,ownerKind,key,value,known,unknownAt,missingAt){containerCases.push({id,ownerKind,key,value,known,unknownAt,missingAt});}
for(const [prefix,ownerKind,key,entry] of [['tabs','paragraph','tabStops',tabEntry],['columns','sectionBreak','columnProperties',columnEntry]]){
  for(const [name,value,known] of [
    ['array',[entry],true],['emptyArray',[],true],['namedObject',{item:entry},false],['numericObject',{'0':entry},false],
    ['emptyObject',{},false],['null',null,false],['string','array',false],['boolean',true,false],['number',1,false],
  ])add(`${prefix}/${name}`,ownerKind,key,value,known,known?undefined:key);
  for(const [name,value] of [['nestedArray',[[entry]]],['emptyNestedArray',[[]]],['nullEntry',[null]],['scalarEntry',[3]]])
    add(`${prefix}/${name}`,ownerKind,key,value,false,`${key}.0`);
}
for(const [prefix,ownerKind,key,valid] of [
  ['font','text','weightedFontFamily',{fontFamily:'Direct',weight:400}],
  ['dimension','text','fontSize',dimension],
  ['page','documentStyle','pageSize',{width:dimension,height:{magnitude:48,unit:'PT'}}],
  ['sectionMargin','sectionBreak','marginTop',dimension],
]){
  add(`${prefix}/object`,ownerKind,key,valid,true);
  for(const [name,value] of [['array',[valid]],['emptyArray',[]],['null',null],['string','object'],['boolean',false],['number',4]])
    add(`${prefix}/${name}`,ownerKind,key,value,false,key);
}
for(const [prefix,ownerKind,key,valid] of [
  ['boolean','text','bold',false],['number','paragraph','lineSpacing',120],['string','documentStyle','defaultHeaderId','header-control'],['enum','paragraph','alignment','CENTER'],
]){
  add(`${prefix}/scalar`,ownerKind,key,valid,true);
  for(const [name,value] of [['array',[valid]],['emptyArray',[]],['object',{value:valid}],['numericObject',{'0':valid}],['emptyObject',{}],['null',null]])
    add(`${prefix}/${name}`,ownerKind,key,value,false,key);
}
// Nested object boundaries inside arrays and inside other structured properties.
for(const [name,value] of [['array',[dimension]],['emptyArray',[]],['null',null],['scalar',24]]){
  add(`tabs/offset-${name}`,'paragraph','tabStops',[{offset:value,alignment:'CENTER'}],false,'tabStops.0.offset');
  add(`columns/width-${name}`,'sectionBreak','columnProperties',[{width:value,paddingEnd:{magnitude:6,unit:'PT'}}],false,'columnProperties.0.width');
  add(`page/width-${name}`,'documentStyle','pageSize',{width:value,height:{magnitude:48,unit:'PT'}},false,'pageSize.width');
}
for(const [name,value] of [['array',[24]],['object',{number:24}],['emptyArray',[]],['emptyObject',{}],['string','24'],['null',null]])
  add(`nestedScalar/${name}`,'text','fontSize',{magnitude:value,unit:'PT'},false,'fontSize.magnitude');
add('nestedString/array','text','weightedFontFamily',{fontFamily:['Direct'],weight:400},false,'weightedFontFamily.fontFamily');
add('nestedNumber/object','text','weightedFontFamily',{fontFamily:'Direct',weight:{number:400}},false,'weightedFontFamily.weight');
add('nestedEnum/array','text','fontSize',{magnitude:24,unit:['PT']},false,'fontSize.unit');
add('nestedEnum/object','paragraph','tabStops',[{offset:dimension,alignment:{value:'CENTER'}}],false,'tabStops.0.alignment');
add('deepColor/array','text','foregroundColor',{color:{rgbColor:[{red:0.5}]}},false,'foregroundColor.color.rgbColor');
add('deepColor/scalarObject','text','foregroundColor',{color:{rgbColor:{red:{number:0.5}}}},false,'foregroundColor.color.rgbColor.red');
add('deepColor/object','text','foregroundColor',{color:{rgbColor:{red:0.5}}},true);
add('optionalColor/emptyObject','text','foregroundColor',{},true);
add('atomic/partialFont','text','weightedFontFamily',{fontFamily:'Direct'},false,undefined,'weightedFontFamily.weight');
add('atomic/partialDimension','text','fontSize',{magnitude:24},false,undefined,'fontSize.unit');
function arrange(c){
  const document=containerDocument(),tab=document.tabs[0].documentTab,paragraph=tab.body.content[1].paragraph;
  if(c.ownerKind==='documentStyle')tab.documentStyle[c.key]=structuredClone(c.value);
  else if(c.ownerKind==='sectionBreak')tab.body.content[0].sectionBreak.sectionStyle[c.key]=structuredClone(c.value);
  else if(c.ownerKind==='paragraph')paragraph.paragraphStyle[c.key]=structuredClone(c.value);
  else paragraph.elements[0].textRun.textStyle={[c.key]:structuredClone(c.value)};
  return document;
}
function styleFrom(snapshot,c){return c.ownerKind==='documentStyle'?snapshot.tabs[0].documentStyle:Object.values(snapshot.nodes).find(n=>n.kind===c.ownerKind).style;}
function checkStyle(style,c){
  const property=style.properties[c.key],facts=style.propertyEvidence?.[c.key]??property.propertyEvidence;
  assert.deepEqual(c.ownerKind==='documentStyle'?property.stored:property.value,c.value,'original explicit value is not coerced or replaced by parent data');
  assert.equal(property.provenance,'direct');assert.equal(facts.atomic,true);
  assert.equal(facts.effectiveStatus,c.known?'observed':'partialOrUnknown');
  if(c.unknownAt){
    assert.ok(facts.unknown.includes(c.unknownAt),`unknown container/kind at ${c.unknownAt}`);
    assert.equal(facts.leaves[c.unknownAt].status,'unknownSchema');
    const path=c.unknownAt.split('.').slice(1);
    assert.deepEqual(facts.leaves[c.unknownAt].stored,path.reduce((v,key)=>v[key],c.value));
    assert.ok(!Object.keys(facts.leaves).some(key=>key.startsWith(`${c.unknownAt}.`)),'wrong container never lends its children a valid schema');
  }
  if(c.missingAt)assert.ok(facts.missing.includes(c.missingAt));
  if(property.effective)assert.equal(property.effective.status,c.known?'storedApiValue':'partialOrUnknown');
  assert.notEqual(style.rendering,'verified');
}
export function checkContainerPure(c){
  const document=arrange(c),snapshot=materialize({document,metadata:{id:'doc-a'},binding:{...owner,snapshotId:'pure-container',documentId:'doc-a',view:'inline'},reviewIncluded:true});
  assert.deepEqual(snapshot.evidence,document);checkStyle(styleFrom(snapshot,c),c);
}
export async function checkContainerApplication(c){
  const w=new SemanticWorld();
  try{
    await w.init();w.document=arrange(c);const original=structuredClone(w.document),inspection=await w.inspect();
    assert.ok(inspection.snapshotId);w.assertInitialPorts();
    const snapshot=w.store.semanticSnapshots.get(inspection.snapshotId,owner,0);assert.deepEqual(snapshot.evidence,original);
    const node=c.ownerKind==='documentStyle'?null:Object.values(snapshot.nodes).find(n=>n.kind===c.ownerKind);
    const args={account,snapshotId:inspection.snapshotId,scope,format:'structured',styles:true,review:true,...node?{selector:{node:node.id}}:{registries:['styles']}};
    const result=await w.call('docs_read',args);assert.equal(result.complete,true);assert.equal(result.coverage.editReady,false);
    const record=result.records.find(r=>node?r.id===node.id:r.kind==='documentStyle');assert.ok(record);checkStyle(record.style,c);
    const [receipt]=w.store.semanticSnapshots.deliveries(inspection.snapshotId,owner,0,[result.coverage.deliveryToken]);
    assert.deepEqual(receipt.nodes,result.coverage.delivered.nodes);assert.ok(receipt.nodeAspects[record.id].includes('styles'));
    assert.equal(w.observe().deliveries,1);
    assert.deepEqual(w.store.semanticSnapshots.get(inspection.snapshotId,owner,0).evidence,original);
  }finally{await w.close();}
}
