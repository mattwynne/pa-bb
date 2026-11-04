import { LIMITS, requireValue, scalar, semanticError, jsonBytes, digest, boundedTree } from './common.mjs';
import { materialize } from './model.mjs';
// Per invocation, not merely returned-output caps. NFC segmentation is bounded
// separately because ICU segmentation and combining-sequence work are costly.
export const SEARCH_LIMITS=Object.freeze({scanUnits:262144,runUnits:65536,nfcUnits:16384,clusterUnits:4096,attempts:65536,candidateBytes:48000});
function boundedCandidates(candidates) {
  const result=[];let bytes=2;
  for(const candidate of candidates){
    const size=jsonBytes(candidate,LIMITS.pageBytes);
    if(result.length===LIMITS.matches||bytes+size+1>SEARCH_LIMITS.candidateBytes)break;
    result.push(candidate);bytes+=size+1;
  }
  return {candidates:result,...(result.length<candidates.length?{truncated:true,count:candidates.length}:{})};
}
function headingInput(h,section=false) {
  requireValue(h&&typeof h==='object'&&!Array.isArray(h));
  requireValue(Object.keys(h).every(k=>['headingId','path','text','level','depth',...(section?['includeHeading','before']:[])].includes(k)));
  requireValue(['headingId','path','text'].filter(k=>h[k]!==undefined).length===1);
  if(h.headingId!==undefined)requireValue(typeof h.headingId==='string'&&h.headingId.length>0&&h.headingId.length<=256);
  if(h.text!==undefined)requireValue(typeof h.text==='string'&&h.text.length>0&&h.text.length<=2000);
  if(h.path!==undefined)requireValue(Array.isArray(h.path)&&h.path.length>0&&h.path.length<=32&&h.path.every(p=>typeof p==='string'&&p.length>0&&p.length<=2000));
  if(h.level!==undefined)requireValue(Number.isSafeInteger(h.level)&&h.level>=1&&h.level<=6);
  if(h.depth!==undefined)requireValue(Number.isSafeInteger(h.depth)&&h.depth>=0&&h.depth<=32);
  if(section)requireValue(typeof h.includeHeading==='boolean');
}
const segmentKey = s=>JSON.stringify(s);

