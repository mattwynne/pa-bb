// Independent observation verifier: resolve the sealed command against the
// actual before model, NOT the planner's target/simulation or compiled program.
import {boundedTree,LIMITS} from '../common.mjs';
import {validatedReadModel} from '../selectors.mjs';
import {projectRegistries} from '../reader.mjs';
import {assertLogicalPlan,sameLogical} from '../logical-plan.mjs';
import {demand} from '../draft-policy.mjs';
const at=(value,path)=>path.reduce((v,k)=>v?.[k],value);
const same=(a,b)=>demand(sameLogical(a,b),'corrupt');
function observedDependency(n){const property=n.style?.properties?.bold,fact=n.style?.propertyEvidence?.bold;return {
 node:n.id,kind:n.kind,parent:n.parent,extent:n.extent,
 properties:{bold:{value:property?.value??null,provenance:property?.provenance??'unknown',source:property?.source??null,status:fact?.effectiveStatus??'unknown'}},
 storedStyle:n.style?.explicit??null,terminatingNewline:n.kind==='text'&&n.text.endsWith('\n')?{start:n.extent.end-1,end:n.extent.end,text:'\n'}:null,
 list:n.list??null,positionedObjectIds:n.positionedObjectIds??[],review:n.review??{},unknownFields:n.unprojectedFields??[]};}
export function compareParagraphBold({plan,before,after}){
 assertLogicalPlan(plan);
 const snapshot=validatedReadModel(before),command=plan.command,p=snapshot.nodes[command.node];
 demand(p?.kind==='paragraph'&&p.segment.kind==='body'&&snapshot.nodes[p.parent]?.kind==='segment','corrupt');
 // Independently project observed identity, not the planner's binding helper.
 // HTTP response accounting remains on the actual before model; it is not intent.
 const b=snapshot.binding;
 const observedBinding={subject:b.subject,account:b.account,threadId:b.threadId,snapshotId:b.snapshotId,documentId:b.documentId,view:b.view,retrievedAt:b.retrievedAt,
  ...(Object.hasOwn(b,'source')?{source:b.source}:{}),revision:snapshot.revision,evidenceDigest:snapshot.evidenceDigest};
 same(plan.binding,observedBinding);
 const runs=p.children.map(id=>snapshot.nodes[id]);demand(runs.length>0&&runs.every(n=>n.kind==='text'&&n.extent),'corrupt');
 // These source paths/ranges are selected ONLY by command.node in the actual
 // before graph, never by plan.target or plan.effect.
 const path=p.evidence.path,original=at(snapshot.evidence,path);
 same(plan.sourceEvidence,{node:p.id,path,digest:p.evidence.digest,paragraph:original});
 same(plan.target,{node:p.id,path,range:{tabId:p.tabId,startIndex:p.extent.start,endIndex:p.extent.end},text:runs.map(n=>n.text).join('')});
 const ids=[...p.children,p.id],deps=ids.map(id=>observedDependency(snapshot.nodes[id]));
 same(plan.effect.dependencies.nodes,deps);
 same(plan.effect.changes,runs.map(n=>{const old=n.style.properties.bold;demand(typeof old?.value==='boolean'&&n.style.propertyEvidence.bold.effectiveStatus==='observed','corrupt');return {node:n.id,property:'bold',before:old.value,after:command.bold,provenance:old.provenance,source:old.source??null};}));
 // Read-side registry projection supplies observed dependencies, not expected
 // mutations. No planner/compiler or generated after document is consulted.
 const registry=projectRegistries(snapshot,{status:'resolved',nodes:ids,tabs:[p.tabId],selectedFootprint:true},['styles','lists','objects','ranges','review']);
 const registryFacts=registry.records.map(r=>r.kind==='registryReference'?{id:r.id,kind:r.kind,ownerNode:r.ownerNode,definitionKind:r.definitionKind,providerId:r.providerId,targets:r.targets,status:r.status,dependencyOwner:r.dependencyOwner??null}:{id:r.id,kind:r.kind,category:r.category,providerId:r.providerId,value:r.value,scopeRelation:r.scopeRelation});
 same(plan.effect.dependencies.registryRecords,registryFacts);same(plan.effect.dependencies.registryLosses,registry.losses);
 boundedTree(after,LIMITS);
 const observed=at(after,path),oldRuns=original.paragraph.elements,newRuns=observed?.paragraph?.elements;
 let changesMatched=Array.isArray(newRuns)&&newRuns.length===oldRuns.length;
 if(changesMatched)for(let i=0;i<oldRuns.length;i++){
  const a=oldRuns[i],b=newRuns[i];
  if(!a.textRun||!b?.textRun||a.startIndex!==b.startIndex||a.endIndex!==b.endIndex||a.textRun.content!==b.textRun.content||b.textRun.textStyle?.bold!==command.bold)changesMatched=false;
 }
 const left=structuredClone(snapshot.evidence),right=structuredClone(after);
 delete left.revisionId;delete right.revisionId;
 if(changesMatched)for(const d of [left,right])for(const e of at(d,path).paragraph.elements){
  const style=e.textRun.textStyle;
  // An omitted/empty before container is valid known inherited evidence. Mask
  // only bold, preserving every unrelated style/unknown field on either side.
  if(style){delete style.bold;if(Object.keys(style).length===0)delete e.textRun.textStyle;}
 }
 const preservationMatched=changesMatched&&sameLogical(left,right);
 return {matched:changesMatched&&preservationMatched,changesMatched,preservationMatched,attribution:'notEstablished'};
}
