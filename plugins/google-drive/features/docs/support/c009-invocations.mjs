// Narrow fixed production boundary for C009. No caller callback, writable log,
// SQL, clock getter or alternate implementation is accepted by these methods.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createReadEvidenceService} from '../../../core/docs-semantic/read-evidence-service.mjs';
import {footprint,evaluateWitness} from '../../../core/docs-semantic/coverage.mjs';
import {modelBinding} from './local-invocations.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const copy=x=>freeze(structuredClone(x));
export function c009InvocationBoundary(db,store){
 let now=0;const records=[],connectionId=randomUUID(),fileDigest=hash(db.name);
 const api=store.semanticSnapshots,names=Object.keys(api).filter(n=>typeof api[n]==='function');
 const originals=Object.fromEntries(names.map(n=>[n,api[n]]));
 const fixed=Object.fromEntries(names.map(n=>[n,originals[n].bind(api)]));
 // Native application code also holds this object. Lock its production methods
 // before exposing the host, including commit/work methods used after awaits.
 Object.freeze(api);
 const guard=()=>{assert.equal(store.semanticSnapshots,api,'C009 production store object replaced');for(const n of names)assert.equal(api[n],originals[n],'C009 production store binding replaced');};
 const service=createReadEvidenceService({snapshots:fixed,clock:()=>now,ids:()=> 'pin-c009'});
 const queries={
  snapshots:'SELECT id,subject,account,thread,created,expires,evidence_digest,model_digest,bytes FROM docs_semantic_snapshots ORDER BY id',
  cursors:'SELECT id,snapshot,expires,state FROM docs_semantic_cursors ORDER BY id',
  deliveries:'SELECT id,snapshot,data FROM docs_semantic_delivery ORDER BY id',
  pins:'SELECT snapshot,owner,expires FROM docs_semantic_pins ORDER BY snapshot,owner',
  work:'SELECT snapshot,id,bytes FROM docs_semantic_read_work ORDER BY snapshot,id',
  integrity:'SELECT kind,id,snapshot,digest FROM docs_semantic_integrity ORDER BY kind,id,snapshot',
 };
 const tables={snapshots:'snapshots',cursors:'cursors',deliveries:'delivery',pins:'pins',work:'read_work',integrity:'integrity'};
 const prepared=Object.fromEntries(Object.entries(queries).map(([name,sql])=>[name,{rows:db.prepare(sql+' LIMIT 129'),count:db.prepare('SELECT count(*) n FROM docs_semantic_'+tables[name])}]));
 const lengths=['cursors','delivery'].map(t=>db.prepare('SELECT coalesce(max(length(CAST('+ (t==='cursors'?'state':'data')+' AS BLOB))),0) n FROM docs_semantic_'+t));
 function observe(operation,args,invoke){
  guard();const entry={id:randomUUID(),sequence:records.length+1,operation,clock:now,connectionId,args:copy(args)};
  try{const result=invoke();records.push(copy({...entry,result}));return result;}
  catch(error){records.push(copy({...entry,error:{category:error.semanticCode??'unexpected'}}));throw error;}
 }
 return Object.freeze({
  clock:()=>now,sequence:()=>records.length,guard,
  advance(value){assert.ok(Number.isSafeInteger(value)&&value>=now&&value<=1800000,'bounded monotone C009 clock');return observe('clock.advance',{from:now,to:value},()=>now=value);},
  get(id,owner){return observe('snapshot.get',{id,owner},()=>fixed.get(id,owner,now));},
  peek(cursor,owner,id){return observe('cursor.peek',{cursor,owner,id},()=>fixed.peekCursor(cursor,owner,now,id));},
  consumeCursor(cursor,owner,id){return observe('cursor.consume',{cursor,owner,id},()=>fixed.consumeCursor(cursor,owner,now,id));},
  deliveries(id,owner,tokens){return observe('delivery.get',{id,owner,tokens},()=>fixed.deliveries(id,owner,now,tokens));},
  pin(id,owner,pinId,expires){return observe('pin.create',{id,owner,pinId,expires},()=>fixed.pin(id,owner,pinId,now,expires));},
  readPinned(id,owner,pinId){return observe('pin.read',{id,owner,pinId},()=>fixed.readPinned(id,owner,pinId,now));},
  release(id,owner,pinId){return observe('pin.release',{id,owner,pinId},()=>fixed.releasePin(id,owner,pinId));},
  coverage(id,owner,tokens,spec){return observe('coverage.evaluate',{id,owner,tokens,spec},()=>{
   const snapshot=fixed.get(id,owner,now),deliveries=fixed.deliveries(id,owner,now,tokens),fp=footprint(snapshot,spec);
   return {model:modelBinding(snapshot),deliveries,footprint:fp,result:evaluateWitness(snapshot,fp,{deliveries})};
  });},
  evaluate(owner,args){return observe('evidence.evaluate',{owner,args},()=>service.evaluate(owner,args));},
  retain(owner,args){return observe('evidence.retain',{owner,args},()=>service.retain(owner,args));},
  consume(owner,handle){return observe('evidence.consume',{owner,handle},()=>service.consume(owner,handle));},
  state(){return observe('sqlite.observe',{},()=>{
   for(const q of Object.values(prepared))assert.ok(q.count.get().n<=128,'C009 row observation bound');
   for(const q of lengths)assert.ok(q.get().n<=65536,'C009 stored record observation bound');
   const result={connectionId,fileDigest,...Object.fromEntries(Object.entries(prepared).map(([k,q])=>[k,q.rows.all()]))};
   assert.ok(Buffer.byteLength(JSON.stringify(result))<=524288,'C009 storage observation byte bound');return result;
  });},
  records:()=>copy(records),
 });
}
