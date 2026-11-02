// Contract substitute only: logical atomicity/immutability, no crash/durability,
// physical SQLite accounting, native registration or provider observations.
import {DRAFT_LIMITS,checkLimits,demand,draftHash,bytes,immutable,validateReservation,validateSaved,sameRequest,publicationRecord,requireDraftEvidence,rejectedRecord,cancelRecord,admit} from '../../../core/docs-semantic/draft-policy.mjs';
export function createMemoryDraftJournal({snapshots,limits=DRAFT_LIMITS}){
 checkLimits(limits);
 const rows=new Map(),plans=new Map();
 const usage=()=>({records:rows.size,bytes:[...rows.values()].reduce((n,r)=>n+bytes(r),0)+[...plans.values()].reduce((n,p)=>n+bytes(p),0)});
 const saved=r=>r?immutable(validateSaved({record:r,plan:r.headHash?plans.get(r.operationId):null},limits)):null;
 const owned=(id,o)=>{const r=rows.get(id);demand(r?.subject===o.subject,'unknown');return saved(r);};
 return {
  byRequest(o,id){return saved([...rows.values()].find(r=>r.subject===o.subject&&r.threadId===o.threadId&&r.requestId===id));},
  byId(o,id){return rows.get(id)?.subject===o.subject?saved(rows.get(id)):null;},
  reserve(candidate){validateReservation(candidate,limits);const old=[...rows.values()].find(r=>r.subject===candidate.subject&&r.threadId===candidate.threadId&&r.requestId===candidate.requestId);if(old){sameRequest(old,candidate);return {created:false,saved:saved(old)};}demand(!rows.has(candidate.operationId),'key_conflict');admit(usage(),bytes(candidate),1,limits);const copy=immutable(candidate);rows.set(copy.operationId,copy);return {created:true,saved:saved(copy)};},
  publish(id,o,plan,now){const {record:r}=owned(id,o),next=publicationRecord(r,o,plan,now,limits);admit(usage(),bytes(next)-bytes(r)+bytes(plan),0,limits);const s=snapshots.get(r.snapshotId,o,now);requireDraftEvidence(plan,s);const copy=immutable(next),p=immutable(plan);snapshots.pin(r.snapshotId,o,id,now,r.expiresAt);rows.set(id,copy);plans.set(id,p);return saved(copy);},
  reject(id,o,category){const {record:r}=owned(id,o),next=rejectedRecord(r,o,category,limits);admit(usage(),bytes(next)-bytes(r),0,limits);rows.set(id,immutable(next));return saved(next);},
  cancel(id,o,expected,now){const {record:r}=owned(id,o),next=cancelRecord(r,o,expected,now,limits);admit(usage(),bytes(next)-bytes(r),0,limits);rows.set(id,immutable(next));return saved(next);},
  catalog(o,{operationId,namespace}){const r=rows.get(operationId);if(r?.subject!==o.subject||namespace&&namespace!=='semantic')return [];const value=saved(r);return [{namespace:'semantic',operationId,subject:r.subject,state:null,receipt:JSON.stringify(value.record),plan:value.plan}];},
 };
}
