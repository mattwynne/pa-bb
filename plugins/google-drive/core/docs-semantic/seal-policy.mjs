// First bold seal only: no dispatch, consent decision, ACK or verification.
import {family,replyCount} from './family.mjs';
import {replacementShape} from './replacement-evidence.mjs';
import {validateRuntimeRecord,runtimeWriterMatches,runtimeResult,nextExecutionFact} from './execution-policy.mjs';
import {bytes,draftHash,immutable,strict,demand,hashValid,keyValid,ownerCheck,timeCheck,validateSaved,requireDraftEvidence} from './draft-policy.mjs';
import {checkContextDraft,checkInitialEvidence,contextObservation,contextRights,interpretLocalContext} from './target-context.mjs';
import {legacyWriterResources,writerDigest,assertWriterGrants} from './writer-coordination.mjs';
import {sameLogical} from './logical-plan.mjs';
export const SEAL_LIMITS=Object.freeze({version:1,beforeBytes:1048576,headerBytes:65536,recordBytes:4096,readbackBytes:1048576,replyBytes:16384,futureCredit:2*1048576+65536});
export function sealOwner(header,owner,{origin=false}={}){
 ownerCheck(owner);demand(header.subject===owner.subject&&header.account===owner.account&&(!origin||header.threadId===owner.threadId),'owner');
}
export function sealResources(saved,context){
 const b=saved.plan.binding;
 demand(context?.kind===family(saved.plan).contextKind&&context.binding?.operationId===saved.record.operationId&&context.binding.headHash===saved.record.headHash,'head');
 for(const k of ['subject','account','threadId','snapshotId','documentId'])demand(context.binding[k]===b[k],'owner');
 demand(sameLogical(context.binding.initialRevision,b.revision)&&context.binding.initialEvidenceDigest===b.evidenceDigest,'corrupt');
 demand(context.ancestry?.status==='observed'&&context.ancestry.boundary?.kind==='myDriveRoot','unsupported');
 const observations=context.observations;demand(Array.isArray(observations)&&observations.length>=2&&observations.length<=31,'budget');
 const seen=new Set();
 observations.forEach((o,i)=>{
  contextObservation({document:o.metadata,responseDigest:o.responseDigest,responseBytes:o.responseBytes},i===0?b.documentId:o.metadata.id,{folder:i!==0});
  demand(!seen.has(o.metadata.id),'corrupt');seen.add(o.metadata.id);
  if(i<observations.length-1)demand(o.metadata.parents?.length===1&&o.metadata.parents[0]===observations[i+1].metadata.id,'corrupt');
  else demand(o.metadata.id===context.ancestry.boundary.id&&o.responseDigest===context.ancestry.boundary.responseDigest&&(!o.metadata.parents||o.metadata.parents.length===0),'corrupt');
 });
 return contextRights(b.documentId,observations.map(o=>o.metadata));
}
export function currentBefore(saved,snapshot,read){
 checkInitialEvidence(saved,snapshot);
 demand(read?.reviewIncluded===true&&read.document?.documentId===saved.plan.binding.documentId&&read.document.revisionId===saved.plan.binding.revision.id,'snapshot');
 demand(sameLogical(read.document,snapshot.evidence),'snapshot');
 demand(hashValid(read.responseDigest)&&Number.isSafeInteger(read.responseBytes)&&read.responseBytes>0&&read.responseBytes<=SEAL_LIMITS.beforeBytes,'budget');
}
// Birth/result obligations are deliberately NOT the role conflict matrix. Copy
// source/common destination stability is compatible; its unresolved RESULT is not.
export function knownResultObligations(raw,resourceIds){
 const wanted=new Set(resourceIds),obligations=[];
 for(const row of raw.owners){const r=JSON.parse(row.record);if(r.disposition==='held')for(const id of [r.createdId,...r.observedIds].filter(Boolean))if(wanted.has(id))obligations.push({kind:'modernHeldResult',ownerDigest:writerDigest([row.namespace,row.key]),id});}
 for(const row of raw.legacy){
  legacyWriterResources(row); // decode/version/C-B1 validation precedes lifecycle filtering
  const p=JSON.parse(row.receipt);let result=null,complete=false;
  if(row.namespace==='docs_creations'){
   const kind=p.kind??'document';result=kind==='document'?p.documentId:kind==='spreadsheet'?p.spreadsheetId:p.fileId;
   complete=p.outcome==='verified';
   if(kind==='copy')complete=complete&&p.acknowledged===true;
   if(kind==='upload')complete=complete&&p.acknowledged===true&&p.claimState==='verified';
   if(p.sharedVersion===1)complete=complete&&p.claimState==='verified'&&p.createAcknowledged===true&&p.populateAcknowledged===true;
  }else if(row.namespace==='drive_filing_operations'&&p.kind==='folder'){result=p.fileId;complete=row.state==='verified';}
  if(result&&wanted.has(result)&&!complete)obligations.push({kind:'legacyUnresolvedResult',ownerDigest:writerDigest([row.namespace,row.key]),id:result});
 }
 return obligations;
}
export function admitSeal({saved,owner,input,context,snapshot,read,raw,now}){
 checkContextDraft(saved,owner,input,now);checkInitialEvidence(saved,snapshot);currentBefore(saved,snapshot,read);
 demand(bytes(snapshot)<=SEAL_LIMITS.beforeBytes&&bytes(snapshot.evidence)<=SEAL_LIMITS.beforeBytes,'budget');
 const resources=sealResources(saved,context),local=interpretLocalContext(raw,resources,context.observations);
 demand(local.blockers.length===0,'conflict');
 demand(knownResultObligations(raw,resources.map(r=>r.id)).length===0,'conflict');
 demand(local.origins.every(o=>o.kind==='unmarked'||o.kind==='historicalMarker'),'conflict');
 const r=saved.record,b=saved.plan.binding;
 const header={version:1,operationId:r.operationId,headHash:r.headHash,subject:r.subject,account:r.account,threadId:r.threadId,createdAt:now,deadline:r.expiresAt,kind:saved.plan.kind,capabilityVersion:saved.plan.capabilityVersion,...(saved.plan.kind==='paragraphReplace'?{programShape:replacementShape(saved.plan.effect)}:{}),documentId:b.documentId,initialRevision:b.revision,
  before:{snapshotId:r.snapshotId,evidenceDigest:b.evidenceDigest,modelDigest:draftHash(snapshot),rawBytes:bytes(snapshot.evidence),modelBytes:bytes(snapshot)},
  resources,contextDigest:draftHash(context),localCaptureDigest:raw.digest,currentReadDigest:read.responseDigest,origin:'unresolved',originPolicy:'ordinary-existing-local-exclusion/1',futureCredit:SEAL_LIMITS.futureCredit};
 validateSealHeader(header);
 const record={version:1,operationId:r.operationId,headHash:r.headHash,headerDigest:draftHash(header),status:'sealed',claim:'held',approvalIntent:'pending',stage:{stageId:family(header).stageId,submission:'not_sent',intentPersisted:false,verification:'not_run'}};
 return immutable({header,record});
}
export function validateSealHeader(h){
 strict(h,['version','operationId','headHash','subject','account','threadId','createdAt','deadline','kind','capabilityVersion','documentId','initialRevision','before','resources','contextDigest','localCaptureDigest','currentReadDigest','origin','originPolicy','futureCredit',...(h.kind==='paragraphReplace'?['programShape']:[])]);
 demand(h.version===1&&keyValid(h.operationId)&&hashValid(h.headHash),'corrupt');family(h);replyCount(h);
 ownerCheck({subject:h.subject,account:h.account,threadId:h.threadId});timeCheck(h.createdAt);timeCheck(h.deadline);demand(h.createdAt<h.deadline,'corrupt');
 demand(h.initialRevision?.kind==='docs'&&h.initialRevision.subject===h.subject&&typeof h.initialRevision.id==='string'&&h.initialRevision.id.length>0,'corrupt');
 strict(h.before,['snapshotId','evidenceDigest','modelDigest','rawBytes','modelBytes']);
 demand(hashValid(h.before.evidenceDigest)&&hashValid(h.before.modelDigest)&&[h.before.rawBytes,h.before.modelBytes].every(n=>Number.isSafeInteger(n)&&n>0&&n<=SEAL_LIMITS.beforeBytes),'corrupt');
 for(const k of ['contextDigest','localCaptureDigest','currentReadDigest'])demand(hashValid(h[k]),'corrupt');
 const rights=contextRights(h.documentId,h.resources.filter(r=>r.role==='accessStable').map(r=>({id:r.id})));
 demand(sameLogical(rights,h.resources)&&h.origin==='unresolved'&&h.originPolicy==='ordinary-existing-local-exclusion/1'&&h.futureCredit===SEAL_LIMITS.futureCredit,'corrupt');
 demand(bytes(h)<=SEAL_LIMITS.headerBytes,'budget');return h;
}
export function validateSeal(saved){
 const {header:h,record:r}=saved;validateSealHeader(h);
 if(r.version===2){validateRuntimeRecord(h,r);return saved;}
 strict(r,['version','operationId','headHash','headerDigest','status','claim','approvalIntent','stage']);
 demand(r.version===1&&r.operationId===h.operationId&&r.headHash===h.headHash&&r.headerDigest===draftHash(h),'corrupt');
 demand(['sealed','cancelled'].includes(r.status)&&r.claim===(r.status==='sealed'?'held':'released')&&r.approvalIntent==='pending','corrupt');
 strict(r.stage,['stageId','submission','intentPersisted','verification']);demand(r.stage.stageId===family(h).stageId&&r.stage.submission==='not_sent'&&r.stage.intentPersisted===false&&r.stage.verification==='not_run','corrupt');
 demand(bytes(r)<=SEAL_LIMITS.recordBytes,'budget');return saved;
}
export function checkSealLineage(seal,draft,snapshot){
 validateSeal(seal);demand(draft,'corrupt');validateSaved(draft);requireDraftEvidence(draft.plan,snapshot);
 const h=seal.header,r=draft.record,b=draft.plan.binding;
 demand(h.kind===draft.plan.kind&&h.capabilityVersion===draft.plan.capabilityVersion&&(h.kind!=='paragraphReplace'||sameLogical(h.programShape,replacementShape(draft.plan.effect))),'corrupt');
 demand(r.state==='draft'&&r.operationId===h.operationId&&r.headHash===h.headHash&&r.subject===h.subject&&r.account===h.account&&r.threadId===h.threadId&&r.expiresAt===h.deadline,'corrupt');
 demand(b.documentId===h.documentId&&b.snapshotId===h.before.snapshotId&&sameLogical(b.revision,h.initialRevision)&&b.evidenceDigest===h.before.evidenceDigest,'corrupt');
}
export function semanticClaimOperation(header,op,resources){
 validateSealHeader(header);strict(op,['operationId','subject','documentId','contextIds','semanticHeaderDigest']);
 demand(op.operationId===header.operationId&&op.subject===header.subject&&op.documentId===header.documentId&&op.semanticHeaderDigest===draftHash(header)&&sameLogical(resources,header.resources),'unsupported');
 return {operationId:header.operationId,subject:header.subject,documentId:header.documentId,contextIds:header.resources.filter(g=>g.role==='accessStable').map(g=>g.id),semanticHeaderDigest:draftHash(header)};
}
export function checkSealCoordinator(saved,writer){
 validateSeal(saved);const {header:h,record:r}=saved;
 demand(writer&&writer.namespace==='semantic'&&writer.operationId===h.operationId&&writer.subject===h.subject&&writer.semanticHeaderDigest===draftHash(h)&&writer.disposition===(r.claim==='held'?'held':'released'),'corrupt');
 if(r.version===2)runtimeWriterMatches(h,r,writer);else demand(writer.submission==='not_sent'&&writer.phase===(r.claim==='held'?'claimed':'not_sent'),'corrupt');
 assertWriterGrants(r.claim==='held'?h.resources.map(g=>({...g,grantKind:'grant'})):[],writer.grants);
}
export function checkSealAccount(saved,owner,account){
 demand(account?.subject===owner.subject&&typeof account.email==='string'&&account.email.toLowerCase()===saved.record.account.toLowerCase(),'owner');
}
export function cancelNotSent(saved,owner,writer){
 validateSeal(saved);sealOwner(saved.header,owner,{origin:true});checkSealCoordinator(saved,writer);
 demand(writer.intentStage===null&&writer.acknowledgement===null&&writer.createdId===null&&writer.observedIds.length===0,'conflict');
 demand(saved.record.stage.submission==='not_sent'&&!saved.record.stage.intentPersisted&&saved.record.stage.verification==='not_run','conflict');
 return immutable({...saved,record:saved.record.version===2?nextExecutionFact(saved.header,saved.record,{kind:'notSent',reason:'cancelled'}):{...saved.record,status:'cancelled',claim:'released'}});
}
export function preparedSemanticCancellation(saved,owner,writer){
 validateSeal(saved);sealOwner(saved.header,owner,{origin:true});
 demand((saved.record.version===2?saved.record.status==='not_submitted'&&!saved.record.stage.intentPersisted:saved.record.status==='cancelled')&&saved.record.claim==='released'&&writer.phase==='claimed'&&writer.submission==='not_sent'&&writer.intentStage===null&&writer.acknowledgement===null&&writer.createdId===null&&writer.observedIds.length===0,'conflict');
}
export function sealResult(saved){
 validateSeal(saved);const {header:h,record:r}=saved;
 if(r.version===2)return runtimeResult(saved);
 return immutable({operationId:h.operationId,draftId:h.operationId,draftHash:h.headHash,state:r.status,submission:r.stage.submission,claim:r.claim,stage:r.stage,approval:'intent_pending',approvalIntent:r.approvalIntent,execution:'sealedNoDispatcher',origin:'unresolved',beforeEvidence:{snapshotId:h.before.snapshotId,modelDigest:h.before.modelDigest,evidenceDigest:h.before.evidenceDigest,retained:true},thisCall:{providerMutationCount:0},retrySafe:false});
}
export function executionReference(header,rowBinding){
 validateSealHeader(header);return {version:1,operationId:header.operationId,subject:header.subject,account:header.account,threadId:header.threadId,headHash:header.headHash,snapshotId:header.before.snapshotId,modelDigest:header.before.modelDigest,evidenceDigest:header.before.evidenceDigest,rowBinding,futureCredit:header.futureCredit};
}
export function checkExecutionReference(ref,header,snapshot,rowBinding){
 demand(sameLogical(ref,executionReference(header,rowBinding))&&draftHash(snapshot)===header.before.modelDigest&&snapshot.evidenceDigest===header.before.evidenceDigest,'corrupt');
 const b=snapshot.binding;demand(b.subject===header.subject&&b.account===header.account&&b.threadId===header.threadId&&b.documentId===header.documentId&&b.snapshotId===header.before.snapshotId&&b.view==='inline'&&sameLogical(snapshot.revision,header.initialRevision),'corrupt');
}
