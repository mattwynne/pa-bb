import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateRequest, writablePath, discoveryDigest} from '../features/docs/coverage/wire.mjs';
import {wireProbe} from '../features/docs/coverage/wire-probes.mjs';
import {WireSimulator} from '../features/docs/support/wire-simulator.mjs';
const fixture = name => JSON.parse(readFileSync(new URL(`../features/docs/coverage/fixtures/${name}.json`,import.meta.url)));
for(const name of ['bold','namedStyle','namedStyleClear','pageSize','tableWidth','sectionGap','date','border','resetBold']) test(`independent valid wire vector: ${name}`,()=>{
  const v=wireProbe(name);assert.doesNotThrow(()=>validateRequest(v.request,v.effects));
});
for(const name of ['boldString','namedStyleMissingMasks','namedStyleImplicitClear','documentSize','dimensionString','dimensionZero','dimensionUnit','nestedPath','columnWidth','outputHeader','outputSectionWidth','outputDate','outputEnum','partialBorder','partialBorderMask','undeclaredReset','wildcard','rootMask','unmaskedValue','unsupportedValidator','arrayType']) test(`invalid wire vector rejected: ${name}`,()=>{
  const v=wireProbe(name);assert.throws(()=>validateRequest(v.request,v.effects));
});
test('independent provider schema pin and writable paths reject output-only fields',()=>{
  assert.equal(discoveryDigest,'3948e9385816c87782b0548c577a39d240336015d2f4e63e1f40bac835f81741');
  assert.equal(writablePath('updateSectionStyle','columnProperties.paddingEnd.magnitude').type,'number');
  assert.throws(()=>writablePath('updateDocumentStyle','documentId'));
});
test('dimensional nonfinite, negative, output enum and nested reset cases fail closed',()=>{
  for(const n of [NaN,Infinity,-1]){const v=wireProbe('pageSize');v.request.updateDocumentStyle.documentStyle.pageSize.width.magnitude=n;assert.throws(()=>validateRequest(v.request));}
  const v=wireProbe('tableWidth');v.request.updateTableColumnProperties.tableColumnProperties.width.magnitude=4;assert.throws(()=>validateRequest(v.request),/minimum/);
  const reset={updateTextStyle:{range:{tabId:'tab-a',startIndex:1,endIndex:6},textStyle:{},fields:'fontSize.magnitude'}};
  // A partial Dimension reset is not a typed complete dimension contract.
  assert.throws(()=>validateRequest(reset,{reset:['fontSize.magnitude']}),/dimension reset/);
});
for(const kind of ['format','replace'])test(`independent before/request/after simulator contract: ${kind}`,()=>{
  const v=fixture('legacy-vectors'),s=new WireSimulator(v.before),original=structuredClone(v.before);
  v[kind].request.requests.forEach(r=>validateRequest(r));const reply=s.submit(v[kind].request);
  assert.deepEqual(s.document,v[kind].after);assert.deepEqual(v.before,original);
  assert.equal(reply.writeControl.requiredRevisionId,'rev-b');assert.equal('verified' in reply,false);
});
test('simulator preserves hand-authored Unicode, unrelated text, paragraph style and link witnesses',()=>{
  const v=fixture('preservation'),s=new WireSimulator(v.before);v.request.requests.forEach(r=>validateRequest(r));s.submit(v.request);assert.deepEqual(s.document,v.after);
});
test('simulator refuses stale revisions/unsupported structure atomically rather than inventing success',()=>{
  const v=fixture('legacy-vectors'),s=new WireSimulator(v.before),r=structuredClone(v.format.request);r.writeControl.requiredRevisionId='other';
  assert.throws(()=>s.submit(r),/revision/);assert.deepEqual(s.document,v.before);
  const bad=structuredClone(v.format.request);bad.requests.push({insertTable:{rows:1,columns:1}});
  assert.throws(()=>s.submit(bad),/unsupported/);assert.deepEqual(s.document,v.before);
  const source=readFileSync(new URL('../features/docs/support/wire-simulator.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/import.*(?:core\/|planner|compiler|verifier)/);
});
