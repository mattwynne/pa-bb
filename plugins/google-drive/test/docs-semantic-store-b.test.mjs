import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { SemanticWorld, semanticAccount, semanticScope } from '../features/docs/support/semantic-world.mjs';
import { selectorDocument } from '../features/docs/support/selectors-b-checks.mjs';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createSemanticSnapshotStore, READ_WORK_BYTES } from '../adapters/docs-semantic-store.mjs';
import { LIMITS } from '../core/docs-semantic/common.mjs';
const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
async function fixture(run) {
  const w=new SemanticWorld();w.document=selectorDocument();await w.init({pageBytes:3000});
  try {
    const inspected=await w.inspect();assert.ok(inspected.snapshotId);
    const input={account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope,format:'structured'};
    const first=await w.call('docs_read',input);assert.ok(first.nextCursor,JSON.stringify(first));
    await run({w,input,first,db:w.host.bb.storage.database(),s:w.store.semanticSnapshots});
  } finally {await w.close();}
}
test('B actual cursor bindings survive wrong subject/account/thread/snapshot attempts and SQLite reopen',()=>fixture(({w,input,first,db,s})=>{
  const snapshotId=input.snapshotId;
  for(const bad of [{...owner,subject:'other'},{...owner,account:'other@example.test'},{...owner,threadId:'other'}]){
    assert.throws(()=>s.consumeCursor(first.nextCursor,bad,1,snapshotId),/snapshot/);
    assert.throws(()=>s.deliveries(snapshotId,bad,1,[first.coverage.deliveryToken]),/snapshot/);
  }
  assert.throws(()=>s.consumeCursor(first.nextCursor,owner,1,'other-snapshot'),/snapshot/);
  db.close();const reopened=createBbStore(w.host.bb.storage.database(),w.host.bb.storage.migrate).semanticSnapshots;
  const continued=reopened.consumeCursor(first.nextCursor,owner,299999,snapshotId);
  assert.equal(continued.state.offset,first.records.length);
  assert.equal(continued.snapshot.binding.documentId,'doc-a');
  assert.deepEqual(continued.state.request,{scope:semanticScope,format:'structured',styles:false,review:false,omitImages:false});
  assert.throws(()=>reopened.consumeCursor(first.nextCursor,owner,299999,snapshotId),/snapshot/);
  assert.deepEqual(reopened.deliveries(snapshotId,owner,299999,[first.coverage.deliveryToken])[0].nodes,first.coverage.delivered.nodes);
}));
for(const field of ['offset','lossOffset','selection','projection','document','view','expires','snapshot'])test(`B cursor integrity refuses changed ${field}`,()=>fixture(async({w,input,first,db,s})=>{
  const row=db.prepare('SELECT * FROM docs_semantic_cursors WHERE id=?').get(first.nextCursor),state=JSON.parse(row.state);
  if(field==='offset')state.offset=0;
  if(field==='lossOffset')state.lossOffset=1;
  if(field==='selection')state.selection.runs=[[0,1]];
  if(field==='projection')state.request.format='text';
  if(field==='document')state.documentId='other';
  if(field==='view')state.view='acceptedPreview';
  if(field==='expires')db.prepare('UPDATE docs_semantic_cursors SET expires=? WHERE id=?').run(599999,row.id);
  else if(field==='snapshot'){
    const next=await w.inspect();db.prepare('UPDATE docs_semantic_cursors SET snapshot=? WHERE id=?').run(next.snapshotId,row.id);
  } else db.prepare('UPDATE docs_semantic_cursors SET state=? WHERE id=?').run(JSON.stringify(state),row.id);
  assert.throws(()=>s.consumeCursor(row.id,owner,1),/corrupt/);
  // Corrupt/wrong-owner reads do not erase the valid token. Restore exact saved
  // bytes solely in this disposable fault fixture, then consume once.
  db.prepare('UPDATE docs_semantic_cursors SET snapshot=?,expires=?,state=? WHERE id=?').run(row.snapshot,row.expires,row.state,row.id);
  assert.equal(s.consumeCursor(row.id,owner,1,input.snapshotId).state.offset,JSON.parse(row.state).offset);
}));
for(const field of ['nodes','aspects','scope','view','digest','readId','offset','complete'])test(`B delivery integrity refuses changed ${field}`,()=>fixture(({input,first,db,s})=>{
  const id=first.coverage.deliveryToken,row=db.prepare('SELECT data FROM docs_semantic_delivery WHERE id=?').get(id),value=JSON.parse(row.data);
  if(field==='nodes')value.nodes=[];
  if(field==='aspects')value.nodeAspects={};
  if(field==='scope')value.scope={tabs:{all:true},segments:[{kind:'body'}]};
  if(field==='view')value.view='acceptedPreview';
  if(field==='digest')value.evidenceDigest='0'.repeat(64);
  if(field==='readId')value.readId='other';
  if(field==='offset')value.offset=100;
  if(field==='complete')value.complete=!value.complete;
  db.prepare('UPDATE docs_semantic_delivery SET data=? WHERE id=?').run(JSON.stringify(value),id);
  assert.throws(()=>s.deliveries(input.snapshotId,owner,1,[id]),/corrupt/);
  db.prepare('UPDATE docs_semantic_delivery SET data=? WHERE id=?').run(row.data,id);
  assert.deepEqual(s.deliveries(input.snapshotId,owner,1,[id])[0],JSON.parse(row.data));
}));
test('B exact TTL boundaries and retained pin evidence never extend ordinary selection authority',()=>fixture(({w,input,first,db,s})=>{
  const id=input.snapshotId;
  s.pin(id,owner,'draft-a',0,900000);s.pin(id,owner,'draft-a',0,900000);
  assert.throws(()=>s.pin(id,owner,'draft-a',1,900001),/conflict/);
  assert.throws(()=>s.pin(id,owner,'too-long',599999,2400000),/budget/);
  assert.throws(()=>s.consumeCursor(first.nextCursor,owner,300000,id),/snapshot/);
  assert.equal(s.get(id,owner,599999).binding.snapshotId,id);
  assert.throws(()=>s.get(id,owner,600000),/snapshot/);
  s.sweep(600000);assert.equal(s.stats().snapshots,1);
  db.close();s=createBbStore(w.host.bb.storage.database(),w.host.bb.storage.migrate).semanticSnapshots;
  assert.equal(s.readPinned(id,owner,'draft-a',899999).binding.snapshotId,id);
  for(const call of [()=>s.issueCursor(id,owner,{},600000),()=>s.pin(id,owner,'new',600000,900000),()=>s.deliveries(id,owner,600000,[first.coverage.deliveryToken])])assert.throws(call,/snapshot/);
  assert.throws(()=>s.readPinned(id,{...owner,threadId:'other'},'draft-a',700000),/snapshot/);
  assert.throws(()=>s.readPinned(id,owner,'other-draft',700000),/snapshot/);
  assert.throws(()=>s.readPinned(id,owner,'draft-a',900000),/snapshot/);
  s.sweep(900000);assert.deepEqual(s.stats(),{snapshots:0,bytes:0});
}));
test('B pin cap/release/cross-snapshot owner and pressure leave old receipts and account untouched',()=>fixture(async({w,input,db,s})=>{
  await w.store.reserveFormatting({operationId:'legacy-held',subject:owner.subject,documentId:'doc-a',state:'uncertain',appliedRevision:'r-old'});
  const accountBefore=await w.store.bySubject(owner.subject);
  for(let i=0;i<32;i++)s.pin(input.snapshotId,owner,`draft-${i}`,0,900000);
  assert.throws(()=>s.pin(input.snapshotId,owner,'overflow',0,900000),/budget/);
  assert.throws(()=>s.releasePin(input.snapshotId,{...owner,account:'other'},'draft-0'),/snapshot/);
  s.releasePin(input.snapshotId,owner,'draft-0');s.pin(input.snapshotId,owner,'replacement',0,900000);
  const next=await w.inspect();s.pin(next.snapshotId,owner,'draft-1',0,900000);
  assert.equal(s.readPinned(next.snapshotId,owner,'draft-1',1).binding.snapshotId,next.snapshotId);
  const limited=createSemanticSnapshotStore(db,{limits:{...LIMITS,poolBytes:s.stats().bytes}});
  assert.throws(()=>limited.pin(next.snapshotId,owner,'pressure',0,900000),/budget/);
  assert.equal(await w.store.activeFormatting('doc-a'),'legacy-held');assert.deepEqual(await w.store.bySubject(owner.subject),accountBefore);
  assert.equal(s.readPinned(input.snapshotId,owner,'draft-1',600000).binding.snapshotId,input.snapshotId);
}));
for(const kind of ['modelBytes','evidenceBytes','compressedEvidence','snapshotIdentity','pinDeadline'])test(`B corrupt storage ${kind} fails boundedly`,()=>fixture(({input,db,s})=>{
  const id=input.snapshotId;
  if(kind==='modelBytes')db.prepare('UPDATE docs_semantic_snapshots SET data=? WHERE id=?').run(deflateSync('{"wrong":true}'),id);
  if(kind==='evidenceBytes')db.prepare('UPDATE docs_semantic_evidence SET bytes=?').run(LIMITS.providerBytes+1);
  if(kind==='compressedEvidence')db.prepare('UPDATE docs_semantic_evidence SET data=?,bytes=?').run(deflateSync('x'.repeat(1024*1024)),100);
  if(kind==='snapshotIdentity')db.prepare('UPDATE docs_semantic_snapshots SET expires=? WHERE id=?').run(900000,id);
  if(kind==='pinDeadline'){
    s.pin(id,owner,'pin',0,900000);db.prepare('UPDATE docs_semantic_pins SET expires=? WHERE snapshot=?').run(1800000,id);
    assert.throws(()=>s.readPinned(id,owner,'pin',1),/corrupt/);return;
  }
  assert.throws(()=>s.get(id,owner,1),/corrupt/);
}));
test('B page pool failure is atomic, but already consumed cursor stays consumed',()=>fixture(({input,first,db,s})=>{
  const before=db.prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n;
  const continued=s.consumeCursor(first.nextCursor,owner,1,input.snapshotId);
  const limited=createSemanticSnapshotStore(db,{limits:{...LIMITS,poolBytes:s.stats().bytes}});
  const delivery=s.deliveries(input.snapshotId,owner,1,[first.coverage.deliveryToken])[0];
  assert.throws(()=>limited.commitPage(input.snapshotId,owner,delivery,continued.state,1),/budget/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_cursors').get().n,0);
  assert.throws(()=>s.consumeCursor(first.nextCursor,owner,2,input.snapshotId),/snapshot/);
}));
test('B native partial and loss-only pages freeze membership and persist each exact loss once',async()=>{
  const w=new SemanticWorld(),d=selectorDocument();
  d.tabs[0].documentTab.body.content=[{startIndex:1,endIndex:101,paragraph:{elements:Array.from({length:100},(_,i)=>({startIndex:i+1,endIndex:i+2,inlineObjectElement:{inlineObjectId:'logo'}}))}}];
  w.document=d;await w.init({pageBytes:3000});
  try {
    const inspected=await w.inspect(),base={account:semanticAccount,snapshotId:inspected.snapshotId};
    let page=await w.call('docs_read',{...base,scope:semanticScope,format:'text',styles:true,review:true});
    assert.equal(page.complete,false);const losses=[],tokens=[];
    for(let count=0;;count++){
      assert.ok(count<100);assert.deepEqual(page.records,[]);assert.deepEqual(page.coverage.delivered.nodes,[]);
      const token=page.coverage.deliveryToken;tokens.push(token);
      const [saved]=w.store.semanticSnapshots.deliveries(base.snapshotId,owner,0,[token]);
      assert.deepEqual(saved.losses,page.losses);assert.equal(saved.offset,0);assert.equal(saved.lossOffset,losses.length);
      losses.push(...page.losses);
      if(page.complete)break;
      page=await w.call('docs_read',{...base,cursor:page.nextCursor});
    }
    assert.equal(losses.length,100);assert.equal(new Set(losses.map(l=>l.node)).size,100);
    assert.ok(losses.every(l=>l.kind==='nonText'&&l.sourceKind==='inlineObjectElement'));
    assert.equal(w.host.bb.storage.database().prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,tokens.length);
    const snapshot=w.store.semanticSnapshots.get(base.snapshotId,owner,0);assert.deepEqual(snapshot.evidence,d);
    // Empty heading section remains genuinely empty, not failed pagination.
    w.document=selectorDocument();const next=await w.inspect();
    const empty=await w.call('docs_read',{account:semanticAccount,snapshotId:next.snapshotId,scope:semanticScope,selector:{section:{headingId:'next',includeHeading:false}},format:'text'});
    assert.equal(empty.complete,true);assert.deepEqual(empty.records,[]);assert.deepEqual(empty.losses,[]);
    assert.deepEqual(w.store.semanticSnapshots.deliveries(next.snapshotId,owner,0,[empty.coverage.deliveryToken])[0].nodes,[]);
  } finally {await w.close();}
});
test('B native active snapshot counts are isolated by originating thread without evicting evidence',()=>fixture(async({w,input,first,s})=>{
  for(let i=0;i<3;i++)assert.ok((await w.inspect()).snapshotId);
  const denied=await w.inspect();assert.equal(denied.category,'budget');
  const other=await w.call('docs_inspect',{account:semanticAccount,document:'doc-a',scope:semanticScope},'thread-b');assert.ok(other.snapshotId);
  assert.equal(s.stats().snapshots,5);
  assert.deepEqual(s.deliveries(input.snapshotId,owner,0,[first.coverage.deliveryToken])[0].nodes,first.coverage.delivered.nodes);
  assert.throws(()=>s.get(other.snapshotId,owner,0),/snapshot/);
}));
test('B cumulative page work is durable and bounded independently of output size',()=>fixture(({w,input,db,s})=>{
  const id=input.snapshotId;
  for(let i=0;i<8;i++)s.chargeReadWork(id,owner,'bounded-read',32*1048576,0);
  assert.equal(db.prepare('SELECT bytes FROM docs_semantic_read_work WHERE id=?').get('bounded-read').bytes,READ_WORK_BYTES);
  db.close();s=createBbStore(w.host.bb.storage.database(),w.host.bb.storage.migrate).semanticSnapshots;
  assert.throws(()=>s.chargeReadWork(id,owner,'bounded-read',1,1),/budget/);
  assert.equal(s.get(id,owner,1).evidence.documentId,'doc-a');
}));
