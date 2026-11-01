import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialize } from '../core/docs-semantic/model.mjs';
import { evidenceAt } from '../core/docs-semantic/common.mjs';
import { findLiteral } from '../core/docs-semantic/selectors.mjs';
import { footprint,previewWitness,narrowWitness,evaluateWitness,namedStyleFootprint } from '../core/docs-semantic/coverage.mjs';
const f=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/snapshot-vector.json',import.meta.url)));
const binding={snapshotId:'snapshot',subject:'subject',account:'writer@example.test',threadId:'thread',documentId:'doc-a',view:'inline',retrievedAt:0};
const make=()=>materialize({document:f.document,metadata:f.metadata,binding,reviewIncluded:true});
const scope={tabs:{ids:['tab-a']},segments:[{kind:'body'}]};
const delivery=(s,fp)=>({snapshotId:s.binding.snapshotId,evidenceDigest:s.evidenceDigest,view:s.binding.view,nodes:fp.nodes,aspects:fp.aspects});
test('materialization, exact delivery and complete original preview are independent evidence',()=>{
  const s=make(),node=Object.values(s.nodes).find(n=>n.text==='Old ').parent,fp=footprint(s,{nodes:[node],aspects:['content','styles','review'],destructive:true});
  assert.equal(evaluateWitness(s,fp).witnessSatisfied,false);
  assert.equal(evaluateWitness(s,fp,{deliveries:[delivery(s,fp)]}).witnessSatisfied,true);
  const records=fp.nodes.map(id=>({node:id,providerEvidence:evidenceAt(s,s.nodes[id].evidence.path)}));
  const preview=previewWitness(s,fp,records),result=evaluateWitness(s,fp,{preview});
  assert.equal(result.witnessSatisfied,true);assert.equal(result.editReady,false);assert.equal(result.authoringAuthority,'notEstablished');
  assert.throws(()=>previewWitness(s,fp,records.slice(1)),/scope/);
  assert.throws(()=>evaluateWitness(s,fp,{preview:{...preview,originalRecords:records.map((r,i)=>i? r:{...r,providerEvidence:{changed:true}})}}),/conflict/);
});
test('sibling content, wrong-view and wrong-snapshot deliveries cannot authorize a footprint',()=>{
  const s=make(),a=Object.values(s.nodes).find(n=>n.text==='Old '),b=Object.values(s.nodes).find(n=>n.text==='Sibling\n');
  const fp=footprint(s,{nodes:[a.id],aspects:['content','styles']}),other=footprint(s,{nodes:[b.id],aspects:['content','styles']});
  assert.equal(evaluateWitness(s,fp,{deliveries:[delivery(s,other)]}).witnessSatisfied,false);
  for(const changed of [{snapshotId:'other'},{view:'acceptedPreview'},{evidenceDigest:'other'}])assert.throws(()=>evaluateWitness(s,fp,{deliveries:[{...delivery(s,fp),...changed}]}),/snapshot/);
});
test('narrow preimage is exact, but future induced-effect/cardinality proof is not invented',()=>{
  const s=make(),match=findLiteral(s,scope,{literal:'Old terms'}).candidates[0],fp=footprint(s,{nodes:[match.node],dependencies:match.runs,aspects:['content','styles','review']});
  const narrow=narrowWitness(s,fp,match);assert.equal(narrow.preimage,'Old terms');
  assert.throws(()=>narrowWitness(s,fp,{...match,text:'changed'}),/conflict/);
  const result=evaluateWitness(s,fp,{narrow,deliveries:[delivery(s,fp)],effectsPreviewed:true});
  assert.equal(result.witnessSatisfied,false);assert.ok(result.missingAspects.includes('effectAndCardinalityProofNotImplemented'));assert.equal(result.editReady,false);
});
test('preview view and missing review coverage remain separate from successful delivery',()=>{
  const preview=materialize({document:{...f.document,suggestionsViewMode:'PREVIEW_SUGGESTIONS_ACCEPTED'},metadata:f.metadata,binding:{...binding,view:'acceptedPreview'},reviewIncluded:false});
  const node=Object.values(preview.nodes).find(n=>n.kind==='paragraph').id,fp=footprint(preview,{nodes:[node],aspects:['content','review']});
  const result=evaluateWitness(preview,fp,{deliveries:[delivery(preview,fp)]});assert.equal(result.witnessSatisfied,false);
  assert.deepEqual(result.missingAspects,['review','currentEditorRevision']);
});
test('named-style evidence identifies indirect usage and explicit overrides without deleting prose',()=>{
  const s=make(),result=namedStyleFootprint(s,'tab-a','NORMAL_TEXT');assert.equal(result.contentDeletion,false);assert.equal(result.usage.length,1);
  const first=result.usage[0].runs[0];assert.deepEqual(first.overrides,{bold:true});assert.equal(first.effective.fontSize.provenance,'named');
});
