// CLOSED saved family dispatch, never supplied by an agent or provider.
import {requireValue} from './common.mjs';
import {compileParagraphComposition} from './compiler/paragraph-composition.mjs';
import {compareParagraphComposition} from './verification/paragraph-composition.mjs';
import {compositionReplies} from './composition-plan.mjs';
import {compileParagraphBold} from './compiler/paragraph-bold.mjs';
import {compileParagraphReplace} from './compiler/paragraph-replace.mjs';
import {compareParagraphBold} from './verification/paragraph-bold.mjs';
import {compareParagraphReplace} from './verification/paragraph-replace.mjs';
export function family(value){
 if(value.kind==='paragraphComposition'&&value.capabilityVersion==='paragraph-composition/1')return {kind:'paragraphComposition',capabilityVersion:'paragraph-composition/1',stageId:'composition-1',execution:'nativeParagraphComposition-v1',contextKind:'paragraphCompositionTargetContext',compile:compileParagraphComposition,compare:compareParagraphComposition};
 if(value.kind==='paragraphBold'&&value.capabilityVersion==='paragraph-bold/1')return {kind:'paragraphBold',capabilityVersion:'paragraph-bold/1',stageId:'bold-1',execution:'nativeBold-v1',contextKind:'paragraphBoldTargetContext',compile:compileParagraphBold,compare:compareParagraphBold};
 if(value.kind==='paragraphReplace'&&value.capabilityVersion==='paragraph-replace/2')return {kind:'paragraphReplace',capabilityVersion:'paragraph-replace/2',stageId:'text-2',execution:'nativeParagraphReplace-v2',contextKind:'paragraphReplaceTargetContext',compile:compileParagraphReplace,compare:compareParagraphReplace};
 if(value.kind==='paragraphReplace'&&value.capabilityVersion==='paragraph-replace/1')return {kind:'paragraphReplace',capabilityVersion:'paragraph-replace/1',stageId:'text-1',execution:'nativeParagraphReplace-v1',contextKind:'paragraphReplaceTargetContext',compile:compileParagraphReplace,compare:compareParagraphReplace};
 requireValue(false,'unsupported');
}
export function replyCount(header){const f=family(header);if(f.kind==='paragraphComposition')return compositionReplies(header.programShape);if(f.kind==='paragraphBold')return 1;const s=header.programShape;requireValue(s&&Object.keys(s).sort().join(',')==='deleteUnits,insertUnits'&&[s.deleteUnits,s.insertUnits].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2000)&&(s.deleteUnits+s.insertUnits)>0,'corrupt');return Number(s.deleteUnits>0)+2*Number(s.insertUnits>0);}
