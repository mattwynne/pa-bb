import test from 'node:test';import assert from 'node:assert/strict';
import {textWorld} from './docs-semantic-text-fixtures.mjs';import {textVector,plainStyle} from './docs-semantic-text-vectors.mjs';import {parse} from './docs-semantic-native-fixtures.mjs';
for(const kind of ['otherStyle','splitBefore','splitAfter','otherTab','otherTabDrift'])test(`actual literal preservation/coalescing ${kind}`,async()=>{
 const v=textVector(),body=v.before.tabs[0].documentTab.body.content;
 if(kind==='otherStyle'){body[0].paragraph.elements[0].textRun.textStyle.smallCaps=true;v.after.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.textStyle.smallCaps=true;}
 if(kind==='splitBefore')body[1].paragraph.elements=[{startIndex:10,endIndex:14,textRun:{content:'😀 o',textStyle:structuredClone(plainStyle)}},{startIndex:14,endIndex:22,textRun:{content:'ld tail\n',textStyle:structuredClone(plainStyle)}}];
 if(kind==='splitAfter')v.after.tabs[0].documentTab.body.content[1].paragraph.elements=[{startIndex:10,endIndex:13,textRun:{content:'😀 ',textStyle:structuredClone(plainStyle)}},{startIndex:13,endIndex:18,textRun:{content:'newer',textStyle:structuredClone(plainStyle)}},{startIndex:18,endIndex:24,textRun:{content:' tail\n',textStyle:structuredClone(plainStyle)}}];
 if(kind.startsWith('otherTab')){const other={tabProperties:{tabId:'tab-other',title:'Other',index:1},documentTab:{opaqueOtherTab:{marker:'KEEP_TAB'},body:{content:[{startIndex:1,endIndex:5,paragraph:{elements:[{startIndex:1,endIndex:5,textRun:{content:'old\n',textStyle:{bold:true,smallCaps:true}}}]}}]}}};v.before.tabs.push(other);v.after.tabs.push(structuredClone(other));}
 const w=await textWorld('longer',{approval:false,document:v.before,after:v.after,afterInvoke:async w=>{if(kind==='otherTabDrift')w.document.tabs[1].documentTab.body.content[0].paragraph.elements[0].textRun.content='bad\n';}});try{assert.equal(w.draft.state,'draft');const r=parse(await w.run());assert.equal(r.state,kind==='otherTabDrift'?'uncertain':'verified');assert.equal(r.claim,kind==='otherTabDrift'?'held':'released');assert.equal(w.posts,1);}finally{await w.close();}
});
test('paragraph-start insertion refuses unsupported ACTIVE boundary inheritance instead of silently dropping it',async()=>{
 const v=textVector('start');v.before.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.textStyle.smallCaps=true;const w=await textWorld('start',{approval:false,document:v.before});try{assert.equal(w.draft.state,'rejected');assert.equal(w.posts,0);}finally{await w.close();}
});
