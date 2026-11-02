// Private first-edit prerequisite: actual context + fresh full read + atomic seal.
// Deliberately no transport submit, approval decision, intent or continuation.
import {createBoldTargetContextService} from './bold-target-context.mjs';
import {checkContextDraft,checkInitialEvidence} from './target-context.mjs';
import {sealOwner,sealResult,currentBefore} from './seal-policy.mjs';
import {ownerCheck,strict,keyValid,hashValid,demand,draftError} from './draft-policy.mjs';
export function createBoldSealService({store,docs,clock=Date.now,diagnose=()=>{},guard=()=>{}}){
 const context=createBoldTargetContextService({store,docs,clock,diagnose,guard});
 async function sealOwned(owner,input,signal,dispatchOwner=null){
  let stage='seal_draft';
  try{
   ownerCheck(owner);strict(input,['operationId','planHash']);demand(keyValid(input.operationId)&&hashValid(input.planHash));signal?.throwIfAborted();
   const old=store.semanticExecutions.byId(owner,input.operationId);
   if(old){sealOwner(old.header,owner,{origin:true});demand(old.header.headHash===input.planHash,'head');return dispatchOwner?{created:false,saved:old}:sealResult(old);}
   function current(){guard();signal?.throwIfAborted();const saved=store.semanticDrafts.byId(owner,input.operationId);checkContextDraft(saved,owner,input,clock());const snapshot=store.semanticSnapshots.readPinned(saved.record.snapshotId,owner,input.operationId,clock());checkInitialEvidence(saved,snapshot);return {saved,snapshot};}
   current();stage='seal_context';const observed=await context.inspectBoldTargetContext(owner,input,signal);current();
   async function account(){const {saved}=current(),record=await store.byEmail(saved.record.account);current();demand(record?.subject===owner.subject&&record.email.toLowerCase()===saved.record.account.toLowerCase(),'owner');return record;}
   stage='seal_authority';let record=await account();current();const authority=await docs.authority(record,guard);current();demand(authority?.subject===owner.subject,'owner');record=await account();current();
   stage='seal_current_read';const before=current(),read=await (dispatchOwner?docs.readExecution(record,before.saved.plan.binding.documentId,signal,guard):docs.read(record,before.saved.plan.binding.documentId,'inline',signal,{includeReview:true}));current();record=await account();current();
   currentBefore(before.saved,before.snapshot,read);
   stage='seal_transaction';return dispatchOwner?store.semanticExecutions.sealForApply(owner,input,observed,read,clock(),dispatchOwner):sealResult(store.semanticExecutions.seal(owner,input,observed,read,clock()));
  }catch(error){
   const c=error?.draftCode??error?.contextCode??error?.semanticCode??error?.writerCode;
   const category=['invalid','unknown','owner','head','sealed','state','expired','unsupported','snapshot','corrupt','budget','capacity','conflict'].includes(c)?c:signal?.aborted?'cancelled':'storage';
   try{diagnose(stage,category);}catch{/* safe diagnostics never replace the failure */}throw draftError(category);
  }
 }
 function status(owner,input){ownerCheck(owner);strict(input,['operationId','planHash']);const saved=store.semanticExecutions.byId(owner,input.operationId);demand(saved,'unknown');demand(saved.header.headHash===input.planHash,'head');return sealResult(saved);}
 function cancel(owner,input){ownerCheck(owner);strict(input,['operationId','planHash']);return sealResult(store.semanticExecutions.cancelNotSent(owner,input));}
 return Object.freeze({sealBold:(owner,input,signal)=>sealOwned(owner,input,signal),sealForApply:(owner,input,signal,dispatchOwner)=>sealOwned(owner,input,signal,dispatchOwner),status,cancelNotSent:cancel});
}
