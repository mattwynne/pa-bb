// Independently observed before/after GET comparison ONLY. Protocol provenance
// (acknowledgement, persisted stage, claim, approval) belongs to the executor.
import { requireValue, digest, evidenceAt, freeze, jsonBytes, LIMITS } from './common.mjs';
import { validatedReadModel, descendants } from './selectors.mjs';
import { closed, boundedWitness, readBinding, evidenceResult } from './read-effects.mjs';
const equal=(a,b)=>digest(a)===digest(b);
function nativeId(node,kind) {
  if(kind==='headingId')return node.kind==='paragraph'?node.style.explicit.headingId:undefined;
  if(kind==='inlineObjectId')return node.kind==='inlineObjectElement'?node.properties.inlineObjectId:undefined;
  return undefined;
}
function stripStructuralCoordinates(snapshot) {
  const paths=new Set(Object.values(snapshot.nodes).map(n=>JSON.stringify(n.evidence.path)));
  function copy(value,path) {
    if(Array.isArray(value))return value.map((child,i)=>copy(child,[...path,i]));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
      .filter(([key])=>!(path.length===0&&key==='revisionId')&&!(paths.has(JSON.stringify(path))&&['startIndex','endIndex'].includes(key)))
      .map(([key,child])=>[key,copy(child,[...path,key])]));
    return value;
  }
  return copy(snapshot.evidence,[]);
}
export function compareGeneratedEvidence(beforeInput,afterInput,request) {
  const before=validatedReadModel(beforeInput),after=validatedReadModel(afterInput);
  boundedWitness(request);
  closed(request,['kind','predecessor','observation','binding','expectedOriginal','preservation']);
  requireValue(request.kind==='generatedReadComparison','invalid');
  closed(request.predecessor,['binding']);closed(request.observation,['binding','predecessorRevision']);
  requireValue(equal(request.predecessor.binding,readBinding(before))&&equal(request.observation.binding,readBinding(after)),'snapshot');
  for(const key of ['subject','account','threadId','documentId','view'])requireValue(before.binding[key]===after.binding[key],'snapshot');
  requireValue(before.binding.snapshotId!==after.binding.snapshotId&&after.binding.retrievedAt>=before.binding.retrievedAt,'snapshot');
  requireValue(before.revision.kind==='docs'&&after.revision.kind==='docs'&&before.binding.view==='inline'&&
    (!before.binding.source||before.binding.source==='current')&&(!after.binding.source||after.binding.source==='current')&&
    before.metadata.capabilities?.canEdit!==false&&after.metadata.capabilities?.canEdit!==false,'snapshot');
  requireValue(before.revision.id!==after.revision.id&&request.observation.predecessorRevision===before.revision.id,'conflict');
  const selector=request.binding;
  closed(selector,['kind','tabId','segment','nodeKind'],['idKind','returnedId','startIndex']);
  let candidates=Object.values(after.nodes).filter(n=>n.tabId===selector.tabId&&equal(n.segment,selector.segment)&&n.kind===selector.nodeKind);
  if(selector.kind==='returnedId'){
    requireValue(['headingId','inlineObjectId'].includes(selector.idKind)&&typeof selector.returnedId==='string'&&selector.returnedId.length>0&&selector.startIndex===undefined,'unsupported');
    candidates=candidates.filter(n=>nativeId(n,selector.idKind)===selector.returnedId);
    requireValue(!Object.values(before.nodes).some(n=>n.tabId===selector.tabId&&nativeId(n,selector.idKind)===selector.returnedId),'conflict');
  }else{
    requireValue(selector.kind==='exactAnchor'&&Number.isSafeInteger(selector.startIndex)&&selector.startIndex>=0&&selector.returnedId===undefined&&selector.idKind===undefined,'invalid');
    candidates=candidates.filter(n=>n.extent?.start===selector.startIndex);
  }
  requireValue(candidates.length===1,'scope');
  const generated=candidates[0],parent=after.nodes[generated.parent];
  // Supported shape: one inserted physical block/inline in an existing array.
  // Table identity is an exact scoped anchor, never an invented native ID.
  requireValue(['paragraph','table','inlineObjectElement'].includes(generated.kind)&&parent&&['segment','paragraph'].includes(parent.kind),'unsupported');
  requireValue(equal(evidenceAt(after,generated.evidence.path),request.expectedOriginal),'conflict');
  requireValue(generated.extent&&descendants(after,[generated.id]).every(id=>after.nodes[id].extent),'extent');
  const removed=new Set(descendants(after,[generated.id]));
  const oldNodes=Object.values(before.nodes),newNodes=Object.values(after.nodes).filter(n=>!removed.has(n.id));
  requireValue(oldNodes.length===newNodes.length&&oldNodes.length<=500,'budget');
  const expected=[];
  for(let i=0;i<oldNodes.length;i++){
    const a=oldNodes[i],b=newNodes[i];
    requireValue(a.kind===b.kind&&a.tabId===b.tabId&&equal(a.segment,b.segment),'scope');
    expected.push({source:a.id,target:b.id,kind:a.kind,tabId:a.tabId,segment:a.segment,before:a.extent,after:b.extent});
  }
  requireValue(equal(request.preservation,expected),'conflict');
  const left=stripStructuralCoordinates(before),right=stripStructuralCoordinates(after);
  const path=generated.evidence.path,index=path.at(-1);
  requireValue(Number.isSafeInteger(index),'unsupported');
  const sequence=path.slice(0,-1).reduce((v,key)=>v?.[key],right);requireValue(Array.isArray(sequence),'unsupported');sequence.splice(index,1);
  // Comparison includes ALL untouched fields and registries, not just node IDs
  // or displayed text. Unknown startIndex/endIndex names remain substantive.
  requireValue(equal(left,right),'conflict');
  // Drive's observation version/time can advance with a new Docs observation;
  // they are not Docs CAS revisions. Preserve every other metadata field and
  // report both observations rather than requiring a fictitious frozen version.
  const preservedMetadata=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['version','modifiedTime'].includes(key)));
  requireValue(equal(preservedMetadata(before.metadata),preservedMetadata(after.metadata)),'conflict');
  jsonBytes(expected,LIMITS.pageBytes);
  const missing=[];
  if(before.missingReviewCoverage||after.missingReviewCoverage)missing.push('review');
  if(before.unresolvedExtents||after.unresolvedExtents)missing.push('unresolvedExtents');
  return evidenceResult(missing,{materialized:'complete',delivered:'internalObservation',evidenceKind:'generatedReadComparison',
    predecessor:readBinding(before),observation:readBinding(after),generated:{node:generated.id,kind:generated.kind,extent:generated.extent,binding:structuredClone(selector)},
    comparisonDigest:digest({original:request.expectedOriginal,preservation:expected}),protocolProvenance:'notEstablished',
    driveObservations:{predecessor:{version:before.metadata.version??null,modifiedTime:before.metadata.modifiedTime??null},
      observed:{version:after.metadata.version??null,modifiedTime:after.metadata.modifiedTime??null},docsCas:false},
    retainedEvidenceOnly:false});
}
