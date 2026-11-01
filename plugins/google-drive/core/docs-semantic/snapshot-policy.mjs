// Core-owned read-evidence policy. Persistence adapters evaluate these guards
// inside their atomic operations; no SQL, compression or physical accounting.
import { LIMITS, requireValue, jsonBytes } from './common.mjs';
import { validateStructuralFacts } from './model.mjs';
export const READ_WORK_BYTES=256*1048576;
export function checkSnapshotOwner(row,owner) {
  requireValue(row&&row.subject===owner.subject&&row.account===owner.account&&row.thread===owner.threadId,'snapshot');
}
export function checkSnapshotTime(now){requireValue(Number.isSafeInteger(now)&&now>=0,'invalid');}
export function checkSnapshotLive(row,now){checkSnapshotTime(now);requireValue(now<row.expires,'snapshot');}
export function validateStoredModel(result,row,limits=LIMITS) {
  const b=result.binding;
  requireValue(result.version===1&&result.evidenceDigest===row.evidence_digest&&b?.snapshotId===row.id&&b.subject===row.subject&&b.account===row.account&&b.threadId===row.thread,'corrupt');
  requireValue(Number.isSafeInteger(b.retrievedAt)&&b.retrievedAt<=row.created&&row.created<row.expires&&row.expires===b.retrievedAt+limits.snapshotMs,'corrupt');
  requireValue(result.evidence.documentId===b.documentId&&result.metadata.id===b.documentId,'corrupt');
  const views={inline:'SUGGESTIONS_INLINE',acceptedPreview:'PREVIEW_SUGGESTIONS_ACCEPTED',rejectedPreview:'PREVIEW_WITHOUT_SUGGESTIONS'};
  requireValue(Object.hasOwn(views,b.view)&&result.evidence.suggestionsViewMode===views[b.view],'corrupt');
  requireValue(result.nodes&&Array.isArray(result.tabs)&&Array.isArray(result.outline),'corrupt');
  const nodes=Object.values(result.nodes);requireValue(nodes.length<=limits.nodes,'corrupt');
  const reached=new Set();
  for(const n of nodes){
    requireValue(typeof n.id==='string'&&result.nodes[n.id]===n&&n.id.startsWith(`${b.snapshotId}:`)&&Array.isArray(n.children)&&Array.isArray(n.evidence?.path),'corrupt');
    for(const child of n.children){requireValue(!reached.has(child)&&result.nodes[child]?.parent===n.id,'corrupt');reached.add(child);}
    if(n.parent===null)requireValue(n.kind==='segment','corrupt');
  }
  for(const n of nodes)requireValue(n.parent===null||reached.has(n.id),'corrupt');
  validateStructuralFacts(result);
}
export function validateCursorState(snapshot,state,limits=LIMITS) {
  jsonBytes(state,limits.pageBytes);
  requireValue(state.view===snapshot.binding.view&&state.documentId===snapshot.binding.documentId,'conflict');
  if(state.offset!==undefined)requireValue(Number.isSafeInteger(state.offset)&&state.offset>=0,'invalid');
  if(state.lossOffset!==undefined)requireValue(Number.isSafeInteger(state.lossOffset)&&state.lossOffset>=0,'invalid');
  return JSON.stringify(state);
}
export function validateDelivery(snapshot,delivery,limits=LIMITS) {
  jsonBytes(delivery,limits.pageBytes);
  requireValue(delivery.snapshotId===snapshot.binding.snapshotId&&delivery.evidenceDigest===snapshot.evidenceDigest&&delivery.view===snapshot.binding.view,'conflict');
  requireValue(Array.isArray(delivery.nodes)&&new Set(delivery.nodes).size===delivery.nodes.length,'invalid');
  const known=new Set([...Object.keys(snapshot.nodes),...(snapshot.registryEntries??[]).map(n=>n.id),...(snapshot.registryReferences??[]).map(n=>n.id)]);
  for(const id of delivery.nodes){
    const aspects=delivery.nodeAspects?.[id];requireValue(Array.isArray(aspects),'invalid');
    requireValue(known.has(id)||typeof id==='string'&&id.startsWith(`${snapshot.binding.snapshotId}:`)&&aspects.length===0,'conflict');
    requireValue(aspects.every(a=>['content','styles','review'].includes(a)),'invalid');
  }
  return JSON.stringify(delivery);
}
export function checkSnapshotAdmission(binding,now,active,limits=LIMITS) {
  for(const key of ['snapshotId','subject','account','threadId','documentId'])requireValue(typeof binding[key]==='string'&&binding[key].length>0&&binding[key].length<=320,'invalid');
  requireValue(Number.isSafeInteger(binding.retrievedAt)&&binding.retrievedAt<=now&&now<binding.retrievedAt+limits.snapshotMs,'snapshot');
  requireValue(active<limits.activePerOwner,'budget');
}
export function nextReadWork(previous,bytes,limits=LIMITS) {
  requireValue(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=limits.modelBytes,'budget');
  const total=previous+bytes;requireValue(total<=READ_WORK_BYTES,'budget');return total;
}
export function checkPin(now,expires,previous,count,limits=LIMITS) {
  requireValue(Number.isSafeInteger(expires)&&expires>now&&expires<=now+limits.pinMs,'budget');
  requireValue(previous===undefined||previous===expires,'conflict');
  requireValue(previous!==undefined||count<32,'budget');
}
export function checkRetainedWitness(record,pinOwner,expires) {
  requireValue(record.format==='retainedWitness'&&record.retention?.pinId===pinOwner&&record.retention?.expires===expires,'conflict');
}
export function checkNewWitness(record,pinExists) {
  requireValue(record?.format==='retainedWitness'&&record.nodes?.length===0,'invalid');requireValue(!pinExists,'conflict');
}
