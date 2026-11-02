// Synchronous technical transactions only. Core defines roles, legacy evidence
// interpretation and transition/release policy. No provider I/O or async closure.
import {WRITER_LIMITS,writerCheck,writerError,writerOwner,validateWriter,nextWriterFact,writerResources,resourcesConflict,legacyWriterResources,ownerRef,writerDigest,writerAdmission,attachmentReason,extendWriterGrants,assertWriterGrants} from '../core/docs-semantic/writer-coordination.mjs';
import {validateSeal,SEAL_LIMITS,executionReference,preparedSemanticCancellation,semanticClaimOperation} from '../core/docs-semantic/seal-policy.mjs';
import {freeze} from '../core/docs-semantic/common.mjs';
import {targetMarker,classifyWriterMarker,nativeMarkerFact} from '../core/docs-semantic/writer-markers.mjs';
const immutable=value=>freeze(structuredClone(value));
const migrationV1Tables=Object.freeze(['docs_creations','drive_sharing_operations','drive_formatting_operations','drive_sheets_edits','drive_filing_operations','docs_image_operations']);
// New catalog participants require an appended migration, never changed v1 SQL.
const legacyTables=[...migrationV1Tables];
export const WRITER_COORDINATION_MIGRATION=`
CREATE TABLE docs_writer_owners(namespace TEXT NOT NULL,operation_id TEXT NOT NULL,subject TEXT NOT NULL,initial_record TEXT NOT NULL,record TEXT NOT NULL,digest TEXT NOT NULL,reserved_bytes INTEGER NOT NULL,PRIMARY KEY(namespace,operation_id));
CREATE TABLE docs_writer_events(namespace TEXT NOT NULL,operation_id TEXT NOT NULL,sequence INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(namespace,operation_id,sequence));
CREATE TABLE docs_writer_resources(namespace TEXT NOT NULL,operation_id TEXT NOT NULL,resource_id TEXT NOT NULL,role TEXT NOT NULL,grant_kind TEXT NOT NULL,PRIMARY KEY(namespace,operation_id,resource_id,role));
CREATE TRIGGER writer_event_no_update BEFORE UPDATE ON docs_writer_events BEGIN SELECT RAISE(ABORT,'Immutable writer event'); END;
CREATE TRIGGER writer_event_no_delete BEFORE DELETE ON docs_writer_events BEGIN SELECT RAISE(ABORT,'Retained writer event'); END;
CREATE TRIGGER writer_owner_identity_no_update BEFORE UPDATE OF namespace,operation_id,subject,initial_record ON docs_writer_owners BEGIN SELECT RAISE(ABORT,'Immutable writer identity'); END;
CREATE TRIGGER writer_owner_no_delete BEFORE DELETE ON docs_writer_owners BEGIN SELECT RAISE(ABORT,'Retained writer owner'); END;
${migrationV1Tables.map(table=>`CREATE TRIGGER replacement_key_guard_${table} BEFORE INSERT ON ${table}
 WHEN EXISTS(SELECT 1 FROM docs_writer_owners WHERE namespace='legacyReplacement' AND operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'Writer operation key conflict'); END;`).join('\n')}
CREATE TRIGGER replacement_key_guard_draft BEFORE INSERT ON docs_semantic_drafts
 WHEN EXISTS(SELECT 1 FROM docs_writer_owners WHERE namespace='legacyReplacement' AND operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'Writer operation key conflict'); END;
`;
const length=x=>Buffer.byteLength(JSON.stringify(x));
export function createWriterStore(db){
 const semanticBytes=(ns,id)=>ns==='semantic'?db.prepare('SELECT length(CAST(header AS BLOB))+length(CAST(record AS BLOB))+512 n FROM docs_semantic_execution WHERE operation_id=?').get(id)?.n??0:0;
 const ownerBytes=(ns,id)=>semanticBytes(ns,id)+(db.prepare('SELECT length(cast(initial_record AS BLOB))+length(cast(record AS BLOB))+(SELECT coalesce(sum(length(cast(event AS BLOB))),0) FROM docs_writer_events WHERE namespace=? AND operation_id=?)+(SELECT count(*)*512 FROM docs_writer_resources WHERE namespace=? AND operation_id=?) n FROM docs_writer_owners WHERE namespace=? AND operation_id=?').get(ns,id,ns,id,ns,id)?.n??0);
 const usage=()=>{let bytes=0,owners=0;for(const r of db.prepare('SELECT namespace,operation_id,reserved_bytes FROM docs_writer_owners').iterate()){owners++;bytes+=Math.max(r.reserved_bytes,ownerBytes(r.namespace,r.operation_id));}return {owners,bytes};};
 const withinCredit=(ns,id,delta)=>{const row=db.prepare('SELECT reserved_bytes FROM docs_writer_owners WHERE namespace=? AND operation_id=?').get(ns,id);writerCheck(row&&ownerBytes(ns,id)+delta<=row.reserved_bytes,'capacity');};
 function load(namespace,id){ownerRef(namespace,id);const row=db.prepare('SELECT subject,CASE WHEN length(cast(record AS BLOB))<=? THEN record ELSE NULL END record,CASE WHEN length(cast(initial_record AS BLOB))<=? THEN initial_record ELSE NULL END initial_record,digest FROM docs_writer_owners WHERE namespace=? AND operation_id=?').get(WRITER_LIMITS.recordBytes,WRITER_LIMITS.recordBytes,namespace,id);if(!row)return null;let r,initial;try{r=JSON.parse(row.record);initial=JSON.parse(row.initial_record);}catch{throw writerError('corrupt');}validateWriter(r);validateWriter(initial);
 if(namespace==='semantic'){
  const h=db.prepare('SELECT subject,head_hash,CASE WHEN length(CAST(header AS BLOB))<=? THEN header ELSE NULL END header,digest,CASE WHEN length(CAST(record AS BLOB))<=? THEN record ELSE NULL END record,record_digest FROM docs_semantic_execution WHERE operation_id=?').get(SEAL_LIMITS.headerBytes,SEAL_LIMITS.recordBytes,id);writerCheck(h,'corrupt');
  let seal;try{seal={header:JSON.parse(h.header),record:JSON.parse(h.record)};}catch{throw writerError('corrupt');}validateSeal(seal);
  assertWriterGrants(seal.header.resources.map(g=>({...g,grantKind:'grant'})),initial.grants);
  assertWriterGrants(r.disposition==='held'?seal.header.resources.map(g=>({...g,grantKind:'grant'})):[],r.grants);
  writerCheck(initial.semanticHeaderDigest===h.digest,'corrupt');
  writerCheck(seal.header.operationId===id&&seal.header.subject===r.subject&&h.subject===r.subject&&seal.header.headHash===h.head_hash&&writerDigest(seal.header)===h.digest&&writerDigest(seal.record)===h.record_digest&&r.semanticHeaderDigest===h.digest,'corrupt');
  const evidence=db.prepare('SELECT CASE WHEN length(CAST(receipt AS BLOB))<=65536 THEN receipt ELSE NULL END receipt,digest FROM docs_semantic_execution_refs WHERE operation_id=? AND snapshot=? AND subject=? AND reserved_bytes=?').get(id,seal.header.before.snapshotId,r.subject,seal.header.futureCredit);writerCheck(evidence,'corrupt');
  let ref;try{ref=JSON.parse(evidence.receipt);}catch{throw writerError('corrupt');}
  writerCheck(writerDigest(ref)===evidence.digest&&writerDigest(ref)===writerDigest(executionReference(seal.header,ref.rowBinding)),'corrupt');
 }
 writerCheck(initial.sequence===0,'corrupt');let replay=initial;let count=0;for(const e of db.prepare('SELECT sequence,event FROM docs_writer_events WHERE namespace=? AND operation_id=? ORDER BY sequence').iterate(namespace,id)){writerCheck(++count<=WRITER_LIMITS.eventsPerOwner&&e.sequence===count&&Buffer.byteLength(e.event)<=WRITER_LIMITS.eventBytes,'corrupt');let observed;try{observed=JSON.parse(e.event);}catch{throw writerError('corrupt');}replay=nextWriterFact(replay,observed);}writerCheck(r.namespace===namespace&&r.operationId===id&&r.subject===row.subject&&writerDigest(r)===row.digest&&writerDigest(replay)===row.digest,'corrupt');assertWriterGrants(r.grants,projection(namespace,id));return immutable(r);}
 function audit(){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='docs_semantic_execution'").get())writerCheck(!db.prepare("SELECT 1 FROM docs_semantic_execution e LEFT JOIN docs_writer_owners o ON o.namespace='semantic' AND o.operation_id=e.operation_id WHERE o.operation_id IS NULL LIMIT 1").get(),'corrupt');
  writerCheck(!db.prepare('SELECT 1 FROM docs_writer_resources r LEFT JOIN docs_writer_owners o ON o.namespace=r.namespace AND o.operation_id=r.operation_id WHERE o.operation_id IS NULL LIMIT 1').get(),'corrupt');
  writerCheck(!db.prepare('SELECT 1 FROM docs_writer_events e LEFT JOIN docs_writer_owners o ON o.namespace=e.namespace AND o.operation_id=e.operation_id WHERE o.operation_id IS NULL LIMIT 1').get(),'corrupt');
  let n=0;for(const r of db.prepare('SELECT namespace,operation_id FROM docs_writer_owners').iterate()){writerCheck(++n<=WRITER_LIMITS.owners,'capacity');load(r.namespace,r.operation_id);}
 }
 function get(namespace,id){return db.transaction(()=>{audit();return load(namespace,id);})();}
 function eachLegacy(resources,visit){
  const ids=JSON.stringify([...new Set(resources.map(r=>r.id))]);let bytes=0,count=0;
  for(const table of legacyTables){
   const state=table==='docs_creations'?'NULL':'state',resource=table==='docs_creations'?'NULL':table==='drive_sheets_edits'?'spreadsheet_id':['drive_formatting_operations','docs_image_operations'].includes(table)?'document_id':table==='drive_sharing_operations'?'file_id':'resource';
   // Positive binding evidence must reach core even after its ID pointers are
   // damaged. This bounded syntactic superset makes no kind/state/role decision.
   const matches=table==='docs_creations'?`NOT json_valid(receipt) OR CASE WHEN json_valid(receipt) THEN json_type(receipt)!='object' OR json_type(receipt,'$.copyBindingVersion') IS NOT NULL OR json_type(receipt,'$.copySource') IS NOT NULL OR json_extract(receipt,'$.documentId') IN (SELECT value FROM json_each(?)) OR json_extract(receipt,'$.spreadsheetId') IN (SELECT value FROM json_each(?)) OR json_extract(receipt,'$.fileId') IN (SELECT value FROM json_each(?)) OR json_extract(receipt,'$.destinationId') IN (SELECT value FROM json_each(?)) OR json_extract(receipt,'$.sourceId') IN (SELECT value FROM json_each(?)) OR json_extract(receipt,'$.copySource.id') IN (SELECT value FROM json_each(?)) OR json_extract(receipt,'$.resource') IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(receipt,'$.contextIds') WHERE value IN (SELECT value FROM json_each(?))) ELSE 0 END`:
    `${resource} IN (SELECT value FROM json_each(?)) OR ${table==='drive_filing_operations'?"resource IN (SELECT 'file:'||value FROM json_each(?)) OR CASE WHEN json_valid(receipt) THEN json_extract(receipt,'$.fileId') IN (SELECT value FROM json_each(?)) ELSE 0 END OR ":''} CASE WHEN json_valid(receipt) THEN EXISTS(SELECT 1 FROM json_each(receipt,'$.contextIds') WHERE value IN (SELECT value FROM json_each(?))) ELSE 0 END`;
   // Folder SQL resources are synthetic; their retained provider RESULT must
   // reach core independently of contextIds, kind, lifecycle or role admission.
   const params=table==='docs_creations'?Array(8).fill(ids):table==='drive_filing_operations'?Array(4).fill(ids):Array(2).fill(ids);
   const query=db.prepare(`SELECT operation_id,subject,${state} state,${resource} resource,CASE WHEN length(cast(receipt AS BLOB))<=? THEN receipt ELSE NULL END receipt FROM ${table} WHERE ${matches} LIMIT ${WRITER_LIMITS.legacyRows+1}`);
   for(const row of query.iterate(WRITER_LIMITS.legacyBytes,...params)){writerCheck(++count<=WRITER_LIMITS.legacyRows,'capacity');bytes+=typeof row.receipt==='string'?Buffer.byteLength(row.receipt):WRITER_LIMITS.legacyBytes;writerCheck(bytes<=8*1024*1024,'capacity');visit({namespace:table,key:row.operation_id,subject:row.subject,state:row.state,resource:row.resource,receipt:row.receipt});}
  }
 }
 function allowed(namespace,id,resources){
  ownerRef(namespace,id);audit();let okay=true;
  for(const row of db.prepare('SELECT namespace,operation_id,resource_id,role FROM docs_writer_resources WHERE resource_id IN (SELECT value FROM json_each(?))').iterate(JSON.stringify(resources.map(r=>r.id)))){
   if(row.namespace===namespace&&row.operation_id===id)continue;
   if(resourcesConflict(resources,[{id:row.resource_id,role:row.role}]))okay=false;
  }
  const wanted=new Set(resources.map(r=>r.id));
  for(const row of db.prepare('SELECT namespace,operation_id FROM docs_writer_owners').iterate()){
   if(row.namespace===namespace&&row.operation_id===id)continue;const r=load(row.namespace,row.operation_id);if(r.disposition!=='held')continue;
   const known=[...new Set([r.createdId,...r.observedIds].filter(Boolean))];for(const file of known)if(wanted.has(file)&&resourcesConflict(resources,[{id:file,role:'contentWrite'},{id:file,role:'accessStable'}]))okay=false;
  }
  eachLegacy(resources,row=>{if(row.namespace===namespace&&row.key===id)return;if(resourcesConflict(resources,legacyWriterResources(row)))okay=false;});return okay;
 }
 function projection(namespace,id){const rows=db.prepare('SELECT CASE WHEN length(cast(resource_id AS BLOB))<=512 THEN resource_id ELSE NULL END AS id,CASE WHEN length(role)<=32 THEN role ELSE NULL END role,CASE WHEN length(grant_kind)<=16 THEN grant_kind ELSE NULL END AS grantKind FROM docs_writer_resources WHERE namespace=? AND operation_id=? ORDER BY resource_id,role LIMIT ?').all(namespace,id,WRITER_LIMITS.resourcesPerOwner+1);writerCheck(rows.length<=WRITER_LIMITS.resourcesPerOwner,'corrupt');return rows;}
 function resources(namespace,id){return db.transaction(()=>{audit();ownerRef(namespace,id);return immutable(projection(namespace,id));})();}
 function insertGrants(namespace,id,requested){const insert=db.prepare('INSERT OR IGNORE INTO docs_writer_resources VALUES (?,?,?,?,?)');for(const r of requested)insert.run(namespace,id,r.id,r.role,r.grantKind);}
 function grant(namespace,id,requested,kind='grant'){
  const old=get(namespace,id),full=extendWriterGrants(old.grants,requested,kind);if(full.length===old.grants.length)return;
  withinCredit(namespace,id,(full.length-old.grants.length)*512);
  event(namespace,id,{kind:'grants',resources:full},()=>insertGrants(namespace,id,full));
 }
 function event(namespace,id,e,apply){
  const old=get(namespace,id);writerCheck(old,'unknown');const next=nextWriterFact(old,e);writerCheck(length(e)<=WRITER_LIMITS.eventBytes,'capacity');withinCredit(namespace,id,length(next)-length(old)+length(e));
  writerCheck(db.prepare('UPDATE docs_writer_owners SET record=?,digest=?,reserved_bytes=? WHERE namespace=? AND operation_id=? AND digest=?').run(JSON.stringify(next),writerDigest(next),next.disposition==='held'?WRITER_LIMITS.reservedBytes:0,namespace,id,writerDigest(old)).changes===1,'conflict');db.prepare('INSERT INTO docs_writer_events VALUES (?,?,?,?)').run(namespace,id,next.sequence,JSON.stringify(e));if(apply)apply();if(next.disposition==='released')db.prepare('DELETE FROM docs_writer_resources WHERE namespace=? AND operation_id=?').run(namespace,id);audit();return next;
 }
 function acquire(namespace,op,kind,commit=()=>true){return db.transaction(()=>{
  const requested=writerResources(kind,op),prior=get(namespace,op.operationId);
  const semanticOperation=()=>{
   writerCheck(kind==='content','unsupported');
   const row=db.prepare('SELECT CASE WHEN length(CAST(header AS BLOB))<=? THEN header ELSE NULL END header,digest FROM docs_semantic_execution WHERE operation_id=?').get(SEAL_LIMITS.headerBytes,op.operationId);writerCheck(row,'unsupported');
   let header;try{header=JSON.parse(row.header);}catch{throw writerError('corrupt');}writerCheck(writerDigest(header)===row.digest,'corrupt');
   return semanticClaimOperation(header,op,requested);
  };
  if(namespace==='semantic'&&prior)semanticOperation();
  if(kind==='nativeCreate'&&!op.documentId&&!op.spreadsheetId&&!op.fileId)writerCheck(requested.length<=WRITER_LIMITS.resourcesPerOwner-2,'capacity');if(prior){writerCheck(prior.subject===op.subject,'owner');writerCheck(prior.disposition==='held','terminal');extendWriterGrants(prior.grants,requested);}
  if(!allowed(namespace,op.operationId,requested))return false;
  if(!prior){let r=namespace==='semantic'?null:writerOwner(namespace,op);writerAdmission(usage(),WRITER_LIMITS.reservedBytes,1);if(namespace==='legacyReplacement')writerCheck(!db.prepare('SELECT 1 FROM docs_semantic_drafts WHERE operation_id=?').get(op.operationId)&&!legacyTables.some(t=>db.prepare(`SELECT 1 FROM ${t} WHERE operation_id=?`).get(op.operationId))&&!db.prepare('SELECT 1 FROM docs_writer_owners WHERE operation_id=?').get(op.operationId),'key_conflict');
   if(!commit())return false;if(namespace==='semantic')r=writerOwner(namespace,semanticOperation());db.prepare('INSERT INTO docs_writer_owners VALUES (?,?,?,?,?,?,?)').run(namespace,op.operationId,op.subject,JSON.stringify(r),JSON.stringify(r),writerDigest(r),WRITER_LIMITS.reservedBytes);insertGrants(namespace,op.operationId,r.grants);audit();
  }else{if(!commit())return false;grant(namespace,op.operationId,requested);}return true;
 })();}
 function markerSnapshot(key){
  ownerRef('docs_creations',key);audit();const rows=[];
  for(const namespace of ['docs_creations','drive_filing_operations']){
   const row=db.prepare(`SELECT operation_id AS key,subject,${namespace==='docs_creations'?'NULL':'state'} AS state,${namespace==='docs_creations'?'NULL':'resource'} AS resource,CASE WHEN length(cast(receipt AS BLOB))<=? THEN receipt ELSE NULL END AS receipt FROM ${namespace} WHERE operation_id=?`).get(WRITER_LIMITS.recordBytes,key);
   if(row)rows.push({namespace,...row});
  }
  return immutable({rows,owner:load('docs_creations',key)});
 }
 // Purpose-specific raw read cut. No admission decision, semantic actor or write.
 function readTargetContextFacts(input){return db.transaction(()=>{
  writerCheck(input&&Object.keys(input).length===2&&Array.isArray(input.resourceIds)&&Array.isArray(input.markerKeys),'invalid');
  const {resourceIds,markerKeys}=input;
  writerCheck(resourceIds.length>0&&resourceIds.length<=WRITER_LIMITS.resourcesPerOwner&&new Set(resourceIds).size===resourceIds.length&&resourceIds.every(id=>typeof id==='string'&&/^[\w-]{1,256}$/.test(id)),'capacity');
  writerCheck(markerKeys.length<=WRITER_LIMITS.resourcesPerOwner&&new Set(markerKeys).size===markerKeys.length&&markerKeys.every(id=>typeof id==='string'&&/^[\w-]{1,128}$/.test(id)),'capacity');
  audit();
  const wanted=new Set(resourceIds),owners=[],legacy=[];let capturedBytes=0;
  const charge=value=>{capturedBytes+=length(value);writerCheck(capturedBytes<=8*1024*1024,'capacity');};
  for(const identity of db.prepare('SELECT namespace,operation_id FROM docs_writer_owners ORDER BY namespace,operation_id').iterate()){
   const {namespace,operation_id:id}=identity,r=load(namespace,id);
   if(!r.grants.some(g=>wanted.has(g.id))&&!(r.disposition==='held'&&[r.createdId,...r.observedIds].some(value=>wanted.has(value))))continue;
   const row=db.prepare('SELECT subject,initial_record,record,digest FROM docs_writer_owners WHERE namespace=? AND operation_id=?').get(namespace,id);
   const events=db.prepare('SELECT sequence,event FROM docs_writer_events WHERE namespace=? AND operation_id=? ORDER BY sequence').all(namespace,id);
   const facts={namespace,key:id,...row,events,resources:projection(namespace,id)};charge(facts);owners.push(facts);
  }
  eachLegacy(resourceIds.map(id=>({id,role:'accessStable'})),row=>{charge(row);legacy.push(row);});
  const markers=markerKeys.map(key=>{const entry={key,...markerSnapshot(key)};charge(entry);return entry;});
  const body={version:1,resourceIds:[...resourceIds],owners,legacy,markers};
  return immutable({...body,capturedBytes,digest:writerDigest(body)});
 })();}
 const api={get,resources,readTargetContextFacts,
  markerCandidates(key){return db.transaction(()=>markerSnapshot(key))();},
  observeNativeMarker(input){return db.transaction(()=>{
   writerCheck(input&&Object.keys(input).length===5&&['observerSubject','metadata','expectedLegacyDigest','expectedOwnerDigest','expectedMetadataDigest'].every(k=>Object.hasOwn(input,k)),'marker');
   const marker=targetMarker(input.metadata);writerCheck(marker?.marker==='paDocsCreation','marker');const snapshot=markerSnapshot(marker.key),decision=classifyWriterMarker(input.metadata,snapshot);
   writerCheck(decision.kind==='nativeObservation'&&decision.legacyDigest===input.expectedLegacyDigest&&decision.ownerDigest===input.expectedOwnerDigest&&decision.metadataDigest===input.expectedMetadataDigest,'conflict');
   writerCheck(typeof input.observerSubject==='string'&&db.prepare('SELECT subject FROM drive_accounts WHERE subject=?').get(input.observerSubject)?.subject===input.observerSubject,'owner');
   if(snapshot.owner.observedIds.includes(input.metadata.id))return immutable({kind:'alreadyObserved'});
   writerCheck(snapshot.owner.sequence<WRITER_LIMITS.eventsPerOwner,'capacity');
   event('docs_creations',marker.key,nativeMarkerFact(snapshot.owner,input.observerSubject,input.metadata,decision));return immutable({kind:'observedPendingId'});
  })();},
  acquire,
  compatible(namespace,op,kind){return db.transaction(()=>allowed(namespace,op.operationId,writerResources(kind,op)))();},
  cancelSemantic(id,owner,headerDigest){return db.transaction(()=>{const r=get('semantic',id);writerCheck(r,'unknown');const row=db.prepare('SELECT header,record FROM docs_semantic_execution WHERE operation_id=?').get(id);preparedSemanticCancellation({header:JSON.parse(row.header),record:JSON.parse(row.record)},owner,r);writerCheck(r?.subject===owner.subject&&r.semanticHeaderDigest===headerDigest&&r.phase==='claimed'&&r.submission==='not_sent'&&r.intentStage===null,'owner');return event('semantic',id,{kind:'knownNotSent'});})();},
  start(namespace,op,stage,commit=()=>true){writerCheck(namespace!=='semantic','unsupported');return db.transaction(()=>{const r=get(namespace,op.operationId);writerCheck(r?.subject===op.subject&&r.disposition==='held','owner');const requested=projection(namespace,op.operationId).map(({id,role})=>({id,role}));if(!allowed(namespace,op.operationId,requested)||!commit())return false;event(namespace,op.operationId,{kind:'intent',stage});return true;})();},
  fact(namespace,id,e){writerCheck(namespace!=='semantic'&&!['grants','markerObservedId'].includes(e?.kind),'unsupported');return db.transaction(()=>event(namespace,id,e))();},
  finishLegacy(namespace,op,e){writerCheck(namespace!=='semantic','unsupported');return db.transaction(()=>{const r=get(namespace,op.operationId);if(!r)return null;writerCheck(r.subject===op.subject,'owner');if(r.disposition==='released')return r;if(e){writerCheck(!['grants','markerObservedId'].includes(e.kind),'unsupported');return event(namespace,op.operationId,e);}if(r.submission==='not_sent'&&['expired','cancelled','declined','approval_unavailable','approval_required','not_submitted','rejected'].includes(op.state??op.claimState??op.outcome))return event(namespace,op.operationId,{kind:'knownNotSent'});return r;})();},
  returned(namespace,op,kind,fact,commit){return db.transaction(()=>{writerCheck(['ack','observedId'].includes(fact?.kind),'unsupported');const r=get(namespace,op.operationId),id=op.documentId??op.spreadsheetId??op.fileId;writerCheck(r?.subject===op.subject&&r.operationKind===(op.kind??'document'),'owner');writerCheck((fact.documentId??fact.id)===id,'corrupt');writerCheck(commit()!==false,'storage');event(namespace,op.operationId,fact);
   let attached=false,reason='resource_conflict';try{attached=db.transaction(()=>{const requested=writerResources(kind,op);if(!allowed(namespace,op.operationId,requested))return false;grant(namespace,op.operationId,requested);return true;})();}catch(error){attached=false;reason=attachmentReason(error);}
   if(!attached){event(namespace,op.operationId,{kind:'attachmentBlocked',id,reason});return false;}return true;
  })();},
  inspect(owner,namespace,id){return db.transaction(()=>{const r=get(namespace,id);writerCheck(r?.subject===owner.subject,'unknown');return immutable({facts:r,resources:resources(namespace,id),thisCall:{providerMutationCount:0},retrySafe:false,semanticExecution:'notImplemented',scope:'legacy-coordination-only'});})();},
 };
 return api;
}
