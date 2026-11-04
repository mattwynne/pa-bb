// Read-only technical port. Construction never migrates, sweeps or admits work.
import {CATALOG_NAMESPACES} from '../core/docs-semantic/draft-catalog.mjs';
const MAX_RECEIPT=4*1024*1024;
export function createRecoveryReadStore(db,store){
 const bounded=(column,limit=MAX_RECEIPT)=>`CASE WHEN length(CAST(${column} AS BLOB))<=${limit} THEN ${column} ELSE NULL END`;
 function discover(subject,operationId){return db.transaction(()=>{
  const rows=[];
  for(const namespace of CATALOG_NAMESPACES){
   const table=namespace==='semantic'?'docs_semantic_drafts':namespace;
   const resource=namespace==='semantic'||namespace==='docs_creations'?'NULL':namespace==='drive_sheets_edits'?'spreadsheet_id':['drive_formatting_operations','docs_image_operations'].includes(namespace)?'document_id':namespace==='drive_sharing_operations'?'file_id':'resource';
   const state=namespace==='semantic'||namespace==='docs_creations'?'NULL':'state',draftDigest=namespace==='semantic'?bounded('digest',64):'NULL';
   const row=db.prepare(`SELECT ${draftDigest} AS draftDigest,subject,${bounded(state,128)} AS state,${bounded(resource,512)} AS resource,${bounded('receipt')} AS receipt,length(CAST(receipt AS BLOB)) AS receiptBytes FROM ${table} WHERE operation_id=? AND subject=?`).get(operationId,subject);
   if(!row)continue;
   const writer=db.prepare(`SELECT ${bounded('initial_record',65536)} AS initial_record,${bounded('record',65536)} AS record,${bounded('digest',64)} AS digest,CASE WHEN typeof(reserved_bytes)='integer' THEN reserved_bytes ELSE NULL END AS reserved_bytes FROM docs_writer_owners WHERE namespace=? AND operation_id=? AND subject=?`).get(namespace,operationId,subject)??null;
   const execution=namespace==='semantic'?db.prepare(`SELECT ${bounded('header',65536)} AS header,${bounded('record',4096)} AS record,${bounded('digest',64)} AS digest,${bounded('record_digest',64)} AS record_digest FROM docs_semantic_execution WHERE operation_id=? AND subject=?`).get(operationId,subject)??null:null;
   rows.push({namespace,operationId,...row,writer,execution});
  }
  return rows;
 })();}
 return Object.freeze({byEmail:async email=>{
  const r=db.prepare(`SELECT ${bounded('subject',1024)} AS subject,${bounded('email',1280)} AS email,${bounded('access_token',16384)} AS accessToken,${bounded('refresh_token',16384)} AS refreshToken,expires_at AS expiresAt FROM drive_accounts WHERE email=? COLLATE NOCASE`).get(email);
  return r??null;
 },discover,
  semanticEvidence(owner,operationId){return db.transaction(()=>{
   const original=store.semanticDrafts.byId(owner,operationId);if(!original)return null;
   const saved=store.semanticExecutions.byId(owner,operationId);
   if(!saved)return {saved:null,draft:original.record,plan:original.plan};
   const input={operationId,planHash:saved.header.headHash};
   return {saved,draft:original.record,plan:original.plan,before:store.semanticExecutions.evidence(owner,input)};
  })();}
 });
}
