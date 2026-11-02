import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeWorld,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';
import {tableBytes} from './docs-semantic-target-context-fixtures.mjs';
for(const fault of ['persisted_uuid','wrong_head','other_thread'])test(`actual unknown cannot be released through readable dispatch owner: ${fault}`,async()=>{
 const w=await nativeWorld({approval:false,lost:true});try{
  const r=parse(await w.run());assert.equal(r.submission,'unknown');assert.equal(r.claim,'held');assert.equal(w.posts,1);
  const saved=w.store.semanticExecutions.byId(owner,keys[0]),before=tableBytes(w.db),who=fault==='other_thread'?{...owner,threadId:'another-thread'}:owner,input=fault==='wrong_head'?{...w.input,planHash:'0'.repeat(64)}:w.input;
  assert.throws(()=>w.store.semanticExecutions.recordNotSent(who,input,saved.record.dispatchOwner,'veto'));
  assert.deepEqual(tableBytes(w.db),before);assert.equal(w.handler.service.status(owner,w.input).claim,'held');
 }finally{await w.close();}
});
