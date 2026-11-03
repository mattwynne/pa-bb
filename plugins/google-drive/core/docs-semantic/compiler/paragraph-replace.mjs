import {assertReplacementPlan} from '../replacement-plan.mjs';
import {immutable} from '../draft-policy.mjs';
import {REPLACE_STYLE_FIELDS} from '../replacement-evidence.mjs';
export function compileParagraphReplace(plan){
 assertReplacementPlan(plan);const f=plan.effect,c=f.changed,tabId=plan.target.range.tabId,requests=[];
 if(c.end>c.start)requests.push({deleteContentRange:{range:{tabId,startIndex:c.start,endIndex:c.end}}});
 if(c.inserted.length){requests.push({insertText:{location:{tabId,index:c.start},text:c.inserted}});requests.push({updateTextStyle:{range:{tabId,startIndex:c.start,endIndex:c.start+c.inserted.length},textStyle:structuredClone(f.insertedStyle),fields:REPLACE_STYLE_FIELDS.join(',')}});}
 return immutable({writeControl:{requiredRevisionId:plan.binding.revision.id,writeMode:'EDIT'},requests});
}
