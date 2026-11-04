// This is a runner-boundary test, not a pure core case. One bounded child checks
// both builtin aliases without ever starting a network/DB/worker operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('pure command rejects external systems, builtin aliases and fetch',()=>{
 const guard=new URL('../features/docs/support/fast-boundary.mjs',import.meta.url).href;
 const specs=['child_process','cluster','worker_threads','sqlite','http','https','http2','net','tls','dgram','dns','dns/promises'].flatMap(s=>[s,'node:'+s]).concat(['@get-bb/plugin-sdk/testing','better-sqlite3']);
 const code=`import assert from 'node:assert/strict';for(const spec of ${JSON.stringify(specs)})await assert.rejects(import(spec),/Fast test crossed external-system boundary/);assert.throws(()=>fetch('https://never.example.test'),/Unexpected network/);await import(${JSON.stringify(new URL('../core/docs-semantic/model.mjs',import.meta.url).href)});`;
 const result=spawnSync(process.execPath,['--import',guard,'--input-type=module','-e',code],{encoding:'utf8',timeout:5000,maxBuffer:65536});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.equal(result.signal,null);
});
