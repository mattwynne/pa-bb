import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { digest } from '../core/docs-semantic/common.mjs';
import { SemanticWorld, semanticAccount, semanticScope } from '../features/docs/support/semantic-world.mjs';
import { selectorDocument } from '../features/docs/support/selectors-b-checks.mjs';

// Fixed historical SQL, not a positional slice of today's migration list.
const history=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/semantic-a-migrations.json',import.meta.url)));
const sha=text=>createHash('sha256').update(text).digest('hex');
const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
const oldTables=['docs_semantic_evidence','docs_semantic_snapshots','docs_semantic_cursors','docs_semantic_delivery','docs_semantic_pins'];
const rows=db=>Object.fromEntries(oldTables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
function currentStore(host,db) {
  return createBbStore(db,(database,statements)=>{
    assert.equal(statements.length,14,'all frozen prefixes retained; native execution stage appended at index 13');
    assert.deepEqual(statements.slice(0,9),history.statements,'recorded statements stay byte-identical');
    assert.deepEqual(statements.slice(0,9).map(sha),history.statementHashes);
    // Independent fixed hashes: never regenerate the original nine-entry fixture
    // or interpolate an applied migration from a future namespace registry.
    assert.equal(sha(statements[9]),'be412ffa3ac317343d0e95f92e923046ea1c99b54e1a5473dd31af39404a62c3');
    assert.equal(sha(statements[10]),'cd09eb0652b45d5a825331263f13b47ad13566bb95adac0789e2e17f363819cf');
    assert.equal(sha(statements[11]),'7130876d34f251b24e1ab2b14b8148845fcfe2828b6a12f57980f023b5bd76e3');
    assert.equal(sha(statements[12]),'9003efaab0e214aadcfe8f4f0dc31cb074d12d6156d29b2070ea315608c4554a');
    assert.equal(sha(statements[13]),'e2bf4ee94bcf3e00d80aba87bcd768ceb07b376497beb7739393b76f42e0fed6');
    host.bb.storage.migrate(database,statements);
  });
}
async function nativeEvidence() {
  const w=new SemanticWorld();w.document=selectorDocument();await w.init({pageBytes:3000});
  try {
    const inspected=await w.inspect();assert.ok(inspected.snapshotId);
    const first=await w.call('docs_read',{account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope,format:'structured'});
    assert.ok(first.nextCursor);
    const db=w.host.bb.storage.database();
    return {snapshot:w.store.semanticSnapshots.get(inspected.snapshotId,owner,0),
      cursor:db.prepare('SELECT * FROM docs_semantic_cursors WHERE id=?').get(first.nextCursor),
      delivery:db.prepare('SELECT * FROM docs_semantic_delivery WHERE id=?').get(first.coverage.deliveryToken)};
  } finally {await w.close();}
}
function installUnsealedARead(db,{snapshot,cursor,delivery}) {
  const {evidence,...model}=snapshot,raw=JSON.stringify(evidence),data=JSON.stringify(model),b=snapshot.binding;
  db.prepare('INSERT INTO docs_semantic_evidence VALUES (?,?,?)').run(snapshot.evidenceDigest,Buffer.byteLength(raw),deflateSync(raw));
  db.prepare('INSERT INTO docs_semantic_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)').run(b.snapshotId,b.subject,b.account,b.threadId,0,600000,snapshot.evidenceDigest,Buffer.byteLength(data),deflateSync(data),digest(data));
  db.prepare('INSERT INTO docs_semantic_cursors VALUES (?,?,?,?)').run(cursor.id,cursor.snapshot,cursor.expires,cursor.state);
  db.prepare('INSERT INTO docs_semantic_delivery VALUES (?,?,?)').run(delivery.id,delivery.snapshot,delivery.data);
  db.prepare('INSERT INTO docs_semantic_pins VALUES (?,?,?)').run(b.snapshotId,'historical-draft',900000);
}
test('historical foundation/A fixture pins all nine original SQL byte hashes',()=>{
  assert.equal(history.statements.length,9);assert.deepEqual(history.statements.map(sha),history.statementHashes);
  assert.equal(history.statementHashes[8],'a921e525a7b37207c9df3f431f4f542fff9a3e7c9b2af2f70d595f7007e1d0d5');
});
for(const count of [0,8,9])test(`B2 real migrator from ${count===0?'fresh':count===8?'legacy prefix':'foundation/A prefix'} and corrected B reopen`,async()=>{
  const host=createFakePluginHost({pluginId:'original-semantic-migration'});
  try {
    let db=host.bb.storage.database();assert.notEqual(db.name,':memory:');
    host.bb.storage.migrate(db,history.statements.slice(0,count));
    if(count){
      db.prepare('INSERT INTO drive_accounts(subject,email,refresh_token) VALUES (?,?,?)').run(owner.subject,owner.account,'PRIVATE_RETAINED_TOKEN');
      db.prepare('INSERT INTO drive_formatting_operations VALUES (?,?,?,?,?)').run('historical-uncertain',owner.subject,'doc-a','uncertain',JSON.stringify({state:'uncertain',appliedRevision:'original-r'}));
    }
    let store=currentStore(host,db);assert.deepEqual(store.semanticSnapshots.stats(),{snapshots:0,bytes:0});
    db.close();db=host.bb.storage.database();store=currentStore(host,db);
    assert.deepEqual(store.semanticSnapshots.stats(),{snapshots:0,bytes:0});
    if(count){assert.equal((await store.bySubject(owner.subject)).refreshToken,'PRIVATE_RETAINED_TOKEN');assert.equal(await store.activeFormatting('doc-a'),'historical-uncertain');}
  } finally {await host.harness.lifecycle.dispose();}
});
test('B2 A rows/pinned bytes are retained without fabricated seals or usable read authority',async()=>{
  const evidence=await nativeEvidence(),id=evidence.snapshot.binding.snapshotId;
  const host=createFakePluginHost({pluginId:'retained-semantic-history'});
  try {
    let db=host.bb.storage.database();host.bb.storage.migrate(db,history.statements);
    installUnsealedARead(db,evidence);
    db.prepare('INSERT INTO drive_accounts(subject,email,refresh_token) VALUES (?,?,?)').run(owner.subject,owner.account,'PRIVATE_RETAINED_TOKEN');
    db.prepare('INSERT INTO drive_formatting_operations VALUES (?,?,?,?,?)').run('historical-uncertain',owner.subject,'doc-a','uncertain',JSON.stringify({state:'uncertain',appliedRevision:'original-r'}));
    const before=rows(db),account=db.prepare('SELECT * FROM drive_accounts').all(),receipt=db.prepare('SELECT * FROM drive_formatting_operations').all();
    let store=currentStore(host,db),s=store.semanticSnapshots;
    assert.deepEqual(rows(db),before);assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_integrity').get().n,0);
    for(const call of [()=>s.get(id,owner,1),()=>s.consumeCursor(evidence.cursor.id,owner,1,id),()=>s.deliveries(id,owner,1,[evidence.delivery.id]),
      ()=>s.readPinned(id,owner,'historical-draft',1),()=>s.releasePin(id,owner,'historical-draft'),()=>s.pin(id,owner,'new-owner',1,1000)]) {
      assert.throws(call,/unsupported/,'unsealed historical evidence never gains read/witness authority');
    }
    s.sweep(1800000);assert.deepEqual(rows(db),before,'automatic maintenance preserves unsealed retained rows, even after their old deadlines');
    db.close();db=host.bb.storage.database();store=currentStore(host,db);s=store.semanticSnapshots;
    assert.deepEqual(rows(db),before);assert.deepEqual(db.prepare('SELECT * FROM drive_accounts').all(),account);assert.deepEqual(db.prepare('SELECT * FROM drive_formatting_operations').all(),receipt);
    assert.equal(await store.activeFormatting('doc-a'),'historical-uncertain');
    assert.throws(()=>s.get(id,owner,1),/unsupported/);
    // Fresh evidence can coexist within unchanged capacity; no old bytes are
    // interpreted or re-sealed as an implicit migration witness.
    // put requires the original snapshot identity to be unique, so this control
    // uses an actual second native observation rather than rewriting handles.
    const next=await nativeEvidence();s.put(next.snapshot,0);
    assert.ok(s.get(next.snapshot.binding.snapshotId,owner,1));
    s.sweep(600000);
    assert.deepEqual(rows(db),before);assert.equal(db.prepare('SELECT count(*) AS n FROM docs_semantic_integrity WHERE snapshot=?').get(id).n,0);
    assert.equal(await store.activeFormatting('doc-a'),'historical-uncertain');
  } finally {await host.harness.lifecycle.dispose();}
});
