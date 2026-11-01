import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../core/docs-semantic/model.mjs';
import { footprint,evaluateWitness,previewWitness } from '../core/docs-semantic/coverage.mjs';
import { evidenceAt,jsonBytes,boundedTree } from '../core/docs-semantic/common.mjs';
import { checkFoundation,gridDocument } from '../features/docs/support/foundation-checks.mjs';
import { semanticVector } from '../features/docs/support/semantic-world.mjs';
const binding={snapshotId:'foundation',subject:'subject',account:'writer@example.test',threadId:'thread',documentId:'doc-a',view:'inline',retrievedAt:0};
const make=(document=semanticVector.document,budgets={})=>materialize({document,metadata:{},binding,reviewIncluded:true,budgets});
for(const name of ['aggregateGrid','ordinalRoundTrip','scopedReview','unknownReview','unknownContent','outsideParent'])test(`native/SQLite foundation: ${name}`,()=>checkFoundation(name));
test('JSON byte measurement and pending traversal bound allocations before serialization',()=>{
  for(const value of [{x:'é😀\n\u0000"\\',skip:undefined},[null,undefined,true,1e-8],Array(3),{nested:{a:[1,2,3]}}]){
    const expected=Buffer.byteLength(JSON.stringify(value));
    assert.equal(jsonBytes(value,expected),expected);assert.throws(()=>jsonBytes(value,expected-1),/budget/);
  }
  assert.throws(()=>boundedTree(Array(100001)),/budget/);
  const m=make(gridDocument([3,3]));assert.ok(Buffer.byteLength(JSON.stringify(m))<=m.resources.modelReservationBytes);
});
test('aggregate multi-table topology and model reservation exact limits and one over',()=>{
  const exact=make(gridDocument([3,3]),{topologySlots:6});assert.equal(exact.resources.topologySlots,6);
  assert.throws(()=>make(gridDocument([3,4]),{topologySlots:6}),/budget/);
  const bytes=exact.resources.modelReservationBytes;
  assert.equal(make(gridDocument([3,3]),{topologySlots:6,modelBytes:bytes}).resources.modelReservationBytes,bytes);
  assert.throws(()=>make(gridDocument([3,3]),{topologySlots:6,modelBytes:bytes-1}),/budget/);
  for(const columns of [Number.MAX_SAFE_INTEGER,1.5,-1]){
    const d=gridDocument([1]);d.tabs[0].documentTab.body.content[0].table.columns=columns;
    assert.throws(()=>make(d),/budget|extent/);
  }
  for(const span of [0,-1,1.5,Number.MAX_SAFE_INTEGER]){
    const d=gridDocument([2]);d.tabs[0].documentTab.body.content[0].table.tableRows[0].tableCells[0].tableCellStyle.columnSpan=span;
    assert.throws(()=>make(d),/extent/);
  }
});
// Independent legal coordinates: physical row/cell ranges are serialization
// ranges, not the visual span rectangle. Leading delimiters and final newline
// gaps are intentional. A rowspan's contents stay in its originating row.
const text=(start,value)=>({startIndex:start,endIndex:start+value.length,paragraph:{elements:[{startIndex:start,endIndex:start+value.length,textRun:{content:value}}]}});
function spanned(){
  const d=gridDocument([2]);d.tabs[0].documentTab.body.content=[{startIndex:1,endIndex:20,table:{rows:2,columns:2,tableRows:[
    {startIndex:2,endIndex:10,tableCells:[
      {startIndex:3,endIndex:6,tableCellStyle:{rowSpan:2,columnSpan:1},content:[text(4,'A\n')]},
      {startIndex:6,endIndex:10,content:[text(7,'BC\n')]}]},
    {startIndex:10,endIndex:20,tableCells:[{startIndex:11,endIndex:20,content:[{startIndex:12,endIndex:19,table:{rows:1,columns:1,tableRows:[
      {startIndex:13,endIndex:19,tableCells:[{startIndex:14,endIndex:19,content:[text(15,'xyz\n')]}]}]}},text(19,'\n')]}]}
  ]}}];return d;
}
test('legal nested/spanned physical extents retain delimiters without visual-span overlap',()=>{
  const m=make(spanned()),table=Object.values(m.nodes).find(n=>n.kind==='table');
  assert.equal(table.grid[0][0],table.grid[1][0]);assert.notEqual(table.grid[0][1],table.grid[1][1]);
  assert.equal(Object.values(m.nodes).filter(n=>n.kind==='table').length,2);assert.equal(m.currentEditEvidence,true);
});
test('rows, cells and nested blocks cannot escape or overlap their known physical ranges',()=>{
  const changes=[
    rows=>{rows[1].startIndex=9;},
    rows=>{rows[0].tableCells[1].startIndex=5;},
    rows=>{rows[0].tableCells[0].startIndex=1;},
    rows=>{rows[1].endIndex=21;},
    rows=>{rows[1].tableCells[0].content[0].endIndex=21;},
    rows=>{rows[0].tableCells[0].content=[text(1000,'x\n')];},
    rows=>{rows[0].tableCells[1].content=[text(7,'x\n'),text(8,'y\n')];}
  ];
  for(const change of changes){const d=spanned();change(d.tabs[0].documentTab.body.content[0].table.tableRows);assert.throws(()=>make(d),/extent/);}
});
test('missing structural extent stays unresolved rather than granting mapped editor evidence',()=>{
  const d=spanned();delete d.tabs[0].documentTab.body.content[0].table.tableRows[0].endIndex;
  const m=make(d),row=Object.values(m.nodes).find(n=>n.kind==='tableRow');
  assert.equal(row.extent,null);assert.equal(row.extentStatus,'unresolved');assert.equal(m.currentEditEvidence,true);assert.equal(m.unresolvedExtents,true);
  const fp=footprint(m,{nodes:[row.id],destructive:true,aspects:['content']});
  const originals=fp.nodes.map(node=>({node,providerEvidence:evidenceAt(m,m.nodes[node].evidence.path)}));
  assert.equal(evaluateWitness(m,fp,{preview:previewWitness(m,fp,originals)}).witnessSatisfied,false);
});
test('footprint validation cannot be bypassed with empty/style-only aspects or omitted dependencies/descendants',()=>{
  const s=make(),target=Object.values(s.nodes).find(n=>n.kind==='paragraph').id;
  const dependency=Object.values(s.nodes).find(n=>n.text==='Tail\n').id;
  for(const aspects of [[],['styles'],['content','content'],['content','unrecognized']]){
    assert.throws(()=>footprint(s,{nodes:[target],destructive:true,aspects}),/invalid|scope/);
  }
  const fp=footprint(s,{nodes:[target],dependencies:[dependency],destructive:true,aspects:['content','styles','review']});
  for(const forged of [{...fp,aspects:[]},{...fp,aspects:['styles']},{...fp,nodes:[target]},{...fp,nodes:fp.nodes.filter(n=>n!==dependency)}]){
    assert.throws(()=>evaluateWitness(s,forged),/invalid|scope/);
  }
  assert.equal(evaluateWitness(s,fp).witnessSatisfied,false);
  const original=fp.nodes.map(node=>({node,providerEvidence:evidenceAt(s,s.nodes[node].evidence.path)}));
  assert.equal(evaluateWitness(s,fp,{preview:previewWitness(s,fp,original)}).witnessSatisfied,true);
  assert.throws(()=>previewWitness(s,fp,original.map(r=>({...r,providerEvidence:JSON.stringify(r.providerEvidence)}))),/invalid/);
});
