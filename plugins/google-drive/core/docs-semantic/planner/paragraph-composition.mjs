// Actual closed multi-command planner. All targets resolved against ONE original snapshot.
import {planParagraphBold} from './paragraph-bold.mjs';
import {planParagraphReplace} from './paragraph-replace.mjs';
import {packComposition,assertCompositionPlan,scalarParts} from '../composition-plan.mjs';
import {COMPOSITION_LIMITS,compositionCommand} from '../composition-policy.mjs';
import {demand,draftHash} from '../draft-policy.mjs';
export function planParagraphComposition(snapshot,commands,{origin,extensions=[],provenance,anchor,existing=[]}){
 demand(Array.isArray(commands)&&commands.length>0&&commands.length<=COMPOSITION_LIMITS.commands,'budget');demand(new Set(commands.map(c=>c.node)).size===commands.length,'conflict');
 demand(existing.length<=commands.length,'corrupt');const scalars=commands.map((c,i)=>{compositionCommand(c);if(existing[i]){const {integrity,...prior}=existing[i];demand(draftHash(c)===draftHash(prior.command),'corrupt');const body={...prior,lifecycle:{...prior.lifecycle,createdAt:anchor,expiresAt:anchor+1800000}};return {...body,integrity:draftHash(body)};}return (c.op==='paragraphBold'?planParagraphBold:planParagraphReplace)(snapshot,c,{createdAt:anchor});});
 const plan=packComposition(scalars,{origin,extensions,provenance});assertCompositionPlan(plan,{snapshot});return plan;
}
export function closedParts(saved){return saved.plan.kind==='paragraphComposition'?scalarParts(saved.plan):[saved.plan];}
export function closedProvenance(saved){return saved.plan.kind==='paragraphComposition'?saved.plan.parts.map(x=>x.provenance):[[{kind:'scalar',draftId:saved.record.operationId,headHash:saved.record.headHash,commandIndex:0,requestHash:saved.record.requestHash}]];}
export function commandProvenance(id,initial,kind='new',headHash=null){return initial.request.commands.map((_,commandIndex)=>[{kind,draftId:id,headHash,commandIndex,requestHash:draftHash(initial)}]);}
