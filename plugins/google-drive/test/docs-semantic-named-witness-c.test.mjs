import test from 'node:test';
import assert from 'node:assert/strict';
import { withWitnessWorld,generatedDocuments } from '../features/docs/support/witness-c-checks.mjs';
import { documentVector,node,paragraph } from '../features/docs/support/witness-c-vectors.mjs';
import { inspectNamedStyleEvidence,compareNamedStyleEvidence } from '../core/docs-semantic/coverage.mjs';
const request={tabId:'tab-a',namedType:'NORMAL_TEXT',family:'text',property:'bold',value:true};
test('C NORMAL_TEXT usage follows actual provenance including named and direct overrides and styled objects',()=>withWitnessWorld(({snapshot:s})=>{
  const page=inspectNamedStyleEvidence(s,request);
  assert.equal(page.total,5);
  assert.deepEqual(page.usages.map(u=>[u.node,u.before,u.after,u.affected,u.provenance,u.source,u.directOverride,u.inheritedSource,u.status]),[
    [node(s,3),true,true,false,'named','HEADING_1',null,'HEADING_1','observed'],
    [node(s,5),false,false,false,'direct',null,false,'NORMAL_TEXT','observed'],
    [node(s,7),true,true,false,'named','HEADING_1',null,'HEADING_1','observed'],
    [node(s,9),false,true,true,'named','NORMAL_TEXT',null,'NORMAL_TEXT','observed'],
    [node(s,10),false,true,true,'named','NORMAL_TEXT',null,'NORMAL_TEXT','observed']]);
  assert.equal(compareNamedStyleEvidence(s,request,[page]).witnessSatisfied,true);
  const italic={...request,property:'italic'},indirect=inspectNamedStyleEvidence(s,italic);
  assert.ok(indirect.usages.every(u=>u.before===false&&u.after===true&&u.affected&&u.source==='NORMAL_TEXT'));
  assert.equal(compareNamedStyleEvidence(s,italic,[indirect]).witnessSatisfied,true);
}));
for(const fault of ['unknownType','missingDefinition','unknownValue','atomicPartial','nonInherited'])test(`C named style reports ${fault} rather than inventing property effects`,()=>{
  const document=documentVector(),tab=document.tabs[0].documentTab;
  const query={...request};
  if(fault==='unknownType')delete tab.body.content[1].paragraph.paragraphStyle.namedStyleType;
  if(fault==='missingDefinition')tab.namedStyles.styles.pop();
  if(fault==='unknownValue')tab.namedStyles.styles[0].textStyle.bold='FUTURE';
  if(fault==='atomicPartial'){
    tab.namedStyles.styles[0].textStyle.weightedFontFamily={fontFamily:'Example',weight:400};
    query.property='weightedFontFamily';query.value={fontFamily:'Other'};
  }
  if(fault==='nonInherited'){tab.namedStyles.styles[0].textStyle.link={url:'https://example.test/a'};query.property='link';query.value={url:'https://example.test/b'};}
  return withWitnessWorld(({snapshot:s})=>{
    const page=inspectNamedStyleEvidence(s,query),result=compareNamedStyleEvidence(s,query,[page]);assert.equal(result.witnessSatisfied,false);
    assert.ok(result.missingAspects.some(a=>['unknownUsageProperty','unsupportedTypedProperty','nonInheritedProperty'].includes(a)));
  },{document});
});
test('C named style table parent remains unknown even when the named type matches',()=>{
  const {after:document}=generatedDocuments();
  const tab=document.tabs[0].documentTab;tab.namedStyles={styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false}}]};
  for(const item of tab.body.content)if(item.paragraph)item.paragraph.paragraphStyle={namedStyleType:'NORMAL_TEXT'};
  tab.body.content[1].table.tableRows[0].tableCells[0].content[0].paragraph.paragraphStyle={namedStyleType:'NORMAL_TEXT'};
  return withWitnessWorld(({snapshot:s})=>{
    const page=inspectNamedStyleEvidence(s,request);
    assert.equal(page.usages.find(u=>u.node===node(s,8)).status,'unknownTableParent');
    assert.equal(compareNamedStyleEvidence(s,request,[page]).witnessSatisfied,false);
  },{document});
});
test('C named usage pages are immutable property enumerations, not truncated complete booleans',()=>{
  const document=documentVector(),tab=document.tabs[0].documentTab;
  tab.body.content=Array.from({length:150},(_,i)=>paragraph(1+i*2,'X\n',{}, {namedStyleType:'NORMAL_TEXT'}));
  return withWitnessWorld(({snapshot:s})=>{
    const pages=[0,50,100].map(offset=>inspectNamedStyleEvidence(s,request,{offset,limit:50}));
    assert.deepEqual(pages.map(p=>[p.offset,p.total,p.nextOffset,p.usages.length]),[[0,150,50,50],[50,150,100,50],[100,150,null,50]]);
    assert.equal(compareNamedStyleEvidence(s,request,pages).witnessSatisfied,true);
    assert.equal(compareNamedStyleEvidence(s,request,[{...pages[0],complete:true}]).witnessSatisfied,false);
    assert.throws(()=>compareNamedStyleEvidence(s,request,[pages[0],pages[2]]),/conflict/);
    assert.throws(()=>compareNamedStyleEvidence(s,request,[pages[0],{...pages[1],witnessDigest:'other'}]),/conflict/);
  },{document});
});
