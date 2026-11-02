// Purpose-specific synchronous seal/cancel operations. No provider I/O/async callback.
import {createDraftJournal} from './docs-draft-store.mjs';
import {draftHash,immutable,demand} from '../core/docs-semantic/draft-policy.mjs';
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
 const originalDrafts=createDraftJournal(db,{snapshots});
 function read(owner,id){
  const row=db.prepare('SELECT subject,head_hash,CASE WHEN length(CAST(header AS BLOB))<=? THEN header ELSE NULL END header,digest,CASE WHEN length(CAST(record AS BLOB))<=? THEN record ELSE NULL END record,record_digest FROM docs_semantic_execution WHERE operation_id=? AND subject=?').get(SEAL_LIMITS.headerBytes,SEAL_LIMITS.recordBytes,id,owner.subject);
  if(!row)return null;let saved;try{saved={header:JSON.parse(row.header),record:JSON.parse(row.record)};}catch{demand(false,'corrupt');}
  validateSeal(saved);const {header:h,record:r}=saved;
  demand(h.operationId===id&&h.subject===row.subject&&h.headHash===row.head_hash&&draftHash(h)===row.digest&&draftHash(r)===row.record_digest,'corrupt');
  if(owner.account!==undefined)demand(h.account===owner.account,'owner');
  checkSealCoordinator(saved,writers.get('semantic',id));
  const before=snapshots.readExecutionEvidence(h,{subject:h.subject,account:h.account,threadId:h.threadId});
  checkSealLineage(saved,originalDrafts.byId({subject:h.subject},id),before);
  return immutable(saved);
 }
 return {
  present(owner,id){return Boolean(db.prepare('SELECT 1 FROM docs_semantic_execution WHERE operation_id=? AND subject=?').get(id,owner.subject));},
  byId(owner,id){return db.transaction(()=>read(owner,id))();},
  seal(owner,input,context,currentRead,now){return db.transaction(()=>{
   const prior=read(owner,input.operationId);if(prior){sealOwner(prior.header,owner,{origin:true});demand(prior.header.headHash===input.planHash,'head');return prior;}
   const saved=draft().byId(owner,input.operationId);demand(saved,'unknown');
   const r=saved.record,account=db.prepare('SELECT subject,email FROM drive_accounts WHERE email=? COLLATE NOCASE').get(r.account);
   checkSealAccount(saved,owner,account);
   const snapshot=snapshots.readPinned(r.snapshotId,owner,r.operationId,now),resources=sealResources(saved,context);
   const raw=writers.readTargetContextFacts({resourceIds:[...new Set(resources.map(r=>r.id))].sort(),markerKeys:markerKeysFor(context.observations)});
   const seal=admitSeal({saved,owner,input,context,snapshot,read:currentRead,raw,now}),h=seal.header;
   // Pre-admission of retained bytes/future credit before any header/rights insert.
   snapshots.checkExecutionAdmission(h,snapshot);
   const acquired=writers.acquire('semantic',{operationId:h.operationId,subject:h.subject,documentId:h.documentId,contextIds:h.resources.filter(r=>r.role==='accessStable').map(r=>r.id),semanticHeaderDigest:draftHash(h)},'content',()=>{
    db.prepare('INSERT INTO docs_semantic_execution VALUES (?,?,?,?,?,?,?)').run(h.operationId,h.subject,h.headHash,JSON.stringify(h),draftHash(h),JSON.stringify(seal.record),draftHash(seal.record));
    snapshots.retainExecution(h,snapshot);return true;
   });
   demand(acquired,'conflict');return read(owner,h.operationId);
  })();},
  cancelNotSent(owner,input){return db.transaction(()=>{
   const old=read(owner,input.operationId);demand(old,'unknown');demand(old.header.headHash===input.planHash,'head');
   const next=cancelNotSent(old,owner,writers.get('semantic',input.operationId));if(old.record.status==='cancelled')return old;
   db.prepare('UPDATE docs_semantic_execution SET record=?,record_digest=? WHERE operation_id=? AND record_digest=?').run(JSON.stringify(next.record),draftHash(next.record),input.operationId,draftHash(old.record));
   writers.cancelSemantic(input.operationId,owner,draftHash(old.header));return read(owner,input.operationId);
  })();},
  evidence(owner,input){return db.transaction(()=>{const saved=read(owner,input.operationId);demand(saved,'unknown');demand(saved.header.headHash===input.planHash,'head');sealOwner(saved.header,owner);return snapshots.readExecutionEvidence(saved.header,owner);})();},
 };
}
