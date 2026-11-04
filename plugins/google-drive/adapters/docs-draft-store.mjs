// Technical SQLite implementation of the internal no-write journal port.
import {DRAFT_LIMITS,checkLimits,demand,draftHash,bytes,immutable,validateRecord,validateReservation,validateSaved,sameRequest,publicationRecord,requireDraftEvidence,rejectedRecord,cancelRecord,admit} from '../core/docs-semantic/draft-policy.mjs';
import {validateCompositionLineage,compositionResult,initialResultArtifact} from '../core/docs-semantic/composition-lineage.mjs';
import {supersededRecord} from '../core/docs-semantic/composition-policy.mjs';
import {sameLogical} from '../core/docs-semantic/logical-plan.mjs';
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
export function createDraftJournal(db,{snapshots,limits=DRAFT_LIMITS,execution}){
 checkLimits(limits);
 const usage=()=>({records:db.prepare('SELECT count(*) AS n FROM docs_semantic_drafts').get().n,bytes:db.prepare('SELECT coalesce(sum(length(cast(receipt AS BLOB))),0) AS n FROM docs_semantic_drafts').get().n+db.prepare('SELECT coalesce(sum(length(cast(plan AS BLOB))),0) AS n FROM docs_semantic_draft_revisions').get().n});
 function rowRecord(row){
  demand(row&&typeof row.receipt==='string'&&Buffer.byteLength(row.receipt)<=limits.recordBytes,'corrupt');let r;try{r=JSON.parse(row.receipt);}catch{demand(false,'corrupt');}
  validateRecord(r,limits);demand(draftHash(r)===row.digest&&r.operationId===row.operation_id&&r.subject===row.subject&&r.threadId===row.thread&&r.requestId===row.request_id,'corrupt');return r;
 }
 function revision(id,hash){const rev=db.prepare('SELECT CASE WHEN length(cast(plan AS BLOB))<=? THEN plan ELSE NULL END AS plan FROM docs_semantic_draft_revisions WHERE operation_id=? AND hash=?').get(limits.planBytes,id,hash);demand(rev&&typeof rev.plan==='string','corrupt');let value;try{value=JSON.parse(rev.plan);}catch{demand(false,'corrupt');}demand(draftHash(value)===hash,'corrupt');return value;}
 function supersededLink(record){
  if(record.version!==3)return;
  const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(record.supersededBy,record.subject),raw=rowRecord(row),target=raw.version===3?raw.prior:raw;
  demand(target.version===2&&target.account===record.account&&target.threadId===record.threadId&&target.snapshotId===record.snapshotId&&target.initialInput.family==='combine'&&target.initialInput.request.inputs.some(x=>x.draftId===record.operationId&&x.expectedDraftHash===record.headHash),'corrupt');
  validateSaved({record:{...target,headHash:target.initialHeadHash},plan:revision(target.operationId,target.initialHeadHash)},limits);
 }
 function validatePlan(record,plan,seen=new Set(),memo=new Set(),source=null){
  validateSaved({record,plan},limits);if(!plan)return;
  const validated=draftHash({id:record.operationId,hash:draftHash(plan),requestHash:record.requestHash,subject:record.subject,account:record.account,thread:record.threadId,snapshot:record.snapshotId,expires:record.expiresAt,source:source?draftHash(source):null});if(memo.has(validated))return;if(source)requireDraftEvidence(plan,source);if(plan.kind!=='paragraphComposition'){memo.add(validated);return;}
  const key=record.operationId+'/'+draftHash(plan);demand(!seen.has(key)&&seen.size<8,'corrupt');seen.add(key);
  const owner={subject:record.subject,account:record.account,threadId:record.threadId};
  validateCompositionLineage(plan,(id,hash)=>{
   return readRevision(owner,id,hash,seen,memo,source);
  });
  // Immutable history is independently decoded against its retained RAW
  // witnesses. If a ROOT execution/source exists, pass that exact validated
  // model through ALL ancestors; do not require their expired transient pins.
  seen.delete(key);memo.add(validated);
 }
 function readRevision(owner,id,hash,seen=new Set(),memo=new Set(),source=null){
  const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(id,owner.subject),raw=rowRecord(row),base=raw.version===3?raw.prior:raw;
  demand(base.account===owner.account&&base.threadId===owner.threadId,'owner');supersededLink(raw);const prior={record:{...base,headHash:hash},plan:revision(id,hash)};validatePlan(prior.record,prior.plan,seen,memo,source);return prior;
 }
 function decode(row){
  if(!row)return null;const record=rowRecord(row),plan=record.headHash?revision(record.operationId,record.headHash):null,memo=new Set(),source=plan?.kind==='paragraphComposition'?snapshots.readRetainedDraft(record.snapshotId,{subject:record.subject,account:record.account,threadId:record.threadId},record.operationId):null;validatePlan(record,plan,new Set(),memo,source);
  supersededLink(record);
  const base=record.version===3?record.prior:record;let initialResult;
  if(base.version===2&&base.state!=='planning'){
   demand(base.initialResultHash,'corrupt');const a=revision(base.operationId,base.initialResultHash);demand(a.version===1&&a.kind==='compositionPlanningResult'&&Object.keys(a).sort().join(',')==='kind,requestHash,result,version'&&a.requestHash===base.requestHash,'corrupt');
   const first={...base,state:base.initialHeadHash?'draft':'rejected',headHash:base.initialHeadHash,cancelledAt:null},initialPlan=base.initialHeadHash?revision(base.operationId,base.initialHeadHash):null;
   validatePlan(first,initialPlan,new Set(),memo,source);demand(sameLogical(a.result,compositionResult({record:first,plan:initialPlan})),'corrupt');initialResult=a.result;
  }
  const seal=execution?.byId({subject:record.subject},record.operationId);return immutable({record,plan,...(initialResult?{initialResult}:{}),...(seal?{execution:seal}:{})});
 }
 function originalResult(next,plan){const a=initialResultArtifact(next,plan);demand(bytes(a.value)<=limits.planBytes,'budget');return {...a,record:{...next,initialResultHash:a.hash}};}
 const insertRevision=(id,hash,value)=>db.prepare('INSERT INTO docs_semantic_draft_revisions VALUES (?,?,?)').run(id,hash,JSON.stringify(value));
 // Cap values in SQL before crossing the boundary, including corrupt rows.
 const columns=`operation_id,subject,thread,request_id,digest,CASE WHEN length(cast(receipt AS BLOB))<=${limits.recordBytes} THEN receipt ELSE NULL END AS receipt`;
 const raw=id=>db.prepare('SELECT 1 FROM docs_semantic_drafts WHERE operation_id=?').get(id);
 const owned=(id,owner)=>{const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(id,owner.subject);demand(row,'unknown');return decode(row);};
 function save(previous,next,extraBytes=0){
  validateRecord(next,limits);admit(usage(),bytes(next)-bytes(previous)+extraBytes,0,limits);
  demand(db.prepare('UPDATE docs_semantic_drafts SET receipt=?,digest=? WHERE operation_id=? AND digest=?').run(JSON.stringify(next),draftHash(next),next.operationId,draftHash(previous)).changes===1,'head');
 }
 const authorized=(saved,owner)=>{if(saved?.execution)demand(saved.execution.header.account===owner.account,'owner');return saved;};
 const api={
  byRequest(owner,requestId){return db.transaction(()=>authorized(decode(db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE subject=? AND thread=? AND request_id=?`).get(owner.subject,owner.threadId,requestId)),owner))();},
  byId(owner,id){return db.transaction(()=>{const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(id,owner.subject);return authorized(decode(row),owner);})();},
  reserve(candidate){return db.transaction(()=>{
   validateReservation(candidate,limits);if(candidate.version===2)demand(candidate.initialInput.family!=='combine','invalid');const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE subject=? AND thread=? AND request_id=?`).get(candidate.subject,candidate.threadId,candidate.requestId);
   if(row){const saved=decode(row);sameRequest(saved.record,candidate);return {created:false,saved};}
   demand(!raw(candidate.operationId)&&!LEGACY_KEY_TABLES.some(table=>db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).get(candidate.operationId)),'key_conflict');
   admit(usage(),bytes(candidate),1,limits);db.prepare('INSERT INTO docs_semantic_drafts VALUES (?,?,?,?,?,?)').run(candidate.operationId,candidate.subject,candidate.threadId,candidate.requestId,JSON.stringify(candidate),draftHash(candidate));return {created:true,saved:immutable({record:candidate,plan:null})};
  })();},
  publish(id,owner,plan,now){return db.transaction(()=>{
   const {record}=owned(id,owner);let next=publicationRecord(record,owner,plan,now,limits);const initial=record.version===2?originalResult(next,plan):null;if(initial)next=initial.record;
   // Admission precedes pin/revision work; all compound writes roll back together.
   const extra=bytes(plan)+(initial?bytes(initial.value):0);admit(usage(),bytes(next)-bytes(record)+extra,0,limits);
   const snapshot=snapshots.get(record.snapshotId,owner,now);requireDraftEvidence(plan,snapshot);
   snapshots.pin(record.snapshotId,owner,id,now,record.expiresAt);
   save(record,next,extra);insertRevision(id,next.headHash,plan);if(initial)insertRevision(id,initial.hash,initial.value);return immutable({record:next,plan,...(initial?{initialResult:initial.result}:{})});
  })();},
  reject(id,owner,category){return db.transaction(()=>{const {record}=owned(id,owner);let next=rejectedRecord(record,owner,category,limits);const initial=record.version===2?originalResult(next,null):null;if(initial)next=initial.record;save(record,next,initial?bytes(initial.value):0);if(initial)insertRevision(id,initial.hash,initial.value);return immutable({record:next,plan:null,...(initial?{initialResult:initial.result}:{})});})();},
  extendComposition(id,owner,expected,plan,now){return db.transaction(()=>{
   const saved=owned(id,owner),r=saved.record;demand(r.version===2&&r.state==='draft'&&!saved.execution&&r.subject===owner.subject&&r.account===owner.account&&r.threadId===owner.threadId,'owner');demand(r.headHash===expected&&now<r.expiresAt,'head');
   const snapshot=snapshots.get(r.snapshotId,owner,now);requireDraftEvidence(plan,snapshot);demand(plan.extensions.length===saved.plan.extensions.length+1&&sameLogical(plan.extensions.slice(0,-1),saved.plan.extensions)&&plan.extensions.at(-1).request.draft.expectedDraftHash===expected,'head');
   const next={...r,headHash:draftHash(plan)};validateSaved({record:next,plan});validateCompositionLineage(plan,(source,hash)=>readRevision(owner,source,hash));save(r,next,bytes(plan));insertRevision(id,next.headHash,plan);return immutable({record:next,plan,initialResult:saved.initialResult});
  })();},
  combineComposition(candidate,owner,inputs,plan,now){return db.transaction(()=>{
   validateReservation(candidate,limits);demand(candidate.version===2&&candidate.initialInput.family==='combine'&&sameLogical(candidate.initialInput.request.inputs,inputs),'invalid');
   const prior=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE subject=? AND thread=? AND request_id=?`).get(owner.subject,owner.threadId,candidate.requestId);if(prior){const saved=decode(prior);sameRequest(saved.record,candidate);return saved;}
   const sources=inputs.map(x=>{const s=owned(x.draftId,owner),r=s.record;demand(r.state==='draft'&&!s.execution&&r.subject===owner.subject&&r.account===owner.account&&r.threadId===owner.threadId,'owner');demand(r.headHash===x.expectedDraftHash&&now<r.expiresAt,'head');return s;});
   demand(!raw(candidate.operationId)&&!LEGACY_KEY_TABLES.some(table=>db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).get(candidate.operationId)),'key_conflict');
   for(const s of sources)requireDraftEvidence(s.plan,snapshots.readPinned(s.record.snapshotId,owner,s.record.operationId,now));
   const snapshot=snapshots.readPinned(candidate.snapshotId,owner,sources[0].record.operationId,now);requireDraftEvidence(plan,snapshot);validateCompositionLineage(plan,(id,hash)=>sources.find(s=>s.record.operationId===id&&s.record.headHash===hash));
   let next=publicationRecord(candidate,owner,plan,now,limits);const initial=originalResult(next,plan);next=initial.record;const superseded=sources.map(s=>supersededRecord(s.record,next.operationId));
   const delta=bytes(next)+bytes(plan)+bytes(initial.value)+superseded.reduce((n,r,i)=>n+bytes(r)-bytes(sources[i].record),0);admit(usage(),delta,1,limits);
   // No eager reservation: every new key/pin/head and BOTH input changes are in
   // this same transaction. A thrown pin/storage/CAS fault rolls back ALL rows.
   db.prepare('INSERT INTO docs_semantic_drafts VALUES (?,?,?,?,?,?)').run(next.operationId,next.subject,next.threadId,next.requestId,JSON.stringify(next),draftHash(next));
   snapshots.pinFromRetained(candidate.snapshotId,owner,sources[0].record.operationId,next.operationId,now,next.expiresAt);
   insertRevision(next.operationId,next.headHash,plan);insertRevision(next.operationId,initial.hash,initial.value);for(const [i,r]of superseded.entries())save(sources[i].record,r);
   return immutable({record:next,plan,initialResult:initial.result});
  })();},
  cancel(id,owner,expected,now){return db.transaction(()=>{const saved=owned(id,owner);demand(!saved.execution,'sealed');const {record,plan}=saved,next=cancelRecord(record,owner,expected,now,limits);if(next!==record)save(record,next);return immutable({record:next,plan});})();},
  catalog(owner,{operationId,namespace}){
   // Filter by SQL subject BEFORE touching private receipt JSON. A corrupt
   // other-subject record can block collision admission but is never disclosed.
   const rows=[];
   if(!namespace||namespace==='semantic'){const row=db.prepare(`SELECT ${columns} FROM docs_semantic_drafts WHERE operation_id=? AND subject=?`).get(operationId,owner.subject);if(row){let saved;try{saved=decode(row);}catch{ /* safe unsupported catalog entry */ }if(saved?.execution)demand(saved.execution.header.account===owner.account,'owner');rows.push({namespace:'semantic',operationId,subject:row.subject,state:null,receipt:saved?row.receipt:'!corrupt',plan:saved?.plan??null,...(saved?.execution?{execution:saved.execution}:!saved&&execution?.present(owner,operationId)?{executionUnsupported:true}:{})});}}
   for(const table of LEGACY_KEY_TABLES){if(namespace&&namespace!==table)continue;const state=table==='docs_creations'?'NULL':'state';const resource=table==='docs_creations'?'NULL':table==='drive_sheets_edits'?'spreadsheet_id':['drive_formatting_operations','docs_image_operations'].includes(table)?'document_id':table==='drive_sharing_operations'?'file_id':'resource';const row=db.prepare(`SELECT subject,${state} AS state,${resource} AS resource,CASE WHEN length(cast(receipt AS BLOB))<=? THEN receipt ELSE NULL END AS receipt FROM ${table} WHERE operation_id=? AND subject=?`).get(limits.catalogBytes,operationId,owner.subject);if(row)rows.push({namespace:table,operationId,subject:row.subject,state:row.state??null,receipt:row.receipt,...(row.resource===null?{}:{resource:row.resource})});}
   return rows;
  },
 };
 return api;
}
