// Additive read evidence only. Never updates legacy receipts or execution claims.
import { randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { LIMITS, digest, freeze, requireValue, semanticError, jsonBytes, boundedTree } from '../core/docs-semantic/common.mjs';
import {SEAL_LIMITS,executionReference,checkExecutionReference,sealOwner,validateSeal} from '../core/docs-semantic/seal-policy.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
import { checkSnapshotOwner as checkOwner, checkSnapshotTime as time, checkSnapshotLive, validateStoredModel, validateCursorState, validateDelivery, checkSnapshotAdmission, nextReadWork, checkPin, checkNewWitness, checkRetainedWitness } from '../core/docs-semantic/snapshot-policy.mjs';
export { READ_WORK_BYTES } from '../core/docs-semantic/snapshot-policy.mjs';
export const SEMANTIC_SNAPSHOT_MIGRATION = `
CREATE TABLE docs_semantic_evidence (digest TEXT PRIMARY KEY, bytes INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE docs_semantic_snapshots (id TEXT PRIMARY KEY, subject TEXT NOT NULL, account TEXT NOT NULL, thread TEXT NOT NULL,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, evidence_digest TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, model_digest TEXT NOT NULL);
CREATE TABLE docs_semantic_cursors (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE docs_semantic_pins (snapshot TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(snapshot,owner));
CREATE TABLE docs_semantic_delivery (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX docs_semantic_owner ON docs_semantic_snapshots(subject,thread);
`;
// Append-only bookkeeping migration. Historical read evidence is deliberately
// NOT sealed/backfilled: its observations cannot certify old delivery claims.
export const SEMANTIC_BOOKKEEPING_MIGRATION = `
CREATE TABLE docs_semantic_integrity (kind TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kind,id,snapshot));
CREATE TABLE docs_semantic_read_work (snapshot TEXT NOT NULL, id TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(snapshot,id));
`;
const tokenPattern=/^[A-Za-z0-9_-]{1,128}$/;
const token=value=>requireValue(typeof value==='string'&&tokenPattern.test(value),'invalid');
const size=value=>Buffer.byteLength(value);
// Includes conservative row/index overhead as well as logical AND compressed
// bytes. This is a bounded live-data reservation, not SQLite file-size reporting.
export const STORE_ROW_BYTES=256;
export function createSemanticSnapshotStore(db,{ids=randomUUID,limits=LIMITS}={}) {
  const getRow=id=>db.prepare(`SELECT id,subject,account,thread,created,expires,evidence_digest,bytes,model_digest,
    length(data) AS compressed_bytes FROM docs_semantic_snapshots WHERE id=?`).get(id);
  function rowBinding(row) {
    return {id:row.id,subject:row.subject,account:row.account,thread:row.thread,created:row.created,expires:row.expires,
      evidence_digest:row.evidence_digest,bytes:row.bytes,model_digest:row.model_digest};
  }
  function seal(kind,id,snapshot,value) {
    db.prepare('INSERT INTO docs_semantic_integrity VALUES (?,?,?,?)').run(kind,id,snapshot,digest({kind,id,snapshot,value}));
  }
  function verify(kind,id,snapshot,value) {
    const row=db.prepare('SELECT snapshot,digest FROM docs_semantic_integrity WHERE kind=? AND id=? AND snapshot=?').get(kind,id,snapshot);
    if(!row){
      // A snapshot with no seal is unsupported retained evidence. A missing
      // child seal under a sealed B snapshot is corruption, not an A upgrade.
      const parent=kind==='snapshot'?null:db.prepare("SELECT 1 FROM docs_semantic_integrity WHERE kind='snapshot' AND id=? AND snapshot=?").get(snapshot,snapshot);
      requireValue(parent,'unsupported');throw semanticError('corrupt');
    }
    requireValue(row.snapshot===snapshot&&row.digest===digest({kind,id,snapshot,value}),'corrupt');
  }
  function integrityBytes(kind,id,snapshot) {return STORE_ROW_BYTES+2*size(kind+id+snapshot)+64;}
  const validateModel=(result,row)=>validateStoredModel(result,row,limits);
  function decode(row) {
    try {
      verify('snapshot',row.id,row.id,rowBinding(row));
      const saved=db.prepare('SELECT bytes,length(data) AS compressed_bytes FROM docs_semantic_evidence WHERE digest=?').get(row.evidence_digest);
      requireValue(saved&&Number.isSafeInteger(saved.bytes)&&saved.bytes>0&&saved.bytes<=limits.providerBytes&&Number.isSafeInteger(row.bytes)&&row.bytes>0&&row.bytes<=limits.poolBytes,'corrupt');
      requireValue(saved.compressed_bytes<=limits.providerBytes+1024&&row.compressed_bytes<=limits.poolBytes+16384,'corrupt');
      // SQLite checks lengths before returning BLOBs to JavaScript.
      const evidenceBlob=db.prepare('SELECT data FROM docs_semantic_evidence WHERE digest=?').get(row.evidence_digest).data;
      const modelBlob=db.prepare('SELECT data FROM docs_semantic_snapshots WHERE id=?').get(row.id).data;
      // Trust no compressed-size ratio. Output allocations are capped by the
      // recorded bounded sizes, and exact byte/digest checks precede JSON use.
      const raw=inflateSync(evidenceBlob,{maxOutputLength:saved.bytes});
      const body=inflateSync(modelBlob,{maxOutputLength:row.bytes});
      requireValue(raw.length===saved.bytes&&body.length===row.bytes&&digest(raw.toString())===row.evidence_digest&&digest(body.toString())===row.model_digest,'corrupt');
      const result=JSON.parse(body.toString());result.evidence=JSON.parse(raw.toString());
      boundedTree(result,{...limits,providerBytes:limits.poolBytes,nodes:1000000,depth:96});
      validateModel(result,row);return freeze(result);
    } catch {throw semanticError('corrupt');}
  }
  const executionRefsPresent=()=>{
    const present=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='docs_semantic_execution_refs'").get());
    if(!present&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='docs_semantic_execution'").get())requireValue(!db.prepare('SELECT 1 FROM docs_semantic_execution LIMIT 1').get(),'corrupt');
    return present;
  };
  function stats() {
    if(executionRefsPresent())requireValue(!db.prepare('SELECT 1 FROM docs_semantic_execution_refs WHERE reserved_bytes!=? LIMIT 1').get(SEAL_LIMITS.futureCredit),'corrupt');
    const queries=[
      `SELECT coalesce(sum(bytes+length(data)+2*length(digest)+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_evidence`,
      `SELECT coalesce(sum(bytes+length(data)+length(CAST(id||subject||account||thread||evidence_digest||model_digest||id||subject||thread AS BLOB))+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_snapshots`,
      `SELECT coalesce(sum(length(CAST(id||id||snapshot||state AS BLOB))+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_cursors`,
      `SELECT coalesce(sum(length(CAST(id||id||snapshot||data AS BLOB))+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_delivery`,
      `SELECT coalesce(sum(2*length(CAST(snapshot||owner AS BLOB))+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_pins`,
      `SELECT coalesce(sum(length(CAST(kind||id||snapshot||kind||id||snapshot||digest AS BLOB))+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_integrity`,
      `SELECT coalesce(sum(2*length(CAST(snapshot||id AS BLOB))+${STORE_ROW_BYTES}),0) AS n FROM docs_semantic_read_work`
    ];
    if(executionRefsPresent())queries.push(`SELECT coalesce(sum(reserved_bytes+length(CAST(receipt||digest||operation_id||snapshot||subject AS BLOB))+${STORE_ROW_BYTES}),0) n FROM docs_semantic_execution_refs`);
    return {snapshots:db.prepare('SELECT count(*) AS n FROM docs_semantic_snapshots').get().n,bytes:queries.reduce((sum,sql)=>sum+db.prepare(sql).get().n,0)};
  }
  function capacity(extra){requireValue(Number.isSafeInteger(extra)&&extra>=0&&stats().bytes+extra<=limits.poolBytes,'budget');}
  function sweep(now) {
    time(now);
    db.transaction(()=>{
      if(executionRefsPresent()){
        let count=0;
        for(const saved of db.prepare('SELECT CASE WHEN length(CAST(header AS BLOB))<=65536 THEN header ELSE NULL END header,digest,CASE WHEN length(CAST(record AS BLOB))<=4096 THEN record ELSE NULL END record,record_digest FROM docs_semantic_execution LIMIT 1025').iterate()){
          requireValue(++count<=1024,'budget');
          try{const seal={header:JSON.parse(saved.header),record:JSON.parse(saved.record)};validateSeal(seal);requireValue(draftHash(seal.header)===saved.digest&&draftHash(seal.record)===saved.record_digest,'corrupt');}catch{throw semanticError('corrupt');}
        }
      }
      // Unsealed A rows are retained verbatim, including expired pins/cursors.
      // Only known B bookkeeping participates in automatic read-data cleanup.
      db.prepare(`DELETE FROM docs_semantic_cursors WHERE expires<=? AND EXISTS
        (SELECT 1 FROM docs_semantic_integrity i WHERE i.kind='cursor' AND i.id=docs_semantic_cursors.id AND i.snapshot=docs_semantic_cursors.snapshot)`).run(now);
      db.prepare(`DELETE FROM docs_semantic_pins WHERE expires<=? AND EXISTS
        (SELECT 1 FROM docs_semantic_integrity i WHERE i.kind='pin' AND i.id=docs_semantic_pins.owner AND i.snapshot=docs_semantic_pins.snapshot)`).run(now);
      const removed=db.prepare(`DELETE FROM docs_semantic_snapshots WHERE expires<=?
        AND id NOT IN (SELECT snapshot FROM docs_semantic_pins)
        ${executionRefsPresent()?`AND id NOT IN (SELECT snapshot FROM docs_semantic_execution_refs)
        AND NOT EXISTS(SELECT 1 FROM docs_semantic_execution e WHERE NOT json_valid(e.header) OR CASE WHEN json_valid(e.header) THEN json_type(e.header,'$.before.snapshotId') IS NOT 'text' OR json_extract(e.header,'$.before.snapshotId')=docs_semantic_snapshots.id ELSE 1 END)`:''}
        AND EXISTS (SELECT 1 FROM docs_semantic_integrity i WHERE i.kind='snapshot' AND i.id=docs_semantic_snapshots.id AND i.snapshot=docs_semantic_snapshots.id)
        RETURNING evidence_digest`).all(now);
      for(const [table,kind,key] of [['docs_semantic_cursors','cursor','id'],['docs_semantic_delivery','delivery','id'],['docs_semantic_pins','pin','owner'],['docs_semantic_read_work','work','id']])
        db.prepare(`DELETE FROM ${table} WHERE snapshot NOT IN (SELECT id FROM docs_semantic_snapshots)
          AND EXISTS (SELECT 1 FROM docs_semantic_integrity i WHERE i.kind=? AND i.id=${table}.${key} AND i.snapshot=${table}.snapshot)`).run(kind);
      for(const {evidence_digest:hash} of removed)
        db.prepare('DELETE FROM docs_semantic_evidence WHERE digest=? AND digest NOT IN (SELECT evidence_digest FROM docs_semantic_snapshots)').run(hash);
      db.prepare(`DELETE FROM docs_semantic_integrity WHERE snapshot NOT IN (SELECT id FROM docs_semantic_snapshots)
        OR (kind='cursor' AND id NOT IN (SELECT id FROM docs_semantic_cursors))
        OR (kind='pin' AND NOT EXISTS (SELECT 1 FROM docs_semantic_pins p WHERE p.snapshot=docs_semantic_integrity.snapshot AND p.owner=docs_semantic_integrity.id))`).run();
    })();
  }
  function checkPageTokens(tokens) {
    token(tokens?.deliveryToken);token(tokens?.nextCursor);
    requireValue(tokens.deliveryToken!==tokens.nextCursor,'conflict');return Object.freeze({...tokens});
  }
  const pageTokens=()=>checkPageTokens({deliveryToken:ids(),nextCursor:ids()});
  function live(id,owner,now) {
    time(now);const row=getRow(id);checkOwner(row,owner);
    verify('snapshot',row.id,row.id,rowBinding(row));checkSnapshotLive(row,now);return row;
  }
  function cursorData(row,state) {
    // Decode/integrity is technical; continuation meaning is core policy.
    jsonBytes(state,limits.pageBytes);return validateCursorState(decode(row),state,limits);
  }
  function cursorBytes(id,snapshot,state) {return STORE_ROW_BYTES+2*size(id)+size(snapshot)+size(state)+integrityBytes('cursor',id,snapshot);}
  function saveCursor(id,row,state,now) {
    const expires=Math.min(now+limits.cursorMs,row.expires);
    db.prepare('INSERT INTO docs_semantic_cursors VALUES (?,?,?,?)').run(id,row.id,expires,state);
    seal('cursor',id,row.id,{binding:rowBinding(row),expires,state});
  }
  function deliveryData(row,delivery) {
    jsonBytes(delivery,limits.pageBytes);return validateDelivery(decode(row),delivery,limits);
  }
  function deliveryBytes(id,snapshot,data){return STORE_ROW_BYTES+2*size(id)+size(snapshot)+size(data)+integrityBytes('delivery',id,snapshot);}
  function saveDelivery(id,row,data) {
    db.prepare('INSERT INTO docs_semantic_delivery VALUES (?,?,?)').run(id,row.id,data);
    seal('delivery',id,row.id,{binding:rowBinding(row),data});
  }
  // Shared bounded accessor. Retained witnesses use this only after validating
  // the exact existing pin; ordinary deliveries still require live snapshots.
  function storedDeliveries(row,tokens) {
    requireValue(Array.isArray(tokens)&&tokens.length<=1000&&new Set(tokens).size===tokens.length);
    let bytes=0;
    return tokens.map(idToken=>{
      token(idToken);
      const measured=db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM docs_semantic_delivery WHERE snapshot=? AND id=?').get(row.id,idToken);
      requireValue(measured,'snapshot');requireValue(measured.bytes<=limits.pageBytes,'corrupt');
      bytes+=measured.bytes;requireValue(bytes<=limits.modelBytes,'budget');
      const saved=db.prepare('SELECT data FROM docs_semantic_delivery WHERE snapshot=? AND id=?').get(row.id,idToken);
      verify('delivery',idToken,row.id,{binding:rowBinding(row),data:saved.data});
      try{return JSON.parse(saved.data);}catch{throw semanticError('corrupt');}
    });
  }
  // Shared sealed read; peeking does not consume. Native packing/work charging
  // may fail before commitPage atomically consumes and publishes continuation.
  function readCursor(cursor,owner,now,expectedSnapshot) {
    time(now);token(cursor);
    const row=db.prepare('SELECT id,snapshot,expires,length(CAST(state AS BLOB)) AS state_bytes FROM docs_semantic_cursors WHERE id=?').get(cursor);
    requireValue(row&&now<row.expires&&(!expectedSnapshot||row.snapshot===expectedSnapshot),'snapshot');
    requireValue(row.state_bytes<=limits.pageBytes,'corrupt');
    row.state=db.prepare('SELECT state FROM docs_semantic_cursors WHERE id=?').get(cursor).state;
    const saved=live(row.snapshot,owner,now);
    verify('cursor',cursor,row.snapshot,{binding:rowBinding(saved),expires:row.expires,state:row.state});
    requireValue(size(row.state)<=limits.pageBytes,'corrupt');
    let state;try{state=JSON.parse(row.state);}catch{throw semanticError('corrupt');}
    const snapshot=decode(saved);cursorData(saved,state);
    return {snapshot,state};
  }
  function consumeCursor(cursor,owner,now,expectedSnapshot){return db.transaction(()=>{
    const result=readCursor(cursor,owner,now,expectedSnapshot);
    db.prepare('DELETE FROM docs_semantic_cursors WHERE id=?').run(cursor);
    db.prepare("DELETE FROM docs_semantic_integrity WHERE kind='cursor' AND id=?").run(cursor);
    return result;
  })();}
  const api = {
    stats,sweep,pageTokens,
    checkExecutionAdmission(header,snapshot){
      requireValue(executionRefsPresent(),'unsupported');
      const row=getRow(header.before.snapshotId);requireValue(row,'snapshot');
      checkOwner(row,{subject:header.subject,account:header.account,threadId:header.threadId});
      const ref=executionReference(header,rowBinding(row));
      checkExecutionReference(ref,header,snapshot,rowBinding(row));
      requireValue(Buffer.byteLength(JSON.stringify(ref))<=65536,'budget');
      capacity(header.futureCredit+Buffer.byteLength(JSON.stringify(ref))+Buffer.byteLength(header.operationId+row.id+header.subject)+64+STORE_ROW_BYTES);
      return ref;
    },
    retainExecution(header,snapshot){
      const ref=api.checkExecutionAdmission(header,snapshot);
      db.prepare('INSERT INTO docs_semantic_execution_refs VALUES (?,?,?,?,?,?)').run(header.operationId,header.before.snapshotId,header.subject,JSON.stringify(ref),draftHash(ref),header.futureCredit);
    },
    readExecutionEvidence(header,owner){
      sealOwner(header,owner);requireValue(executionRefsPresent(),'unsupported');
      const saved=db.prepare('SELECT snapshot,subject,CASE WHEN length(CAST(receipt AS BLOB))<=65536 THEN receipt ELSE NULL END receipt,digest,reserved_bytes FROM docs_semantic_execution_refs WHERE operation_id=?').get(header.operationId);
      requireValue(saved&&saved.snapshot===header.before.snapshotId&&saved.subject===header.subject&&saved.reserved_bytes===header.futureCredit,'corrupt');
      let ref;try{ref=JSON.parse(saved.receipt);}catch{throw semanticError('corrupt');}
      requireValue(draftHash(ref)===saved.digest,'corrupt');
      const row=getRow(saved.snapshot);checkOwner(row,{subject:header.subject,account:header.account,threadId:header.threadId});
      requireValue(row.bytes<=header.before.modelBytes&&row.evidence_digest===header.before.evidenceDigest&&draftHash(ref.rowBinding)===draftHash(rowBinding(row)),'corrupt');
      const evidence=db.prepare('SELECT bytes FROM docs_semantic_evidence WHERE digest=?').get(row.evidence_digest);
      requireValue(evidence?.bytes===header.before.rawBytes&&row.bytes+evidence.bytes<=header.before.modelBytes,'corrupt');
      const snapshot=decode(row);checkExecutionReference(ref,header,snapshot,rowBinding(row));return snapshot;
    },
    put(snapshot,now) {return db.transaction(()=>{
      time(now);
      boundedTree(snapshot,{...limits,providerBytes:limits.poolBytes,nodes:1000000,depth:96});
      sweep(now);requireValue(!getRow(snapshot.binding.snapshotId),'conflict');
      const b=snapshot.binding;
      checkSnapshotAdmission(b,now,0,limits); // Validate before binding untrusted values to SQL.
      checkSnapshotAdmission(b,now,db.prepare('SELECT count(*) AS n FROM docs_semantic_snapshots WHERE subject=? AND thread=?').get(b.subject,b.threadId).n,limits);
      const {evidence,...rest}=snapshot;
      jsonBytes(evidence,limits.providerBytes);jsonBytes(rest,limits.poolBytes);
      const raw=JSON.stringify(evidence),data=JSON.stringify(rest),hash=digest(raw);
      requireValue(hash===snapshot.evidenceDigest,'corrupt');
      const exists=db.prepare('SELECT 1 FROM docs_semantic_evidence WHERE digest=?').get(hash);
      capacity(size(data)+(exists?0:size(raw)));
      const compressedModel=deflateSync(data),compressedEvidence=exists?null:deflateSync(raw);
      const row={id:b.snapshotId,subject:b.subject,account:b.account,thread:b.threadId,created:now,expires:b.retrievedAt+limits.snapshotMs,
        evidence_digest:hash,bytes:size(data),model_digest:digest(data)};
      validateModel(snapshot,row);
      const snapshotBytes=size(data)+compressedModel.length+size(b.snapshotId+b.subject+b.account+b.threadId+hash+row.model_digest+b.snapshotId+b.subject+b.threadId)+STORE_ROW_BYTES+integrityBytes('snapshot',b.snapshotId,b.snapshotId);
      capacity(snapshotBytes+(exists?0:size(raw)+compressedEvidence.length+2*size(hash)+STORE_ROW_BYTES));
      if(!exists)db.prepare('INSERT INTO docs_semantic_evidence VALUES (?,?,?)').run(hash,size(raw),compressedEvidence);
      db.prepare('INSERT INTO docs_semantic_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)').run(b.snapshotId,b.subject,b.account,b.threadId,now,row.expires,hash,size(data),compressedModel,row.model_digest);
      seal('snapshot',b.snapshotId,b.snapshotId,rowBinding(row));
    })();},
    get(id,owner,now){return decode(live(id,owner,now));},
    issueCursor(id,owner,state,now){return db.transaction(()=>{
      const row=live(id,owner,now),data=cursorData(row,state),cursor=ids();token(cursor);
      capacity(cursorBytes(cursor,id,data));saveCursor(cursor,row,data,now);return cursor;
    })();},
    peekCursor(cursor,owner,now,expectedSnapshot){return db.transaction(()=>readCursor(cursor,owner,now,expectedSnapshot))();},
    consumeCursor,
    deliver(id,owner,delivery,now){return db.transaction(()=>{
      const row=live(id,owner,now),data=deliveryData(row,delivery),deliveryToken=ids();token(deliveryToken);
      capacity(deliveryBytes(deliveryToken,id,data));saveDelivery(deliveryToken,row,data);return deliveryToken;
    })();},
    commitPage(id,owner,delivery,nextState,now,tokens=pageTokens(),continuation){return db.transaction(()=>{
      const reserved=checkPageTokens(tokens),row=live(id,owner,now);
      if(continuation){
        requireValue(reserved.deliveryToken!==continuation.cursor&&reserved.nextCursor!==continuation.cursor,'conflict');
        jsonBytes(continuation.state,limits.pageBytes);
        const consumed=consumeCursor(continuation.cursor,owner,now,id);
        requireValue(digest(consumed.state)===digest(continuation.state),'conflict');
      }
      const data=deliveryData(row,delivery),state=nextState?cursorData(row,nextState):null;
      const deliveryToken=reserved.deliveryToken,nextCursor=state?reserved.nextCursor:null;
      capacity(deliveryBytes(deliveryToken,id,data)+(state?cursorBytes(nextCursor,id,state):0));
      saveDelivery(deliveryToken,row,data);if(state)saveCursor(nextCursor,row,state,now);
      return {deliveryToken,nextCursor};
    })();},
    deliveries(id,owner,now,tokens){
      return storedDeliveries(live(id,owner,now),tokens);
    },
    chargeReadWork(id,owner,readId,bytes,now){return db.transaction(()=>{
      live(id,owner,now);token(readId);nextReadWork(0,bytes,limits);
      const old=db.prepare('SELECT bytes FROM docs_semantic_read_work WHERE snapshot=? AND id=?').get(id,readId);
      if(old)verify('work',readId,id,{bytes:old.bytes});
      const total=nextReadWork(old?.bytes??0,bytes,limits);
      if(!old)capacity(STORE_ROW_BYTES+2*size(id+readId)+integrityBytes('work',readId,id));
      db.prepare('INSERT INTO docs_semantic_read_work VALUES (?,?,?) ON CONFLICT(snapshot,id) DO UPDATE SET bytes=excluded.bytes').run(id,readId,total);
      if(old)db.prepare("DELETE FROM docs_semantic_integrity WHERE kind='work' AND id=? AND snapshot=?").run(readId,id);
      seal('work',readId,id,{bytes:total});
    })();},
    pin(id,owner,pinOwner,now,expires){return db.transaction(()=>{
      const row=live(id,owner,now);token(pinOwner);
      checkPin(now,expires,undefined,0,limits);
      const previous=db.prepare('SELECT expires FROM docs_semantic_pins WHERE snapshot=? AND owner=?').get(id,pinOwner);
      if(previous)verify('pin',pinOwner,id,{binding:rowBinding(row),expires:previous.expires});
      checkPin(now,expires,previous?.expires,db.prepare('SELECT count(*) AS n FROM docs_semantic_pins WHERE snapshot=?').get(id).n,limits);
      if(!previous){
        capacity(STORE_ROW_BYTES+2*size(id+pinOwner)+integrityBytes('pin',pinOwner,id));
        db.prepare('INSERT INTO docs_semantic_pins VALUES (?,?,?)').run(id,pinOwner,expires);
        seal('pin',pinOwner,id,{binding:rowBinding(row),expires});
      }
    })();},
    readPinned(id,owner,pinOwner,now){
      time(now);const row=getRow(id);checkOwner(row,owner);token(pinOwner);
      const pin=db.prepare('SELECT expires FROM docs_semantic_pins WHERE snapshot=? AND owner=?').get(id,pinOwner);
      requireValue(pin&&now<pin.expires,'snapshot');verify('pin',pinOwner,id,{binding:rowBinding(row),expires:pin.expires});return decode(row);
    },
    // Internal read-evidence persistence, not a draft or reservation. Reuses
    // existing immutable delivery records and B pins in one SQLite transaction;
    // migrations 0..9 and unsupported unsealed history remain untouched.
    retainWitness(id,owner,pinOwner,record,now,expires){return db.transaction(()=>{
      checkNewWitness(record,db.prepare('SELECT 1 FROM docs_semantic_pins WHERE snapshot=? AND owner=?').get(id,pinOwner));
      api.pin(id,owner,pinOwner,now,expires);
      const deliveryToken=api.deliver(id,owner,record,now);
      return {pinId:pinOwner,expires,deliveryToken};
    })();},
    pinnedWitness(id,owner,pinOwner,deliveryToken,now){
      const snapshot=api.readPinned(id,owner,pinOwner,now),row=getRow(id);
      const pin=db.prepare('SELECT expires FROM docs_semantic_pins WHERE snapshot=? AND owner=?').get(id,pinOwner);
      const [record]=storedDeliveries(row,[deliveryToken]);
      checkRetainedWitness(record,pinOwner,pin.expires);
      storedDeliveries(row,record.references?.deliveryTokens??[]);
      return {snapshot,record,pinId:pinOwner,expires:pin.expires};
    },
    releasePin(id,owner,pinOwner){return db.transaction(()=>{
      const row=getRow(id);checkOwner(row,owner);token(pinOwner);
      verify('snapshot',id,id,rowBinding(row));
      const pin=db.prepare('SELECT expires FROM docs_semantic_pins WHERE snapshot=? AND owner=?').get(id,pinOwner);
      if(pin)verify('pin',pinOwner,id,{binding:rowBinding(row),expires:pin.expires});
      db.prepare('DELETE FROM docs_semantic_pins WHERE snapshot=? AND owner=?').run(id,pinOwner);
      db.prepare("DELETE FROM docs_semantic_integrity WHERE kind='pin' AND id=? AND snapshot=?").run(pinOwner,id);
    })();},
  };
  return api;
}
