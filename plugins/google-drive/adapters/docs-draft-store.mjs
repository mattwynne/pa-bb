// Technical SQLite implementation of the internal no-write journal port.
import {DRAFT_LIMITS,checkLimits,demand,draftHash,bytes,immutable,validateRecord,validateReservation,validateSaved,sameRequest,publicationRecord,requireDraftEvidence,rejectedRecord,cancelRecord,admit} from '../core/docs-semantic/draft-policy.mjs';
import {LEGACY_KEY_TABLES} from '../core/docs-semantic/draft-catalog.mjs';
// Frozen v1 SQL inputs: future catalog namespaces require an appended migration,
// never a change to the already-applied index-10 bytes.
const migrationV1Tables=Object.freeze(['docs_creations','drive_sharing_operations','drive_formatting_operations','drive_sheets_edits','drive_filing_operations','docs_image_operations']);
export const SEMANTIC_DRAFT_MIGRATION=`
CREATE TABLE docs_semantic_drafts (
 operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, thread TEXT NOT NULL, request_id TEXT NOT NULL,
 receipt TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(subject,thread,request_id)
);
CREATE TABLE docs_semantic_draft_revisions (
 operation_id TEXT NOT NULL, hash TEXT NOT NULL, plan TEXT NOT NULL, PRIMARY KEY(operation_id,hash)
);
${migrationV1Tables.map(table=>`CREATE TRIGGER semantic_key_guard_${table} BEFORE INSERT ON ${table}
 WHEN EXISTS (SELECT 1 FROM docs_semantic_drafts WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'Semantic operation key conflict'); END;`).join('\n')}
CREATE TRIGGER semantic_key_guard_draft BEFORE INSERT ON docs_semantic_drafts
 WHEN ${migrationV1Tables.map(table=>`EXISTS (SELECT 1 FROM ${table} WHERE operation_id=NEW.operation_id)`).join(' OR ')}
 BEGIN SELECT RAISE(ABORT,'Semantic operation key conflict'); END;
CREATE TRIGGER semantic_draft_revision_no_update BEFORE UPDATE ON docs_semantic_draft_revisions
 BEGIN SELECT RAISE(ABORT,'Immutable semantic draft revision'); END;
CREATE TRIGGER semantic_draft_revision_no_delete BEFORE DELETE ON docs_semantic_draft_revisions
 BEGIN SELECT RAISE(ABORT,'Retained semantic draft revision'); END;
CREATE TRIGGER semantic_draft_no_delete BEFORE DELETE ON docs_semantic_drafts
 BEGIN SELECT RAISE(ABORT,'Retained semantic draft key'); END;
`;
export function createDraftJournal(db,{snapshots,limits=DRAFT_LIMITS}){
 checkLimits(limits);
 const usage=()=>({records:db.prepare('SELECT count(*) AS n FROM docs_semantic_drafts').get().n,bytes:db.prepare('SELECT coalesce(sum(length(cast(receipt AS BLOB))),0) AS n FROM docs_semantic_drafts').get().n+db.prepare('SELECT coalesce(sum(length(cast(plan AS BLOB))),0) AS n FROM docs_semantic_draft_revisions').get().n});
 function decode(row){
  if(!row)return null;demand(typeof row.receipt==='string'&&Buffer.byteLength(row.receipt)<=limits.recordBytes,'corrupt');
  let record;try{record=JSON.parse(row.receipt);}catch{demand(false,'corrupt');}
  validateRecord(record,limits);demand(draftHash(record)===row.digest&&record.operationId===row.operation_id&&record.subject===row.subject&&record.threadId===row.thread&&record.requestId===row.request_id,'corrupt');
  let plan=null;if(record.headHash){const rev=db.prepare('SELECT CASE WHEN length(cast(plan AS BLOB))<=? THEN plan ELSE NULL END AS plan FROM docs_semantic_draft_revisions WHERE operation_id=? AND hash=?').get(limits.planBytes,record.operationId,record.headHash);demand(rev&&typeof rev.plan==='string','corrupt');try{plan=JSON.parse(rev.plan);}catch{demand(false,'corrupt');}}
  return immutable(validateSaved({record,plan},limits));
 }
 // Cap values in SQL before crossing the boundary, including corrupt rows.
 const columns=`operation_id,subject,thread,request_id,digest,CASE WHEN length(cast(receipt AS BLOB))<=${limits.recordBytes} THEN receipt ELSE NULL END AS receipt`;
 const raw=id=>db.prepare('SELECT 1 FROM docs_semantic_drafts WHERE operation_id=?').get(id);
 const owned=(id,owner)=>{const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(id,owner.subject);demand(row,'unknown');return decode(row);};
 function save(previous,next,extraBytes=0){
  validateRecord(next,limits);admit(usage(),bytes(next)-bytes(previous)+extraBytes,0,limits);
  demand(db.prepare('UPDATE docs_semantic_drafts SET receipt=?,digest=? WHERE operation_id=? AND digest=?').run(JSON.stringify(next),draftHash(next),next.operationId,draftHash(previous)).changes===1,'head');
 }
 const api={
  byRequest(owner,requestId){return decode(db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE subject=? AND thread=? AND request_id=?`).get(owner.subject,owner.threadId,requestId));},
  byId(owner,id){const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(id,owner.subject);return decode(row);},
  reserve(candidate){return db.transaction(()=>{
   validateReservation(candidate,limits);const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE subject=? AND thread=? AND request_id=?`).get(candidate.subject,candidate.threadId,candidate.requestId);
   if(row){const saved=decode(row);sameRequest(saved.record,candidate);return {created:false,saved};}
   demand(!raw(candidate.operationId)&&!LEGACY_KEY_TABLES.some(table=>db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).get(candidate.operationId)),'key_conflict');
   admit(usage(),bytes(candidate),1,limits);db.prepare('INSERT INTO docs_semantic_drafts VALUES (?,?,?,?,?,?)').run(candidate.operationId,candidate.subject,candidate.threadId,candidate.requestId,JSON.stringify(candidate),draftHash(candidate));return {created:true,saved:immutable({record:candidate,plan:null})};
  })();},
  publish(id,owner,plan,now){return db.transaction(()=>{
   const {record}=owned(id,owner),next=publicationRecord(record,owner,plan,now,limits);
   // Admission precedes pin/revision work; all compound writes roll back together.
   admit(usage(),bytes(next)-bytes(record)+bytes(plan),0,limits);
   const snapshot=snapshots.get(record.snapshotId,owner,now);requireDraftEvidence(plan,snapshot);
   snapshots.pin(record.snapshotId,owner,id,now,record.expiresAt);
   save(record,next,bytes(plan));db.prepare('INSERT INTO docs_semantic_draft_revisions VALUES (?,?,?)').run(id,next.headHash,JSON.stringify(plan));return immutable({record:next,plan});
  })();},
  reject(id,owner,category){return db.transaction(()=>{const {record}=owned(id,owner),next=rejectedRecord(record,owner,category,limits);save(record,next);return immutable({record:next,plan:null});})();},
  cancel(id,owner,expected,now){return db.transaction(()=>{const {record,plan}=owned(id,owner),next=cancelRecord(record,owner,expected,now,limits);if(next!==record)save(record,next);return immutable({record:next,plan});})();},
  catalog(owner,{operationId,namespace}){
   // Filter by SQL subject BEFORE touching private receipt JSON. A corrupt
   // other-subject record can block collision admission but is never disclosed.
   const rows=[];
   if(!namespace||namespace==='semantic'){const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(operationId,owner.subject);if(row){let saved;try{saved=decode(row);}catch{ /* safe unsupported catalog entry */ }rows.push({namespace:'semantic',operationId,subject:row.subject,state:null,receipt:saved?row.receipt:'!corrupt',plan:saved?.plan??null});}}
   for(const table of LEGACY_KEY_TABLES){if(namespace&&namespace!==table)continue;const state=table==='docs_creations'?'NULL':'state';const resource=table==='docs_creations'?'NULL':table==='drive_sheets_edits'?'spreadsheet_id':['drive_formatting_operations','docs_image_operations'].includes(table)?'document_id':table==='drive_sharing_operations'?'file_id':'resource';const row=db.prepare(`SELECT subject,${state} AS state,${resource} AS resource,CASE WHEN length(cast(receipt AS BLOB))<=? THEN receipt ELSE NULL END AS receipt FROM ${table} WHERE operation_id=? AND subject=?`).get(limits.catalogBytes,operationId,owner.subject);if(row)rows.push({namespace:table,operationId,subject:row.subject,state:row.state??null,receipt:row.receipt,...(row.resource===null?{}:{resource:row.resource})});}
   return rows;
  },
 };
 return api;
}
