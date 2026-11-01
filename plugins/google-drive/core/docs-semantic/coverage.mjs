// Pure read-evidence calculus, not an authoring planner or consent gate.
// Legacy pure footprint helpers accept TRUSTED INTERNAL records only. Public
// inputs must use the store-backed read-evidence facade, never delivery arrays.
// Typed effect comparisons recompute targets/dependencies from canonical facts.
import { requireValue, digest, evidenceAt, freeze, scalar, boundedTree, LIMITS } from './common.mjs';
import { validatedReadModel } from './selectors.mjs';
import { compareReadEvidence } from './read-effects.mjs';
export { resolveTargetEvidence, inspectEffectEvidence, compareReadEvidence } from './read-effects.mjs';
export { inspectNamedStyleEvidence, compareNamedStyleEvidence } from './named-style-evidence.mjs';
export { compareGeneratedEvidence } from './generated-evidence.mjs';
import { validateStructuralFacts } from './model.mjs';
const aspects=new Set(['content','styles','review']);
// A footprint is a bounded proposal, not evidence. Validation happens at each
// witness entry; even an invalid retained model can describe its missing scope.
function proposedDescendants(snapshot,roots){
  const seen=new Set(),stack=[...roots].reverse();
  while(stack.length){
    requireValue(seen.size<=100000,'budget');
    const id=stack.pop();if(seen.has(id))continue;
    const node=snapshot.nodes[id];requireValue(node&&Array.isArray(node.children),'snapshot');seen.add(id);
    for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);
  }
  return [...seen];
}
export function footprint(snapshot,{nodes,dependencies=[],aspects:required=['content'],destructive=false}) {
  boundedTree(snapshot,{...LIMITS,providerBytes:LIMITS.modelBytes,nodes:1000000,depth:96});
  requireValue(Array.isArray(nodes)&&nodes.length>0&&Array.isArray(dependencies));
  validateAspects(required,destructive);
  const expanded=destructive?proposedDescendants(snapshot,nodes):nodes;
  const ids=[...new Set([...expanded,...dependencies])];requireValue(ids.every(id=>snapshot.nodes[id]),'snapshot');
  const result={snapshotId:snapshot.binding.snapshotId,evidenceDigest:snapshot.evidenceDigest,nodes:ids,targets:[...nodes],dependencies:[...dependencies],aspects:[...required],destructive};
  validateFootprint(snapshot,result);return freeze(result);
}
function validateAspects(required,destructive){
  requireValue(Array.isArray(required)&&required.length>0&&new Set(required).size===required.length,'invalid');
  requireValue(required.every(aspect=>aspects.has(aspect)),'invalid');
  requireValue(typeof destructive==='boolean'&&(!destructive||required.includes('content')),'invalid');
}
function validateFootprint(snapshot,fp){
  requireValue(fp&&fp.snapshotId===snapshot.binding.snapshotId&&fp.evidenceDigest===snapshot.evidenceDigest,'snapshot');
  validateAspects(fp.aspects,fp.destructive);
  for(const list of [fp.nodes,fp.targets,fp.dependencies]){
    requireValue(Array.isArray(list)&&new Set(list).size===list.length,'scope');
    requireValue(list.every(id=>typeof id==='string'&&Object.hasOwn(snapshot.nodes,id)),'scope');
  }
  requireValue(fp.targets.length>0,'scope');
  const closure=fp.destructive?proposedDescendants(snapshot,fp.targets):fp.targets;
  const required=new Set([...closure,...fp.dependencies]);
  requireValue(fp.nodes.length===required.size&&fp.nodes.every(id=>required.has(id)),'scope');
}
function materialized(snapshot,fp){
  snapshot=validatedReadModel(snapshot);
  validateFootprint(snapshot,fp);
  validateStructuralFacts(snapshot);
  const missing=[];
  if(fp.aspects.includes('review')&&snapshot.missingReviewCoverage)missing.push('review');
  for(const id of fp.nodes){const n=snapshot.nodes[id];if(!n||digest(evidenceAt(snapshot,n.evidence.path))!==n.evidence.digest)missing.push('evidence');}
  return [...new Set(missing)];
}
// Complete previews compare actual original records, not a caller's boolean.
// Preview evidence can satisfy delivery but never grants effect/epoch/approval
// authority; later planner/executor must independently prove those facts.
export function previewWitness(snapshot,fp,originalRecords) {
  const missing=materialized(snapshot,fp);requireValue(!missing.length,'unavailable');
  requireValue(Array.isArray(originalRecords)&&originalRecords.length===fp.nodes.length,'scope');
  const seen=new Set();
  for(const record of originalRecords){
    requireValue(record&&fp.nodes.includes(record.node)&&!seen.has(record.node),'scope');seen.add(record.node);
    requireValue(record.providerEvidence&&typeof record.providerEvidence==='object'&&!Array.isArray(record.providerEvidence),'invalid');
    boundedTree(record.providerEvidence);
    requireValue(digest(record.providerEvidence)===snapshot.nodes[record.node].evidence.digest,'conflict');}
  return freeze({kind:'completePreview',snapshotId:fp.snapshotId,footprintDigest:digest(fp),originalDigest:digest(originalRecords),originalRecords:structuredClone(originalRecords),nodes:[...seen],aspects:fp.aspects,materialized:'complete',delivered:'completePreview',witnessSatisfied:false,missingAspects:[],editReady:false,authoringAuthority:'notEstablished'});
}
export function narrowWitness(snapshot,fp,match) {
  snapshot=validatedReadModel(snapshot);validateFootprint(snapshot,fp);
  requireValue(match?.snapshotId===snapshot.binding.snapshotId&&fp.targets.includes(match.node),'snapshot');
  requireValue(match.runs?.length&&match.extent&&typeof match.text==='string','invalid');
  const runs=match.runs.map(id=>snapshot.nodes[id]);requireValue(runs.every(n=>n?.kind==='text'&&n.parent===match.node&&fp.nodes.includes(n.id)),'scope');
  let text='',end=match.extent.start;
  for(const n of runs){const a=Math.max(n.extent.start,match.extent.start),b=Math.min(n.extent.end,match.extent.end);requireValue(a===end&&b>a,'extent');text+=n.text.slice(a-n.extent.start,b-n.extent.start);end=b;}
  scalar(text);requireValue(end===match.extent.end&&text===match.text,'conflict');
  return freeze({kind:'narrowLiteral',snapshotId:fp.snapshotId,footprintDigest:digest(fp),preimage:text,extent:match.extent,runDigests:runs.map(n=>n.evidence.digest),materialized:'complete',delivered:'preimageOnly',witnessSatisfied:false,missingAspects:['typedEffectWitness'],editReady:false,authoringAuthority:'notEstablished'});
}
// Native revision/view provenance is independent of mapped completeness. Only
// unknown ranges in this footprint, its necessary ancestry, or a potentially
// intersecting scope block it. These conservative envelopes are NOT coordinates
// assigned to unresolved nodes; their extents remain null in the model.
function unresolvedForFootprint(snapshot,fp){
  const context=n=>JSON.stringify([n.tabId,n.segment]);
  const unresolved=n=>n.kind!=='segment'&&(!n.extent||n.extentStatus==='unresolved');
  const necessary=new Set(),groups=new Map();
  for(const id of fp.nodes){
    let ancestor=snapshot.nodes[id];
    while(ancestor&&!necessary.has(ancestor.id)){necessary.add(ancestor.id);ancestor=snapshot.nodes[ancestor.parent];}
    const n=snapshot.nodes[id],key=context(n);
    if(!groups.has(key))groups.set(key,{whole:false,ranges:[]});
    const group=groups.get(key);
    // Segment-wide and zero-width targets cannot use an unrelated finite range
    // as proof of disjointness from an unresolved node in that same context.
    if(!n.extent||n.extent.start===n.extent.end)group.whole=true;
    else group.ranges.push({...n.extent});
  }
  for(const group of groups.values()){
    const merged=[];
    for(const range of group.ranges.sort((a,b)=>a.start-b.start)){
      if(merged.length&&range.start<=merged.at(-1).end)merged.at(-1).end=Math.max(merged.at(-1).end,range.end);
      else merged.push(range);
    }
    group.ranges=merged;
  }
  const missing=[];
  for(const n of Object.values(snapshot.nodes)){
    if(!unresolved(n))continue;
    if(necessary.has(n.id)){missing.push(n.id);continue;}
    const group=groups.get(context(n));if(!group)continue;
    if(group.whole){missing.push(n.id);continue;}
    let parent=snapshot.nodes[n.parent];
    while(parent&&!parent.extent)parent=snapshot.nodes[parent.parent];
    let start=parent?.extent.start??0,end=parent?.extent.end??Infinity;
    const raw=evidenceAt(snapshot,n.evidence.path),rawStart=raw?.startIndex;
    if(Number.isSafeInteger(rawStart)&&rawStart>=start&&rawStart<end)start=rawStart;
    else if(rawStart!==undefined){start=0;end=Infinity;} // contradictory/unknown start cannot prove disjointness
    let lo=0,hi=group.ranges.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(group.ranges[mid].end<=start)lo=mid+1;else hi=mid;}
    if(lo<group.ranges.length&&group.ranges[lo].start<end)missing.push(n.id);
  }
  return missing;
}
export function evaluateWitness(snapshot,fp,{deliveries=[],preview,narrow,effectWitness}={}) {
  if(effectWitness){
    const result=compareReadEvidence(snapshot,effectWitness,deliveries);
    requireValue(result.footprint&&digest(result.footprint)===digest(fp),'scope');
    return result;
  }
  const missingAspects=materialized(snapshot,fp),missingNodes=[];
  // Preview/history snapshots and noneditor reads retain useful read evidence,
  // but cannot become native-CAS target evidence.
  const unresolvedNodes=unresolvedForFootprint(snapshot,fp);
  if(unresolvedNodes.length)missingAspects.push('unresolvedExtents');
  if(snapshot.binding.view!=='inline'||snapshot.revision.kind!=='docs'||snapshot.revision.subject!==snapshot.binding.subject||
    snapshot.binding.source&&snapshot.binding.source!=='current'||snapshot.metadata.capabilities?.canEdit===false)missingAspects.push('currentEditorRevision');
  const delivered=new Map();
  for(const page of deliveries){
    requireValue(page.snapshotId===snapshot.binding.snapshotId&&page.evidenceDigest===snapshot.evidenceDigest&&page.view===snapshot.binding.view,'snapshot');
    for(const node of page.nodes??[]){
      const original=snapshot.nodes[node];requireValue(original,'scope');
      const actual=page.nodeAspects? page.nodeAspects[node] : page.aspects;
      requireValue(Array.isArray(actual)&&actual.every(aspect=>aspects.has(aspect)),'invalid');
      const set=delivered.get(node)??new Set();
      // A legacy/global receipt cannot turn internally retained unknown bytes
      // into agent delivery. Only exact original previews cover those omissions.
      if(!original.unprojectedFields?.length)for(const aspect of actual)set.add(aspect);
      delivered.set(node,set);
    }
  }
  let completePreview=false;
  if(preview){const checked=previewWitness(snapshot,fp,preview.originalRecords);requireValue(checked.originalDigest===preview.originalDigest&&checked.footprintDigest===preview.footprintDigest,'conflict');completePreview=true;}
  // The historical untyped narrow preimage remains insufficient by itself.
  // The effectWitness branch above compares concrete typed disclosures and
  // recomputed cardinality. A legacy effectsPreviewed flag remains irrelevant.
  if(narrow)missingAspects.push('effectAndCardinalityProofNotImplemented');
  if(!completePreview)for(const id of fp.nodes)if(fp.aspects.some(a=>!delivered.get(id)?.has(a)))missingNodes.push(id);
  return freeze({materialized:missingAspects.includes('evidence')?'incomplete':'complete',delivered:completePreview?'completePreview':missingNodes.length?'incomplete':'content',witnessSatisfied:missingAspects.length===0&&missingNodes.length===0,
    missingAspects:[...new Set(missingAspects)],missingNodes,unresolvedNodes,editReady:false,authoringAuthority:'notEstablished'});
}
// Historical explicit-type diagnostic summary, not an indirect effect proof.
// Use inspect/compareNamedStyleEvidence for complete property-specific usage.
export function namedStyleFootprint(snapshot,tabId,namedType) {
  snapshot=validatedReadModel(snapshot);
  const tab=snapshot.tabs.find(t=>t.providerId===tabId);requireValue(tab,'scope');
  const usage=Object.values(snapshot.nodes).filter(n=>n.tabId===tabId&&n.kind==='paragraph'&&n.style.explicit.namedStyleType===namedType);
  return freeze({snapshotId:snapshot.binding.snapshotId,tabId,namedType,definition:tab.registries.namedStyles?.styles?.find(s=>s.namedStyleType===namedType)??null,
    usage:usage.map(n=>({node:n.id,paragraphOverrides:n.style.explicit,runs:n.children.filter(id=>snapshot.nodes[id].kind==='text').map(id=>({node:id,overrides:snapshot.nodes[id].style.explicit,effective:snapshot.nodes[id].style.properties}))})),
    indirect:true,contentDeletion:false,diagnosticOnly:true,materialized:'complete',delivered:'diagnostic',witnessSatisfied:false,missingAspects:['propertySpecificUsage'],editReady:false,authoringAuthority:'notEstablished'});
}
