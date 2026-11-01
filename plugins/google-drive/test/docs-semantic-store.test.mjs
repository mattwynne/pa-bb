import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { materialize } from '../core/docs-semantic/model.mjs';
import { createSemanticSnapshotStore } from '../adapters/docs-semantic-store.mjs';
import { LIMITS } from '../core/docs-semantic/common.mjs';
const f=JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/snapshot-vector.json',import.meta.url)));
const owner={subject:'subject-a',account:'writer@example.test',threadId:'thread-a'};
const make=(id,retrievedAt=0)=>materialize({document:f.document,metadata:f.metadata,binding:{...owner,snapshotId:id,documentId:'doc-a',view:'inline',retrievedAt},reviewIncluded:true});
test('file-backed snapshots survive reopen, enforce owner and cursor consume transaction',async()=>{
  const host=createFakePluginHost({pluginId:'semantic-store-test'});try{
    let db=host.bb.storage.database(),store=createBbStore(db,host.bb.storage.migrate).semanticSnapshots;
    assert.notEqual(db.name,':memory:');assert.ok(store,'new read-only store seam');
    store.put(make('snap-a'),0);const cursor=store.issueCursor('snap-a',owner,{offset:2,request:{format:'structured'},view:'inline',documentId:'doc-a'},0);
    assert.throws(()=>store.consumeCursor(cursor,{...owner,threadId:'other'},1),/snapshot/);
    assert.throws(()=>store.consumeCursor(cursor,{...owner,subject:'other'},1),/snapshot/);
    db.close();db=host.bb.storage.database();store=createBbStore(db,host.bb.storage.migrate).semanticSnapshots;
    assert.equal(store.consumeCursor(cursor,owner,1).state.offset,2);
    assert.throws(()=>store.consumeCursor(cursor,owner,2),/snapshot/);
    assert.equal(store.get('snap-a',owner,3).evidenceDigest,make('snap-a').evidenceDigest);
    assert.throws(()=>store.put(make('snap-a'),3),/conflict/);
  }finally{await host.harness.lifecycle.dispose();}
});
test('cursor five-minute bound, ten-minute snapshot bound, explicit pin lifetime does not extend read authority',async()=>{
  const host=createFakePluginHost({pluginId:'semantic-store-ttl'});try{
    const store=createBbStore(host.bb.storage.database(),host.bb.storage.migrate).semanticSnapshots;assert.ok(store);
    store.put(make('snap-a'),0);const c=store.issueCursor('snap-a',owner,{offset:1,view:'inline',documentId:'doc-a'},0);
    assert.throws(()=>store.consumeCursor(c,owner,300000),/snapshot/);
    store.pin('snap-a',owner,'draft-a',599999,900000);
    assert.throws(()=>store.get('snap-a',owner,600000),/snapshot/);
    assert.equal(store.readPinned('snap-a',owner,'draft-a',600000).binding.snapshotId,'snap-a');
    assert.throws(()=>store.issueCursor('snap-a',owner,{},600000),/snapshot/);
    assert.throws(()=>store.pin('snap-a',owner,'draft-b',600000,900000),/snapshot/);
    assert.throws(()=>store.readPinned('snap-a',owner,'draft-a',900000),/snapshot/);
    store.sweep(900000);assert.equal(store.stats().snapshots,0);
  }finally{await host.harness.lifecycle.dispose();}
});
test('logical pool exact boundary succeeds and one-byte shortage leaves no partial snapshot',async()=>{
  const host=createFakePluginHost({pluginId:'semantic-store-byte-boundary'});try{
    const db=host.bb.storage.database();createBbStore(db,host.bb.storage.migrate);
    const snapshot=make('snap-exact'),{evidence,...body}=snapshot;
    // B adds bounded row/index metadata, compressed storage and integrity rows
    // to the live reservation. Independent byte arithmetic, not store.stats as
    // the oracle: 3 rows, their exact text fields, and both compressed blobs.
    const raw=JSON.stringify(evidence),model=JSON.stringify(body),b=snapshot.binding;
    const bytes=Buffer.byteLength(raw)+Buffer.byteLength(model)+deflateSync(raw).length+deflateSync(model).length+
      3*256+128+Buffer.byteLength(b.snapshotId+b.subject+b.account+b.threadId+b.snapshotId+b.subject+b.threadId)+128+
      2*Buffer.byteLength('snapshot'+b.snapshotId+b.snapshotId)+64;
    const short=createSemanticSnapshotStore(db,{limits:{...LIMITS,poolBytes:bytes-1}});
    assert.throws(()=>short.put(snapshot,0),/budget/);assert.deepEqual(short.stats(),{snapshots:0,bytes:0});
    const exact=createSemanticSnapshotStore(db,{limits:{...LIMITS,poolBytes:bytes}});exact.put(snapshot,0);assert.deepEqual(exact.stats(),{snapshots:1,bytes});
    assert.throws(()=>exact.issueCursor('snap-exact',owner,{view:'inline',documentId:'doc-a'},0),/budget/);
    db.prepare('UPDATE docs_semantic_snapshots SET model_digest=? WHERE id=?').run('corrupt','snap-exact');
    assert.throws(()=>exact.get('snap-exact',owner,0),/corrupt/);
  }finally{await host.harness.lifecycle.dispose();}
});
test('per-owner capacity is bounded; old write receipts and account rows unchanged',async()=>{
  const host=createFakePluginHost({pluginId:'semantic-store-capacity'});try{
    const db=host.bb.storage.database(),store=createBbStore(db,host.bb.storage.migrate),s=store.semanticSnapshots;assert.ok(s);
    await store.addAccount({...owner,refreshToken:'SENTINEL',email:owner.account});
    await store.reserveFormatting({operationId:'legacy',subject:owner.subject,documentId:'doc-a',state:'uncertain',appliedRevision:'rev-a'});
    for(let i=0;i<4;i++)s.put(make(`snap-${i}`),0);
    assert.throws(()=>s.put(make('snap-5'),0),/budget/);
    s.sweep(600000);s.put(make('snap-next',600000),600000);
    assert.equal(await store.activeFormatting('doc-a'),'legacy');assert.equal((await store.bySubject(owner.subject)).refreshToken,'SENTINEL');
  }finally{await host.harness.lifecycle.dispose();}
});
