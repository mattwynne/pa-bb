// Unregistered production use cases. owner comes from a verified account/thread
// boundary (as in S02), not from a tool argument. Planning owns no claims;
// linked seals project their actual state, without transport or consent decisions.
import {sealResult} from './seal-policy.mjs';
import {randomUUID} from 'node:crypto';
import {planParagraphReplace} from './planner/paragraph-replace.mjs';
import {family} from './family.mjs';
import {planParagraphBold} from './planner/paragraph-bold.mjs';
import {compileParagraphBold} from './compiler/paragraph-bold.mjs';
import {DRAFT_LIMITS,demand,strict,ownerCheck,inputCheck,reservation,draftHash,draftResult as unsealedResult,planningCategory,draftError,keyValid} from './draft-policy.mjs';
import {catalogCandidates,catalogResult,parseCatalogHandle,historicalKeyValid} from './draft-catalog.mjs';
export function createDraftService({snapshots,journal,clock=Date.now,ids=randomUUID,diagnose=()=>{},limits=DRAFT_LIMITS}){
 // Diagnostics are an external port: a failed logger must never replace the
 // original safe failure or interrupt persistence of a no-write receipt.
 function draftResult(saved,now){return saved.execution?sealResult(saved.execution):unsealedResult(saved,now);}
 function report(stage,category){try{diagnose(stage,category);}catch{ /* keep original bounded outcome */ }}
 function boundary(stage,run){try{return run();}catch(error){const code=error?.draftCode??error?.semanticCode;const category=['invalid','owner','unknown','head','sealed','request_conflict','key_conflict','capacity','budget','corrupt','unsupported','snapshot','witness','storage'].includes(code)?code:'storage';report(stage,category);throw draftError(category);}}
 function plan(owner,input){return boundary('draft_plan',()=>{
  ownerCheck(owner);inputCheck(input);const now=clock();
  // A duplicate recovers even after source/draft expiry, never replans/rekeys.
  const prior=journal.byRequest(owner,input.requestId);
  if(prior){demand(prior.record.requestHash===draftHash(input),'request_conflict');return draftResult(prior,now);}
  const candidate=reservation(owner,input,ids(),now,limits),reserved=journal.reserve(candidate);
  if(!reserved.created)return draftResult(reserved.saved,now);
  let logical;
  try{
   const snapshot=snapshots.get(input.snapshotId,owner,now);
   demand(snapshot.binding.subject===owner.subject&&snapshot.binding.threadId===owner.threadId&&snapshot.binding.account===owner.account,'owner');
   logical=(input.command.op==='paragraphReplace'?planParagraphReplace:planParagraphBold)(snapshot,input.command,{createdAt:candidate.createdAt,limits});family(logical).compile(logical);
  }catch(error){const category=planningCategory(error);report('draft_planning_rejected',category);return draftResult(journal.reject(candidate.operationId,owner,category),clock());}
  try{return draftResult(journal.publish(candidate.operationId,owner,logical,clock()),clock());}
  catch(error){
   // Publication/pin rollback leaves a recoverable reservation. Persist a
   // no-write failure if possible; a second storage failure never hides/rekeys it.
   const category=planningCategory(error);report('draft_publication_failed',category);
   try{return draftResult(journal.reject(candidate.operationId,owner,category),clock());}catch{throw draftError('storage');}
  }
 });}
 function status(owner,lookup){return boundary('draft_status',()=>{ownerCheck(owner);strict(lookup,[],['draftId','requestId']);demand(Object.keys(lookup).length===1);if(lookup.draftId)demand(keyValid(lookup.draftId));else demand(typeof lookup.requestId==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(lookup.requestId));const saved=lookup.draftId?journal.byId(owner,lookup.draftId):journal.byRequest(owner,lookup.requestId);demand(saved,'unknown');return draftResult(saved,clock());});}
 function cancel(owner,args){return boundary('draft_cancel',()=>{ownerCheck(owner);strict(args,['draftId','expectedDraftHash']);demand(keyValid(args.draftId));return draftResult(journal.cancel(args.draftId,owner,args.expectedDraftHash,clock()),clock());});}
 function operationStatus(owner,args){return boundary('draft_catalog',()=>{ownerCheck(owner);strict(args,[],['operationId','recoveryHandle']);demand(Object.keys(args).length===1);const lookup=args.recoveryHandle?parseCatalogHandle(args.recoveryHandle):{operationId:args.operationId};demand(historicalKeyValid(lookup.operationId));return catalogResult(catalogCandidates(journal.catalog(owner,lookup),owner.subject,limits));});}
 return {plan,status,cancel,operationStatus};
}
