import test from 'node:test';
import assert from 'node:assert/strict';
import {createSemanticSnapshotStore} from '../adapters/docs-semantic-store.mjs';
import {createSealStore} from '../adapters/docs-seal-store.mjs';
import {LIMITS} from '../core/docs-semantic/common.mjs';
import {SEAL_LIMITS} from '../core/docs-semantic/seal-policy.mjs';
import {nativeWorld,parse,owner,keys} from './docs-semantic-native-fixtures.mjs';

test('real precharged before/after and reply conversion verifies at a genuinely FULL finite pool, no double admission',async()=>{
 const w=await nativeWorld({approval:false});try{
  const limits={...LIMITS,poolBytes:w.store.semanticSnapshots.stats().bytes+SEAL_LIMITS.futureCredit+8192},snapshots=createSemanticSnapshotStore(w.db,{limits});w.store.semanticSnapshots=snapshots;w.store.semanticExecutions=createSealStore(w.db,{snapshots,writers:w.store.writers,draft:()=>w.store.semanticDrafts});
  let full=null;w.checkpoint=stage=>{if(stage==='afterIntent'){limits.poolBytes=snapshots.stats().bytes;full=limits.poolBytes;}};
  const result=parse(await w.run());assert.equal(result.state,'verified');assert.equal(w.posts,1);assert.equal(w.afterGets,1);assert.equal(snapshots.stats().bytes,full);const rows=w.db.prepare('SELECT kind,bytes FROM docs_semantic_stage_evidence ORDER BY kind').all();assert.deepEqual(rows.map(r=>r.kind),['after','reply']);const remaining=w.db.prepare('SELECT reserved_bytes FROM docs_semantic_execution_refs').get().reserved_bytes;assert.equal(remaining+rows.reduce((sum,r)=>sum+2*r.bytes+512,0),SEAL_LIMITS.futureCredit);assert.equal(w.store.semanticExecutions.evidence(owner,w.input).revision.id,'r1');
 }finally{await w.close();}
});
for(const timing of ['BEFORE','AFTER'])test(`${timing} actual reply insert failure rolls artifact/credit/ACK back, zero GET`,async()=>{
 const w=await nativeWorld({approval:false});try{w.db.exec(`CREATE TRIGGER fail_reply ${timing} INSERT ON docs_semantic_stage_evidence WHEN NEW.kind='reply' BEGIN SELECT RAISE(ABORT,'PRIVATE_BLOB_FAILURE'); END;`);const result=parse(await w.run());assert.equal(result.submission,'unknown');assert.equal(result.claim,'held');assert.equal(w.posts,1);assert.equal(w.afterGets,0);assert.equal(w.db.prepare('SELECT count(*) n FROM docs_semantic_stage_evidence').get().n,0);assert.equal(w.db.prepare('SELECT reserved_bytes FROM docs_semantic_execution_refs').get().reserved_bytes,SEAL_LIMITS.futureCredit);assert.equal(w.store.semanticExecutions.byId(owner,keys[0]).record.response,null);}finally{await w.close();}
});
