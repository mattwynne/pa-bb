import { LIMITS, requireValue, evidenceAt, jsonBytes } from './common.mjs';
import { resolveScope, resolveSelector, descendants } from './selectors.mjs';

export function resolveReadSelection(snapshot,scope,selector) {
  const scoped=resolveScope(snapshot,scope);
  if(scoped.status!=='resolved'||!selector)return scoped;
  const selected=resolveSelector(snapshot,scope,selector);
  if(selected.status!=='resolved')return selected;
  const nodes=selector.section?selected.nodes:descendants(snapshot,selected.nodes);
  const ids=new Set(nodes),ancestors=new Set();
  for(const id of nodes){
    let parent=snapshot.nodes[id].parent;
    while(parent&&!ids.has(parent)&&!ancestors.has(parent)){
      ancestors.add(parent);parent=snapshot.nodes[parent].parent;
    }
  }
  return {...selected,tabs:scoped.tabs,nodes,ancestors:[...ancestors],selectedFootprint:true};
}
// Compact runs of ORIGINAL snapshot insertion positions freeze the resolved
// membership. They are internal cursor data, not a transformed identity API or
// public ordinal selector. No target is resolved again during continuation.
export function freezeReadSelection(snapshot,selection) {
  const positions=new Map(Object.keys(snapshot.nodes).map((id,index)=>[id,index])),runs=[];
  for(const id of selection.nodes){
    const index=positions.get(id);requireValue(index!==undefined,'snapshot');
    const last=runs.at(-1);
    if(last&&last[0]+last[1]===index)last[1]++;
    else runs.push([index,1]);
  }
  const result={tabs:selection.tabs,runs,selectedFootprint:selection.selectedFootprint??false,ancestors:selection.ancestors??[]};
  jsonBytes(result,LIMITS.pageBytes);
  return result;
}
export function thawReadSelection(snapshot,frozen) {
  const ids=Object.keys(snapshot.nodes),nodes=[],seen=new Set();
  for(const [start,count] of frozen.runs){
    requireValue(Number.isSafeInteger(start)&&Number.isSafeInteger(count)&&start>=0&&count>0&&start+count<=ids.length&&nodes.length+count<=ids.length,'corrupt');
    for(let i=start;i<start+count;i++){
      requireValue(!seen.has(ids[i]),'corrupt');seen.add(ids[i]);nodes.push(ids[i]);
    }
  }
  return {status:'resolved',tabs:frozen.tabs,nodes,selectedFootprint:frozen.selectedFootprint,ancestors:frozen.ancestors};
}
function diagnosticProjection(records,losses=[],reviewAvailable=false) {
  // Registry handles are not semantic node handles. Their aspect delivery is
  // explicit but cannot transfer authority to the nodes that reference them.
  const nodeAspects=Object.fromEntries(records.map(record=>[record.id,
    record.definitionStatus==='unknownShape'?[]:['styles','lists'].includes(record.category)?['styles']:record.category==='review'&&reviewAvailable?['review']:[]]));
  return {records,losses,nodeAspects,aspects:[],missingAspects:['content','styles','review'],projection:'diagnostic'};
}
export function projectRegistries(snapshot,selection,categories) {
  const wanted=new Set(categories),selected=new Set(selection.nodes),tabs=new Set(selection.tabs),records=[],losses=[];
  let reserved=0;
  const sizeCache=new WeakMap();
  function charge(value){
    const amount=2048+2*jsonBytes(value,LIMITS.modelBytes,sizeCache);
    requireValue(amount<=LIMITS.modelBytes-reserved,'budget');reserved+=amount;
  }
  const references=(snapshot.registryReferences??[]).filter(r=>selected.has(r.ownerNode)&&wanted.has(r.category));
  const targets=new Set(references.flatMap(r=>r.targets));
  let comparisons=0;
  const scopeNodes=selection.nodes.map(id=>snapshot.nodes[id]);
  const contexts=new Map(),rangeRelations=new Map();
  const contextKey=(tabId,segmentId)=>JSON.stringify([tabId,segmentId??null]);
  for(const node of scopeNodes){
    const key=contextKey(node.tabId,node.segment.id);
    if(!contexts.has(key))contexts.set(key,{whole:false,unknown:false,ranges:[]});
    const context=contexts.get(key);
    if(node.kind==='segment')context.whole=true;
    else if(node.extent)context.ranges.push(node.extent);
    else context.unknown=true;
  }
  // Merge once, then each registry span uses logarithmic lookup. Shared comment
  // anchors reuse their result rather than rescanning every selected node.
  for(const context of contexts.values()){
    const merged=[];
    for(const range of context.ranges.sort((a,b)=>a.start-b.start)){
      const last=merged.at(-1);
      if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);
      else merged.push({...range});
    }
    context.ranges=merged;
  }
  function rangeRelation(entry){
    if(rangeRelations.has(entry.id))return rangeRelations.get(entry.id);
    let unknown=!entry.value.ranges?.length,result;
    for(const range of entry.value.ranges??[]){
      requireValue(++comparisons<=LIMITS.reviewComparisons,'budget');
      if(!range||typeof range!=='object'||range.tabId!==undefined&&typeof range.tabId!=='string'||range.segmentId!==undefined&&typeof range.segmentId!=='string'){unknown=true;continue;}
      const start=range.startIndex??0,end=range.endIndex;
      if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(end)||end<start){unknown=true;continue;}
      const context=contexts.get(contextKey(range.tabId??entry.tabId,range.segmentId));
      if(!context)continue;
      if(context.whole){result='selectedSegment';break;}
      let lo=0,hi=context.ranges.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(context.ranges[mid].end<=start)lo=mid+1;else hi=mid;}
      const next=context.ranges[lo];
      if(next&&(start===end?next.start<=start:next.start<end)){result='intersects';break;}
      unknown||=context.unknown;
    }
    result??=unknown?'unresolved':'disjoint';rangeRelations.set(entry.id,result);return result;
  }
  const anchors=new Map(),knownReferences=new Set();
  for(const entry of snapshot.registryEntries??[])if(entry.kind==='commentAnchor'){
    const id=entry.value.anchorId??entry.providerId;
    if(!anchors.has(id))anchors.set(id,[]);
    anchors.get(id).push(entry);
  }
  for(const reference of snapshot.registryReferences??[])for(const target of reference.targets)knownReferences.add(target);
  for(const entry of snapshot.registryEntries??[]){
    if(!wanted.has(entry.category)||entry.tabId!==null&&!tabs.has(entry.tabId))continue;
    let relation=targets.has(entry.id)?'referenced':'tabDefinition';
    if(['namedRange','commentAnchor'].includes(entry.kind))relation=rangeRelation(entry);
    if(entry.kind==='commentThread'&&anchors.has(entry.value.anchorId)){
      const relations=anchors.get(entry.value.anchorId).map(rangeRelation);
      relation=relations.includes('intersects')?'intersects':relations.includes('selectedSegment')?'selectedSegment':relations.includes('unresolved')?'unresolved':'disjoint';
    }
    if(entry.kind==='suggestionThread'&&!targets.has(entry.id)&&knownReferences.has(entry.id))relation='disjoint';
    if(relation==='disjoint')continue;
    if(selection.selectedFootprint&&!targets.has(entry.id)&&!['intersects','unresolved'].includes(relation)){
      // Page/style definitions are applicable metadata. Unanchored review data
      // has unknown scope, not a fabricated relationship to the selected text.
      if(entry.kind==='documentStyle')relation='tabStyle';
      else if(entry.tabId===null)relation='unresolved';
      else continue;
    }
    if(entry.tabId===null&&!targets.has(entry.id)&&!['intersects','selectedSegment'].includes(relation))relation='unresolved';
    charge(entry);
    records.push({...entry,scopeRelation:relation,registryAspect:entry.category==='styles'||entry.category==='lists'?'styles':entry.category==='review'?'review':'registry',provenance:{snapshotId:snapshot.binding.snapshotId,view:snapshot.binding.view}});
    if(relation==='unresolved')losses.push({node:entry.id,kind:'unresolvedRegistryScope',missingAspects:['content','styles','review']});
    if(entry.definitionStatus==='unknownShape')losses.push({node:entry.id,kind:'unknownDefinitionShape',missingAspects:['content','styles','review']});
  }
  for(const reference of references){charge(reference);records.push(reference);}
  for(const reference of references)if(reference.status!=='resolved')losses.push({node:reference.id,kind:'unresolvedReference',providerId:reference.providerId,definitionKind:reference.definitionKind});
  if(wanted.has('diagnostics')){
    const ownerPaths=new Map(Object.values(snapshot.nodes).map(n=>[JSON.stringify(n.evidence.path),n]));
    const tabPaths=new Map(snapshot.tabs.map(t=>[JSON.stringify(t.evidencePath),t]));
    // Unknown fields already have bounded paths/digests. A diagnostic request
    // explicitly opts into their values; default structured reads do not.
    for(const [i,field] of snapshot.unknownFields.entries()){
      let tab,owner;
      const path=[...field.path];
      while(path.length){
        const key=JSON.stringify(path);
        owner??=ownerPaths.get(key);tab??=tabPaths.get(key);path.pop();
      }
      if(tab&&!tabs.has(tab.providerId))continue;
      if(selection.selectedFootprint&&owner&&!selected.has(owner.id))continue;
      requireValue(++comparisons<=LIMITS.reviewComparisons,'budget');
      charge(field);charge(evidenceAt(snapshot,[...field.path,field.field]));
      records.push({id:`${snapshot.binding.snapshotId}:unknown:${i}`,kind:'unknownField',tabId:tab?.providerId??null,field:field.field,path:field.path,digest:field.digest,
        value:evidenceAt(snapshot,[...field.path,field.field]),diagnosticOnly:true,scopeRelation:owner?'owner':'unresolved'});
    }
  }
  jsonBytes(records,LIMITS.modelBytes);
  return diagnosticProjection(records,losses,!snapshot.missingReviewCoverage);
}
export function projectInspection(snapshot,selection,include,outlineDepth) {
  const records=[{id:`${snapshot.binding.snapshotId}:metadata`,kind:'documentSummary',metadata:snapshot.metadata,
    counts:{selectedNodes:selection.nodes.length},capabilities:{authoring:'not_exposed',nativeSuggestions:'accountUnverified'},readProof:false}],chosen=new Set(selection.nodes);
  let reservation=2048+jsonBytes(snapshot.metadata,LIMITS.modelBytes);
  function summary(value){
    const size=2048+2*jsonBytes(value,LIMITS.modelBytes);
    requireValue(size<=LIMITS.modelBytes-reservation,'budget');reservation+=size;records.push(value);
  }
  if(include.includes('tabs'))for(const tab of snapshot.tabs)if(selection.tabs.includes(tab.providerId)){
    summary({id:`${snapshot.binding.snapshotId}:tab:${tab.ordinal}`,kind:'tabSummary',tabId:tab.providerId,title:tab.title,parent:tab.parent,ordinal:tab.ordinal,siblingIndex:tab.siblingIndex,depth:tab.depth});
    for(const node of tab.segments)summary({id:`${snapshot.binding.snapshotId}:segmentSummary:${node}`,kind:'segmentSummary',ownerNode:node,tabId:tab.providerId,segment:snapshot.nodes[node].segment,selected:chosen.has(node)});
  }
  if(include.includes('outline'))for(const heading of snapshot.outline)if(chosen.has(heading.node)&&(outlineDepth===undefined||heading.depth<=outlineDepth))summary({id:`${snapshot.binding.snapshotId}:outline:${heading.node}`,kind:'headingSummary',heading});
  const registry=projectRegistries(snapshot,selection,include);
  for(const record of registry.records)summary(record);
  return diagnosticProjection(records,registry.losses,!snapshot.missingReviewCoverage);
}
// Each structured record owns one node. Children are handles, never textual
// placeholders. Exact provider evidence is bounded, and explicitly diagnostic.
export function project(snapshot,selection,{format,styles=false,review=false,omitImages=false,registries}={}) {
  requireValue(selection.status==='resolved','scope');requireValue(['structured','text'].includes(format),'unsupported');
  if(registries){requireValue(format==='structured','unsupported');return projectRegistries(snapshot,selection,registries);}
  const records=[],losses=[],nodeAspects=Object.create(null);
  const requested=['content',...(styles?['styles']:[]),...(review&&!snapshot.missingReviewCoverage?['review']:[])];
  for(const id of selection.nodes){const n=snapshot.nodes[id];
    if(omitImages&&n.kind==='inlineObjectElement'&&n.objectKind==='image'){losses.push({node:id,kind:'omittedImage'});continue;}
    if(format==='structured'){
      const {evidence,...record}=n;
      records.push({...record,...(!styles?{style:undefined}:{}),...(!review?{review:undefined}:{}),
        providerEvidence:n.kind.startsWith('opaque')?evidenceAt(snapshot,evidence.path):undefined,evidenceDigest:evidence.digest});
    }else if(n.kind==='text') records.push({kind:'text',node:id,text:n.text,extent:n.extent,...(styles?{style:n.style}:{}),...(review?{review:n.review}:{})});
    else if(!['segment','paragraph','tableRow','tableCell'].includes(n.kind))losses.push({node:id,kind:'nonText',sourceKind:n.kind});
    // Retention/digests are not delivery. These unknown locations are absent
    // from the record's actual content; a full original preview can cover them.
    for(const field of n.unprojectedFields??[])losses.push({node:id,kind:'unknownFieldOmitted',path:field.path,field:field.field,digest:field.digest,missingAspects:['content','styles','review']});
    const incompleteStyle=Boolean(n.style?.unknownParentProperties?.length||n.style?.missingNamedStyle);
    if(incompleteStyle)losses.push({node:id,kind:'unresolvedStyleInheritance',missingAspects:['styles'],
      ...(n.style.missingNamedStyle?{namedStyleType:n.style.missingNamedStyle}:{}),...(n.style.unknownParentProperties?{unknownProperties:n.style.unknownParentProperties}: {})});
    if(records.at(-1)?.id===id||records.at(-1)?.node===id)nodeAspects[id]=n.unprojectedFields?.length?[]:requested.filter(aspect=>aspect!=='styles'||!incompleteStyle);
    if(!styles&&n.style)losses.push({node:id,kind:'styleAnnotationOmitted'});
    if(!review&&n.review&&Object.keys(n.review).length)losses.push({node:id,kind:'reviewAnnotationOmitted'});
  }
  const aspects=requested.filter(aspect=>records.length>0&&Object.values(nodeAspects).every(values=>values.includes(aspect)));
  return {records,losses,nodeAspects,aspects,
    missingAspects:['content','styles','review'].filter(aspect=>!aspects.includes(aspect)),projection:format};
}
// Pack the COMPLETE public, delivery and continuation envelopes. Each record
// travels atomically with its losses/aspects. Omission-only losses follow the
// records and have their own cursor offset, so a full last page cannot hide them.
// Measure each unit once; candidate checks use additive JSON container sizes and
// a bounded cache of small envelope shapes, never repeated growing serialization.
export function packReadProjection(projection,{offset=0,lossOffset=0},pageBytes,build) {
  requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=projection.records.length,'invalid');
  requireValue(Number.isSafeInteger(lossOffset)&&lossOffset>=0,'invalid');
  requireValue(pageBytes>0&&pageBytes<=LIMITS.pageBytes,'budget');
  const cache=new WeakMap(),bytes=value=>jsonBytes(value,LIMITS.modelBytes,cache);
  const allIds=new Set(projection.records.map(r=>r.node??r.id)),byNode=new Map(),orphans=[];
  for(const loss of projection.losses){
    if(!allIds.has(loss.node))orphans.push(loss);
    else {if(!byNode.has(loss.node))byNode.set(loss.node,[]);byNode.get(loss.node).push(loss);}
  }
  requireValue(lossOffset<=orphans.length&&(offset===projection.records.length||lossOffset===0),'invalid');
  const aspectNames=['content','styles','review'];
  const names=mask=>aspectNames.filter((_,i)=>mask&(1<<i));
  const delta=(count,sum)=>count?sum+count-1:0; // contents replacing [] or {}
  let end=offset,lossEnd=lossOffset;
  let totals={records:0,recordBytes:0,losses:0,lossBytes:0,nodeBytes:0,mapBytes:0,mask:7};
  const bases=new Map();
  function fits(t,nextOffset,nextLossOffset){
    const complete=nextOffset===projection.records.length&&nextLossOffset===orphans.length;
    const mask=t.records?t.mask:0;
    const key=[complete,mask,String(nextOffset).length,String(nextLossOffset).length].join(':');
    if(!bases.has(key)){
      const base=build({records:[],losses:[],nodes:[],nodeAspects:{},aspects:names(mask),complete,nextOffset,nextLossOffset});
      bases.set(key,{result:bytes(base.result),delivery:bytes(base.delivery),cursor:base.nextState?bytes(base.nextState):0});
    }
    const base=bases.get(key),loss=delta(t.losses,t.lossBytes),nodes=delta(t.records,t.nodeBytes),map=delta(t.records,t.mapBytes);
    return base.result+delta(t.records,t.recordBytes)+loss+nodes+map<=pageBytes&&
      base.delivery+loss+nodes+map<=pageBytes&&base.cursor<=pageBytes;
  }
  const units=projection.records.slice(offset).map(record=>{
    const id=record.node??record.id,losses=byNode.get(id)??[],aspects=projection.nodeAspects[id];
    return {recordBytes:bytes(record),losses:losses.length,lossBytes:losses.reduce((sum,l)=>sum+bytes(l),0),
      nodeBytes:bytes(id),mapBytes:bytes(id)+1+bytes(aspects),
      mask:aspectNames.reduce((bits,aspect,i)=>aspects.includes(aspect)?bits|(1<<i):bits,0)};
  });
  const orphanBytes=orphans.slice(lossOffset).map(loss=>bytes(loss));
  function appendRecord(t,unit){
    return {records:t.records+1,recordBytes:t.recordBytes+unit.recordBytes,losses:t.losses+unit.losses,
      lossBytes:t.lossBytes+unit.lossBytes,nodeBytes:t.nodeBytes+unit.nodeBytes,mapBytes:t.mapBytes+unit.mapBytes,mask:t.mask&unit.mask};
  }
  // Fit is NOT monotone at completion: null replaces the cursor and the saved
  // continuation disappears. Check the complete remaining candidate before any
  // greedy prefix can label its record or loss unit indivisible/unpageable.
  let terminal=totals;
  for(const unit of units)terminal=appendRecord(terminal,unit);
  terminal={...terminal,losses:terminal.losses+orphanBytes.length,lossBytes:terminal.lossBytes+orphanBytes.reduce((sum,n)=>sum+n,0)};
  if(fits(terminal,projection.records.length,orphans.length)){
    totals=terminal;end=projection.records.length;lossEnd=orphans.length;
  }
  while(end<projection.records.length){
    const candidate=appendRecord(totals,units[end-offset]);
    if(!fits(candidate,end+1,lossEnd))break;
    totals=candidate;end++;
  }
  if(end===projection.records.length)while(lossEnd<orphans.length){
    const candidate={...totals,losses:totals.losses+1,lossBytes:totals.lossBytes+orphanBytes[lossEnd-lossOffset]};
    if(!fits(candidate,end,lossEnd+1))break;
    totals=candidate;lossEnd++;
  }
  const complete=end===projection.records.length&&lossEnd===orphans.length;
  requireValue(end>offset||lossEnd>lossOffset||complete,'budget');
  const records=projection.records.slice(offset,end),nodes=records.map(r=>r.node??r.id);
  const losses=nodes.flatMap(id=>byNode.get(id)??[]).concat(orphans.slice(lossOffset,lossEnd));
  const nodeAspects=Object.fromEntries(nodes.map(id=>[id,projection.nodeAspects[id]]));
  const packed=build({records,losses,nodes,nodeAspects,aspects:names(totals.records?totals.mask:0),complete,nextOffset:end,nextLossOffset:lossEnd});
  // Exact defense-in-depth checks happen BEFORE any receipt/cursor commit.
  requireValue(bytes(packed.result)<=pageBytes&&bytes(packed.delivery)<=pageBytes&&(!packed.nextState||bytes(packed.nextState)<=pageBytes),'budget');
  return packed;
}
// Diagnostic record-only pager retained for source callers. The native service
// uses packReadProjection above, never a guessed envelope reserve.
// Pages never cut a scalar or claim a partly delivered record. Oversized single
// records fail closed. Increasing that bound needs a separately reviewed codec.
export function pageProjection(projection,offset=0,pageBytes=LIMITS.pageBytes,envelope={}) {
  requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=projection.records.length);requireValue(pageBytes>0&&pageBytes<=LIMITS.pageBytes,'budget');
  const page={...envelope,records:[],losses:[],nextOffset:null,complete:false};let end=offset;
  const cache=new WeakMap(),bytes=value=>jsonBytes(value,LIMITS.modelBytes,cache),byNode=new Map();
  for(const loss of projection.losses){if(!byNode.has(loss.node))byNode.set(loss.node,[]);byNode.get(loss.node).push(loss);}
  const allRecordIds=new Set(projection.records.map(r=>r.node??r.id));
  const remaining=projection.records.slice(offset),remainingIds=new Set(remaining.map(r=>r.node??r.id));
  const terminal={...envelope,records:remaining,losses:projection.losses.filter(l=>remainingIds.has(l.node)||!allRecordIds.has(l.node)),nextOffset:null,complete:true};
  if(bytes(terminal)<=pageBytes)return terminal;
  let recordBytes=0,lossBytes=0;
  while(end<projection.records.length){
    const next=projection.records[end],losses=byNode.get(next.node??next.id)??[];
    const nextRecords=recordBytes+bytes(next),nextLosses=lossBytes+losses.reduce((sum,l)=>sum+bytes(l),0);
    const count=page.records.length+1,lossCount=page.losses.length+losses.length;
    const base=bytes({...envelope,records:[],losses:[],nextOffset:end+1,complete:false});
    if(base+nextRecords+count-1+nextLosses+Math.max(0,lossCount-1)>pageBytes)break;
    page.records.push(next);page.losses.push(...losses);recordBytes=nextRecords;lossBytes=nextLosses;end++;
  }
  requireValue(end>offset||end===projection.records.length,'budget');
  if(end===projection.records.length){page.complete=true;page.nextOffset=null;
    // Omissions with no output node (e.g. object-only text) are not hidden.
    page.losses=[...page.losses,...projection.losses.filter(l=>!allRecordIds.has(l.node))];
  }else page.nextOffset=end;
  requireValue(Buffer.byteLength(JSON.stringify(page))<=pageBytes,'budget');return page;
}
