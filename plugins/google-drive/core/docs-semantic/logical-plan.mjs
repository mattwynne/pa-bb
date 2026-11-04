// Closed logical-plan invariants, not a planner or compiler. Checksums are
// integrity checks only; independent verification still resolves the command
// against the actual before observation. Publication also checks that observation.
import {assertReplacementPlan} from './replacement-plan.mjs';
import {assertCompositionPlan} from './composition-plan.mjs';
import {boundedTree,LIMITS,requireValue,digest} from './common.mjs';
import {validatedReadModel} from './selectors.mjs';
import {inspectEffectEvidence,compareReadEvidence} from './read-effects.mjs';
const check=c=>requireValue(c,'corrupt');
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const ordered=v=>Array.isArray(v)?v.map(ordered):obj(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
export const logicalDigest=v=>digest(ordered(v));
export const sameLogical=(a,b)=>logicalDigest(a)===logicalDigest(b);
function keys(v,required,optional=[]){check(obj(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)));}
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=320;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const empty=v=>Array.isArray(v)&&v.length===0;
const equal=(a,b)=>check(sameLogical(a,b));
// Transport response accounting belongs to the retained snapshot, not draft intent.
export function logicalPlanBinding(snapshot){
 const b=snapshot.binding;
 return Object.fromEntries([...['subject','account','threadId','snapshotId','documentId','view','retrievedAt'].map(k=>[k,b[k]]),...Object.hasOwn(b,'source')?[['source',b.source]]:[],['revision',structuredClone(snapshot.revision)],['evidenceDigest',snapshot.evidenceDigest]]);
}
export const BOLD_VERIFICATION_LIMIT='Exact observed run topology; no rendering or submission attribution';
export function assertLogicalPlan(p,{record,snapshot}={}){
 if(p?.kind==='paragraphComposition')return assertCompositionPlan(p,{record,snapshot});
 if(p?.kind==='paragraphReplace')return assertReplacementPlan(p,{record,snapshot});
 try{boundedTree(p,{...LIMITS,providerBytes:65536,nodes:20000,depth:64});}catch{check(false);}
 keys(p,['version','kind','mode','capabilityVersion','lifecycle','binding','command','sourceEvidence','target','effect','verification','integrity']);
 check(p.version===1&&p.kind==='paragraphBold'&&p.mode==='direct'&&p.capabilityVersion==='paragraph-bold/1');
 const {integrity,...body}=p;check(hash(integrity)&&logicalDigest(body)===integrity);
 const b=p.binding,c=p.command,t=p.target,e=p.effect,l=p.lifecycle,v=p.verification;
 keys(b,['subject','account','threadId','snapshotId','documentId','view','retrievedAt','revision','evidenceDigest'],['source']);
 for(const k of ['subject','account','threadId','snapshotId','documentId'])check(id(b[k]));
 check(b.view==='inline'&&(!Object.hasOwn(b,'source')||b.source==='current')&&integer(b.retrievedAt)&&hash(b.evidenceDigest));
 keys(b.revision,['kind','id','subject']);check(b.revision.kind==='docs'&&typeof b.revision.id==='string'&&b.revision.id.length>0&&b.revision.id.length<=2048&&b.revision.subject===b.subject);
 keys(l,['createdAt','expiresAt','budgets']);keys(l.budgets,['version','planBytes','recordBytes']);
 check(integer(l.createdAt)&&integer(l.expiresAt)&&l.createdAt>=b.retrievedAt&&l.expiresAt===l.createdAt+1800000&&l.budgets.version===1);
 for(const k of ['planBytes','recordBytes'])check(Number.isSafeInteger(l.budgets[k])&&l.budgets[k]>0&&l.budgets[k]<=65536);
 check(Buffer.byteLength(JSON.stringify(p))<=l.budgets.planBytes);
 const nodeId=x=>id(x)&&x.startsWith(`${b.snapshotId}:`)&&/^[1-9][0-9]{0,5}$/.test(x.slice(b.snapshotId.length+1));
 keys(c,['op','node','bold']);check(c.op==='paragraphBold'&&nodeId(c.node)&&typeof c.bold==='boolean');
 keys(t,['node','path','range','text']);check(t.node===c.node&&typeof t.text==='string'&&t.text.endsWith('\n')&&t.text.indexOf('\n')===t.text.length-1);
 check(Array.isArray(t.path)&&t.path.length>=6&&t.path[0]==='tabs'&&integer(t.path[1]));
 let pos=2;while(t.path[pos]==='childTabs'){check(integer(t.path[pos+1]));pos+=2;}
 equal(t.path.slice(pos,pos+3),['documentTab','body','content']);check(pos+4===t.path.length&&integer(t.path[pos+3]));
 const source=p.sourceEvidence;keys(source,['node','path','digest','paragraph']);check(source.node===c.node&&hash(source.digest)&&digest(source.paragraph)===source.digest);equal(source.path,t.path);
 keys(source.paragraph,['endIndex','paragraph'],['startIndex']);keys(source.paragraph.paragraph,['elements'],['paragraphStyle','positionedObjectIds']);
 const sourceRuns=source.paragraph.paragraph.elements;check(Array.isArray(sourceRuns)&&sourceRuns.length>0);
 check(sourceRuns.every(r=>obj(r)&&obj(r.textRun)&&typeof r.textRun.content==='string'));equal(t.text,sourceRuns.map(r=>r.textRun.content).join(''));
 keys(t.range,['tabId','startIndex','endIndex']);check(id(t.range.tabId)&&integer(t.range.startIndex)&&integer(t.range.endIndex)&&t.range.endIndex>t.range.startIndex&&t.text.length===t.range.endIndex-t.range.startIndex);
 check((source.paragraph.startIndex??0)===t.range.startIndex&&source.paragraph.endIndex===t.range.endIndex);
 keys(v,['kind','version','bold','normalization','limitation']);check(v.kind==='paragraphBoldExactPreservation'&&v.version===1&&v.bold===c.bold&&v.limitation===BOLD_VERIFICATION_LIMIT);equal(v.normalization,['revisionIdOnly']);
 keys(e,['target','dependencies','changes','effect','footprint','witnessSatisfied']);check(e.witnessSatisfied===true);
 const target=e.target;
 keys(target,['binding','scope','selector','cardinality','status','count','enumeration','nodes','matches','sourceMaps','selectedMatches','materialized','delivered','witnessSatisfied','missingAspects','editReady','authoringAuthority']);
 equal(target.binding,{...b,source:'current'});equal(target.scope,{tabs:{ids:[t.range.tabId]},segments:[{kind:'body'}]});equal(target.selector,{node:c.node});equal(target.cardinality,{exactly:1});equal(target.nodes,[c.node]);
 check(target.status==='resolved'&&target.count===1&&target.enumeration==='complete'&&target.materialized==='complete'&&target.delivered==='targetEvidence'&&target.witnessSatisfied===false&&target.editReady===false&&target.authoringAuthority==='notEstablished');
 for(const k of ['matches','sourceMaps','selectedMatches','missingAspects'])check(empty(target[k]));
 equal(e.effect,{kind:'style',family:'text',set:{bold:c.bold}});
 keys(e.dependencies,['nodes','registryRecords','registryLosses']);check(Array.isArray(e.dependencies.nodes)&&e.dependencies.nodes.length>=2&&empty(e.dependencies.registryLosses)&&Array.isArray(e.dependencies.registryRecords));
 const deps=e.dependencies.nodes;check(deps.every(obj)&&Array.isArray(e.changes)&&e.dependencies.registryRecords.every(obj));
 const paragraph=deps.at(-1),runs=deps.slice(0,-1),runIds=runs.map(n=>n.node);
 check(new Set(deps.map(n=>n.node)).size===deps.length&&runs.length===e.changes.length&&runs.length===sourceRuns.length);
 let end=t.range.startIndex;
 for(const n of deps){
  keys(n,['node','kind','parent','extent','properties','storedStyle','terminatingNewline','list','positionedObjectIds','review','unknownFields']);
  check(nodeId(n.node)&&nodeId(n.parent)&&n.list===null&&Array.isArray(n.positionedObjectIds)&&n.positionedObjectIds.every(id)&&obj(n.review)&&Object.keys(n.review).length===0&&empty(n.unknownFields)&&obj(n.storedStyle));
  keys(n.extent,['start','end']);check(integer(n.extent.start)&&integer(n.extent.end));keys(n.properties,['bold']);keys(n.properties.bold,['value','provenance','source','status']);
 }
 equal(paragraph.storedStyle,source.paragraph.paragraph.paragraphStyle??{});equal(paragraph.positionedObjectIds,source.paragraph.paragraph.positionedObjectIds??[]);
 check(paragraph.node===c.node&&paragraph.kind==='paragraph'&&paragraph.terminatingNewline===null);equal(paragraph.extent,{start:t.range.startIndex,end:t.range.endIndex});equal(paragraph.properties.bold,{value:null,provenance:'unknown',source:null,status:'unknown'});
 for(let i=0;i<runs.length;i++){
  const n=runs[i],old=n.properties.bold,change=e.changes[i],raw=sourceRuns[i];
  keys(raw,['endIndex','textRun'],['startIndex']);keys(raw.textRun,['content'],['textStyle']);
  equal(n.storedStyle,raw.textRun.textStyle??{});equal(n.extent,{start:raw.startIndex??0,end:raw.endIndex});check(raw.textRun.content.length===raw.endIndex-(raw.startIndex??0));equal(n.positionedObjectIds,[]);check(n.kind==='text'&&n.parent===c.node&&n.extent.start===end&&n.extent.end>end&&n.extent.end<=t.range.endIndex);end=n.extent.end;
  check(old.status==='observed'&&typeof old.value==='boolean'&&['direct','named'].includes(old.provenance));
  if(old.provenance==='direct')check(old.source===null&&n.storedStyle.bold===old.value);else {check(id(old.source)&&!Object.hasOwn(n.storedStyle,'bold'));const defs=e.dependencies.registryRecords.filter(r=>r.kind==='namedStyle'&&r.providerId===old.source);check(defs.length===1&&defs[0].value?.textStyle?.bold===old.value);}
  equal(change,{node:n.node,property:'bold',before:old.value,after:c.bold,provenance:old.provenance,source:old.source});
  equal(n.terminatingNewline,i===runs.length-1?{start:t.range.endIndex-1,end:t.range.endIndex,text:'\n'}:null);
 }
 check(end===t.range.endIndex);
 equal(e.footprint,{snapshotId:b.snapshotId,evidenceDigest:b.evidenceDigest,nodes:[...runIds,c.node],targets:runIds,dependencies:[c.node],aspects:['styles'],destructive:false});
 const registryKinds={namedStyle:'styles',documentStyle:'styles',listDefinition:'lists',inlineObjectDefinition:'objects',positionedObjectDefinition:'objects',dropdownDefinition:'objects',namedRange:'ranges',commentAnchor:'review',suggestedDocumentStyle:'review',suggestedNamedStyles:'review',commentThread:'review',suggestionThread:'review'};
 const registryIds=e.dependencies.registryRecords.map(r=>r.id);check(new Set(registryIds).size===registryIds.length);
 for(const r of e.dependencies.registryRecords){
  check(id(r.id));
  if(r.kind==='registryReference'){
   keys(r,['id','kind','ownerNode','definitionKind','providerId','targets','status','dependencyOwner']);
   check(deps.some(n=>n.node===r.ownerNode)&&Object.hasOwn(registryKinds,r.definitionKind)&&id(r.providerId)&&r.status==='resolved'&&(r.dependencyOwner===null||r.dependencyOwner===c.node));
   check(Array.isArray(r.targets)&&r.targets.length===1&&e.dependencies.registryRecords.some(n=>n.id===r.targets[0]&&n.kind===r.definitionKind&&n.providerId===r.providerId));
  }else{
   keys(r,['id','kind','category','providerId','value','scopeRelation']);
   check(Object.hasOwn(registryKinds,r.kind)&&r.category===registryKinds[r.kind]&&(r.providerId===null||id(r.providerId))&&obj(r.value)&&['referenced','tabStyle','intersects','selectedSegment','tabDefinition'].includes(r.scopeRelation));
  }
 }
 if(record){
  for(const k of ['subject','account','threadId','snapshotId'])check(b[k]===record[k]);
  check(l.createdAt===record.createdAt&&l.expiresAt===record.expiresAt);
  check(record.requestHash===logicalDigest({requestId:record.requestId,snapshotId:record.snapshotId,mode:p.mode,command:c}));
 }
 if(snapshot){
  const s=validatedReadModel(snapshot),n=s.nodes[c.node];check(n?.kind==='paragraph'&&n.segment.kind==='body'&&s.nodes[n.parent]?.kind==='segment');
  equal(b,logicalPlanBinding(s));
  equal(p.sourceEvidence,{node:n.id,path:n.evidence.path,digest:n.evidence.digest,paragraph:n.evidence.path.reduce((v,k)=>v[k],s.evidence)});
  equal(t,{node:n.id,path:n.evidence.path,range:{tabId:n.tabId,startIndex:n.extent?.start,endIndex:n.extent?.end},text:n.children.map(x=>s.nodes[x].text??'').join('')});
  const request={scope:{tabs:{ids:[n.tabId]},segments:[{kind:'body'}]},selector:{node:c.node},effect:{kind:'style',family:'text',set:{bold:c.bold}}};
  const facts=inspectEffectEvidence(s,request),presentation={target:facts.target,dependencies:facts.dependencies,changes:facts.changes,effect:request.effect};
  check(compareReadEvidence(s,{...request,presentation}).witnessSatisfied);equal(e,{...presentation,footprint:facts.footprint,witnessSatisfied:true});
 }
 return p;
}
