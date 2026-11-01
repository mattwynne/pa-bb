// External snapshot-port substitute only. Real core owns semantic decisions.
// No SDK, SQLite, filesystem, HTTP, fake durability or physical byte accounting.
import { randomUUID } from 'node:crypto';
import { LIMITS, digest, freeze, requireValue, jsonBytes, boundedTree } from '../../../core/docs-semantic/common.mjs';
import { checkSnapshotOwner, checkSnapshotTime, checkSnapshotLive, checkSnapshotAdmission, validateStoredModel, validateCursorState, validateDelivery, nextReadWork, checkPin, checkNewWitness, checkRetainedWitness } from '../../../core/docs-semantic/snapshot-policy.mjs';
const copy=x=>freeze(structuredClone(x));
const token=x=>requireValue(typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x),'invalid');
export function createMemorySnapshots({ids=randomUUID,limits=LIMITS}={}) {
  const rows=new Map(),cursors=new Map(),deliveries=new Map(),pins=new Map(),work=new Map();
  const pair=(a,b)=>JSON.stringify([a,b]);
  function owned(id,owner){const row=rows.get(id);checkSnapshotOwner(row,owner);return row;}
  function live(id,owner,now){checkSnapshotTime(now);const row=owned(id,owner);checkSnapshotLive(row,now);return row;}
  function readCursor(id,owner,now,expected){token(id);const c=cursors.get(id);requireValue(c&&now<c.expires&&(!expected||c.snapshot===expected),'snapshot');const row=live(c.snapshot,owner,now);validateCursorState(row.model,c.state,limits);return {snapshot:copy(row.model),state:copy(c.state)};}
  function records(id,tokens){requireValue(Array.isArray(tokens)&&tokens.length<=1000&&new Set(tokens).size===tokens.length);let bytes=0;return tokens.map(t=>{token(t);const d=deliveries.get(t);requireValue(d?.snapshot===id,'snapshot');bytes+=jsonBytes(d.data,limits.pageBytes);requireValue(bytes<=limits.modelBytes,'budget');return copy(d.data);});}
  const api={
    put(snapshot,now){checkSnapshotTime(now);boundedTree(snapshot,{...limits,providerBytes:limits.poolBytes,nodes:1000000,depth:96});api.sweep(now);const b=snapshot.binding;requireValue(!rows.has(b.snapshotId),'conflict');checkSnapshotAdmission(b,now,[...rows.values()].filter(r=>r.subject===b.subject&&r.thread===b.threadId).length,limits);const row={id:b.snapshotId,subject:b.subject,account:b.account,thread:b.threadId,created:now,expires:b.retrievedAt+limits.snapshotMs,evidence_digest:snapshot.evidenceDigest};const {evidence,...rest}=snapshot;jsonBytes(evidence,limits.providerBytes);jsonBytes(rest,limits.poolBytes);requireValue(digest(JSON.stringify(evidence))===snapshot.evidenceDigest,'corrupt');validateStoredModel(snapshot,row,limits);rows.set(row.id,{...row,model:copy(snapshot)});},
    get(id,owner,now){return copy(live(id,owner,now).model);},
    pageTokens(){const values={deliveryToken:ids(),nextCursor:ids()};token(values.deliveryToken);token(values.nextCursor);requireValue(values.deliveryToken!==values.nextCursor,'conflict');return Object.freeze(values);},
    issueCursor(id,owner,state,now){const row=live(id,owner,now);validateCursorState(row.model,state,limits);const cursor=ids();token(cursor);requireValue(!cursors.has(cursor),'conflict');cursors.set(cursor,{snapshot:id,expires:Math.min(now+limits.cursorMs,row.expires),state:copy(state)});return cursor;},
    peekCursor:readCursor,
    consumeCursor(id,owner,now,expected){const value=readCursor(id,owner,now,expected);cursors.delete(id);return value;},
    deliver(id,owner,data,now){const row=live(id,owner,now);validateDelivery(row.model,data,limits);const t=ids();token(t);requireValue(!deliveries.has(t),'conflict');deliveries.set(t,{snapshot:id,data:copy(data)});return t;},
    deliveries(id,owner,now,tokens){live(id,owner,now);return records(id,tokens);},
    commitPage(id,owner,data,nextState,now,tokens=api.pageTokens(),continuation){
      const row=live(id,owner,now);token(tokens?.deliveryToken);token(tokens?.nextCursor);requireValue(tokens.deliveryToken!==tokens.nextCursor,'conflict');
      if(continuation){requireValue(tokens.deliveryToken!==continuation.cursor&&tokens.nextCursor!==continuation.cursor,'conflict');jsonBytes(continuation.state,limits.pageBytes);const prior=readCursor(continuation.cursor,owner,now,id);requireValue(digest(prior.state)===digest(continuation.state),'conflict');}
      validateDelivery(row.model,data,limits);if(nextState)validateCursorState(row.model,nextState,limits);
      requireValue(!deliveries.has(tokens.deliveryToken)&&(!nextState||!cursors.has(tokens.nextCursor)),'conflict');
      // All fallible checks precede the atomic observable transition.
      const saved=copy(data),state=nextState?copy(nextState):null;
      if(continuation)cursors.delete(continuation.cursor);
      deliveries.set(tokens.deliveryToken,{snapshot:id,data:saved});
      if(state)cursors.set(tokens.nextCursor,{snapshot:id,expires:Math.min(now+limits.cursorMs,row.expires),state});
      return {deliveryToken:tokens.deliveryToken,nextCursor:state?tokens.nextCursor:null};
    },
    chargeReadWork(id,owner,readId,bytes,now){live(id,owner,now);token(readId);const key=pair(id,readId);work.set(key,nextReadWork(work.get(key)??0,bytes,limits));},
    pin(id,owner,pinId,now,expires){live(id,owner,now);token(pinId);const key=pair(id,pinId);checkPin(now,expires,pins.get(key)?.expires,[...pins.values()].filter(p=>p.snapshot===id).length,limits);pins.set(key,{snapshot:id,owner:pinId,expires});},
    readPinned(id,owner,pinId,now){checkSnapshotTime(now);const row=owned(id,owner);token(pinId);const pin=pins.get(pair(id,pinId));requireValue(pin&&now<pin.expires,'snapshot');return copy(row.model);},
    retainWitness(id,owner,pinId,record,now,expires){checkNewWitness(record,pins.has(pair(id,pinId)));const row=live(id,owner,now);token(pinId);checkPin(now,expires,undefined,[...pins.values()].filter(p=>p.snapshot===id).length,limits);validateDelivery(row.model,record,limits);const t=ids();token(t);requireValue(!deliveries.has(t),'conflict');const saved=copy(record);pins.set(pair(id,pinId),{snapshot:id,owner:pinId,expires});deliveries.set(t,{snapshot:id,data:saved});return {pinId,expires,deliveryToken:t};},
    pinnedWitness(id,owner,pinId,t,now){const snapshot=api.readPinned(id,owner,pinId,now),pin=pins.get(pair(id,pinId)),[record]=records(id,[t]);checkRetainedWitness(record,pinId,pin.expires);records(id,record.references?.deliveryTokens??[]);return {snapshot,record,pinId,expires:pin.expires};},
    releasePin(id,owner,pinId){owned(id,owner);token(pinId);pins.delete(pair(id,pinId));},
    sweep(now){checkSnapshotTime(now);for(const [k,p]of pins)if(p.expires<=now)pins.delete(k);for(const [k,c]of cursors)if(c.expires<=now)cursors.delete(k);for(const [k,r]of rows)if(r.expires<=now&&![...pins.values()].some(p=>p.snapshot===k))rows.delete(k);for(const [k,d]of deliveries)if(!rows.has(d.snapshot))deliveries.delete(k);for(const [k,c]of cursors)if(!rows.has(c.snapshot))cursors.delete(k);for(const k of work.keys())if(!rows.has(JSON.parse(k)[0]))work.delete(k);},
  };
  // Explicit test observations, not a database facade or persistence evidence.
  const observe=()=>({snapshots:rows.size,deliveries:deliveries.size,cursors:cursors.size,pins:pins.size,work:copy([...work])});
  const observeDetailed=()=>copy({
    snapshots:[...rows.values()].map(({model,...row})=>row),
    cursors:[...cursors].map(([id,value])=>({id,...value})),
    deliveries:[...deliveries].map(([id,value])=>({id,...value})),
    pins:[...pins.values()],work:[...work].map(([key,bytes])=>{const[snapshot,id]=JSON.parse(key);return{snapshot,id,bytes};}),
  });
  return {observeDetailed,port:new Proxy(api,{get(target,key){if(!(key in target))throw new Error(`Unsupported snapshot port: ${String(key)}`);return target[key];}}),observe};
}
