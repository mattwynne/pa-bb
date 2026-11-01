// Offline evidence only. Fixed, bounded reads on the actual host connection.
// No route-supplied SQL/callback/connection and no table-content serialization.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const copy=value=>freeze(structuredClone(value));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function storageObservationBoundary(db) {
  const connectionId=randomUUID(),observations=[];
  const prepare=db.prepare.bind(db);
  const get=sql=>{const s=prepare(sql);return s.get.bind(s);};
  const all=sql=>{const s=prepare(sql);return s.all.bind(s);};
  const changes=get('SELECT total_changes() AS n');
  // Prepare both schemas before the first observation (initializes temp scope).
  const schemas=Object.fromEntries(['main','temp'].map(scope=>[scope,all(`SELECT type,
    substr(name,1,257) AS name, length(CAST(name AS BLOB)) AS nameBytes,
    substr(tbl_name,1,257) AS tbl_name, length(CAST(tbl_name AS BLOB)) AS tableBytes,
    rootpage, substr(sql,1,8193) AS sql, length(CAST(sql AS BLOB)) AS sqlBytes
    FROM ${scope}.sqlite_schema LIMIT 129`)]));
  const properties=['schema_version','user_version','application_id','page_size','page_count','freelist_count','auto_vacuum','encoding','journal_mode'];
  const metadata=Object.fromEntries(['main','temp'].map(scope=>[scope,Object.fromEntries(properties.map(p=>[p,get(`PRAGMA ${scope}.${p}`)]))]));
  const databases=all('SELECT seq, substr(name,1,257) AS name, length(CAST(name AS BLOB)) AS nameBytes, substr(file,1,4097) AS file, length(CAST(file AS BLOB)) AS fileBytes FROM pragma_database_list ORDER BY seq LIMIT 3');
  function capture() {
    assert.ok(observations.length<2,'storage observation count bound');
    const scope=databases();assert.ok(scope.length<=2,'unexpected attached database');
    for(const d of scope)assert.ok(d.nameBytes<=256&&d.fileBytes<=4096,'database scope byte bound');
    assert.deepEqual(scope.map(d=>d.name),['main','temp'],'storage observation main/temp scope');
    const state={};
    for(const name of ['main','temp']){
      const entries=schemas[name]();assert.ok(entries.length<=128,'schema entry count bound');
      // Sort only the bounded result, never ask SQLite to sort an unbounded catalog.
      entries.sort((a,b)=>{const x=JSON.stringify([a.type,a.name,a.tbl_name]),y=JSON.stringify([b.type,b.name,b.tbl_name]);return x<y?-1:x>y?1:0;});
      let bytes=0;
      for(const e of entries){assert.ok(e.nameBytes<=256&&e.tableBytes<=256&&(e.sqlBytes??0)<=8192,'schema entry byte bound');bytes+=e.nameBytes+e.tableBytes+(e.sqlBytes??0);}
      assert.ok(bytes<=256*1024,'schema aggregate byte bound');
      const values={};for(const [p,read] of Object.entries(metadata[name])){
        const value=Object.values(read())[0];assert.ok(Number.isSafeInteger(value)||(typeof value==='string'&&value.length<=64),'bounded database metadata');values[p]=value;
      }
      state[name]={entries:entries.length,schemaDigest:hash(entries),metadata:values};
    }
    observations.push(copy({connectionId,sequence:observations.length+1,totalChanges:changes().n,
      databases:scope.map(d=>({sequence:d.seq,name:d.name,fileDigest:hash(d.file)})),state}));
  }
  return Object.freeze({capture,records:()=>copy(observations)});
}
