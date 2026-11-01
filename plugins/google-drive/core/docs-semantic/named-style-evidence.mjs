// Property-specific usage witnesses consume A's actual provenance and registry
// references. No second inheritance engine or unrelated prose requirement.
import { requireValue, digest, freeze, jsonBytes, LIMITS } from './common.mjs';
import { validatedReadModel } from './selectors.mjs';
import { inspectStyleProperty } from './model.mjs';
import { closed, boundedWitness, readBinding, evidenceResult, WITNESS_LIMITS } from './read-effects.mjs';

function inheritanceOwners(snapshot,node,references,cache) {
  const owners=[];
  let parent=snapshot.nodes[node.parent];
  while(parent){
    const refs=references.get(parent.id)??[];
    const relevant=parent.kind==='paragraph'||['table','tableRow','tableCell'].includes(parent.kind)||
      parent.unprojectedFields?.length||Object.keys(parent.review??{}).length||refs.length;
    if(relevant){
      if(!cache.has(parent.id))cache.set(parent.id,{
        node:parent.id,kind:parent.kind,evidenceDigest:parent.evidence.digest,
        namedStyleType:parent.style?.explicit?.namedStyleType??null,
        review:parent.review??{},unknownFields:parent.unprojectedFields??[],
        references:refs.map(r=>({id:r.id,definitionKind:r.definitionKind,providerId:r.providerId,targets:r.targets,status:r.status,
          dependencyOwner:r.dependencyOwner??null,dependencyEvidenceDigest:r.dependencyEvidenceDigest??null}))});
      owners.push(cache.get(parent.id));
    }
    parent=snapshot.nodes[parent.parent];
  }
  return owners;
}
function namedFacts(snapshot,request) {
  closed(request,['tabId','namedType','family','property','value']);boundedWitness(request);
  const {tabId,namedType,family,property,value}=request;
  requireValue(['text','paragraph'].includes(family));
  const tab=snapshot.tabs.find(t=>t.providerId===tabId);requireValue(tab,'scope');
  const definition=snapshot.registryEntries.find(e=>e.tabId===tabId&&e.kind==='namedStyle'&&e.providerId===namedType);
  requireValue(definition,'scope');
  const styleKey=family==='text'?'textStyle':'paragraphStyle',before=definition.value[styleKey]?.[property];
  requireValue(before!==undefined,'unsupported');
  const oldFacts=inspectStyleProperty(family,property,before),newFacts=inspectStyleProperty(family,property,value);
  const missing=[];
  if(snapshot.registries.suggestedNamedStylesChanges&&Object.keys(snapshot.registries.suggestedNamedStylesChanges).length)missing.push('unresolvedNamedStyleReview');
  if(oldFacts.effectiveStatus!=='observed'||newFacts.effectiveStatus!=='observed')missing.push('unsupportedTypedProperty');
  // Non-inheriting identity/link/tabStops properties cannot be described as an
  // indirect inherited property update. Resets require a separate contract.
  if(['link','headingId','direction','tabStops','namedStyleType'].includes(property))missing.push('nonInheritedProperty');
  const usages=[],references=new Map(),ownerCache=new Map();let usageBytes=0;
  for(const reference of snapshot.registryReferences){
    if(!references.has(reference.ownerNode))references.set(reference.ownerNode,[]);
    references.get(reference.ownerNode).push(reference);
  }
  for(const n of Object.values(snapshot.nodes)){
    if(n.tabId!==tabId||!n.style?.properties||family==='paragraph'&&n.kind!=='paragraph'||family==='text'&&n.kind==='paragraph')continue;
    const p=n.kind==='paragraph'?n:snapshot.nodes[n.parent];
    if(p?.kind!=='paragraph')continue;
    const type=p.style.explicit.namedStyleType;
    const refs=(references.get(n.id)??[]).filter(r=>r.definitionKind==='namedStyle');
    const entry=n.style.properties[property],fact=n.style.propertyEvidence?.[property];
    // Explicit named type alone is not an effect. All known relevant default
    // dependencies, named overrides and direct overrides are shown separately.
    const relevant=refs.some(r=>r.providerId===namedType)||type===namedType||!type||n.style.missingNamedStyle;
    if(!relevant)continue;
    const status=fact?.effectiveStatus??'unknown';
    const indirect=entry?.provenance==='named'&&entry.source===namedType;
    const inheritedSource=fact?.inherited?.source??null;
    const dependencyKnown=refs.length>0&&refs.every(r=>r.status==='resolved');
    if(!type||n.style.missingNamedStyle||!dependencyKnown||status!=='observed')missing.push('unknownUsageProperty');
    const owners=inheritanceOwners(snapshot,n,references,ownerCache);
    for(const owner of owners){
      if(Object.keys(owner.review).length)missing.push('unsupportedReviewEffect');
      if(owner.unknownFields.length)missing.push('unknownDependentFields');
      if(owner.references.some(r=>r.status!=='resolved'))missing.push('unresolvedInheritanceDependency');
    }
    usages.push({node:n.id,kind:n.kind,tabId,segment:n.segment,namedType:type??null,
      directOverride:Object.hasOwn(n.style.explicit,property)?n.style.explicit[property]:null,
      before:entry?.value??null,after:indirect?value:entry?.value??null,
      affected:indirect,provenance:entry?.provenance??'unknown',source:entry?.source??null,inheritedSource,status,
      dependencies:refs.map(r=>({id:r.id,providerId:r.providerId,targets:r.targets,status:r.status,
        dependencyOwner:r.dependencyOwner??null,dependencyEvidenceDigest:r.dependencyEvidenceDigest??null})),
      inheritanceOwners:owners,
      review:n.review??{},unknownFields:n.unprojectedFields??[]});
    usageBytes+=jsonBytes(usages.at(-1),WITNESS_LIMITS.bytes);requireValue(usageBytes<=LIMITS.modelBytes,'budget');
    if(Object.keys(n.review??{}).length)missing.push('unsupportedReviewEffect');
    if(n.unprojectedFields?.length)missing.push('unknownDependentFields');
  }
  if(snapshot.binding.view!=='inline'||snapshot.revision.kind!=='docs'||snapshot.binding.source&&snapshot.binding.source!=='current'||snapshot.metadata.capabilities?.canEdit===false)missing.push('currentEditorRevision');
  return {binding:readBinding(snapshot),request,definition:{id:definition.id,original:definition.value,property,before,after:value},
    usages,missingAspects:[...new Set(missing)],indirect:true,contentDeletion:false};
}
// Bounded complete pages are useful for large definition usage summaries. The
// immutable witness digest covers ALL usages, not only the displayed prefix.
export function inspectNamedStyleEvidence(input,request,{offset=0,limit=100}={}) {
  const snapshot=validatedReadModel(input),facts=namedFacts(snapshot,request);
  requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=facts.usages.length&&Number.isSafeInteger(limit)&&limit>0&&limit<=WITNESS_LIMITS.nodes);
  const witnessDigest=digest(facts),end=Math.min(offset+limit,facts.usages.length);
  const page={binding:facts.binding,request:structuredClone(request),definition:facts.definition,usages:facts.usages.slice(offset,end),offset,
    total:facts.usages.length,nextOffset:end===facts.usages.length?null:end,witnessDigest,complete:end===facts.usages.length,
    missingAspects:facts.missingAspects,materialized:'complete',delivered:'propertyPage',witnessSatisfied:false,indirect:true,contentDeletion:false,editReady:false,authoringAuthority:'notEstablished'};
  boundedWitness(page);return freeze(page);
}
export function compareNamedStyleEvidence(input,request,pages) {
  const snapshot=validatedReadModel(input),facts=namedFacts(snapshot,request),hash=digest(facts);
  requireValue(Array.isArray(pages)&&pages.length>0&&pages.length<=1000,'budget');
  let offset=0;const seen=[];const missing=[...facts.missingAspects];
  for(const page of pages){
    boundedWitness(page);
    requireValue(page.offset===offset&&page.witnessDigest===hash&&digest(page.binding)===digest(facts.binding),'conflict');
    requireValue(digest(page.definition)===digest(facts.definition)&&digest(page.request)===digest(request),'conflict');
    requireValue(Array.isArray(page.usages)&&page.usages.length<=WITNESS_LIMITS.nodes,'budget');
    seen.push(...page.usages);offset+=page.usages.length;
    requireValue(page.total===facts.usages.length&&page.nextOffset===(offset===facts.usages.length?null:offset),'conflict');
  }
  if(digest(seen)!==digest(facts.usages))missing.push('usageEnumeration');
  return evidenceResult(missing,{materialized:'complete',delivered:missing.includes('usageEnumeration')?'partial':'propertySummary',
    binding:facts.binding,comparisonDigest:hash,usageCount:facts.usages.length,indirect:true,contentDeletion:false});
}
