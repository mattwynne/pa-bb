// Fixed current-run storage envelope, not an execution oracle or an FD sandbox.
// Only the inventory is shared; all original trace observations stay intact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JOURNAL_LIMITS, publicationGuard } from './execution-journal.mjs';
const originalFields=['ref','runId','sourceDigest','caseId','key','driver','schema','requestedMode','observedOutcome','fixtureId','fixtureDigest','fixtureProvenance','pickleId','astNodeIds','uri','testCaseStartedId','inventory','trace'];
const contextFields=['kind','version','ref','runId','sourceDigest','producerPid','inventoryDigest','inventory'];
const referenceFields=[...originalFields.filter(k=>k!=='inventory'),'kind','version','inventoryRef','producerPid'];
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function shape(value,fields,label){assert.ok(object(value),`${label} object required`);assert.deepEqual(Object.keys(value).sort(),[...fields].sort(),`${label} fields`);}
function identity(value){for(const k of ['runId','sourceDigest'])assert.ok(typeof value[k]==='string'&&value[k].length,`inventory context ${k}`);assert.ok(Number.isSafeInteger(value.producerPid)&&value.producerPid>0,'inventory producer PID');}
function canonical(value){if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;if(object(value))return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;return JSON.stringify(value);}
function contextRef(c){return hash(canonical({version:c.version,runId:c.runId,sourceDigest:c.sourceDigest,producerPid:c.producerPid,inventoryDigest:c.inventoryDigest}));}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function checkContext(c){
  shape(c,contextFields,'inventory context');assert.equal(c.kind,'inventoryContext','inventory context kind');assert.equal(c.version,1,'inventory context version');identity(c);
  assert.ok(object(c.inventory),'observed inventory object');assert.equal(c.inventoryDigest,hash(canonical(c.inventory)),'inventory value digest');assert.equal(c.ref,contextRef(c),'inventory context identity');
}
function original(receipt,inventory){return Object.fromEntries(originalFields.map(k=>[k,k==='inventory'?inventory:receipt[k]]));}
function checkOriginal(r){
  for(const k of originalFields.filter(k=>!['inventory','trace','fixtureProvenance','astNodeIds'].includes(k)))assert.ok(typeof r[k]==='string'&&r[k].length,`execution required ${k}`);
  for(const k of ['inventory','trace','fixtureProvenance'])assert.ok(object(r[k]),`execution required ${k}`);
  assert.ok(Array.isArray(r.astNodeIds)&&r.astNodeIds.length&&r.astNodeIds.every(id=>typeof id==='string'&&id.length),'execution required astNodeIds');
}
// The reference row and inventory have each already passed physical bounds.
// Serialize only the receipt without inventory (<= one physical row), then add
// the once-computed inventory size. Never stringify an expanded run or retain N
// serialized inventories. Parsed-object overhead is not a JS heap-byte promise.
function logicalSize(r,inventoryBytes){const view=Object.fromEntries(originalFields.filter(k=>k!=='inventory').map(k=>[k,r[k]]));return bytes(view)+Buffer.byteLength(',"inventory":')+inventoryBytes;}
export function createInventoryContext({inventory,runId,sourceDigest,producerPid=process.pid}){
  const c={kind:'inventoryContext',version:1,runId,sourceDigest,producerPid,inventoryDigest:hash(canonical(inventory)),inventory};c.ref=contextRef(c);checkContext(c);return c;
}
export function referenceReceipt(receipt,context,limits=JOURNAL_LIMITS){
  shape(receipt,originalFields,'original execution');checkOriginal(receipt);checkContext(context);
  assert.equal(receipt.runId,context.runId,'execution context run');assert.equal(receipt.sourceDigest,context.sourceDigest,'execution context source');assert.deepEqual(receipt.inventory,context.inventory,'execution observed inventory');
  assert.ok(logicalSize(receipt,bytes(context.inventory))+1<=limits.recordBytes,'execution logical receipt byte limit');
  const {inventory,...rest}=receipt;return {...rest,kind:'execution',version:1,inventoryRef:context.ref,producerPid:context.producerPid};
}
export function decodeCurrentJournal(rows,{inventory,runId,sourceDigest,childPid},limits=JOURNAL_LIMITS){
  assert.ok(Number.isSafeInteger(childPid)&&childPid>0,'actual spawned child PID required');
  assert.ok(Array.isArray(rows)&&rows.length,'missing first inventory context');
  const guard=publicationGuard(limits);let physicalBytes=0;
  for(const row of rows){guard(row);physicalBytes+=bytes(row)+1;}
  const context=rows[0];checkContext(context);
  assert.equal(context.runId,runId,'stale inventory context run');assert.equal(context.sourceDigest,sourceDigest,'stale inventory context source');assert.equal(context.producerPid,childPid,'inventory actual child PID');
  assert.deepEqual(context.inventory,inventory,'actual inventory drift');
  assert.ok(rows.length>1,'unreferenced inventory context');
  const shared=freeze(context.inventory),inventoryBytes=bytes(shared),receipts=[];let maxLogicalReceiptBytes=0,logicalReceiptBytes=0;
  for(const row of rows.slice(1)){
    shape(row,referenceFields,'current execution reference');assert.equal(row.kind,'execution','current execution kind');assert.equal(row.version,1,'current execution version');
    assert.equal(row.inventoryRef,context.ref,'execution inventory reference');assert.equal(row.producerPid,childPid,'execution actual producer PID');assert.equal(row.runId,runId,'stale execution context run');assert.equal(row.sourceDigest,sourceDigest,'stale execution context source');
    const length=logicalSize(row,inventoryBytes)+1;assert.ok(length<=limits.recordBytes,'execution logical receipt byte limit');maxLogicalReceiptBytes=Math.max(maxLogicalReceiptBytes,length);logicalReceiptBytes+=length;
    const receipt=original(row,shared);checkOriginal(receipt);receipts.push(receipt);
  }
  // Retained encoded unique values are bounded by the same physical aggregate:
  // context once + all reference rows/traces; inventory pointers are shared.
  return {context:freeze(context),receipts,physicalRecords:rows.length,physicalBytes,maxLogicalReceiptBytes,logicalReceiptBytes};
}
// Explicit offline compatibility ONLY. This does not assign a current run,
// child PID, source validity or any acceptance credit to historical receipts.
export function decodeHistoricalJournal(rows,limits=JOURNAL_LIMITS){
  const guard=publicationGuard(limits);assert.ok(Array.isArray(rows),'historical receipt array');
  for(const row of rows){guard(row);shape(row,originalFields,'historical embedded execution');checkOriginal(row);}return rows;
}
