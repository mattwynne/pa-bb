import test from 'node:test';
import assert from 'node:assert/strict';
import {materialize} from '../core/docs-semantic/model.mjs';
import {validatedReadModel} from '../core/docs-semantic/selectors.mjs';
import {freeze} from '../core/docs-semantic/common.mjs';
import {planParagraphBold} from '../core/docs-semantic/planner/paragraph-bold.mjs';
import {compileParagraphBold} from '../core/docs-semantic/compiler/paragraph-bold.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
import {validDraftDocument,draftBinding} from './docs-semantic-draft-fixtures.mjs';
const model=()=>materialize({document:validDraftDocument(),metadata:{id:draftBinding.documentId},binding:draftBinding,reviewIncluded:true});
test('immutable validation reuses only a fully independently checked model',()=>{
 const source=model(),checked=validatedReadModel(source);assert.equal(validatedReadModel(source),checked);assert.equal(validatedReadModel(checked),checked);
 const forged=structuredClone(source);Object.values(forged.nodes).find(n=>n.kind==='paragraph').extent.end++;freeze(forged);assert.throws(()=>validatedReadModel(forged),e=>e.semanticCode==='corrupt');
});
test('mutable and shallow-frozen snapshots revalidate after nested graph corruption',()=>{
 for(const shallow of [false,true]){
  const source=structuredClone(model());if(shallow)Object.freeze(source);validatedReadModel(source);
  Object.values(source.nodes).find(n=>n.kind==='text').text='forged';assert.throws(()=>validatedReadModel(source),e=>e.semanticCode==='corrupt');
 }
});
test('model reuse cannot alias plan binding and target witness revisions',()=>{
 const source=model(),node=Object.values(source.nodes).find(n=>n.kind==='paragraph').id;
 const plan=structuredClone(planParagraphBold(source,{op:'paragraphBold',node,bold:true}));
 plan.effect.target.binding.revision.id='forged';
 assert.equal(plan.binding.revision.id,'r1');
 const {integrity,...body}=plan;plan.integrity=draftHash(body);
 assert.throws(()=>compileParagraphBold(plan),/corrupt/);
});
test('frozen accessor objects are not cached as immutable data',()=>{
 const original=model();let nodes=original.nodes;const source={...original};Object.defineProperty(source,'nodes',{get:()=>nodes,enumerable:true});Object.freeze(source);validatedReadModel(source);
 nodes=structuredClone(nodes);Object.values(nodes).find(n=>n.kind==='paragraph').children=[];assert.throws(()=>validatedReadModel(source),e=>e.semanticCode==='corrupt');
});
