// Real child and normal D recorder/intake. Only E's two normal exclusions are
// selected in disposable copies; no synthetic product successes or future keys.
import test from 'node:test';
import {retainRawMaskOnly} from './docs-semantic-isolation.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync,cpSync,symlinkSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../features/docs/coverage/runner.mjs';
import { digest } from '../features/docs/coverage/audit.mjs';
const indexPath='features/docs/coverage/fixtures/index.json';
const adapters='features/docs/coverage/execution-adapters.mjs',bridge='features/docs/coverage/bridge.mjs';
const id='C006.refuseRawMask__capability.refused';
const load=(root,path)=>JSON.parse(readFileSync(join(root,path)));
const save=(root,path,data)=>writeFileSync(join(root,path),JSON.stringify(data,null,2)+'\n');
function replace(root,path,oldText,newText){const file=join(root,path),text=readFileSync(file,'utf8');assert.equal(text.split(oldText).length,2,oldText);writeFileSync(file,text.replace(oldText,newText));}
function isolate(){
  const root=mkdtempSync(join(tmpdir(),'docs-e-negative-'));
  for(const name of readdirSync(packageRoot)){
    if(name==='features'||/\.(ts|tsx|mjs|json|css)$/.test(name))cpSync(join(packageRoot,name),join(root,name),{recursive:true});
    else symlinkSync(join(packageRoot,name),join(root,name));
  }
  writeFileSync(join(root,'cucumber.mjs'),"export default {};export const docs={paths:['features/docs/semantic-raw-mask-e.feature'],import:['features/docs/steps/bridge-d.steps.mjs'],format:['progress']};\n");
  save(root,'features/docs/coverage/baseline.json',{cases:[]});save(root,'features/docs/coverage/bridge-cases.json',{});
  save(root,indexPath,Object.fromEntries(Object.entries(load(root,indexPath)).filter(([key])=>key.startsWith('C006.refuseRawMask'))));
  retainRawMaskOnly(root);
  return root;
}
function fixture(root,change){const index=load(root,indexPath),entry=index[id],f=load(root,entry.path);change(f);save(root,entry.path,f);entry.sha256=digest(readFileSync(join(root,entry.path)));save(root,indexPath,index);}
function skipChild(root){replace(root,adapters,'    compareExecution(record,fixture,trace);','    // Test fault: unchanged parent must reject.');}
function corrupt(root,code){replace(root,bridge,"writeSync(3,JSON.stringify(receipt)+'\\n');","receipt.trace.nativeCalls=structuredClone(receipt.trace.nativeCalls);\n"+code+"\n  writeSync(3,JSON.stringify(receipt)+'\\n');");}
function inRawMask(root,code){replace(root,adapters,"if(route.action==='rawMask'){\n      for(const attempt","if(route.action==='rawMask'){\n      "+code+"\n      for(const attempt");skipChild(root);}
const probes=[
  ['substituted actual host dispatcher',r=>inRawMask(r,`w.host.harness.behavior.callAgentTool=async name=>{throw new Error('tool "'+name+'" arguments are invalid: (input): Unrecognized key: "fields"');};`),/actual raw-mask host calls/],
  ...[
    ['actual table DDL',`db.exec('CREATE TABLE unexpected_e (value TEXT)');assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='unexpected_e'").get());`],
    ['actual create/drop',`db.exec('CREATE TABLE unexpected_e (value TEXT); DROP TABLE unexpected_e');`],
    ['actual index create/drop',`db.exec('CREATE INDEX unexpected_e ON drive_accounts(email); DROP INDEX unexpected_e');`],
    ['actual temp schema create/drop',`db.exec('CREATE TEMP TABLE unexpected_e (value TEXT); DROP TABLE temp.unexpected_e');`],
    ['actual persistent user version',`db.exec('PRAGMA main.user_version=917');assert.equal(db.pragma('main.user_version',{simple:true}),917);`],
    ['actual persistent application id',`db.exec('PRAGMA main.application_id=918');assert.equal(db.pragma('main.application_id',{simple:true}),918);`],
    ['schema mutation with restored version',`const version=db.pragma('main.schema_version',{simple:true});db.exec('CREATE TABLE unexpected_e (value TEXT)');db.unsafeMode(true);db.pragma('main.schema_version='+version);db.unsafeMode(false);assert.equal(db.pragma('main.schema_version',{simple:true}),version);`],
    ['actual schema despite public prepare replacement',`db.exec('CREATE TABLE unexpected_e (value TEXT)');db.prepare=()=>({get:()=>({n:12}),all:()=>[]});`],
  ].map(([name,sql])=>[name,r=>inRawMask(r,'const db=w.host.bb.storage.database();'+sql),/raw mask cannot change SQLite schema or metadata/]),
  ['actual row DML',r=>inRawMask(r,`w.host.bb.storage.database().exec("UPDATE drive_accounts SET email='unexpected@example.test' WHERE subject='subject-d'");`),/raw mask cannot change SQLite/],
  ['missing actual storage observations',r=>corrupt(r,'receipt.trace.storageObservations=[];'),/actual storage observation pair/],
  ['different storage connection',r=>corrupt(r,"receipt.trace.storageObservations=structuredClone(receipt.trace.storageObservations);receipt.trace.storageObservations[1].connectionId='00000000-0000-4000-8000-000000000000';"),/same actual storage connection/],
  ['unrelated schema refusal',r=>{fixture(r,f=>{f.calls[0].args.unrelated=f.calls[0].args.fields;delete f.calls[0].args.fields;});skipChild(r);},/raw mask actually supplied|string/],
  ['invalid permitted control',r=>{fixture(r,f=>{f.calls[1].args.snapshotId='';f.expected.controls[1].snapshotId='';});skipChild(r);},/actual paired schema acceptance/],
  ['missing captured host attempts',r=>corrupt(r,'receipt.trace.nativeCalls=[];'),/actual raw-mask host calls/],
  ['wrong actual native method',r=>corrupt(r,"receipt.trace.nativeCalls[0].name='gdrive_get_file';"),/captured native schema input/],
  ['wrong schema error',r=>corrupt(r,"receipt.trace.nativeCalls[0].error.message='unavailable';"),/exact actual raw-mask schema rejection/],
  ['invented parsed control',r=>corrupt(r,"receipt.trace.nativeCalls[0].control.parsed={};"),/actual paired schema acceptance/],
  ['unexpected storage change',r=>corrupt(r,'receipt.trace.storageChanges.after++;'),/raw mask cannot change SQLite/],
  ['wrong outcome',r=>corrupt(r,"receipt.observedOutcome='success';"),/execution observedOutcome binding/],
  ['reused host invocation across cases',r=>{replace(r,bridge,'let inventory;','let inventory,firstNativeId;');corrupt(r,'firstNativeId??=receipt.trace.nativeCalls[0].id;receipt.trace.nativeCalls[0].id=firstNativeId;');},/reused actual native schema invocation/],
  ['missing normal outcome declaration',r=>{const p='features/docs/coverage/obligations.json',m=load(r,p);delete m.expansion.deliveryOverrides['C006/policy.publicRawMask/refuseRawMask__capability/refused'];save(r,p,m);},/planned delivery evidence/],
  ['phantom registered variant',r=>{const p='features/docs/coverage/registry.json',v=load(r,p);v.operations['policy.publicRawMask'].variants.phantom__capability={};save(r,p,v);},/no implemented semantic driver/],
  ['orphan normal fixture',r=>{const v=load(r,indexPath);v['C006.orphan__capability.refused']=v[id];save(r,indexPath,v);},/normal semantic fixture discovery\/reverse orphan/],
  ['serving exposure declaration',r=>{const p='features/docs/coverage/registry.json',v=load(r,p);v.exposed=['policy.publicRawMask/refuseRawMask__capability'];save(r,p,v);},/no implemented semantic variant may be exposed/],
  ['missing exact fixture',r=>{const v=load(r,indexPath);delete v[id];save(r,indexPath,v);},/missing bridge fixture/,false],
  ['missing Examples row',r=>replace(r,'features/docs/semantic-raw-mask-e.feature','      | C006.refuseRawMask__capability.refused        |\n',''),/semantic delivery lacks implemented invocation\/readback adapter/,false],
];
for(const [name,change,reason,childPass=true] of probes)test('E actual runner rejects '+name,{timeout:60000},()=>{
  const root=isolate();try{
    change(root);const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
    assert.equal(run.signal,null,'outer timeout is not rejection evidence');assert.notEqual(run.status,0);
    assert.match(run.stdout+'\n'+run.stderr,reason);
    if(childPass)assert.match(run.stdout,/2 scenarios \(2 passed\)/,'passing child is not parent evidence');
    assert.doesNotMatch(run.stdout,/"executedObligations":2/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
