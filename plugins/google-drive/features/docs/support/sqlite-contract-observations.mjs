// Fixed technical observations from the actual SQLite connection. Never accepts
// a route/store callback and is not available from the memory substitute.
import assert from 'node:assert/strict';
import { storageObservationBoundary } from './storage-observations.mjs';
export const semanticTables=Object.freeze(['evidence','snapshots','cursors','pins','delivery','integrity','read_work']);
export function sqliteContractObservation(db){
  assert.notEqual(db.name,':memory:');const storage=storageObservationBoundary(db),rows=[];
  const reads=Object.fromEntries(semanticTables.map(name=>{const statement=db.prepare(`SELECT count(*) AS n FROM docs_semantic_${name}`);return[name,statement.get.bind(statement)];}));
  const work=db.prepare('SELECT bytes FROM docs_semantic_read_work ORDER BY snapshot,id LIMIT 2'),readWork=work.all.bind(work);
  const capture=()=>{storage.capture();rows.push({counts:Object.fromEntries(semanticTables.map(name=>[name,reads[name]().n])),work:readWork()});};
  return Object.freeze({capture,result:()=>({storage:storage.records(),rows:structuredClone(rows)})});
}
const expected={
  'immutable model and exact owner binding':[1,1,0,0,0,1,0],
  'exact snapshot and cursor deadlines':[1,1,1,0,0,2,0],
  'failed page leaves cursor unconsumed and no partial publication':[1,1,0,0,1,2,0],
  'wrong owner never consumes cursor':[1,1,0,0,0,1,0],
  'pin retains evidence not ordinary authority':[1,1,0,1,0,2,0],
  'early invalid witness is refused':[1,1,0,0,0,1,0],
  'failed witness delivery rolls back pin publication':[1,1,0,1,1,3,0],
  'malformed binding is semantic invalid before storage mapping':[0,0,0,0,0,0,0],
  'mismatched provider evidence cannot be admitted':[0,0,0,0,0,0,0],
  'work budget exact cumulative boundary':[1,1,0,0,0,2,1],
};
export function compareSqliteContractObservation(name,observation){
  assert.ok(observation&&Array.isArray(observation.storage)&&observation.storage.length===2&&Array.isArray(observation.rows)&&observation.rows.length===2,'missing actual SQLite contract observation (memory is not persistence)');
  const [before,after]=observation.storage;
  assert.match(before.connectionId,/^[a-f0-9-]{36}$/);assert.equal(after.connectionId,before.connectionId);assert.equal(before.sequence,1);assert.equal(after.sequence,2);
  assert.deepEqual(before.databases.map(d=>d.name),['main','temp']);assert.deepEqual(after.databases,before.databases);assert.match(before.databases[0].fileDigest,/^[a-f0-9]{64}$/);
  assert.equal(before.state.main.schemaDigest,after.state.main.schemaDigest);assert.equal(before.state.main.metadata.user_version,after.state.main.metadata.user_version);assert.ok(before.totalChanges>=0&&after.totalChanges>=before.totalChanges);
  assert.deepEqual(observation.rows[0],{counts:Object.fromEntries(semanticTables.map(n=>[n,0])),work:[]});
  assert.ok(expected[name]);assert.deepEqual(observation.rows[1],{counts:Object.fromEntries(semanticTables.map((n,i)=>[n,expected[name][i]])),work:name==='work budget exact cumulative boundary'?[{bytes:268435456}]:[]},'independent actual SQLite contract rows');
  return before.connectionId;
}
