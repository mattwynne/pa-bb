import test from 'node:test';import assert from 'node:assert/strict';
import {nativeWorld,parse} from './docs-semantic-native-fixtures.mjs';import {textVector} from './docs-semantic-text-vectors.mjs';
for(const drift of [false,true])test(`actual unused opaque named-style definition ${drift?'drift holds mismatch':'is preserved and does not ban literal replacement'}`,async()=>{
 const v=textVector();v.before.namedStyles={styles:[{namedStyleType:'HEADING_1',textStyle:{smallCaps:true,baselineOffset:'SUPERSCRIPT',backgroundColor:{color:{rgbColor:{red:0,green:1,blue:0}}},opaqueProviderStyleTag:{token:'KEEP_UNUSED'}}}]};v.after.namedStyles=structuredClone(v.before.namedStyles);
 const w=await nativeWorld({approval:false,document:v.before,after:v.after,wire:v.wire,replyCount:3,sdkPlan:true,paragraphIndex:1,oldText:v.oldText,newText:v.newText,afterInvoke:async w=>{if(drift)w.document.namedStyles.styles[0].textStyle.opaqueProviderStyleTag.token='UNEXPECTED_DRIFT';}});
 try{assert.equal(w.draft.state,'draft','unused style metadata is not an active insertion dependency');const r=parse(await w.run());assert.equal(w.posts,1);assert.equal(r.state,drift?'uncertain':'verified');assert.equal(r.claim,drift?'held':'released');assert.equal(r.stage.verification,drift?'mismatch':'matched');assert.equal(r.submission,'acknowledged');}finally{await w.close();}
});
