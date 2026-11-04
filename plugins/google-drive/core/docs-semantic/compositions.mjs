// Actual K2 new/extend/combine use cases. No claims, provider or UI decisions here.
import {randomUUID} from 'node:crypto';
import {familyInput,combineInput,compositionReservation} from './composition-policy.mjs';
import {planParagraphComposition,closedParts,closedProvenance,commandProvenance} from './planner/paragraph-composition.mjs';
import {compileParagraphComposition} from './compiler/paragraph-composition.mjs';
import {compositionResult} from './composition-lineage.mjs';
import {admitCompositionCard} from './composition-consent.mjs';
import {ownerCheck,strict,demand,draftHash,draftError,planningCategory,keyValid,hashValid,requireDraftEvidence} from './draft-policy.mjs';
import {sameLogical} from './logical-plan.mjs';
import {sealResult} from './seal-policy.mjs';
export function createCompositionService({snapshots,journal,clock=Date.now,ids=randomUUID,diagnose=()=>{}}){
 function boundary(stage,run){try{return run();}catch(error){const code=error?.draftCode??error?.semanticCode,category=['invalid','unsupported','owner','snapshot','head','sealed','unknown','request_conflict','key_conflict','conflict','budget','capacity','corrupt','storage'].includes(code)?code:'storage';try{diagnose(stage,category);}catch{}throw draftError(category);}}
 function replay(prior,initial){demand(prior.record.requestHash===draftHash(initial),'request_conflict');return prior.initialResult??compositionResult(prior);}
 function live(saved,owner,expected,now){demand(saved,'unknown');const r=saved.record;demand(r.subject===owner.subject&&r.account===owner.account&&r.threadId===owner.threadId,'owner');demand(!saved.execution&&r.state==='draft','sealed');demand(r.headHash===expected,'head');demand(now<r.expiresAt,'snapshot');return saved;}
 function checked(record,plan,snapshot){compileParagraphComposition(plan);admitCompositionCard(record,plan,snapshot);return plan;}
 function plan(owner,input,kind){return boundary('plan',()=>{
  ownerCheck(owner);const commands=familyInput(input,kind);demand(input.account===owner.account,'owner');const initial={family:kind,request:input},now=clock();
  if(input.draft.kind==='extend'){
   const d=input.draft,saved=live(journal.byId(owner,d.draftId),owner,d.expectedDraftHash,now);demand(saved.record.version===2&&saved.plan.kind==='paragraphComposition','unsupported');
   // New coverage requires the original ordinary snapshot still be live. An old
   // retained pin is evidence, NOT renewed target-planning authority.
   const snapshot=snapshots.get(saved.record.snapshotId,owner,now);requireDraftEvidence(saved.plan,snapshot);
   const next=checked(saved.record,planParagraphComposition(snapshot,[...saved.plan.parts.map(p=>p.command),...commands],{origin:saved.plan.origin,extensions:[...saved.plan.extensions,initial],provenance:[...saved.plan.parts.map(p=>p.provenance),...commandProvenance(d.draftId,initial,'extend',d.expectedDraftHash)],anchor:saved.record.lifetimeAnchor,existing:closedParts(saved)}),snapshot);
   return compositionResult(journal.extendComposition(d.draftId,owner,d.expectedDraftHash,next,clock()));
  }
  const prior=journal.byRequest(owner,input.draft.requestId);if(prior)return replay(prior,initial);
  const candidate=compositionReservation(owner,initial,ids(),now,input.draft.destination.snapshotId),reserved=journal.reserve(candidate);if(!reserved.created)return replay(reserved.saved,initial);
  try{const snapshot=snapshots.get(candidate.snapshotId,owner,now);demand(snapshot.binding.account===owner.account&&snapshot.binding.subject===owner.subject&&snapshot.binding.threadId===owner.threadId,'owner');const logical=checked(candidate,planParagraphComposition(snapshot,commands,{origin:{draftId:candidate.operationId,initial},provenance:commandProvenance(candidate.operationId,initial),anchor:now}),snapshot);const saved=journal.publish(candidate.operationId,owner,logical,clock());return saved.initialResult;}
  catch(error){const category=planningCategory(error);try{diagnose('planning_rejected',category);}catch{}return journal.reject(candidate.operationId,owner,category).initialResult;}
 });}
 function combine(owner,input){return boundary('combine',()=>{
  ownerCheck(owner);combineInput(input);demand(input.account===owner.account,'owner');const initial={family:'combine',request:input},prior=journal.byRequest(owner,input.requestId);if(prior)return replay(prior,initial); // BEFORE self-superseded input checks
  const now=clock(),sources=input.inputs.map(x=>live(journal.byId(owner,x.draftId),owner,x.expectedDraftHash,now)),first=sources[0];
  demand(sources.every(s=>sameLogical(s.plan.binding,first.plan.binding)&&s.plan.mode==='direct'),'conflict');
  const snapshot=snapshots.readPinned(first.record.snapshotId,owner,first.record.operationId,now);for(const s of sources)requireDraftEvidence(s.plan,snapshot);
  const anchor=Math.min(...sources.map(s=>s.record.expiresAt))-1800000,candidate=compositionReservation(owner,initial,ids(),now,first.record.snapshotId,anchor),commands=sources.flatMap(s=>closedParts(s).map(p=>p.command)),provenance=sources.flatMap((s,i)=>closedProvenance(s).map((v,index)=>[...v,{kind:'combine',draftId:input.inputs[i].draftId,headHash:input.inputs[i].expectedDraftHash,commandIndex:index,requestHash:draftHash(initial)}]));
  const logical=checked(candidate,planParagraphComposition(snapshot,commands,{origin:{draftId:candidate.operationId,initial},provenance,anchor,existing:sources.flatMap(closedParts)}),snapshot);
  // No eager reservation. Failed planning/admission/transaction has NO residue.
  return journal.combineComposition(candidate,owner,input.inputs,logical,clock()).initialResult;
 });}
 function status(owner,input){return boundary('status',()=>{ownerCheck(owner);strict(input,[],['draftId','requestId']);demand(Object.keys(input).length===1);if(input.draftId)demand(keyValid(input.draftId));else demand(typeof input.requestId==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(input.requestId));const saved=input.draftId?journal.byId(owner,input.draftId):journal.byRequest(owner,input.requestId);demand(saved&&saved.record.account===owner.account,'unknown');return saved.execution?sealResult(saved.execution):compositionResult(saved);});}
 function cancel(owner,input){return boundary('cancel',()=>{ownerCheck(owner);strict(input,['draftId','expectedDraftHash']);demand(keyValid(input.draftId)&&hashValid(input.expectedDraftHash));return compositionResult(journal.cancel(input.draftId,owner,input.expectedDraftHash,clock()));});}
 return Object.freeze({plan,combine,status,cancel});
}