function exactKeys(value,keys) {
  requireValue(value&&typeof value==='object'&&!Array.isArray(value),'invalid');
  requireValue(Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'invalid');
}
// Raw evidence hashes alone say nothing about a caller-supplied node inventory.
// Rebuild both observations with the real bounded materializer, then compare
// the complete derived semantic facts before using ANY graph edge/path/kind.
// Continuity below consumes only those rebuilt models, never supplied graphs.
// Only memoize completely immutable inputs AFTER full independent validation.
// Mutable/deserialized inputs are always rechecked; Object.freeze(root) alone
// is insufficient. The rebuilt model is already recursively frozen.
const validatedModels=new WeakMap();
const deepFrozen=value=>typeof value==='function'?false:value===null||typeof value!=='object'||Object.isFrozen(value)&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>Object.hasOwn(d,'value')&&deepFrozen(d.value));
export function validatedReadModel(snapshot) {
  if(snapshot&&typeof snapshot==='object'&&validatedModels.has(snapshot))return validatedModels.get(snapshot);
  boundedTree(snapshot,{...LIMITS,providerBytes:LIMITS.modelBytes,nodes:1000000,depth:96});
  requireValue(typeof snapshot.missingReviewCoverage==='boolean','corrupt');
  const observed=materialize({document:snapshot.evidence,metadata:snapshot.metadata,binding:snapshot.binding,
    reviewIncluded:!snapshot.missingReviewCoverage});
  const fields=['version','evidenceDigest','nodes','tabs','outline','registries','registryEntries','registryReferences',
    'revision','currentEditEvidence','missingReviewCoverage','materialized','unresolvedExtents','unknownFields'];
  for(const field of fields){
    requireValue(Object.hasOwn(snapshot,field)&&digest(snapshot[field])===digest(observed[field]),'corrupt');
  }
  validatedModels.set(observed,observed);
  if(deepFrozen(snapshot))validatedModels.set(snapshot,observed);
  return observed;
}
function mappingBinding(snapshot,observed) {
  exactKeys(observed,['snapshotId','evidenceDigest','subject','account','threadId','documentId','view']);
  for(const key of ['snapshotId','subject','account','threadId','documentId','view'])requireValue(observed[key]===snapshot.binding[key],'snapshot');
  requireValue(observed.evidenceDigest===snapshot.evidenceDigest,'snapshot');
  jsonBytes(snapshot.evidence,LIMITS.providerBytes);
  requireValue(digest(snapshot.evidence)===snapshot.evidenceDigest&&snapshot.evidence.documentId===observed.documentId,'corrupt');
}
// Coordinates are provider observations, not logical identity. Compare the
// original subtree with only structural coordinates removed. Any content,
// topology, span, style, object or provider identity change is unsupported by
// this conservative read-side continuity proof, rather than guessed/rebased.
export function continuityEvidence(snapshot,node) {
  const raw=node.evidence.path.reduce((value,key)=>value?.[key],snapshot.evidence);
  jsonBytes(raw,1048576);
  requireValue(digest(raw)===node.evidence.digest,'corrupt');
  const structuralPaths=new Set(descendants(snapshot,[node.id]).map(id=>JSON.stringify(snapshot.nodes[id].evidence.path)));
  function copy(value,path) {
    if(Array.isArray(value))return value.map((child,index)=>copy(child,[...path,index]));
    if(value&&typeof value==='object'){
      const structural=structuralPaths.has(JSON.stringify(path));
      return Object.fromEntries(Object.entries(value)
        .filter(([key])=>!structural||key!=='startIndex'&&key!=='endIndex')
        .map(([key,child])=>[key,copy(child,[...path,key])]));
    }
    return value;
  }
  return digest(copy(raw,node.evidence.path));
}
// INTERNAL PURE READ-EVIDENCE contract. There is deliberately no native tool,
// coordinate target, writer receipt, execution boolean or automatic rebasing.
// A closed injective mapping records explicit observations, not S03 provenance.
export function evaluateLogicalIdentity(origin,destination,mapping,logicalSource) {
  origin=validatedReadModel(origin);
  destination=validatedReadModel(destination);
  jsonBytes(mapping,LIMITS.pageBytes);
  exactKeys(mapping,['version','id','provenance','origin','destination','entries','mappingDigest']);
  requireValue(mapping.version===1&&typeof mapping.id==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(mapping.id));
  exactKeys(mapping.provenance,['kind','id']);
  requireValue(mapping.provenance.kind==='readEvidenceComparison'&&typeof mapping.provenance.id==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(mapping.provenance.id));
  const {mappingDigest,...facts}=mapping;
  requireValue(mappingDigest===digest(facts),'corrupt');
  mappingBinding(origin,mapping.origin);mappingBinding(destination,mapping.destination);
  requireValue(origin.binding.snapshotId!==destination.binding.snapshotId,'snapshot');
  for(const key of ['subject','account','threadId','documentId','view'])requireValue(origin.binding[key]===destination.binding[key],'snapshot');
  requireValue(Array.isArray(mapping.entries)&&mapping.entries.length>0&&mapping.entries.length<=LIMITS.matches);
  requireValue(typeof logicalSource==='string','invalid');
  const sources=new Set(),targets=new Set();let resolved;
  let comparedBytes=0;
  const indexes=new Map();
  function continuityIndex(snapshot,entry) {
    const key=JSON.stringify([snapshot.binding.snapshotId,entry.kind,entry.tabId,entry.segment]);
    if(indexes.has(key))return indexes.get(key);
    const index=new Map();
    for(const node of Object.values(snapshot.nodes)){
      if(node.kind!==entry.kind||node.tabId!==entry.tabId||segmentKey(node.segment)!==segmentKey(entry.segment))continue;
      comparedBytes+=jsonBytes(node.evidence.path.reduce((value,k)=>value?.[k],snapshot.evidence),1048576);
      requireValue(comparedBytes<=LIMITS.providerBytes,'budget');
      const hash=continuityEvidence(snapshot,node);
      if(!index.has(hash))index.set(hash,[]);
      index.get(hash).push(node.id);
    }
    indexes.set(key,index);return index;
  }
  for(const entry of mapping.entries){
    exactKeys(entry,['source','target','kind','tabId','segment','sourceEvidenceDigest','targetEvidenceDigest']);
    requireValue(typeof entry.source==='string'&&typeof entry.target==='string','invalid');
    requireValue(!sources.has(entry.source)&&!targets.has(entry.target),'conflict');
    sources.add(entry.source);targets.add(entry.target);
    const from=origin.nodes[entry.source],to=destination.nodes[entry.target];
    requireValue(from&&to,'snapshot');
    requireValue(from.kind===entry.kind&&to.kind===entry.kind&&from.tabId===entry.tabId&&to.tabId===entry.tabId&&
      segmentKey(from.segment)===segmentKey(entry.segment)&&segmentKey(to.segment)===segmentKey(entry.segment),'scope');
    requireValue(from.evidence.digest===entry.sourceEvidenceDigest&&to.evidence.digest===entry.targetEvidenceDigest,'corrupt');
    const before=continuityIndex(origin,entry),after=continuityIndex(destination,entry);
    const matching=[...before].find(([,ids])=>ids.includes(from.id));
    requireValue(matching&&matching[1].length===1&&after.get(matching[0])?.length===1&&after.get(matching[0])[0]===to.id,'conflict');
    if(entry.source===logicalSource)resolved=entry;
  }
  requireValue(resolved,'snapshot');
  return {status:'resolved',logicalSource,target:resolved.target,kind:resolved.kind,mappingId:mapping.id,mappingDigest,
    origin:mapping.origin,destination:mapping.destination,provenance:mapping.provenance,
    evidenceKind:'readSideIdentityComparison',authoringAuthority:'notEstablished'};
}
export function parseDocument(input) {
  requireValue(typeof input==='string'&&input.length<=1024);
  if(/^[\w-]{1,256}$/.test(input)) return {documentId:input,urlTab:null};
  let url;try{url=new URL(input);}catch{throw semanticError('invalid');}
  requireValue(url.protocol==='https:'&&url.hostname==='docs.google.com'&&!url.username&&!url.password&&!url.port);
  const match=url.pathname.match(/^\/document\/d\/([\w-]{1,256})(?:\/(?:edit|view|preview))?\/?$/);requireValue(match);
  const query=url.searchParams.getAll('tab'),hash=new URLSearchParams(url.hash.slice(1)).getAll('tab');
  requireValue(query.length<=1&&hash.length<=1&&(!query.length||!hash.length||query[0]===hash[0]),'conflict');
  const urlTab=query[0]??hash[0]??null;
  requireValue(urlTab===null||/^[\w-]{1,256}$/.test(urlTab),'scope');
  return {documentId:match[1],urlTab};
}
export function descendants(snapshot,roots) {
  const result=[],stack=[...roots].reverse();
  while(stack.length){const id=stack.pop(),n=snapshot.nodes[id];requireValue(n,'snapshot');result.push(id);for(let i=n.children.length-1;i>=0;i--)stack.push(n.children[i]);}
  return result;
}
export function resolveScope(snapshot,scope,urlTab=null) {
  requireValue(scope?.tabs&&Array.isArray(scope.segments)&&scope.segments.length>0&&scope.segments.length<=100,'scope');
  const selector=scope.tabs;requireValue(Object.keys(selector).filter(k=>k!=='snapshotId').length===1,'scope');let tabs;
  const byId=new Map(snapshot.tabs.map(t=>[t.providerId,t]));
  if(selector.all===true) tabs=snapshot.tabs;
  else if(selector.ids){requireValue(Array.isArray(selector.ids)&&selector.ids.length>0&&selector.ids.length<=100&&selector.ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&new Set(selector.ids).size===selector.ids.length,'scope');tabs=selector.ids.map(id=>byId.get(id));requireValue(tabs.every(Boolean),'scope');}
  else if(selector.path){requireValue(Array.isArray(selector.path)&&selector.path.length>0&&selector.path.length<=32&&selector.path.every(p=>typeof p==='string'&&p.length>0&&p.length<=256),'scope');tabs=snapshot.tabs.filter(t=>{const path=[t.title];let p=t.parent;while(p){const parent=byId.get(p);requireValue(parent,'corrupt');path.unshift(parent.title);p=parent.parent;}return JSON.stringify(path)===JSON.stringify(selector.path);});}
  else if(selector.ordinal!==undefined){requireValue(selector.snapshotId===snapshot.binding.snapshotId,'snapshot');requireValue(Number.isSafeInteger(selector.ordinal)&&selector.ordinal>=0,'scope');tabs=[snapshot.tabs[selector.ordinal]].filter(Boolean);}
  else throw semanticError('scope');
  if(selector.path&&tabs.length!==1)return {status:tabs.length?'ambiguous':'missing',...boundedCandidates(tabs.map(t=>({tabId:t.providerId,title:t.title,parent:t.parent}))),nodes:[],roots:[]};
  requireValue(tabs.length,'scope');
  requireValue(!urlTab||tabs.length===1&&tabs[0].providerId===urlTab,'conflict');
  const roots=[];
  for(const tab of tabs)for(const wanted of scope.segments){requireValue(['body','header','footer','footnote'].includes(wanted.kind),'scope');requireValue(wanted.kind!=='body'||!wanted.id,'scope');
    const found=tab.segments.filter(id=>{const s=snapshot.nodes[id].segment;return s.kind===wanted.kind&&(!wanted.id||s.id===wanted.id);});requireValue(found.length,'scope');roots.push(...found);}
  requireValue(new Set(roots).size===roots.length,'scope');
  return {status:'resolved',tabs:tabs.map(t=>t.providerId),roots,nodes:descendants(snapshot,roots)};
}
function cardinal(candidates,cardinality={exactly:1}) {
  requireValue(cardinality&&Object.keys(cardinality).length===1);
  if('occurrence'in cardinality){requireValue(Number.isSafeInteger(cardinality.occurrence)&&cardinality.occurrence>=0);const c=candidates[cardinality.occurrence];return {status:c?'resolved':'missing',count:candidates.length,candidates:c?[c]:[]};}
  if('all'in cardinality){const expected=cardinality.all;requireValue(Number.isSafeInteger(expected)&&expected>=1&&expected<=LIMITS.matches);return {status:candidates.length===expected?'resolved':candidates.length?'ambiguous':'missing',count:candidates.length,candidates};}
  requireValue(Number.isSafeInteger(cardinality.exactly)&&cardinality.exactly>=1&&cardinality.exactly<=LIMITS.matches);
  return {status:candidates.length===cardinality.exactly?'resolved':candidates.length?'ambiguous':'missing',count:candidates.length,candidates};
}
// Unicode simple folding never expands a scalar. Upper/lower equivalence is
// corrected for the Unicode simple-fold exceptions (Turkic, Cherokee, ST).
// Runtime Unicode version is returned as provenance, not locale-sensitive case.
function simpleFold(c) {
  if(c==='\u0131'||c==='\u0130')return c;
  const cp=c.codePointAt(0);if(cp>=0x13a0&&cp<=0x13ff||cp>=0xab70&&cp<=0xabbf)return c.toUpperCase();
  if(c==='\ufb05')return '\ufb06';
  // Unicode 17.0 CaseFolding.txt S mappings (not their F expansions).
  // Keep source scalar boundaries; this does not opt into NFC normalization.
  if(c==='\u1fd3')return '\u0390';
  if(c==='\u1fe3')return '\u03b0';
  const upper=c.toUpperCase(),lower=(Array.from(upper).length===1?upper:c).toLowerCase();
  return Array.from(lower).length===1?lower:c;
}
const spaces=new Set(Array.from(' \t\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000'));
const typography=new Map([...Array.from('‘’‚‛').map(c=>[c,"'"]),...Array.from('“”„‟').map(c=>[c,'"']),...Array.from('‐‑‒–—−').map(c=>[c,'-'])]);
export function normalizeMapped(text,normalization='exact',casePolicy='exact') {
  requireValue(typeof text==='string');
  requireValue(text.length<=(normalization==='nfc'?SEARCH_LIMITS.nfcUnits:SEARCH_LIMITS.runUnits),'budget');
  scalar(text);requireValue(['exact','typographic','nfc'].includes(normalization));requireValue(['exact','simpleCaseFold'].includes(casePolicy));
  let chunks=[];
  if(normalization==='nfc') {
    for(const s of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)){
      requireValue(s.segment.length<=SEARCH_LIMITS.clusterUnits,'budget');
      const normalized=s.segment.normalize('NFC');
      if(normalized!==s.segment)chunks.push({start:s.index,end:s.index+s.segment.length,text:normalized});
      else {let pos=s.index;for(const c of s.segment){chunks.push({start:pos,end:pos+c.length,text:c});pos+=c.length;}}
    }
  }
  else {let pos=0;for(const c of text){const start=pos;pos+=c.length;
    if(normalization==='typographic'&&spaces.has(c)){const prior=chunks.at(-1);if(prior?.space){prior.end=pos;continue;}chunks.push({start,end:pos,text:' ',space:true});}
    else chunks.push({start,end:pos,text:normalization==='typographic'?typography.get(c)??c:c});}}
  let output='';const boundaries=new Map([[0,0]]);
  for(const chunk of chunks){boundaries.set(output.length,chunk.start);output+=casePolicy==='simpleCaseFold'?Array.from(chunk.text,simpleFold).join(''):chunk.text;boundaries.set(output.length,chunk.end);}
  return {text:output,boundaries,unicodeVersion:process.versions.unicode};
}
export function findLiteral(snapshot,scope,query) {
  requireValue(query&&typeof query.literal==='string'&&query.literal.length>0&&query.literal.length<=2000);scalar(query.literal);
  requireValue(!query.regex,'unsupported');
  const selected=resolveScope(snapshot,scope);if(selected.status!=='resolved')return {...selected,readProof:false};
  const limit=query.limit??LIMITS.matches;requireValue(Number.isSafeInteger(limit)&&limit>=1&&limit<=LIMITS.matches);
  const needle=normalizeMapped(query.literal,query.normalization,query.casePolicy).text;requireValue(needle.length>0);
  const candidates=[];let count=0,scanned=0,attempts=0,candidateBytes=0;
  for(const id of selected.nodes){const paragraph=snapshot.nodes[id];if(paragraph.kind!=='paragraph')continue;
    let text='',start=null,runIds=[],previous=null;
    const scan=()=>{
      if(!text)return;const mapped=normalizeMapped(text,query.normalization,query.casePolicy);let from=0;
      while(from<=mapped.text.length-needle.length){requireValue(++attempts<=SEARCH_LIMITS.attempts,'budget');const index=mapped.text.indexOf(needle,from);if(index<0)break;const end=index+needle.length;from=index+1;
        if(!mapped.boundaries.has(index)||!mapped.boundaries.has(end))continue;
        const a=mapped.boundaries.get(index),b=mapped.boundaries.get(end);count++;
        requireValue(count<=LIMITS.matches,'budget');
        if(candidates.length<limit){let lo=Math.max(0,a-40),hi=Math.min(text.length,b+40);if(lo>0&&/^[\uDC00-\uDFFF]$/.test(text[lo]))lo--;if(hi<text.length&&/^[\uDC00-\uDFFF]$/.test(text[hi]))hi++;
          // Locate intersecting runs by binary search, not matches × all runs.
          let left=0,right=runIds.length;
          while(left<right){const mid=(left+right)>>>1;if(snapshot.nodes[runIds[mid]].extent.end<=start+a)left=mid+1;else right=mid;}
          const runs=[];
          for(let i=left;i<runIds.length&&snapshot.nodes[runIds[i]].extent.start<start+b;i++)runs.push(runIds[i]);
          const candidate={snapshotId:snapshot.binding.snapshotId,node:id,tabId:paragraph.tabId,segment:paragraph.segment,extent:{start:start+a,end:start+b},text:text.slice(a,b),context:text.slice(lo,hi),runs};
          candidateBytes+=jsonBytes(candidate,SEARCH_LIMITS.candidateBytes);
          requireValue(candidateBytes<=SEARCH_LIMITS.candidateBytes,'budget');candidates.push(candidate);}
      }
    };
    for(const child of paragraph.children){const n=snapshot.nodes[child];
      if(n.kind!=='text'||previous!==null&&n.extent.start!==previous){scan();text='';start=null;runIds=[];previous=null;}
      if(n.kind==='text'){
        scanned+=n.text.length;requireValue(scanned<=SEARCH_LIMITS.scanUnits,'budget');
        requireValue(text.length+n.text.length<=(query.normalization==='nfc'?SEARCH_LIMITS.nfcUnits:SEARCH_LIMITS.runUnits),'budget');
        if(start===null)start=n.extent.start;text+=n.text;runIds.push(child);previous=n.extent.end;
      }
    }scan();
  }
  return {status:count?'matches':'missing',snapshotId:snapshot.binding.snapshotId,count,candidates,truncated:count>candidates.length,readProof:false,normalization:query.normalization??'exact',casePolicy:query.casePolicy??'exact',unicodeVersion:process.versions.unicode};
}
export function resolveSelector(snapshot,scope,selector) {
  const selected=resolveScope(snapshot,scope);if(selected.status!=='resolved')return selected;
  requireValue(selector&&Object.keys(selector).length===1);const allowed=new Set(selected.nodes);
  if(selector.text){const found=findLiteral(snapshot,scope,selector.text);requireValue(!found.truncated,'budget');return {...cardinal(found.candidates,selector.text.cardinality),readProof:false};}
  let nodes=[];
  if(selector.node)nodes=allowed.has(selector.node)?[selector.node]:[];
  else if(selector.span){const {from,to}=selector.span,a=snapshot.nodes[from],b=snapshot.nodes[to];if(a&&b&&allowed.has(from)&&allowed.has(to)&&a.parent===b.parent){const siblings=snapshot.nodes[a.parent]?.children??[],i=siblings.indexOf(from),j=siblings.indexOf(to);requireValue(i>=0&&j>=i,'scope');nodes=siblings.slice(i,j+1);}}
  else if(selector.heading||selector.section){const h=selector.heading??selector.section;
    headingInput(h,Boolean(selector.section));
    const candidates=snapshot.outline.filter(o=>allowed.has(o.node)&&(h.level===undefined||h.level===o.level)&&(h.depth===undefined||h.depth===o.depth)&&
      (h.headingId!==undefined?o.providerId===h.headingId:h.text!==undefined?o.title===h.text:JSON.stringify(o.path)===JSON.stringify(h.path)));
    if(candidates.length!==1)return {status:candidates.length?'ambiguous':'missing',...boundedCandidates(candidates),nodes:[]};
    const target=candidates[0];
    if(selector.heading)nodes=[target.node];
    else {
      const headingExtent=snapshot.nodes[target.node].extent;
      if(!headingExtent||!target.extent&&!h.before)return {status:'unresolved',reason:'sectionExtents',nodes:[],candidates:[{node:target.node}]};
      let end=target.extent?.end;
      if(h.before){
        const boundary=resolveSelector(snapshot,scope,{heading:h.before});
        if(boundary.status!=='resolved')return {...boundary,boundary:'explicitEnd'};
        const node=snapshot.nodes[boundary.nodes[0]];
        requireValue(node.extent&&node.tabId===target.tabId&&segmentKey(node.segment)===segmentKey(target.segment)&&node.extent.start>headingExtent.start,'scope');
        end=node.extent.start;
      }
      const start=h.includeHeading?headingExtent.start:headingExtent.end;
      // A next heading is an exclusive boundary. A terminal observed maximum
      // is not an end: an unmapped tail at or beyond it may still belong here.
      const terminal=!h.before&&target.sectionEnd?.kind!=='nextHeading';
      const boundedEnd=!terminal||target.sectionEnd?.kind==='segmentBoundary';
      const unresolved=[];
      nodes=selected.nodes.filter(id=>{
        const n=snapshot.nodes[id];
        if(n.kind==='segment'||n.tabId!==target.tabId||segmentKey(n.segment)!==segmentKey(target.segment))return false;
        if(!n.extent){
          // Missing bounds are never silently dropped from a selected section.
          let parent=snapshot.nodes[n.parent];
          while(parent&&!parent.extent)parent=snapshot.nodes[parent.parent];
          const raw=n.evidence.path.reduce((v,k)=>v[k],snapshot.evidence);
          const lower=raw.startIndex??parent?.extent?.start??0,upper=parent?.extent?.end??Infinity;
          if((!boundedEnd||(terminal?lower<=end:lower<end))&&upper>start)unresolved.push(id);
          return false;
        }
        return n.extent.start>=start&&n.extent.end<=end;
      });
      if(unresolved.length)return {status:'unresolved',reason:'sectionExtents',nodes:[],...boundedCandidates(unresolved.map(node=>({node})))};
      return {status:'resolved',snapshotId:snapshot.binding.snapshotId,nodes,candidates:[],readProof:false,
        section:{heading:target.node,start,end,includeHeading:h.includeHeading}};
    }
  }else throw semanticError('unsupported');
  return {status:nodes.length?'resolved':'missing',snapshotId:snapshot.binding.snapshotId,nodes,...boundedCandidates(nodes.map(id=>({node:id,kind:snapshot.nodes[id].kind}))),readProof:false};
}
