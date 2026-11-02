// Internal typed program only. No transport or public raw-request interface.
import {assertLogicalPlan} from '../logical-plan.mjs';
import {strict,demand,draftHash,immutable} from '../draft-policy.mjs';
export function compileParagraphBold(plan){
 assertLogicalPlan(plan);
 strict(plan,['version','kind','mode','capabilityVersion','lifecycle','binding','command','sourceEvidence','target','effect','verification','integrity']);
 const {integrity,...body}=plan;demand(draftHash(body)===integrity&&plan.version===1&&plan.kind==='paragraphBold'&&plan.mode==='direct','corrupt');
 const r=plan.target.range,revision=plan.binding.revision;
 demand(revision.kind==='docs'&&revision.subject===plan.binding.subject&&typeof revision.id==='string'&&revision.id.length>0&&revision.id.length<=2048,'corrupt');
 demand(typeof r.tabId==='string'&&Number.isSafeInteger(r.startIndex)&&Number.isSafeInteger(r.endIndex)&&r.startIndex>=0&&r.endIndex>r.startIndex&&typeof plan.command.bold==='boolean','corrupt');
 return immutable({writeControl:{requiredRevisionId:revision.id,writeMode:'EDIT'},requests:[{updateTextStyle:{range:{...r},textStyle:{bold:plan.command.bold},fields:'bold'}}]});
}
