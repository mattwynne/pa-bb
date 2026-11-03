// Purpose-specific synchronous seal/cancel operations. No provider I/O/async callback.
import {nextExecutionFact,replayExecutionFacts,responseFact,verificationFact,validateRuntimeEvidence,STAGE_LIMITS} from '../core/docs-semantic/execution-policy.mjs';
import {family} from '../core/docs-semantic/family.mjs';
import {digest} from '../core/docs-semantic/common.mjs';
import {interpretLocalContext} from '../core/docs-semantic/target-context.mjs';
import {knownResultObligations} from '../core/docs-semantic/seal-policy.mjs';
import {createDraftJournal} from './docs-draft-store.mjs';
import {draftHash,immutable,demand,bytes,strict,ownerCheck} from '../core/docs-semantic/draft-policy.mjs';
import {admitSeal,sealResources,validateSeal,sealOwner,cancelNotSent,checkSealCoordinator,checkSealAccount,checkSealLineage,SEAL_LIMITS} from '../core/docs-semantic/seal-policy.mjs';
import {markerKeysFor} from '../core/docs-semantic/target-context.mjs';
export const SEMANTIC_SEAL_MIGRATION=`
CREATE TABLE docs_semantic_execution(operation_id TEXT PRIMARY KEY,subject TEXT NOT NULL,head_hash TEXT NOT NULL,header TEXT NOT NULL,digest TEXT NOT NULL,record TEXT NOT NULL,record_digest TEXT NOT NULL);
CREATE TABLE docs_semantic_execution_refs(operation_id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,subject TEXT NOT NULL,receipt TEXT NOT NULL,digest TEXT NOT NULL,reserved_bytes INTEGER NOT NULL);
CREATE TRIGGER semantic_execution_identity_no_update BEFORE UPDATE OF operation_id,subject,head_hash,header,digest ON docs_semantic_execution BEGIN SELECT RAISE(ABORT,'Immutable semantic seal'); END;
CREATE TRIGGER semantic_execution_no_delete BEFORE DELETE ON docs_semantic_execution BEGIN SELECT RAISE(ABORT,'Retained semantic seal'); END;
CREATE TRIGGER semantic_execution_ref_no_update BEFORE UPDATE ON docs_semantic_execution_refs BEGIN SELECT RAISE(ABORT,'Immutable execution evidence'); END;
CREATE TRIGGER semantic_execution_ref_no_delete BEFORE DELETE ON docs_semantic_execution_refs BEGIN SELECT RAISE(ABORT,'Retained execution evidence'); END;
CREATE TRIGGER semantic_sealed_head_no_update BEFORE UPDATE ON docs_semantic_drafts
 WHEN EXISTS(SELECT 1 FROM docs_semantic_execution e WHERE e.operation_id=OLD.operation_id)
 BEGIN SELECT RAISE(ABORT,'Sealed semantic head'); END;
CREATE TRIGGER semantic_execution_head_guard BEFORE INSERT ON docs_semantic_execution
 WHEN NOT EXISTS(SELECT 1 FROM docs_semantic_drafts d WHERE d.operation_id=NEW.operation_id AND d.subject=NEW.subject AND json_extract(d.receipt,'$.headHash')=NEW.head_hash AND json_extract(d.receipt,'$.state')='draft')
 BEGIN SELECT RAISE(ABORT,'Semantic seal head mismatch'); END;
`;
export function createSealStore(db,{snapshots,writers,draft}){
 const originalDrafts=createDraftJournal(db,{snapshots}),capabilities=new WeakMap(),activationKey=Object.freeze({});
 function capability(owner,input,value){
  ownerCheck(owner);strict(input,['operationId','planHash']);const c=capabilities.get(value);
  demand(c&&!c.closed&&c.operationId===input.operationId&&c.headHash===input.planHash&&c.owner.subject===owner.subject&&c.owner.account===owner.account&&c.owner.threadId===owner.threadId,'owner');
  const saved=read(owner,input.operationId);demand(saved&&saved.header.headHash===input.planHash&&saved.record.dispatchOwner===c.dispatchOwner,'owner');sealOwner(saved.header,owner,{origin:true});return {c,saved};
 }
 function stageRows(id){return db.prepare('SELECT sequence,CASE WHEN length(CAST(event AS BLOB))<=4096 THEN event ELSE NULL END event,digest FROM docs_semantic_stage_events WHERE operation_id=? ORDER BY sequence LIMIT 17').all(id);}
 function append(saved,dispatchOwner,e,writerFact){
  demand(saved.record.version===2&&saved.record.dispatchOwner===dispatchOwner,'owner');
  const next=nextExecutionFact(saved.header,saved.record,e),rows=stageRows(saved.header.operationId);demand(rows.length<STAGE_LIMITS.events,'capacity');
  db.prepare('INSERT INTO docs_semantic_stage_events VALUES (?,?,?,?)').run(saved.header.operationId,rows.length+1,JSON.stringify(e),draftHash(e));
  demand(db.prepare('UPDATE docs_semantic_execution SET record=?,record_digest=? WHERE operation_id=? AND record_digest=?').run(JSON.stringify(next),draftHash(next),saved.header.operationId,draftHash(saved.record)).changes===1,'conflict');
  if(writerFact)writers.semanticStageFact(saved.header.operationId,dispatchOwner,writerFact);
 }
 function read(owner,id){
  const row=db.prepare('SELECT subject,head_hash,CASE WHEN length(CAST(header AS BLOB))<=? THEN header ELSE NULL END header,digest,CASE WHEN length(CAST(record AS BLOB))<=? THEN record ELSE NULL END record,record_digest FROM docs_semantic_execution WHERE operation_id=? AND subject=?').get(SEAL_LIMITS.headerBytes,SEAL_LIMITS.recordBytes,id,owner.subject);
  if(!row)return null;let saved;try{saved={header:JSON.parse(row.header),record:JSON.parse(row.record)};}catch{demand(false,'corrupt');}
  validateSeal(saved);const {header:h,record:r}=saved;
  demand(h.operationId===id&&h.subject===row.subject&&h.headHash===row.head_hash&&draftHash(h)===row.digest&&draftHash(r)===row.record_digest,'corrupt');
  if(owner.account!==undefined)demand(h.account===owner.account,'owner');
  checkSealCoordinator(saved,writers.get('semantic',id));
  const before=snapshots.readExecutionEvidence(h,{subject:h.subject,account:h.account,threadId:h.threadId});
  const original=originalDrafts.byId({subject:h.subject},id);checkSealLineage(saved,original,before);
  if(r.version===2){demand(draftHash(replayExecutionFacts(h,stageRows(id)))===row.record_digest,'corrupt');validateRuntimeEvidence(h,r,original.plan,before,snapshots.readStageEvidence(h,'reply'),snapshots.readStageEvidence(h,'after'));}
  return immutable(saved);
 }
 const api={
  present(owner,id){return Boolean(db.prepare('SELECT 1 FROM docs_semantic_execution WHERE operation_id=? AND subject=?').get(id,owner.subject));},
  byId(owner,id){return db.transaction(()=>read(owner,id))();},
  sealForApply(owner,input,context,currentRead,now,dispatchOwner){
   const result=api.seal(owner,input,context,currentRead,now,dispatchOwner,activationKey);
   if(!result.created)return result;
   const value=Object.freeze(Object.create(null));capabilities.set(value,{owner:{...owner},operationId:input.operationId,headHash:input.planHash,dispatchOwner,intent:false,invoked:false,closed:false});
   return {...result,capability:value};
  },
  closeCapability(value){const c=capabilities.get(value);if(c)c.closed=true;},
  seal(owner,input,context,currentRead,now,dispatchOwner=null,key=null){demand(!dispatchOwner||key===activationKey,'owner');return db.transaction(()=>{
   const prior=read(owner,input.operationId);if(prior){sealOwner(prior.header,owner,{origin:true});demand(prior.header.headHash===input.planHash,'head');return dispatchOwner?{created:false,saved:prior}:prior;}
   const saved=draft().byId(owner,input.operationId);demand(saved,'unknown');
   const r=saved.record,account=db.prepare('SELECT subject,email FROM drive_accounts WHERE email=? COLLATE NOCASE').get(r.account);
   checkSealAccount(saved,owner,account);
   const snapshot=snapshots.readPinned(r.snapshotId,owner,r.operationId,now),resources=sealResources(saved,context);
   const raw=writers.readTargetContextFacts({resourceIds:[...new Set(resources.map(r=>r.id))].sort(),markerKeys:markerKeysFor(context.observations)});
   const seal=admitSeal({saved,owner,input,context,snapshot,read:currentRead,raw,now}),h=seal.header;
   const activation=dispatchOwner?{kind:'activation',dispatchOwner}:null,record=activation?nextExecutionFact(h,seal.record,activation):seal.record;
   // Pre-admission of retained bytes/future credit before any header/rights insert.
   snapshots.checkExecutionAdmission(h,snapshot);
   const acquired=writers.acquire('semantic',{operationId:h.operationId,subject:h.subject,documentId:h.documentId,contextIds:h.resources.filter(r=>r.role==='accessStable').map(r=>r.id),semanticHeaderDigest:draftHash(h)},'content',()=>{
    db.prepare('INSERT INTO docs_semantic_execution VALUES (?,?,?,?,?,?,?)').run(h.operationId,h.subject,h.headHash,JSON.stringify(h),draftHash(h),JSON.stringify(record),draftHash(record));
    snapshots.retainExecution(h,snapshot);
    if(activation)db.prepare('INSERT INTO docs_semantic_stage_events VALUES (?,?,?,?)').run(h.operationId,1,JSON.stringify(activation),draftHash(activation));return true;
   });
   demand(acquired,'conflict');const result=read(owner,h.operationId);return dispatchOwner?{created:true,saved:result}:result;
  })();},
  cancelNotSent(owner,input){return db.transaction(()=>{
   const old=read(owner,input.operationId);demand(old,'unknown');demand(old.header.headHash===input.planHash,'head');
   if(old.record.version===2){sealOwner(old.header,owner,{origin:true});if(old.record.status==='not_submitted')return old;demand(old.record.stage.submission==='not_sent'&&!old.record.stage.intentPersisted,'conflict');append(old,old.record.dispatchOwner,{kind:'notSent',reason:'cancelled'},{kind:'knownNotSent'});return read(owner,input.operationId);}
   const next=cancelNotSent(old,owner,writers.get('semantic',input.operationId));if(old.record.status==='cancelled')return old;
   db.prepare('UPDATE docs_semantic_execution SET record=?,record_digest=? WHERE operation_id=? AND record_digest=?').run(JSON.stringify(next.record),draftHash(next.record),input.operationId,draftHash(old.record));
   writers.cancelSemantic(input.operationId,owner,draftHash(old.header));return read(owner,input.operationId);
  })();},
  recordConsent(owner,input,cap,consent){return db.transaction(()=>{const {c,saved:s}=capability(owner,input,cap);demand(!c.intent&&!c.invoked,'conflict');append(s,c.dispatchOwner,{kind:'consent',consent});return read(owner,input.operationId);})();},
  persistIntent(owner,input,cap,context,currentRead,programHash,wireHash,now){const result=db.transaction(()=>{
   const {c,saved:s}=capability(owner,input,cap),dispatchOwner=c.dispatchOwner;demand(!c.intent&&!c.invoked,'conflict');sealOwner(s.header,owner,{origin:true});demand(s.header.headHash===input.planHash&&now<s.header.deadline,'head');
   checkSealAccount({record:s.header},owner,db.prepare('SELECT subject,email FROM drive_accounts WHERE email=? COLLATE NOCASE').get(s.header.account));
   const original=originalDrafts.byId(owner,input.operationId),before=snapshots.readExecutionEvidence(s.header,owner),resources=sealResources(original,context);demand(draftHash(resources)===draftHash(s.header.resources),'conflict');
   const compiled=family(original.plan).compile(original.plan);demand(draftHash(compiled)===programHash&&digest(JSON.stringify(compiled))===wireHash,'corrupt');
   const raw=writers.readTargetContextFacts({resourceIds:[...new Set(resources.map(g=>g.id))].sort(),markerKeys:markerKeysFor(context.observations)}),local=interpretLocalContext(raw,resources,context.observations,{operationId:s.header.operationId,subject:s.header.subject,headerDigest:draftHash(s.header)});
   demand(local.blockers.length===0&&knownResultObligations(raw,resources.map(g=>g.id)).length===0&&local.origins.every(o=>o.kind==='unmarked'||o.kind==='historicalMarker'),'conflict');
   // Full current source, not Drive version or the old pin, remains unchanged.
   demand(currentRead?.subject===s.header.subject&&currentRead.document?.revisionId===s.header.initialRevision.id&&draftHash(currentRead.document)===draftHash(before.evidence),'snapshot');
   append(s,dispatchOwner,{kind:'intent',programHash,wireHash,now},{kind:'intent',stage:'content'});return read(owner,input.operationId);
  })();capabilities.get(cap).intent=true;return result;},
  dispatchGate(owner,input,cap,context,programHash,wireHash,now){const result=db.transaction(()=>{
   const {c,saved:s}=capability(owner,input,cap),dispatchOwner=c.dispatchOwner;demand(c.intent&&!c.invoked,'conflict');demand(s&&s.header.headHash===input.planHash&&s.record.dispatchOwner===dispatchOwner&&s.record.stage.submission==='unknown'&&s.record.programHash===programHash&&s.record.wireHash===wireHash&&now<s.header.deadline&&now<s.record.consent.deadline,'conflict');sealOwner(s.header,owner,{origin:true});
   checkSealAccount({record:s.header},owner,db.prepare('SELECT subject,email FROM drive_accounts WHERE email=? COLLATE NOCASE').get(s.header.account));
   const resources=s.header.resources,raw=writers.readTargetContextFacts({resourceIds:[...new Set(resources.map(g=>g.id))].sort(),markerKeys:markerKeysFor(context.observations)}),local=interpretLocalContext(raw,resources,context.observations,{operationId:s.header.operationId,subject:s.header.subject,headerDigest:draftHash(s.header)});
   demand(local.blockers.length===0&&knownResultObligations(raw,resources.map(g=>g.id)).length===0&&local.origins.every(o=>o.kind==='unmarked'||o.kind==='historicalMarker'),'conflict');return true;
  })();capabilities.get(cap).invoked=true;return result;},
  recordNotSent(owner,input,cap,reason){return db.transaction(()=>{const {c,saved:s}=capability(owner,input,cap);demand(!c.invoked&&(reason==='veto'?c.intent:!c.intent),'conflict');append(s,c.dispatchOwner,{kind:'notSent',reason},{kind:'knownNotSent'});return read(owner,input.operationId);})();},
  recordResponse(owner,input,cap,envelope){return db.transaction(()=>{
   const {c,saved:s}=capability(owner,input,cap),dispatchOwner=c.dispatchOwner;demand(c.invoked,'owner');const response=responseFact(s.header,envelope),reply=snapshots.retainStageEvidence(s.header,'reply',envelope);
   if(!response)append(s,dispatchOwner,{kind:'unattributed',reply});
   else append(s,dispatchOwner,{kind:'response',response,reply},response.kind==='acknowledged'?{kind:'ack',stage:'content',documentId:response.documentId,revisionId:response.revisionId,replyDigest:response.replyDigest}:{kind:'rejected',httpStatus:response.httpStatus});
   return read(owner,input.operationId);
  })();},
  recordUnavailable(owner,input,cap,reason){return db.transaction(()=>{const {c,saved:s}=capability(owner,input,cap);demand(c.invoked,'owner');append(s,c.dispatchOwner,{kind:'unavailable',reason});return read(owner,input.operationId);})();},
  recordVerification(owner,input,cap,observed){return db.transaction(()=>{
   const {c,saved:s}=capability(owner,input,cap),dispatchOwner=c.dispatchOwner;demand(c.invoked,'owner');const original=originalDrafts.byId(owner,input.operationId),before=snapshots.readExecutionEvidence(s.header,owner);
   let verification='unavailable',after=null;
   if(observed?.subject===s.header.subject&&observed.document&&typeof observed.document==='object'){
    verification=verificationFact(s.header,s.record,original.plan,before,observed.document);after=snapshots.retainStageEvidence(s.header,'after',observed.document);
   }
   append(s,dispatchOwner,{kind:'verification',verification,after},verification==='matched'?{kind:'verified'}:null);return read(owner,input.operationId);
  })();},
  evidence(owner,input){return db.transaction(()=>{const saved=read(owner,input.operationId);demand(saved,'unknown');demand(saved.header.headHash===input.planHash,'head');sealOwner(saved.header,owner);return snapshots.readExecutionEvidence(saved.header,owner);})();},
 };
 return api;
}
