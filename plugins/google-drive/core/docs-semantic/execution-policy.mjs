// Closed one-stage EDIT facts. No transport, host, database or approved input.
import {strict,demand,draftHash,bytes,immutable,keyValid,hashValid} from './draft-policy.mjs';
import {sameLogical} from './logical-plan.mjs';
import {compareParagraphBold} from './verification/paragraph-bold.mjs';
export const STAGE_LIMITS=Object.freeze({events:16,eventBytes:4096,recordBytes:4096,replyBytes:16384,afterBytes:1048576});
export function initialExecutionRecord(h){return {version:1,operationId:h.operationId,headHash:h.headHash,headerDigest:draftHash(h),status:'sealed',claim:'held',approvalIntent:'pending',stage:{stageId:'bold-1',submission:'not_sent',intentPersisted:false,verification:'not_run'}};}
export function validateRuntimeRecord(h,r){
 strict(r,['version','operationId','headHash','headerDigest','status','claim','approvalIntent','stage','dispatchOwner','consent','programHash','wireHash','response','reply','after','reason']);
 demand(r.version===2&&r.operationId===h.operationId&&r.headHash===h.headHash&&r.headerDigest===draftHash(h)&&keyValid(r.dispatchOwner),'corrupt');
 demand(['reviewing','not_submitted','uncertain','rejected','verified'].includes(r.status)&&['held','released'].includes(r.claim)&&['pending','recorded'].includes(r.approvalIntent),'corrupt');
 strict(r.stage,['stageId','submission','intentPersisted','verification']);const s=r.stage;
 demand(s.stageId==='bold-1'&&['not_sent','unknown','acknowledged','rejected'].includes(s.submission)&&typeof s.intentPersisted==='boolean'&&['not_run','matched','mismatch','unavailable'].includes(s.verification),'corrupt');
 demand(s.submission==='not_sent'||s.intentPersisted,'corrupt');demand(s.verification==='not_run'||s.submission==='acknowledged','corrupt');
 demand(r.claim==='released'?['not_submitted','rejected','verified'].includes(r.status):!['not_submitted','rejected','verified'].includes(r.status),'corrupt');
 demand(r.status!=='verified'||s.submission==='acknowledged'&&s.verification==='matched'&&r.after!==null&&r.response?.saveAcceptable===true,'corrupt');
 demand(r.status!=='not_submitted'||s.submission==='not_sent','corrupt');demand(r.status!=='rejected'||s.submission==='rejected','corrupt');
 if(r.consent!==null){strict(r.consent,['kind','payloadHash','deadline']);demand(['owner_approved','standing_content_consent'].includes(r.consent.kind)&&hashValid(r.consent.payloadHash)&&Number.isSafeInteger(r.consent.deadline)&&r.consent.deadline<=h.deadline,'corrupt');}
 for(const k of ['programHash','wireHash'])demand(r[k]===null||hashValid(r[k]),'corrupt');
 if(s.intentPersisted)demand(r.consent&&r.programHash&&r.wireHash,'corrupt');
 for(const k of ['reply','after'])if(r[k]!==null){strict(r[k],['digest','bytes']);demand(hashValid(r[k].digest)&&Number.isSafeInteger(r[k].bytes)&&r[k].bytes>0&&r[k].bytes<=(k==='reply'?STAGE_LIMITS.replyBytes+256:STAGE_LIMITS.afterBytes),'corrupt');}
 demand(s.submission==='acknowledged'?r.response?.kind==='acknowledged'&&r.reply!==null:s.submission==='rejected'?r.response?.kind==='rejected'&&r.reply!==null:r.response===null,'corrupt');
 demand(r.reason===null||['declined','cancelled','expired','authority_changed','preflight','veto','transport','reply_invalid','after_unavailable','mismatch','save_unresolved'].includes(r.reason),'corrupt');
 demand(bytes(r)<=STAGE_LIMITS.recordBytes,'budget');return r;
}
export function responseFact(header,envelope){
 strict(envelope,['status','body']);demand(Number.isInteger(envelope.status)&&envelope.status>=100&&envelope.status<=599,'corrupt');
 if([400,401,403,404].includes(envelope.status))return {kind:'rejected',httpStatus:envelope.status};
 if(envelope.status!==200)return null;
 const b=envelope.body;
 if(!b||b.documentId!==header.documentId||!Array.isArray(b.replies)||b.replies.length!==1||typeof b.writeControl?.requiredRevisionId!=='string'||!b.writeControl.requiredRevisionId||b.writeControl.requiredRevisionId.length>2048)return null;
 const save=Object.hasOwn(b,'commentUpdateState')?b.commentUpdateState:'ABSENT';
 const reply=b.replies[0];if(!reply||typeof reply!=='object'||Array.isArray(reply))return null;
 const unexpectedReply=Object.keys(reply).length!==0,unexpectedControl=Object.keys(b).some(k=>!['documentId','replies','writeControl','commentUpdateState','suggestionResponses'].includes(k))||Object.keys(b.writeControl).some(k=>!['requiredRevisionId','writeMode'].includes(k))||Object.hasOwn(b.writeControl,'writeMode')&&b.writeControl.writeMode!=='EDIT';
 const unexpectedSuggestions=Object.hasOwn(b,'suggestionResponses')&&(!Array.isArray(b.suggestionResponses)||b.suggestionResponses.length!==0);
 return {kind:'acknowledged',documentId:b.documentId,revisionId:b.writeControl.requiredRevisionId,replyDigest:draftHash(b),save:typeof save==='string'&&['ABSENT','ALL_SAVED','NO_UPDATES_REQUESTED','ALL_FAILED_UNKNOWN_REASON','UNSPECIFIED'].includes(save)?save:'UNKNOWN',saveAcceptable:!unexpectedControl&&!unexpectedReply&&!unexpectedSuggestions&&['ABSENT','ALL_SAVED','NO_UPDATES_REQUESTED'].includes(save),unexpectedSuggestions,unexpectedReply,unexpectedControl};
}
export function nextExecutionFact(header,old,e){
 demand(e&&typeof e==='object'&&bytes(e)<=STAGE_LIMITS.eventBytes,'budget');
 if(e.kind==='activation'){
  strict(e,['kind','dispatchOwner']);demand(old.version===1&&old.status==='sealed'&&keyValid(e.dispatchOwner),'conflict');
  return immutable(validateRuntimeRecord(header,{...old,version:2,status:'reviewing',dispatchOwner:e.dispatchOwner,consent:null,programHash:null,wireHash:null,response:null,reply:null,after:null,reason:null}));
 }
 validateRuntimeRecord(header,old);demand(old.claim==='held','conflict');const r=structuredClone(old),s=r.stage;
 if(e.kind==='consent'){
  strict(e,['kind','consent']);demand(s.submission==='not_sent'&&!s.intentPersisted&&r.consent===null,'conflict');r.consent=e.consent;r.approvalIntent='recorded';
 }else if(e.kind==='intent'){
  strict(e,['kind','programHash','wireHash','now']);demand(s.submission==='not_sent'&&!s.intentPersisted&&r.consent&&e.now<r.consent.deadline&&e.now<header.deadline,'conflict');r.programHash=e.programHash;r.wireHash=e.wireHash;s.submission='unknown';s.intentPersisted=true;r.status='uncertain';
 }else if(e.kind==='notSent'){
  strict(e,['kind','reason']);demand(s.submission==='not_sent'&&!s.intentPersisted||e.reason==='veto'&&s.submission==='unknown','conflict');s.submission='not_sent';r.status='not_submitted';r.claim='released';r.reason=e.reason;
 }else if(e.kind==='response'){
  strict(e,['kind','response','reply']);demand(s.submission==='unknown'&&s.intentPersisted,'conflict');r.response=e.response;r.reply=e.reply;
  demand(e.response?.kind==='acknowledged'||e.response?.kind==='rejected','corrupt');s.submission=e.response.kind;
  if(s.submission==='rejected'){r.status='rejected';r.claim='released';}else r.reason=e.response.saveAcceptable?null:'save_unresolved';
 }else if(e.kind==='unattributed'){
  strict(e,['kind','reply']);demand(s.submission==='unknown'&&s.intentPersisted,'conflict');r.reply=e.reply;r.reason='reply_invalid';
 }else if(e.kind==='verification'){
  strict(e,['kind','verification','after']);demand(s.submission==='acknowledged'&&['matched','mismatch','unavailable'].includes(e.verification),'conflict');s.verification=e.verification;r.after=e.after;
  if(e.verification==='matched'&&r.response.saveAcceptable){r.status='verified';r.claim='released';r.reason=null;}else{r.status='uncertain';r.reason=e.verification==='unavailable'?'after_unavailable':'mismatch';}
 }else if(e.kind==='unavailable'){
  strict(e,['kind','reason']);demand(s.submission==='unknown'||s.submission==='acknowledged','conflict');r.reason=e.reason;r.status='uncertain';
 }else demand(false,'unsupported');
 return immutable(validateRuntimeRecord(header,r));
}
export function replayExecutionFacts(header,rows){
 demand(Array.isArray(rows)&&rows.length<=STAGE_LIMITS.events,'corrupt');let r=initialExecutionRecord(header);
 for(const [index,row]of rows.entries()){demand(row.sequence===index+1&&typeof row.event==='string'&&Buffer.byteLength(row.event)<=STAGE_LIMITS.eventBytes,'corrupt');let e;try{e=JSON.parse(row.event);}catch{demand(false,'corrupt');}demand(draftHash(e)===row.digest,'corrupt');r=nextExecutionFact(header,r,e);}
 return r;
}
export function runtimeWriterMatches(header,r,w){
 validateRuntimeRecord(header,r);demand(w&&w.namespace==='semantic'&&w.operationId===header.operationId&&w.subject===header.subject&&w.semanticHeaderDigest===draftHash(header)&&w.disposition===(r.claim==='held'?'held':'released'),'corrupt');
 const expected=r.stage.submission==='acknowledged'?(r.status==='verified'?'verified':'acknowledged'):r.stage.submission==='unknown'?'intent':r.stage.submission==='rejected'?'rejected':r.claim==='released'?'not_sent':'claimed';
 demand(w.phase===expected&&w.submission===r.stage.submission,'corrupt');
 if(r.response?.kind==='acknowledged')demand(w.acknowledgement?.documentId===r.response.documentId&&w.acknowledgement.revisionId===r.response.revisionId&&w.acknowledgement.replyDigest===r.response.replyDigest,'corrupt');
}
export function authorizeSemanticWriterEvent(r,owner,event){
 demand(r.version===2&&r.dispatchOwner===owner,'owner');
 if(event.kind==='intent')demand(r.stage.submission==='unknown'&&r.stage.intentPersisted&&event.stage==='content','conflict');
 else if(event.kind==='ack')demand(r.stage.submission==='acknowledged'&&event.documentId===r.response.documentId&&event.revisionId===r.response.revisionId&&event.replyDigest===r.response.replyDigest,'conflict');
 else if(event.kind==='verified')demand(r.status==='verified'&&r.claim==='released'&&r.stage.verification==='matched','conflict');
 else if(event.kind==='knownNotSent')demand(r.status==='not_submitted'&&r.claim==='released'&&r.stage.submission==='not_sent','conflict');
 else if(event.kind==='rejected')demand(r.status==='rejected'&&r.claim==='released'&&event.httpStatus===r.response.httpStatus,'conflict');
 else demand(false,'unsupported');
}
export function verificationFact(header,r,plan,before,after){
 demand(r.stage.submission==='acknowledged','conflict');
 if(after?.documentId!==header.documentId||after?.revisionId!==r.response.revisionId)return 'mismatch';
 return compareParagraphBold({plan,before,after}).matched&&r.response.saveAcceptable?'matched':'mismatch';
}
export function validateRuntimeEvidence(header,r,plan,before,reply,after){
 validateRuntimeRecord(header,r);
 if(r.reply)demand(reply&&sameLogical(responseFact(header,reply),r.response)&&draftHash(reply)===r.reply.digest&&bytes(reply)===r.reply.bytes,'corrupt');
 if(r.after)demand(after&&draftHash(after)===r.after.digest&&bytes(after)===r.after.bytes&&verificationFact(header,r,plan,before,after)===r.stage.verification,'corrupt');
}
export function runtimeResult(saved,mutationCount=0,observation){
 const {header:h,record:r}=saved;validateRuntimeRecord(h,r);
 return immutable({operationId:h.operationId,draftId:h.operationId,draftHash:h.headHash,state:r.status,submission:r.stage.submission,claim:r.claim,stage:r.stage,approval:r.consent?.kind??'intent_pending',execution:'nativeBold-v1',response:r.response,reason:r.reason,thisCall:{providerMutationCount:mutationCount},retrySafe:false,...observation?{observation}:{}});
}
