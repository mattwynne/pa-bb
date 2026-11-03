import test from 'node:test';import assert from 'node:assert/strict';
import {textWorld} from './docs-semantic-text-fixtures.mjs';import {textVector} from './docs-semantic-text-vectors.mjs';import {pending,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {createDocsFormatService} from '../core/docs-format.mjs';
for(const oldFirst of [true,false])test(`actual legacy formatting claim ${oldFirst?'before text seal blocks it':'after real text seal is blocked'} without native POST`,async()=>{
 const v=textVector();for(const d of [v.before,v.after]){const tab=d.tabs[0].documentTab;tab.body.content.unshift({endIndex:1,sectionBreak:{}});tab.documentStyle={documentFormat:{documentMode:'PAGES'}};}
 const w=await textWorld('longer',{document:v.before,after:v.after});let running,form;
 try{assert.equal(w.draft.state,'draft');const legacy=createDocsFormatService({store:w.store,drive:w.adapter.drive,docs:w.adapter.docs,clock:()=>w.now});
  if(!oldFirst){running=w.run();form=await pending(w);assert.equal(form.rendererId,'docs-replacement-approval');}
  const preview=await legacy.format({account:owner.account,operationId:keys[1],document:'draft-doc',expectedRevisionId:'r1',ranges:[{tabId:'tab-a',startIndex:10,endIndex:22,textStyle:{bold:true}}],preview:true});assert.equal(preview.outcome,'proposed');const claimed=await w.store.claimFormatting(keys[1],'draft-doc');assert.equal(claimed,oldFirst);
  if(oldFirst){const r=await w.run();assert.equal(r.isError,true);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_execution').get().n,0);assert.equal(w.store.writers.get('drive_formatting_operations',keys[1]).disposition,'held');}
  else{assert.equal(w.store.writers.get('semantic',keys[0]).disposition,'held');w.h.harness.behavior.submitInteraction(form.id,{approved:false});assert.equal(parse(await running).submission,'not_sent');running=null;form=null;}
  assert.equal(w.posts,0);
 }finally{if(form)w.h.harness.behavior.cancelInteraction(form.id);if(running)await running;await w.close();}
});
