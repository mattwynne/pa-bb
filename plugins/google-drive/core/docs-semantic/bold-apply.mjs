// The first actual native bold pipeline. Unregistered; input is intent identity only.
import {randomUUID} from 'node:crypto';
import {ownerCheck,strict,demand,keyValid,hashValid,draftError,draftHash} from './draft-policy.mjs';
import {createBoldSealService} from './bold-seal.mjs';
import {createBoldTargetContextService} from './bold-target-context.mjs';
import {sealResult,sealOwner,checkSealLineage,currentBefore} from './seal-policy.mjs';
import {family} from './family.mjs';
import {replacementConsentPayload} from './replacement-consent.mjs';
import {runtimeResult} from './execution-policy.mjs';
import {boldConsentPayload,boldApprovalDecision} from './bold-consent.mjs';
export function createBoldApplyService({store,docs,batch,authority,review,clock=Date.now,ids=randomUUID,diagnose=()=>{},checkpoint=()=>{}}){
 const active=new Map();
 function inputCheck(owner,input){ownerCheck(owner);strict(input,['operationId','planHash']);demand(keyValid(input.operationId)&&hashValid(input.planHash));}
 function result(saved,count=0,observation){return saved.record.version===2?runtimeResult(saved,count,observation):sealResult(saved);}
 function status(owner,input){inputCheck(owner,input);const s=store.semanticExecutions.byId(owner,input.operationId);demand(s&&s.header.headHash===input.planHash,'unknown');return result(s);}
 async function apply(owner,input,signal){
  inputCheck(owner,input);const existing=store.semanticExecutions.byId(owner,input.operationId);if(existing){sealOwner(existing.header,owner,{origin:true});demand(existing.header.headHash===input.planHash,'head');return result(existing);}
  const prior=active.get(input.operationId);if(prior){demand(prior.subject===owner.subject&&prior.threadId===owner.threadId&&prior.account===owner.account&&prior.planHash===input.planHash,'owner');return {operationId:input.operationId,state:'preparing',claim:'none',submission:'not_sent',thisCall:{providerMutationCount:0},retrySafe:false};}
  let finish;const finished=new Promise(resolve=>{finish=resolve;});
  const dispatchOwner=ids(),token=authority.capture(),cap={...owner,planHash:input.planHash,dispatchOwner,invoked:false,finished};active.set(input.operationId,cap);
  let stage='seal',created=false,mutations=0,storeCapability=null;
  const local=()=>{authority.check(token);signal?.throwIfAborted();demand(active.get(input.operationId)===cap,'owner');};
  const loaded=()=>{local();const s=store.semanticExecutions.byId(owner,input.operationId);demand(s&&s.record.version===2&&s.record.dispatchOwner===dispatchOwner&&s.header.headHash===input.planHash&&s.record.claim==='held'&&clock()<s.header.deadline,'head');return s;};
  const report=category=>{try{diagnose(stage,category);}catch{/* retain original facts */}};
  try{
   local();const sealing=createBoldSealService({store,docs,clock,diagnose,guard:local});
   const sealed=await sealing.sealForApply(owner,input,signal,dispatchOwner);
   if(!sealed.created)return result(sealed.saved);created=true;storeCapability=sealed.capability;demand(storeCapability,'owner');loaded();
   const before=store.semanticExecutions.evidence(owner,input),original=store.semanticDrafts.byId(owner,input.operationId);checkSealLineage(sealed.saved,original,before);
   stage='policy';const approvalRequired=await authority.readPolicy();loaded();
   const deadline=Math.min(clock()+600000,sealed.saved.header.deadline);
   const profile=family(original.plan),consent=(profile.kind==='paragraphReplace'?replacementConsentPayload:boldConsentPayload)(sealed.saved,original.plan,before,deadline);
   if(approvalRequired){
    stage='approval';const remaining=deadline-clock();demand(remaining>0,'snapshot');const raw=await review(consent.payload,remaining,signal,owner.threadId,profile.kind);loaded();
    const decision=boldApprovalDecision(raw);
    if(decision.outcome!=='approved')return result(store.semanticExecutions.recordNotSent(owner,input,storeCapability,decision.outcome==='declined'?'declined':'cancelled'));
    demand(clock()<deadline,'snapshot');
   }
   store.semanticExecutions.recordConsent(owner,input,storeCapability,{kind:approvalRequired?'owner_approved':'standing_content_consent',payloadHash:consent.payloadHash,deadline});
   const contextService=createBoldTargetContextService({store,docs,clock,diagnose,guard:()=>{loaded();}});
   stage='context';const context=await contextService.inspectExecutionTargetContext(owner,input,signal);loaded();
   async function account(){loaded();const record=await store.byEmail(sealed.saved.header.account);loaded();demand(record?.subject===owner.subject,'owner');return record;}
   stage='authority';let record=await account();loaded();await docs.authority(record,()=>{loaded();});loaded();record=await account();loaded();
   stage='current_read';const currentRead=await docs.readExecution(record,sealed.saved.header.documentId,signal,()=>{loaded();});loaded();record=await account();loaded();currentBefore(original,before,currentRead);
   stage='prepare';const compiled=profile.compile(original.plan),prepared=await batch.prepare(record,sealed.saved.header.documentId,compiled,signal,()=>{loaded();});loaded();
   stage='final_policy';const policyNow=await authority.readPolicy();loaded();demand(policyNow===approvalRequired,'owner');record=await account();loaded();
   stage='intent';store.semanticExecutions.persistIntent(owner,input,storeCapability,context,currentRead,prepared.programHash,prepared.wireHash,clock());
   // Technical checkpoints are synchronous; never await here. Tests can kill a
   // real process or queue a microtask without replacing dispatch semantics.
   checkpoint('afterIntent');
   try{local();store.semanticExecutions.dispatchGate(owner,input,storeCapability,context,prepared.programHash,prepared.wireHash,clock());}
   catch{return result(store.semanticExecutions.recordNotSent(owner,input,storeCapability,'veto'));}
   stage='dispatch';cap.invoked=true;mutations=1;
   let envelope;
   try{envelope=await prepared.dispatchOnce();}catch{report('transport');return result(store.semanticExecutions.recordUnavailable(owner,input,storeCapability,'transport'),mutations);}
   // Never check signal/account/epochs before saving an attributable response.
   stage='response';checkpoint('beforeResponseCommit');
   let saved;
   try{saved=store.semanticExecutions.recordResponse(owner,input,storeCapability,envelope);}catch{report('response_storage');return result(store.semanticExecutions.byId(owner,input.operationId),mutations);}
   checkpoint('afterResponseCommit');
   if(saved.record.stage.submission!=='acknowledged'||!saved.record.response.saveAcceptable){report(saved.record.stage.submission==='rejected'?'provider_rejected':saved.record.stage.submission==='unknown'?'reply_invalid':'save_unresolved');return result(saved,mutations);}
   stage='readback';
   if(signal?.aborted||authority.disposed())return result(store.semanticExecutions.recordVerification(owner,input,storeCapability,null),mutations);
   try{
    const readToken=authority.capture(),readGuard=()=>{authority.check(readToken);signal?.throwIfAborted();};readGuard();
    record=await store.byEmail(saved.header.account);readGuard();demand(record?.subject===saved.header.subject,'owner');
    const after=await docs.readExecution(record,saved.header.documentId,signal,readGuard);readGuard();
    stage='verification';checkpoint('beforeVerificationCommit');saved=store.semanticExecutions.recordVerification(owner,input,storeCapability,after);if(saved.record.stage.verification!=='matched')report('mismatch');
   }catch{report(stage==='verification'?'verification_unavailable':'after_unavailable');saved=store.semanticExecutions.recordVerification(owner,input,storeCapability,null);}
   return result(saved,mutations);
  }catch(error){
   const category=['owner','snapshot','head','conflict','budget','capacity','corrupt'].includes(error?.draftCode)?error.draftCode:signal?.aborted?'cancelled':'preflight';report(category);
   if(created&&!cap.invoked){
    try{const s=store.semanticExecutions.byId(owner,input.operationId);if(s.record.status==='not_submitted')return result(s);if(s.record.stage.submission==='not_sent'&&!s.record.stage.intentPersisted)return result(store.semanticExecutions.recordNotSent(owner,input,storeCapability,clock()>=s.header.deadline?'expired':signal?.aborted?'cancelled':'preflight'));return result(s);}
    catch{throw draftError('storage');}
   }
   if(created)return result(store.semanticExecutions.byId(owner,input.operationId),mutations);
   throw draftError(category);
  }finally{if(storeCapability)store.semanticExecutions.closeCapability(storeCapability);if(active.get(input.operationId)===cap)active.delete(input.operationId);finish();}
 }
 async function observe(owner,input,signal){
  inputCheck(owner,input);const saved=store.semanticExecutions.byId(owner,input.operationId);demand(saved&&saved.header.headHash===input.planHash,'unknown');
  let observation={kind:'unavailable'};
  try{const record=await store.byEmail(saved.header.account);demand(record?.subject===saved.header.subject,'owner');const raw=await docs.readExecution(record,saved.header.documentId,signal),before=store.semanticExecutions.evidence(owner,input),plan=store.semanticDrafts.byId(owner,input.operationId).plan;observation={kind:family(plan).compare({plan,before,after:raw.document}).matched?'observed_matching':'observed_mismatch',attribution:'notEstablished'};}catch{try{diagnose('observe','after_unavailable');}catch{/* diagnostic cannot change facts */}/* no mutation, ACK or release from observation */}
  return result(saved,0,observation);
 }
 return Object.freeze({apply,status,observe,drain:()=>Promise.all([...active.values()].map(c=>c.finished))});
}
