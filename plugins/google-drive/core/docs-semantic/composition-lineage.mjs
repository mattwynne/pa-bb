// Validate immutable ancestry against ACTUAL retained revisions, not self-reported hashes.
import {assertCompositionPlan,scalarParts} from './composition-plan.mjs';
import {familyInput} from './composition-policy.mjs';
import {closedParts,closedProvenance,commandProvenance} from './planner/paragraph-composition.mjs';
import {demand,draftHash,validateSaved,immutable} from './draft-policy.mjs';
import {sameLogical} from './logical-plan.mjs';
const intention=p=>{const {integrity,lifecycle,...body}=p;return body;};
export function validateCompositionLineage(plan,readRevision){
 assertCompositionPlan(plan);const expanded=scalarParts(plan);let commands=[],provenance=[];const origin=plan.origin.initial;
 if(origin.family==='combine'){
  const sources=origin.request.inputs.map(x=>readRevision(x.draftId,x.expectedDraftHash));demand(sources.every(Boolean),'corrupt');
  demand(plan.lifecycle.expiresAt===Math.min(...sources.map(s=>s.record.expiresAt)),'corrupt');
  for(const [i,s]of sources.entries()){
   demand(sameLogical(plan.binding,s.plan.binding)&&s.plan.mode==='direct','corrupt');const part=closedParts(s),prior=closedProvenance(s),ref=origin.request.inputs[i];
   demand(sameLogical(expanded.slice(commands.length,commands.length+part.length).map(intention),part.map(intention)),'corrupt');
   commands.push(...part.map(x=>x.command));provenance.push(...prior.map((v,index)=>[...v,{kind:'combine',draftId:ref.draftId,headHash:ref.expectedDraftHash,commandIndex:index,requestHash:draftHash(origin)}]));
  }
 }else{commands=familyInput(origin.request,origin.family);provenance=commandProvenance(plan.origin.draftId,origin);}
 for(const [i,e]of plan.extensions.entries()){
  const prior=readRevision(plan.origin.draftId,e.request.draft.expectedDraftHash);demand(prior?.plan.kind==='paragraphComposition'&&sameLogical(prior.plan.binding,plan.binding)&&sameLogical(prior.plan.origin,plan.origin)&&sameLogical(prior.plan.extensions,plan.extensions.slice(0,i)),'corrupt');demand(sameLogical(prior.plan.parts.map(x=>x.command),commands)&&sameLogical(prior.plan.parts.map(x=>x.provenance),provenance)&&sameLogical(expanded.slice(0,commands.length).map(intention),scalarParts(prior.plan).map(intention)),'corrupt');
  commands.push(...familyInput(e.request,e.family));provenance.push(...commandProvenance(plan.origin.draftId,e,'extend',e.request.draft.expectedDraftHash));
 }
 demand(sameLogical(plan.parts.map(x=>x.command),commands)&&sameLogical(plan.parts.map(x=>x.provenance),provenance),'corrupt');return plan;
}
export function compositionResult(saved){const {record:r,plan}=validateSaved(saved);return immutable({draftId:r.operationId,operationId:r.operationId,draftHash:r.headHash,state:r.state,bindings:plan?[plan.binding]:[],exports:{},proposal:plan,expiresAt:new Date(r.expiresAt).toISOString(),nextAction:r.state==='draft'?'extend_or_apply':'inspect',...(r.error?{error:r.error}:{})});}
export function initialResultArtifact(record,plan){const result=compositionResult({record,plan}),value={version:1,kind:'compositionPlanningResult',requestHash:record.requestHash,result};return {result,value,hash:draftHash(value)};}
