// One atomic batch. Sort WHOLE independent paragraph blocks, never individual requests.
import {assertCompositionPlan,scalarParts} from '../composition-plan.mjs';
import {compileParagraphBold} from './paragraph-bold.mjs';
import {compileParagraphReplace} from './paragraph-replace.mjs';
import {immutable,demand} from '../draft-policy.mjs';
export function compileParagraphComposition(plan){
 assertCompositionPlan(plan);const blocks=scalarParts(plan).map((p,index)=>({index,tab:p.target.range.tabId,start:p.target.range.startIndex,program:(p.kind==='paragraphBold'?compileParagraphBold:compileParagraphReplace)(p)}));
 blocks.sort((a,b)=>a.tab<b.tab?-1:a.tab>b.tab?1:b.start-a.start||a.index-b.index);
 demand(blocks.every(b=>b.program.writeControl.requiredRevisionId===plan.binding.revision.id),'corrupt');
 return immutable({writeControl:{requiredRevisionId:plan.binding.revision.id,writeMode:'EDIT'},requests:blocks.flatMap(b=>b.program.requests)});
}
