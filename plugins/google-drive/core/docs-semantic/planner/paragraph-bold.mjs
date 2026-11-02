// First internal production planner: one existing whole body paragraph, bold only.
// Evidence is resolved from the S02 model, never supplied as a resolved plan.
import {logicalPlanBinding} from '../logical-plan.mjs';
import {validatedReadModel} from '../selectors.mjs';
import {inspectEffectEvidence,compareReadEvidence} from '../read-effects.mjs';
import {DRAFT_LIMITS,checkLimits,timeCheck,demand,strict,draftHash,immutable,boundedPlan} from '../draft-policy.mjs';
export function planParagraphBold(input,command,{createdAt=input.binding.retrievedAt,limits=DRAFT_LIMITS}={}){
 timeCheck(createdAt);checkLimits(limits);
 strict(command,['op','node','bold']);demand(command.op==='paragraphBold'&&typeof command.node==='string'&&typeof command.bold==='boolean');
 const snapshot=validatedReadModel(input),p=snapshot.nodes[command.node];
 demand(snapshot.evidence.documentId===snapshot.binding.documentId&&snapshot.metadata.id===snapshot.binding.documentId,'snapshot');
 demand(p?.kind==='paragraph'&&p.segment.kind==='body'&&snapshot.nodes[p.parent]?.kind==='segment','unsupported');
 demand(snapshot.binding.view==='inline'&&snapshot.revision.kind==='docs'&&snapshot.revision.subject===snapshot.binding.subject&&snapshot.binding.source!=='history','snapshot');
 demand(!snapshot.missingReviewCoverage&&snapshot.metadata.capabilities?.canEdit!==false,'witness');
 const children=p.children.map(id=>snapshot.nodes[id]);
 demand(p.extent&&children.length>0&&children.every(n=>n.kind==='text'&&n.extent),'unsupported');
 let end=p.extent.start;for(const n of children){demand(n.extent.start===end,'witness');end=n.extent.end;}
 demand(end===p.extent.end&&children.at(-1).text.endsWith('\n')&&children.slice(0,-1).every(n=>!n.text.includes('\n'))&&children.at(-1).text.indexOf('\n')===children.at(-1).text.length-1,'unsupported');
 const scope={tabs:{ids:[p.tabId]},segments:[{kind:'body'}]},request={scope,selector:{node:p.id},effect:{kind:'style',family:'text',set:{bold:command.bold}}};
 const facts=inspectEffectEvidence(snapshot,request),presentation={target:facts.target,dependencies:facts.dependencies,changes:facts.changes,effect:request.effect};
 const witness=compareReadEvidence(snapshot,{...request,presentation});demand(witness.witnessSatisfied,'witness');
 const value={version:1,kind:'paragraphBold',mode:'direct',capabilityVersion:'paragraph-bold/1',
  lifecycle:{createdAt,expiresAt:createdAt+limits.draftMs,budgets:{version:limits.version,planBytes:limits.planBytes,recordBytes:limits.recordBytes}},
  binding:logicalPlanBinding(snapshot),
  command:structuredClone(command),
  sourceEvidence:{node:p.id,path:[...p.evidence.path],digest:p.evidence.digest,paragraph:structuredClone(p.evidence.path.reduce((v,k)=>v[k],snapshot.evidence))},
  target:{node:p.id,path:p.evidence.path,range:{tabId:p.tabId,startIndex:p.extent.start,endIndex:p.extent.end},text:children.map(n=>n.text).join('')},
  effect:{...presentation,footprint:facts.footprint,witnessSatisfied:true},
  verification:{kind:'paragraphBoldExactPreservation',version:1,bold:command.bold,normalization:['revisionIdOnly'],limitation:'Exact observed run topology; no rendering or submission attribution'}};
 boundedPlan(value,limits);return immutable({...value,integrity:draftHash(value)});
}
