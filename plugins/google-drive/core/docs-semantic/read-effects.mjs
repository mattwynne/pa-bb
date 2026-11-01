// INTERNAL read/effect comparison vocabulary, deliberately not a planner.
// Effects describe proposed intent; these functions compare its exact disclosure
// with observed source facts. No requests, permission, claims or approvals exist.
import { LIMITS, boundedTree, requireValue, digest, evidenceAt, freeze, scalar, jsonBytes } from './common.mjs';
import { validatedReadModel, resolveSelector, resolveScope, findLiteral, normalizeMapped, descendants } from './selectors.mjs';
import { inspectStyleProperty } from './model.mjs';
import { footprint, evaluateWitness, previewWitness } from './coverage.mjs';
import { projectRegistries } from './reader.mjs';

export const WITNESS_LIMITS=Object.freeze({bytes:65536,nodes:500,properties:16});
export function closed(value,required,optional=[]) {
  requireValue(value&&typeof value==='object'&&!Array.isArray(value));
  requireValue(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));
}
export function boundedWitness(value) {
  boundedTree(value,{...LIMITS,providerBytes:WITNESS_LIMITS.bytes,nodes:20000,depth:64});
}
export function readBinding(snapshot) {
  const {snapshotId,subject,account,threadId,documentId,view,retrievedAt}=snapshot.binding;
  requireValue(Number.isSafeInteger(retrievedAt)&&retrievedAt>=0,'snapshot');
  for(const id of [snapshotId,subject,account,threadId,documentId])requireValue(typeof id==='string'&&id.length>0&&id.length<=320,'snapshot');
  return {snapshotId,subject,account,threadId,documentId,view,retrievedAt,source:snapshot.binding.source??'current',evidenceDigest:snapshot.evidenceDigest,revision:snapshot.revision};
}
function orderedFacts(value) {
  if(Array.isArray(value))return value.map(orderedFacts);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,orderedFacts(value[key])]));
  return value;
}
// Object key ordering is not an effect; array order and every actual value are.
const equal=(a,b)=>digest(orderedFacts(a))===digest(orderedFacts(b));
const unique=list=>[...new Set(list)];
export function evidenceResult(missing,extra={}) {
  return freeze({...extra,witnessSatisfied:missing.length===0,missingAspects:unique(missing),editReady:false,authoringAuthority:'notEstablished'});
}
function targetEvidence(snapshot,request) {
  closed(request,['scope','selector']);boundedWitness(request);
  const {scope,selector}=request;
  closed(selector,[],['node','span','heading','section','text']);requireValue(Object.keys(selector).length===1);
  if(selector.text)closed(selector.text,['literal'],['normalization','casePolicy','cardinality','limit']);
  const selected=resolveSelector(snapshot,scope,selector);
  let matches=[],nodes=[],count=selected.count??selected.nodes?.length??0,enumeration='complete';
  if(selector.text){
    // Enumerate independently of requested presentation limit. Never turn a
    // selected occurrence into a claim that the entire search found one match.
    const all=findLiteral(snapshot,scope,{...selector.text,limit:LIMITS.matches});
    matches=all.candidates;count=all.count;enumeration=all.truncated?'incomplete':'complete';
    nodes=unique((selected.candidates??[]).map(m=>m.node));
  }else nodes=selected.nodes??[];
  if(selected.truncated||selected.status==='unresolved')enumeration='incomplete';
  requireValue(nodes.length<=WITNESS_LIMITS.nodes,'budget');
  const sourceMaps=matches.map(match=>{
    const mapped=normalizeMapped(match.text,selector.text.normalization,selector.text.casePolicy);
    return {node:match.node,extent:match.extent,normalizedText:mapped.text,
      boundaries:[...mapped.boundaries].map(([normalizedOffset,sourceOffset])=>({normalizedOffset,sourceOffset:match.extent.start+sourceOffset})),
      runs:match.runs.map(id=>{const n=snapshot.nodes[id],start=Math.max(n.extent.start,match.extent.start),end=Math.min(n.extent.end,match.extent.end);
        return {node:id,extent:{start,end},text:n.text.slice(start-n.extent.start,end-n.extent.start)};})};
  });
  const result={binding:readBinding(snapshot),scope:structuredClone(scope),selector:structuredClone(selector),cardinality:structuredClone(selector.text?.cardinality??{exactly:1}),
    status:selected.status,count,enumeration,nodes,matches,sourceMaps,selectedMatches:selector.text?selected.candidates:[],
    ...(selected.section?{section:selected.section}:{}),materialized:'complete',delivered:'targetEvidence',witnessSatisfied:false,
    missingAspects:selected.status==='resolved'&&enumeration==='complete'?[]:['targetEnumeration'],editReady:false,authoringAuthority:'notEstablished'};
  boundedWitness(result);return freeze(result);
}
export function resolveTargetEvidence(input,request) {
  return targetEvidence(validatedReadModel(input),request);
}
function property(node,key) {
  const entry=node.style?.properties?.[key],fact=node.style?.propertyEvidence?.[key];
  return {value:entry?.value??null,provenance:entry?.provenance??'unknown',source:entry?.source??null,status:fact?.effectiveStatus??'unknown'};
}
function dependencies(snapshot,ids,properties) {
  const selected={status:'resolved',nodes:ids,tabs:unique(ids.map(id=>snapshot.nodes[id].tabId)),selectedFootprint:true};
  const registry=projectRegistries(snapshot,selected,['styles','lists','objects','ranges','review']);
  const nodes=ids.map(id=>{
    const n=snapshot.nodes[id];
    return {node:id,kind:n.kind,parent:n.parent,extent:n.extent,
      properties:Object.fromEntries(properties.map(key=>[key,property(n,key)])),storedStyle:n.style?.explicit??null,
      terminatingNewline:n.kind==='text'&&n.text.endsWith('\n')?{start:n.extent.end-1,end:n.extent.end,text:'\n'}:null,
      list:n.list??null,positionedObjectIds:n.positionedObjectIds??[],review:n.review??{},
      unknownFields:n.unprojectedFields??[]};
  });
  const registryRecords=registry.records.map(record=>record.kind==='registryReference'?
    {id:record.id,kind:record.kind,ownerNode:record.ownerNode,definitionKind:record.definitionKind,providerId:record.providerId,
      targets:record.targets,status:record.status,dependencyOwner:record.dependencyOwner??null}:
    {id:record.id,kind:record.kind,category:record.category,providerId:record.providerId,value:record.value,scopeRelation:record.scopeRelation});
  return {nodes,registryRecords,registryLosses:registry.losses};
}
function paragraphDependencies(snapshot,targets) {
  const result=[];
  for(const id of targets){
    const n=snapshot.nodes[id],p=n.kind==='paragraph'?n:snapshot.nodes[n.parent];
    requireValue(p?.kind==='paragraph','unsupported');
    result.push(p.id,...p.children);
  }
  return unique(result);
}
function inlineText(value,allowEmpty=true) {
  requireValue(typeof value==='string'&&value.length<=2000&&(allowEmpty||value.length>0));scalar(value);
  requireValue(!/[\n\r\u0000-\u0008\u000b-\u001f\u007f-\u009f\ue000-\uf8ff]/u.test(value),'unsupported');
}
function styleEffect(snapshot,target,effect) {
  requireValue(!target.selector.text,'unsupported');
  closed(effect,['kind','family','set']);requireValue(['text','paragraph'].includes(effect.family),'unsupported');
  const keys=Object.keys(effect.set??{});requireValue(keys.length>0&&keys.length<=WITNESS_LIMITS.properties);
  // These independent property sets have no hyperlink/border/reset transforms.
  const supported=effect.family==='text'?['bold','italic','underline','strikethrough','smallCaps']:['alignment','keepWithNext','keepLinesTogether'];
  for(const key of keys){requireValue(supported.includes(key),'unsupported');requireValue(inspectStyleProperty(effect.family,key,effect.set[key]).effectiveStatus==='observed','unsupported');}
  const targets=effect.family==='text'?unique(target.nodes.flatMap(id=>snapshot.nodes[id].kind==='paragraph'?snapshot.nodes[id].children:[id])):target.nodes;
  requireValue(targets.every(id=>snapshot.nodes[id].kind===(effect.family==='text'?'text':'paragraph')),'unsupported');
  const deps=paragraphDependencies(snapshot,targets),changes=[],missing=[];
  for(const id of targets)for(const key of keys){
    const before=property(snapshot.nodes[id],key);
    if(before.status!=='observed')missing.push('unknownStyleProperty');
    changes.push({node:id,property:key,before:before.value,after:effect.set[key],provenance:before.provenance,source:before.source});
  }
  // Whole paragraph text ranges include the newline and may affect list bullet
  // styles. Until a typed bullet-effect contract exists, do not conceal that.
  if(deps.some(id=>snapshot.nodes[id].list))missing.push('unsupportedListEffect');
  return {targets,deps,properties:keys,changes,missing,destructive:false,aspects:['styles']};
}
function literalEffect(snapshot,target,effect) {
  closed(effect,['kind','replacement','stylePolicy']);inlineText(effect.replacement);
  requireValue(effect.stylePolicy==='preservePositions','unsupported');
  requireValue(target.selector.text,'unsupported');
  const matches=target.selectedMatches,targets=unique(matches.map(m=>m.node)),deps=paragraphDependencies(snapshot,targets);
  const missing=[],changes=[];
  for(const m of matches){
    // This vocabulary proves equal-width inline changes only. Variable-width,
    // newline joins and link-changing policies need additional effect contracts,
    // not guessed coordinate transforms or an unconditional complete flag.
    if(m.text.length!==effect.replacement.length||/[\r\n]/u.test(m.text))missing.push('unsupportedLiteralShape');
    changes.push({kind:'literalReplacement',node:m.node,extent:m.extent,before:m.text,after:effect.replacement,runs:m.runs,stylePolicy:'preservePositions'});
  }
  for(let i=1;i<matches.length;i++)if(matches[i].node===matches[i-1].node&&matches[i].extent.start<matches[i-1].extent.end)missing.push('overlappingEffects');
  if(deps.some(id=>snapshot.nodes[id].list))missing.push('unsupportedListEffect');
  return {targets,deps,properties:[],changes,missing,destructive:false,aspects:['content','styles','review']};
}
function boundaryFacts(snapshot,ids) {
  const selected=new Set(ids),neighbors=new Set();
  for(const id of ids){
    const n=snapshot.nodes[id];if(selected.has(n.parent))continue;
    const siblings=snapshot.nodes[n.parent]?.children??[],index=siblings.indexOf(id);
    for(const other of [siblings[index-1],siblings[index+1]])if(other&&!selected.has(other))neighbors.add(other);
  }
  return [...neighbors].map(id=>{
    const n=snapshot.nodes[id],last=snapshot.nodes[n.children.at(-1)];
    return {node:id,kind:n.kind,extent:n.extent,style:n.style?.explicit?{explicit:n.style.explicit,properties:n.style.properties}:null,list:n.list??null,review:n.review??{},
      terminator:last?.kind==='text'&&last.text.endsWith('\n')?{node:last.id,extent:{start:last.extent.end-1,end:last.extent.end},text:'\n'}:null,
      unknownFields:n.unprojectedFields??[]};
  });
}
// Canonical structural envelopes classify an operation's affected suffix, not
// merely intersections with its old target. Bounds remain comparison-only: no
// missing provider end is filled in. A next sibling/ancestor can prove an
// unknown earlier node precedes the insertion; a later known start cannot.
function affectedSuffix(snapshot,anchor,index) {
  let root=anchor;
  while(root.parent)root=snapshot.nodes[root.parent];
  const result=[],stack=[[root,Infinity]];
  while(stack.length){
    const [n,inheritedUpper]=stack.pop();
    const upper=Math.min(inheritedUpper,n.extent?.end??Infinity);
    const raw=evidenceAt(snapshot,n.evidence.path);
    if(n.kind==='segment'&&(n.unprojectedFields?.length||Object.keys(n.review??{}).length))result.push(n.id);
    if(n.kind!=='segment'){
      const affected=n.extent?n.extent.end>index||n.extent.start>=index:
        upper>=index||Number.isSafeInteger(raw.startIndex)&&raw.startIndex>=index;
      if(affected)result.push(n.id);
    }
    let nextUpper=upper;
    for(let i=n.children.length-1;i>=0;i--){
      const child=snapshot.nodes[n.children[i]];
      stack.push([child,nextUpper]);
      const start=child.extent?.start??evidenceAt(snapshot,child.evidence.path).startIndex;
      if(Number.isSafeInteger(start))nextUpper=Math.min(nextUpper,start);
    }
  }
  return result;
}
function physicalRoots(snapshot,ids) {
  const selected=new Set(ids);
  return ids.filter(id=>!selected.has(snapshot.nodes[id].parent));
}
function broadEffect(snapshot,target,effect) {
  closed(effect,['kind','action'],['replacement']);requireValue(['delete','replace'].includes(effect.action));
  if(effect.action==='replace'){
    requireValue(Array.isArray(effect.replacement)&&effect.replacement.length>0&&effect.replacement.length<=100);
    for(const block of effect.replacement){closed(block,['kind','text']);requireValue(block.kind==='paragraph','unsupported');inlineText(block.text);}
  }else requireValue(effect.replacement===undefined);
  requireValue(!target.selector.text,'unsupported');
  const targets=target.nodes,deps=unique(descendants(snapshot,targets)),missing=[];
  const roots=physicalRoots(snapshot,deps);
  // This grammar removes whole segment-level blocks only. Text roots (including
  // terminators), row/cell roots, and blocks inside cells/TOCs require parent
  // topology/join effects not represented by a removeOriginal record.
  if(roots.some(id=>!['paragraph','table'].includes(snapshot.nodes[id].kind)||snapshot.nodes[snapshot.nodes[id].parent]?.kind!=='segment'))missing.push('unsupportedDestructiveRoot');
  const selected=new Set(deps),suffix=new Set(),contexts=new Map();
  for(const id of roots){const n=snapshot.nodes[id],key=JSON.stringify([n.tabId,n.segment]);
    if(n.extent&&(!contexts.has(key)||n.extent.start<contexts.get(key).extent.start))contexts.set(key,n);
  }
  // One suffix traversal per actual segment, not roots × whole-model work.
  for(const n of contexts.values())for(const dependent of affectedSuffix(snapshot,n,n.extent.start))if(!selected.has(dependent))suffix.add(dependent);
  const unresolvedSuffix=[...suffix].filter(id=>!snapshot.nodes[id].extent);
  if(unresolvedSuffix.length)missing.push('unresolvedDestructiveDependency');
  for(const id of suffix){const n=snapshot.nodes[id];
    if(Object.keys(n.review??{}).length)missing.push('unsupportedSuffixReviewEffect');
    if(n.unprojectedFields?.length)missing.push('unknownSuffixFields');
    if(n.kind.startsWith('opaque'))missing.push('unsupportedSuffixElement');
  }
  const changes=deps.map(id=>{const n=snapshot.nodes[id];return {kind:'removeOriginal',node:id,sourceKind:n.kind,extent:n.extent,
    removedStyle:n.style?.explicit??n.style??null,list:n.list??null,positionedObjectIds:n.positionedObjectIds??[],review:n.review??{},unknownFields:n.unprojectedFields??[]};});
  if(deps.some(id=>snapshot.nodes[id].positionedObjectIds?.length))missing.push('unsupportedPositionedObjectEffect');
  // A complete original is necessary but cannot itself prove an unsupported
  // object destruction/reconstruction. Disjoint objects are not in this test.
  if(deps.some(id=>!['paragraph','text','table','tableRow','tableCell'].includes(snapshot.nodes[id].kind)))missing.push('unsupportedDestructiveElement');
  if(effect.action==='replace')changes.push({kind:'replacementFragment',blocks:effect.replacement});
  const boundaries=boundaryFacts(snapshot,deps);
  for(const boundary of boundaries){
    if(boundary.kind!=='paragraph'||!boundary.extent||!boundary.terminator)missing.push('unsupportedBoundary');
    if(boundary.unknownFields.length||Object.keys(boundary.review).length||boundary.list)missing.push('unprovenBoundaryEffect');
    for(const id of descendants(snapshot,[boundary.node])){const n=snapshot.nodes[id];
      if(!n.extent||n.unprojectedFields?.length||Object.keys(n.review??{}).length||n.list||n.style?.missingNamedStyle||n.style?.unknownParentProperties?.length)missing.push('unprovenBoundaryEffect');
    }
  }
  return {targets,deps,boundaries,unresolvedSuffix,properties:[],changes,missing,destructive:true,aspects:['content','styles','review']};
}
function insertionEffect(snapshot,target,effect) {
  requireValue(!target.selector.text,'unsupported');
  closed(effect,['kind','at','text']);requireValue(['start','end'].includes(effect.at),'unsupported');inlineText(effect.text,false);
  requireValue(target.nodes.length===1&&snapshot.nodes[target.nodes[0]].kind==='paragraph','unsupported');
  const p=snapshot.nodes[target.nodes[0]];
  requireValue(p.extent&&p.children.length>0&&p.children.every(id=>snapshot.nodes[id].kind==='text'),'unsupported');
  const last=snapshot.nodes[p.children.at(-1)];requireValue(last.text.endsWith('\n'),'unsupported');
  const index=effect.at==='start'?p.extent.start:p.extent.end-1;
  // Walk the actual segment root, not a caller-selected mapped-node subset.
  const deps=unique([p.id,...p.children,...affectedSuffix(snapshot,p,index)]);
  const missing=[];
  if(deps.some(id=>!snapshot.nodes[id].extent))missing.push('unresolvedInsertionDependency');
  if(deps.some(id=>!['paragraph','text'].includes(snapshot.nodes[id].kind)))missing.push('unsupportedInsertionDependency');
  if(deps.some(id=>snapshot.nodes[id].list))missing.push('unsupportedListEffect');
  const changes=[{kind:'insertText',node:p.id,index,text:effect.text,inheritFrom:effect.at==='start'?p.children[0]:p.children.at(-1)},
    ...deps.filter(id=>snapshot.nodes[id].extent).map(id=>{const n=snapshot.nodes[id];return {kind:'extentShift',node:id,before:n.extent,
      after:{start:n.extent.start>=index&&id!==p.id?n.extent.start+effect.text.length:n.extent.start,end:n.extent.end+effect.text.length}};})];
  return {targets:[p.id],deps,properties:[],changes,missing,destructive:false,aspects:['content','styles','review']};
}
function effectEvidence(snapshot,request) {
  closed(request,['scope','selector','effect']);boundedWitness(request);
  const target=targetEvidence(snapshot,{scope:request.scope,selector:request.selector});
  if(target.status!=='resolved'||target.enumeration!=='complete')return {target,missingAspects:['targetEnumeration'],materialized:'incomplete',delivered:'none',witnessSatisfied:false,editReady:false,authoringAuthority:'notEstablished'};
  const effect=structuredClone(request.effect);
  const builders={style:styleEffect,replaceLiteral:literalEffect,destructiveScope:broadEffect,insertText:insertionEffect};
  requireValue(effect&&Object.hasOwn(builders,effect.kind),'unsupported');
  const facts=builders[effect.kind](snapshot,target,effect);
  requireValue(facts.deps.length<=WITNESS_LIMITS.nodes,'budget');
  const fp=footprint(snapshot,{nodes:facts.targets,dependencies:facts.deps.filter(id=>!facts.targets.includes(id)),aspects:facts.aspects,destructive:facts.destructive});
  const dependencyFacts=dependencies(snapshot,fp.nodes,facts.properties);
  if(facts.boundaries)dependencyFacts.boundaries=facts.boundaries;
  if(facts.unresolvedSuffix?.length)dependencyFacts.unresolvedSuffix=facts.unresolvedSuffix.map(id=>({node:id,kind:snapshot.nodes[id].kind,extent:null,evidenceDigest:snapshot.nodes[id].evidence.digest}));
  const missing=[...facts.missing];
  if(snapshot.registries.suggestedNamedStylesChanges&&Object.keys(snapshot.registries.suggestedNamedStylesChanges).length)missing.push('unresolvedNamedStyleReview');
  for(const id of fp.nodes){const n=snapshot.nodes[id];
    if(n.unprojectedFields?.length)missing.push('unknownDependentFields');
    if(Object.keys(n.review??{}).length)missing.push('unsupportedReviewEffect');
  }
  // Unknown-scope anchors cannot be declared disjoint by absence of a node ID.
  if(dependencyFacts.registryLosses.length)missing.push('unresolvedRegistryDependency');
  if(['destructiveScope','insertText'].includes(effect.kind)&&dependencyFacts.registryRecords.some(r=>['namedRange','commentAnchor'].includes(r.kind)))missing.push('unsupportedAnchorEffect');
  const evidence={target,effect,footprint:fp,dependencies:dependencyFacts,changes:facts.changes,missingAspects:unique(missing),materialized:'complete',delivered:'none',witnessSatisfied:false,editReady:false,authoringAuthority:'notEstablished'};
  boundedWitness(evidence);return freeze(evidence);
}
export function inspectEffectEvidence(input,request) {
  return effectEvidence(validatedReadModel(input),request);
}
// TRUSTED INTERNAL boundary: deliveries must be store-resolved records. Public
// callers use createReadEvidenceService; no native schema accepts these arrays.
export function compareReadEvidence(input,request,trustedDeliveries=[]) {
  const snapshot=validatedReadModel(input);
  closed(request,['scope','selector','effect'],['presentation','originalRecords']);boundedWitness(request);
  const facts=effectEvidence(snapshot,{scope:request.scope,selector:request.selector,effect:request.effect});
  if(!facts.footprint)return evidenceResult(facts.missingAspects,{materialized:'incomplete',delivered:'none',target:facts.target});
  const {footprint:fp}=facts,missing=[...facts.missingAspects];
  const base=evaluateWitness(snapshot,fp,{deliveries:trustedDeliveries});
  missing.push(...base.missingAspects);
  const expected={target:facts.target,dependencies:facts.dependencies,changes:facts.changes,effect:request.effect};
  if(!request.presentation||!equal(request.presentation,expected))missing.push('effectPresentation');
  let delivered='none';
  if(fp.destructive){
    if(request.originalRecords){
      const preview=previewWitness(snapshot,fp,request.originalRecords);
      const check=evaluateWitness(snapshot,fp,{preview});missing.push(...check.missingAspects);delivered='completePreview';
    }else if(base.witnessSatisfied)delivered='storedContent';
    else missing.push('fullOriginals');
  }else if(!missing.includes('effectPresentation'))delivered='effectPreview';
  return evidenceResult(missing,{materialized:base.materialized,delivered,target:facts.target,footprint:fp,
    comparisonDigest:digest(expected),globalDiagnostics:{missingReviewCoverage:snapshot.missingReviewCoverage,unresolvedExtents:snapshot.unresolvedExtents}});
}
