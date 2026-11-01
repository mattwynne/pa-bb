import test from 'node:test';
import assert from 'node:assert/strict';
import * as coverage from '../core/docs-semantic/coverage.mjs';
import { SemanticWorld, semanticAccount, semanticScope } from '../features/docs/support/semantic-world.mjs';

import { documentVector, node, styleRequest, literalRequest, broadRequest } from '../features/docs/support/witness-c-vectors.mjs';
import { createReadEvidenceService } from '../core/docs-semantic/read-evidence-service.mjs';
async function withModel(run) {
  const world=new SemanticWorld();world.document=documentVector();await world.init();
  try {const result=await world.inspect();const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
    const model=world.store.semanticSnapshots.get(result.snapshotId,owner,0);await run(model,world,owner);
  } finally {await world.close();}
}
test('C narrow resolved evidence enumerates exact preimage, context and source UTF-16 without whole prose delivery',async()=>withModel(s=>{
  const result=coverage.resolveTargetEvidence(s,{scope:semanticScope,selector:{text:{literal:'Old 😀',cardinality:{exactly:1}}}});
  assert.equal(result.enumeration,'complete');assert.equal(result.count,1);
  assert.deepEqual(result.matches.map(m=>({node:m.node,text:m.text,context:m.context,extent:m.extent,runs:m.runs})),[
    {node:node(s,4),text:'Old 😀',context:'Old 😀 terms\n',extent:{start:7,end:13},runs:[node(s,5)]}]);
  assert.equal(result.binding.revision.id,'r1');assert.equal(result.authoringAuthority,'notEstablished');assert.equal(result.editReady,false);
}));
test('C caller-derived omission cannot certify a target even when raw evidence digest is unchanged',async()=>withModel(s=>{
  const forged=structuredClone(s);delete forged.nodes[node(s,4)];
  assert.throws(()=>coverage.resolveTargetEvidence(forged,{scope:semanticScope,selector:{text:{literal:'Old'}}}),/corrupt/);
}));
test('C exact effect comparison supports metadata style and refuses a hidden effect',async()=>withModel(s=>{
  const request=styleRequest(s);
  const facts=coverage.inspectEffectEvidence(s,{scope:request.scope,selector:request.selector,effect:request.effect});
  assert.deepEqual(facts.changes,[{node:node(s,5),property:'bold',before:false,after:true,provenance:'direct',source:null}]);
  assert.deepEqual(facts.footprint.nodes,[node(s,5),node(s,4)]);
  const {presentation}=request;
  assert.deepEqual(facts.target,presentation.target);assert.deepEqual(facts.dependencies,presentation.dependencies);
  const result=coverage.compareReadEvidence(s,request);
  assert.equal(result.witnessSatisfied,true);assert.equal(result.delivered,'effectPreview');assert.equal(result.editReady,false);
  assert.equal(coverage.evaluateWitness(s,facts.footprint,{effectWitness:request}).witnessSatisfied,true);
  assert.equal(coverage.compareReadEvidence(s,{...request,presentation:{...presentation,changes:[]}}).witnessSatisfied,false);
}));
