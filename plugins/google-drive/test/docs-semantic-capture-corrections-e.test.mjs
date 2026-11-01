import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { productionHost } from '../features/docs/support/production-host.mjs';
import { storageObservationBoundary } from '../features/docs/support/storage-observations.mjs';
const args=()=>({account:'reader@example.test',snapshotId:'snap-e',scope:{tabs:{ids:['tab-e']},segments:[{kind:'body'}]},format:'structured',fields:'*'});
test('E1 replacement is refused before recording or calling replacement; original host remains usable',async()=>{
  const w=await productionHost(async()=>{throw Error('unexpected HTTP')});try{
    const original=w.host.harness.behavior.callAgentTool;let replacedCalls=0;
    w.host.harness.behavior.callAgentTool=async name=>{replacedCalls++;throw Error('tool "'+name+'" arguments are invalid: (input): Unrecognized key: "fields"');};
    await assert.rejects(()=>w.invokeNative('docs_read',args(),'thread-d'),/native host dispatcher replaced/);
    assert.equal(replacedCalls,0);assert.deepEqual(w.nativeCalls(),[]);assert.deepEqual(w.invocations,[]);
    w.host.harness.behavior.callAgentTool=original;
    const input=args(),saved=structuredClone(input);
    await assert.rejects(()=>w.invokeNative('docs_read',input,'thread-d'),/Unrecognized key: "fields"/);
    input.scope.tabs.ids[0]='mutated';input.fields='mutated';const records=w.nativeCalls();
    assert.equal(records.length,1);assert.deepEqual(records[0].args,saved);assert.equal(records[0].sequence,1);
    assert.throws(()=>{records[0].error.message='fake';},TypeError);assert.throws(()=>records.pop(),TypeError);
    assert.equal(replacedCalls,0);
  }finally{await w.close();}
});
async function withDb(fn){const host=createFakePluginHost({pluginId:'google-drive'});try{return await fn(host.bb.storage.database());}finally{await host.harness.lifecycle.dispose();}}
test('E2 fixed connection/queries and immutable bounded snapshots, without content rows',()=>withDb(db=>{
  db.exec('CREATE TABLE probe(value TEXT)');const observer=storageObservationBoundary(db);observer.capture();
  db.exec('CREATE INDEX changed ON probe(value)');
  db.prepare=()=>{throw Error('replacement prepare must not be used');};observer.capture();
  const [before,after]=observer.records();assert.equal(before.connectionId,after.connectionId);assert.equal(before.totalChanges,after.totalChanges);
  assert.notEqual(before.state.main.schemaDigest,after.state.main.schemaDigest);assert.notEqual(before.state.main.metadata.schema_version,after.state.main.metadata.schema_version);
  assert.deepEqual(before.databases.map(d=>d.name),['main','temp']);
  assert.throws(()=>{after.state.main.schemaDigest='fake';},TypeError);assert.throws(()=>observer.records().pop(),TypeError);
  assert.throws(()=>observer.capture(),/storage observation count bound/);
}));
for(const [name,sql] of [
  ['table create/drop','CREATE TABLE t(v); DROP TABLE t'],
  ['temp create/drop','CREATE TEMP TABLE t(v); DROP TABLE temp.t'],
  ['index create/drop','CREATE INDEX idx ON probe(value); DROP INDEX idx'],
])test('E2 '+name+' leaves schema history even when schema digest is restored',()=>withDb(db=>{
  db.exec('CREATE TABLE probe(value TEXT)');const observer=storageObservationBoundary(db);observer.capture();db.exec(sql);observer.capture();
  const [before,after]=observer.records(),scope=name.startsWith('temp')?'temp':'main';
  assert.equal(before.totalChanges,after.totalChanges);assert.equal(before.state[scope].schemaDigest,after.state[scope].schemaDigest);
  assert.notEqual(before.state[scope].metadata.schema_version,after.state[scope].metadata.schema_version);
}));
for(const property of ['user_version','application_id','journal_mode'])test('E2 actual persistent metadata '+property+' is independently captured',()=>withDb(db=>{
  const observer=storageObservationBoundary(db);observer.capture();db.exec(`PRAGMA main.${property}=${property==='journal_mode'?'TRUNCATE':975}`);observer.capture();
  const [before,after]=observer.records();assert.equal(before.totalChanges,after.totalChanges);assert.equal(before.state.main.schemaDigest,after.state.main.schemaDigest);
  assert.notEqual(before.state.main.metadata[property],after.state.main.metadata[property]);
}));
test('E2 schema digest also catches DDL with manually restored schema_version',()=>withDb(db=>{
  const observer=storageObservationBoundary(db);observer.capture();const version=db.pragma('schema_version',{simple:true});
  db.exec('CREATE TABLE t(v)');
  // Only this disposable fault fixture disables SQLite defensive mode, then
  // restores it, to prove the schema digest is independent of the version.
  db.unsafeMode(true);db.pragma('schema_version='+version);db.unsafeMode(false);
  assert.equal(db.pragma('schema_version',{simple:true}),version);
  observer.capture();const [before,after]=observer.records();
  assert.equal(before.state.main.metadata.schema_version,after.state.main.metadata.schema_version);assert.notEqual(before.state.main.schemaDigest,after.state.main.schemaDigest);
}));
test('E2 attached database is out of the fixed main/temp scope, not silently ignored',()=>withDb(db=>{
  const observer=storageObservationBoundary(db);observer.capture();db.exec("ATTACH ':memory:' AS extra");assert.throws(()=>observer.capture(),/unexpected attached database/);
}));
for(const [name,setup,reason] of [
  ['entry count',db=>{for(let i=0;i<129;i++)db.exec(`CREATE TABLE t${i}(v)`);},/schema entry count bound/],
  ['entry bytes',db=>db.exec('CREATE TABLE t(v /*'+'x'.repeat(8200)+'*/)'),/schema entry byte bound/],
  ['aggregate bytes',db=>{for(let i=0;i<40;i++)db.exec(`CREATE TABLE t${i}(v /*${'x'.repeat(7000)}*/)`);},/schema aggregate byte bound/],
])test('E2 bounded observer refuses '+name,()=>withDb(db=>{const observer=storageObservationBoundary(db);setup(db);assert.throws(()=>observer.capture(),reason);}));
test('E2 unchanged observed state is not a claim of zero attempted writes',()=>withDb(db=>{
  const observer=storageObservationBoundary(db);observer.capture();db.exec('BEGIN; CREATE TABLE rolled_back(v); ROLLBACK');observer.capture();
  const [before,after]=observer.records();assert.equal(before.totalChanges,after.totalChanges);assert.deepEqual(before.state,after.state);
}));
