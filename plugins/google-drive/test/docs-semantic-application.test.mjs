import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureCases} from '../features/docs/support/fixture-cases.mjs';
import { applicationFamily,executeApplication,compareApplication } from '../features/docs/coverage/application-execution.mjs';
import { createMemorySnapshots } from '../features/docs/support/memory-snapshots.mjs';
import { snapshotContractCases } from '../features/docs/support/snapshot-contract.mjs';
const cases=fixtureCases('c003','c005','c006','c007','c008','c010','c011','c012','c013','c015');
assert.ok(cases.every(({record})=>applicationFamily(record)));
for(const [name,run]of Object.entries(snapshotContractCases()))test(`fast snapshot substitute contract: ${name}`,()=>run(createMemorySnapshots().port));
for(const {record,fixture} of cases)test(`actual application + independent oracle ${record.caseId}`,async()=>{
  const trace=await executeApplication(record,fixture);
  assert.ok(compareApplication(record,fixture,trace));
  // Direct counterfeit/omission controls replace per-rule package copies. The
  // positive above executes actual core answers, never a canned semantic result.
  assert.throws(()=>compareApplication(record,fixture,{...trace,boundary:{...trace.boundary,layer:'native'}}),/fixed application boundary/);
  assert.throws(()=>compareApplication(record,fixture,{...trace,events:trace.events.slice(1)}),/exact application instruction/);
  const i=trace.events.findIndex(e=>e.instruction.expect==='inspect'),event=trace.events[i],events=[...trace.events];events[i]={...event,result:{...event.result,coverage:{...event.result.coverage,readProof:true}}};
  assert.throws(()=>compareApplication(record,fixture,{...trace,events}),/independent complete inspection envelope/);
  function corrupt(index,change,reason){const events=[...trace.events],result=structuredClone(events[index].result);change(result);events[index]={...events[index],result};assert.throws(()=>compareApplication(record,fixture,{...trace,events}),reason);}
  if(record.outcomeVariant==='success'){
    for(const key of ['materialized','delivered','missingReviewCoverage'])corrupt(i,r=>{r.coverage[key]='counterfeit';},/independent complete inspection envelope/);
    const get=trace.events.findIndex(e=>e.instruction.op==='get'&&e.result);
    corrupt(get,r=>{r.revision.id='counterfeit';},/independent exact original revision/);
    if(fixture.expected.tabs)corrupt(get,r=>{r.tabs[0].title='counterfeit';},/independent authored tab inventory/);
    if(['C003','C008','C010','C011','C012','C013','C015'].includes(record.ledgerId))corrupt(get,r=>{r.unresolvedExtents=!r.unresolvedExtents;},/independent .*extent fact/);
    const last=trace.events.findLastIndex(e=>e.instruction.op==='state');corrupt(last,r=>{r.work.push({snapshot:'snap-d',id:'unexpected',bytes:1});},/exact logical publication\/cursor\/pin\/work transition/);
    const cursor=trace.events.findIndex(e=>e.instruction.op==='state'&&e.result.cursors.length);if(cursor>=0)corrupt(cursor,r=>{r.cursors[0].state.request.format='counterfeit';},/exact logical publication/);
  }
  if(record.outcomeVariant==='bounds'){
    const charged=trace.events.findIndex(e=>e.instruction.op==='state'&&e.result.work.length);if(charged>=0)corrupt(charged,r=>{r.work=[];r.deliveries.push({id:'fabricated',snapshot:'snap-d',data:{}});},/exact logical publication/);
  }
});
