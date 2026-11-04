// Internal no-write draft lifecycle. No provider/BB/database dependencies.
import {createHash} from 'node:crypto';
import {boundedTree,LIMITS,freeze} from './common.mjs';
import {replacementCommand} from './replacement-evidence.mjs';
import {assertLogicalPlan} from './logical-plan.mjs';
import {validateCompositionRecord,validateSupersededRecord,completedCompositionRecord} from './composition-policy.mjs';
// Versioned conservative local admission bounds, not provider limits. No eviction.
export const DRAFT_LIMITS=Object.freeze({version:1,records:1024,totalBytes:8*1024*1024,recordBytes:65536,planBytes:65536,draftMs:1800000,catalogBytes:4*1024*1024});
export const draftError=code=>Object.assign(new Error(`Semantic draft ${code}`),{draftCode:code});
export function demand(condition,code='invalid'){if(!condition)throw draftError(code);}
export function strict(value,required,optional=[]){demand(value&&typeof value==='object'&&!Array.isArray(value));demand(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
export const keyValid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export const hashValid=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
export const bytes=x=>Buffer.byteLength(JSON.stringify(x));
function sorted(x){if(Array.isArray(x))return x.map(sorted);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])]));return x;}
export const draftHash=x=>createHash('sha256').update(JSON.stringify(sorted(x))).digest('hex');
export const immutable=x=>freeze(structuredClone(x));
export function ownerCheck(owner){strict(owner,['subject','account','threadId']);for(const v of Object.values(owner))demand(typeof v==='string'&&v.length>0&&v.length<=320&&v.isWellFormed());}
export function inputCheck(input){strict(input,['requestId','snapshotId','mode','command']);demand(typeof input.requestId==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(input.requestId));demand(typeof input.snapshotId==='string'&&input.snapshotId.length>0&&input.snapshotId.length<=128);demand(input.mode==='direct');if(input.command?.op==='paragraphReplace'){replacementCommand(input.command);return;}strict(input.command,['op','node','bold']);demand(input.command.op==='paragraphBold'&&typeof input.command.node==='string'&&input.command.node.length>0&&input.command.node.length<=512&&typeof input.command.bold==='boolean');}
export function timeCheck(now){demand(Number.isSafeInteger(now)&&now>=0);}
export function checkLimits(limits){demand(limits.version===1,'unsupported');for(const k of ['records','totalBytes','recordBytes','planBytes','draftMs','catalogBytes'])demand(Number.isSafeInteger(limits[k])&&limits[k]>0&&limits[k]<=DRAFT_LIMITS[k],'budget');demand(limits.draftMs===DRAFT_LIMITS.draftMs,'budget');}
export function admit(usage,delta,count,limits=DRAFT_LIMITS){checkLimits(limits);demand(usage.records+count<=limits.records&&usage.bytes+delta<=limits.totalBytes,'capacity');}
export function boundedPlan(plan,limits=DRAFT_LIMITS){boundedTree(plan,{...LIMITS,providerBytes:limits.planBytes,nodes:20000,depth:64});demand(bytes(plan)<=limits.planBytes,'budget');}
export function validateRecord(record,limits=DRAFT_LIMITS){
 if(record?.version===2)return validateCompositionRecord(record,limits);
 if(record?.version===3)return validateSupersededRecord(record,limits);
 strict(record,['version','operationId','subject','account','threadId','requestId','requestHash','snapshotId','createdAt','expiresAt','state','headHash','error','cancelledAt']);
 demand(record.version===1,'unsupported');demand(keyValid(record.operationId)&&hashValid(record.requestHash),'corrupt');ownerCheck({subject:record.subject,account:record.account,threadId:record.threadId});timeCheck(record.createdAt);timeCheck(record.expiresAt);demand(record.expiresAt===record.createdAt+limits.draftMs,'corrupt');demand(typeof record.requestId==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(record.requestId),'corrupt');demand(typeof record.snapshotId==='string'&&record.snapshotId.length>0&&record.snapshotId.length<=128,'corrupt');
 demand(['planning','draft','rejected','cancelled'].includes(record.state),'corrupt');demand(record.headHash===null||hashValid(record.headHash),'corrupt');demand(['draft','cancelled'].includes(record.state)?hashValid(record.headHash):record.headHash===null,'corrupt');
 demand(record.state==='rejected'?['invalid','unsupported','snapshot','owner','witness','budget','capacity','corrupt','storage'].includes(record.error):record.error===null,'corrupt');demand(record.state==='cancelled'?Number.isSafeInteger(record.cancelledAt)&&record.cancelledAt>=record.createdAt:record.cancelledAt===null,'corrupt');demand(bytes(record)<=limits.recordBytes,'budget');return record;
}
export function reservation(owner,input,operationId,now,limits=DRAFT_LIMITS){ownerCheck(owner);inputCheck(input);timeCheck(now);checkLimits(limits);return validateRecord({version:1,operationId,...owner,requestId:input.requestId,requestHash:draftHash(input),snapshotId:input.snapshotId,createdAt:now,expiresAt:now+limits.draftMs,state:'planning',headHash:null,error:null,cancelledAt:null},limits);}
export function validateReservation(record,limits=DRAFT_LIMITS){validateRecord(record,limits);demand(record.state==='planning'&&record.headHash===null&&record.error===null&&record.cancelledAt===null,'corrupt');return record;}
export function sameRequest(record,candidate){demand(record.subject===candidate.subject&&record.threadId===candidate.threadId&&record.requestId===candidate.requestId,'corrupt');demand(record.requestHash===candidate.requestHash,'request_conflict');}
export function completedRecord(record,plan,limits=DRAFT_LIMITS){
 validateRecord(record,limits);demand(record.state==='planning','head');boundedPlan(plan,limits);assertLogicalPlan(plan,{record});
 if(record.version===2)return completedCompositionRecord(record,plan);
 const {integrity,...body}=plan;demand(integrity===draftHash(body)&&plan.lifecycle?.createdAt===record.createdAt&&plan.lifecycle.expiresAt===record.expiresAt&&plan.lifecycle.budgets?.version===limits.version,'corrupt');
 const request={requestId:record.requestId,snapshotId:record.snapshotId,mode:plan.mode,command:plan.command};inputCheck(request);demand(draftHash(request)===record.requestHash,'corrupt');
 return validateRecord({...record,state:'draft',headHash:draftHash(plan)},limits);
}
export function requireDraftOwner(record,owner){ownerCheck(owner);demand(record.subject===owner.subject&&record.threadId===owner.threadId,'owner');}
export function publicationRecord(record,owner,plan,now,limits=DRAFT_LIMITS){
 requireDraftOwner(record,owner);timeCheck(now);demand(now<record.expiresAt,'snapshot');
 const next=completedRecord(record,plan,limits);
 demand(plan.binding.snapshotId===record.snapshotId&&plan.binding.subject===record.subject&&plan.binding.threadId===record.threadId&&plan.binding.account===record.account,'corrupt');return next;
}
export function requireDraftEvidence(plan,snapshot){assertLogicalPlan(plan,{snapshot});}
export function rejectedRecord(record,owner,category,limits=DRAFT_LIMITS){requireDraftOwner(record,owner);validateRecord(record,limits);demand(record.state==='planning','head');return validateRecord({...record,state:'rejected',error:category},limits);}
export function cancelRecord(record,owner,expected,now,limits=DRAFT_LIMITS){validateRecord(record,limits);ownerCheck(owner);timeCheck(now);demand(record.subject===owner.subject&&record.threadId===owner.threadId,'owner');demand(record.headHash===expected&&hashValid(expected),'head');demand(record.state==='draft'||record.state==='cancelled','head');return record.state==='cancelled'?record:validateRecord({...record,state:'cancelled',cancelledAt:now},limits);}
export function validateSaved({record,plan},limits=DRAFT_LIMITS){validateRecord(record,limits);if(record.headHash){demand(plan&&draftHash(plan)===record.headHash,'corrupt');boundedPlan(plan,limits);assertLogicalPlan(plan,{record});}else demand(plan===null,'corrupt');return {record,plan};}
export function draftResult(saved,now){const {record:r,plan}=validateSaved(saved);timeCheck(now);return immutable({draftId:r.operationId,operationId:r.operationId,requestId:r.requestId,state:r.state,draftHash:r.headHash,createdAt:r.createdAt,expiresAt:r.expiresAt,expired:now>=r.expiresAt,error:r.error,submission:'not_sent',claim:'none',thisCall:{providerMutationCount:0},proposal:plan,execution:'notImplemented',authoringAuthority:'notEstablished',approval:'notRequested',retrySafe:false});}
export function planningCategory(error){
 const code=error?.draftCode??error?.semanticCode;
 if(['invalid','unsupported','snapshot','owner','witness','budget','capacity','corrupt','storage'].includes(code))return code;
 if(['scalar','extent','scope','unavailable','denied','conflict'].includes(code))return 'unsupported';
 return code==='head'?'corrupt':'storage';
}
