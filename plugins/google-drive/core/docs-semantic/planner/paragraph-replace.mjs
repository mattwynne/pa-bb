import {logicalPlanBinding} from '../logical-plan.mjs';
import {inspectParagraphReplacementEvidence,compareParagraphReplacementEvidence} from '../replacement-evidence.mjs';
import {DRAFT_LIMITS,checkLimits,timeCheck,boundedPlan,draftHash,immutable} from '../draft-policy.mjs';
import {digest} from '../common.mjs';
export function planParagraphReplace(snapshot,command,{createdAt=snapshot.binding.retrievedAt,limits=DRAFT_LIMITS}={}){
 timeCheck(createdAt);checkLimits(limits);const w=inspectParagraphReplacementEvidence(snapshot,command);compareParagraphReplacementEvidence(snapshot,command,w);
 const p={version:1,kind:'paragraphReplace',mode:'direct',capabilityVersion:'paragraph-replace/1',lifecycle:{createdAt,expiresAt:createdAt+limits.draftMs,budgets:{version:limits.version,planBytes:limits.planBytes,recordBytes:limits.recordBytes}},binding:logicalPlanBinding(snapshot),command:structuredClone(command),sourceEvidence:{node:command.node,path:w.path,bodyPath:w.bodyPath,body:w.body,digest:digest(w.body),namedStyles:w.namedStyles},target:{node:command.node,path:w.path,range:{tabId:snapshot.nodes[command.node].tabId,startIndex:w.facts.match.start,endIndex:w.facts.match.end},text:w.facts.paragraphText},effect:w.facts,verification:{kind:'paragraphReplacementExactPreservation',version:1,normalization:['revisionIdOnly','identicalPureTextRunCoalescing']}};boundedPlan(p,limits);return immutable({...p,integrity:draftHash(p)});
}
