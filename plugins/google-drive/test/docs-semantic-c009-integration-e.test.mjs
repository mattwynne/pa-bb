// Normal C009 joins and parent-only negatives: no standalone source test credit.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,readdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {packageRoot} from '../features/docs/coverage/runner.mjs';
import {expand,allClosures} from '../features/docs/coverage/expand.mjs';
import {cucumberResults,digest} from '../features/docs/coverage/audit.mjs';
import {assertProductIntake} from '../features/docs/coverage/product-intake.mjs';
import {readJournal} from '../features/docs/coverage/execution-journal.mjs';
const json=p=>JSON.parse(readFileSync(p));
const manifest=json(join(packageRoot,'features/docs/coverage/obligations.json')),records=expand(manifest),c009=records.filter(r=>r.ledgerId==='C009');
const variants=['cursorExpiry','cursorReplay','draftPinnedEvidence','empty','overrun','partial','snapshotExpiry','wrongThread'];
test('all sixteen current normal C009 joins, no candidate shadow, exact remaining closures',{timeout:180000},()=>{
 assert.equal(Object.keys(manifest.rows).length,211);assert.equal(records.length,11197);assert.equal(c009.length,16);
 assert.deepEqual(c009.map(r=>r.caseId).sort(),variants.flatMap(v=>['counterexample','success'].map(o=>`C009.${v}__local.${o}`)).sort());
 const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:packageRoot,encoding:'utf8',timeout:150000,maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stdout+run.stderr);
 const dir=run.stdout.match(/Docs current-run evidence: (.+)/)[1],summary=json(join(dir,'summary.json')),account=json(join(dir,'s02-accounting.json'));
 assert.equal(summary.executedObligations,238);assert.equal(summary.bridgeCandidates,4);assert.equal(summary.implementedAdapterVariants,59);assert.equal(summary.enabledVariants,0);
 assert.deepEqual(summary.s02,{required:367,executed:238,remaining:129,readVariants:59,completeReadClosures:42});
 const expected=records.filter(r=>r.ledgerId==='C009'||r.operation==='policy.publicRawMask'||['docs_read.structure','docs_read.richCell','docs_read.opaque','docs_read.segment','docs_read.view','docs_read.reviewView','docs_find.literal','docs_find.normalization','selector.cardinality'].includes(r.operation)||r.ledgerId==='C005'&&r.earliestSlice==='S02');assert.equal(expected.length,238);
 assert.deepEqual(account.executedKeys.sort(),expected.map(r=>r.key).sort());assert.deepEqual(account.remainingKeys,records.filter(r=>r.earliestSlice==='S02'&&!expected.includes(r)).map(r=>r.key));
 const closures=allClosures(manifest,records);for(const [key,c] of Object.entries(account.readClosures)){
  assert.deepEqual(c.required,closures.get(key).map(r=>r.key));assert.equal(c.missing.length,/^(docs_read\.(projection|structure|richCell|opaque|segment|view|reviewView)|docs_find\.(literal|normalization))\//.test(key)?0:5);assert.ok(c.missing.every(k=>!k.startsWith('C009/')));
 }
 assert.equal(new Set(Object.values(account.readClosures).flatMap(c=>c.required)).size,311);
 assert.equal(new Set(Object.values(account.readClosures).flatMap(c=>c.missing)).size,85);
 const fixtures=json(join(packageRoot,'features/docs/coverage/fixtures/index.json')),candidates=json(join(packageRoot,'features/docs/coverage/bridge-cases.json'));
 assert.equal(Object.keys(candidates).length,4);for(const r of c009){assert.ok(fixtures[r.caseId]);assert.equal(candidates[r.caseId],undefined);}
 const receipts=readJournal(join(dir,'executions.ndjson')),messages=readJournal(join(dir,'messages.ndjson'),{recordBytes:4*1024*1024,totalBytes:64*1024*1024,records:100000});
 const results=cucumberResults(messages,summary.runId).filter(r=>r.caseId.startsWith('C'));
 const input={manifest,registry:json(join(packageRoot,'features/docs/coverage/registry.json')),results,fixtures:{...fixtures,...candidates},root:packageRoot,receipts,inventory:receipts[0].inventory,runId:summary.runId,fingerprint:summary.sourceDigest};
 assertProductIntake(input);
 const joined=receipts.filter(r=>r.caseId.startsWith('C009.'));assert.equal(joined.length,16);assert.equal(new Set(joined.map(r=>r.fixtureDigest)).size,16);assert.equal(new Set(joined.map(r=>r.pickleId)).size,16);
 for(const r of c009){
  assert.throws(()=>assertProductIntake({...input,receipts:receipts.filter(x=>x.caseId!==r.caseId)}),/missing actual adapter invocation record/,r.key);
  assert.throws(()=>assertProductIntake({...input,results:results.filter(x=>x.caseId!==r.caseId),receipts:receipts.filter(x=>x.caseId!==r.caseId)}),/semantic delivery lacks implemented invocation/,r.key);
  const changed=structuredClone(results);changed.find(x=>x.caseId===r.caseId).observedOutcome=r.outcomeVariant==='success'?'counterexample':'success';assert.throws(()=>assertProductIntake({...input,results:changed}),/execution observedOutcome binding/,r.key);
 }
 for(const kind of ['local','native','connection']){
  const copy=structuredClone(receipts),pair=copy.filter(r=>r.caseId.startsWith('C009.')).slice(0,2);
  if(kind==='local')pair[1].trace.localCalls[0].id=pair[0].trace.localCalls[0].id;
  if(kind==='native')pair[1].trace.nativeCalls[0].id=pair[0].trace.nativeCalls[0].id;
  if(kind==='connection')for(const call of pair[1].trace.localCalls){call.connectionId=pair[0].trace.localCalls[0].connectionId;if(call.operation==='sqlite.observe')call.result.connectionId=call.connectionId;}
  const changed=structuredClone(results);for(const receipt of pair)changed.find(x=>x.caseId===receipt.caseId).executionDigest=digest(JSON.stringify(receipt.trace));
  assert.throws(()=>assertProductIntake({...input,receipts:copy,results:changed}),/reused actual/,kind);
 }
});
const load=(root,p)=>json(join(root,p)),save=(root,p,v)=>writeFileSync(join(root,p),JSON.stringify(v,null,2)+'\n');
function replace(root,p,from,to){const path=join(root,p),s=readFileSync(path,'utf8');assert.equal(s.split(from).length,2,from);writeFileSync(path,s.replace(from,to));}
const adapter='features/docs/coverage/c009-execution.mjs';
function isolated(caseId){
 const root=mkdtempSync(join(tmpdir(),'c009-parent-negative-'));
 for(const n of readdirSync(packageRoot))if(n==='features'||/\.(ts|tsx|mjs|json|css)$/.test(n))cpSync(join(packageRoot,n),join(root,n),{recursive:true});else symlinkSync(join(packageRoot,n),join(root,n));
 const r=c009.find(r=>r.caseId===caseId);assert.ok(r);
 writeFileSync(join(root,'cucumber.mjs'),"export default {};export const docs={paths:['features/docs/semantic-c009-e.feature'],import:['features/docs/steps/bridge-d.steps.mjs'],format:['progress']};\n");
 writeFileSync(join(root,'features/docs/semantic-c009-e.feature'),`@docs @bridgeExecution @C009 @F_READ @S_COVERAGE\nFeature: Exact single C009 control\n Scenario: Normal execution [${caseId}]\n  When the offline production bridge executes "${caseId}"\n`);
 save(root,'features/docs/coverage/baseline.json',{cases:[]});save(root,'features/docs/coverage/bridge-cases.json',{});
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,{[caseId]:index[caseId]});
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);save(root,rp,{operations:{'snapshot.coverage':{variants:{[r.semanticVariant]:registry.operations['snapshot.coverage'].variants[r.semanticVariant]}}},exposed:[]});
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides={[r.key]:m.expansion.deliveryOverrides[r.key]};save(root,mp,m);
 replace(root,'features/docs/coverage/execution-adapters.mjs','    compareC009(record,fixture,trace);','    // Parent-only fault control: never grant credit from a child pass.');return root;
}
const faults={
 cursorExpiry:r=>replace(r,adapter,'p.advance(negative?300000:299999)','p.advance(negative?299999:300000)'),
 snapshotExpiry:r=>replace(r,adapter,'p.advance(negative?600000:599999)','p.advance(negative?599999:600000)'),
 wrongThread:r=>replace(r,adapter,'attempt(()=>p.get(id,negative?other:owner));','attempt(()=>p.get(id,negative?owner:other));'),
 overrun:r=>replace(r,adapter,"const raw=name==='document'?wire(f):JSON.stringify(f.provider[name]);","const raw=name==='document'?wire(f).slice(0,-1):JSON.stringify(f.provider[name]);"),
 partial:r=>replace(r,adapter,'p.deliveries(id,owner,tokens);p.coverage(id,owner,tokens,spec);p.state();','p.deliveries(id,owner,tokens);p.coverage(id,owner,[],spec);p.state();'),
 empty:r=>replace(r,adapter,"p.coverage(id,owner,tokens,{nodes:['snap-d:1'],aspects:['content'],destructive:true});",'p.state();'),
 draftPinnedEvidence:r=>replace(r,adapter,'p.consume(owner,handle);attempt(()=>p.consume(other,handle));','attempt(()=>p.consume(other,handle));'),
 cursorReplay:r=>replace(r,adapter,'p.state();p.peek(first.nextCursor,owner,id);','p.state();'),
};
for(const v of variants)for(const outcome of ['success','counterexample'])test(`C009 parent rejects actual ${v}/${outcome} fault after passing child`,{timeout:60000},()=>{
 const root=isolated(`C009.${v}__local.${outcome}`);try{
  faults[v](root);const r=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
  assert.equal(r.signal,null,'timeout is not a semantic rejection');assert.notEqual(r.status,0);assert.match(r.stdout,/1 scenario \(1 passed\)/);assert.match(r.stderr,/C009/);assert.doesNotMatch(r.stdout,/"executedObligations":1/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
for(const fault of ['fixture','outcome','native','local','dispatcher','store','commit'])test(`C009 exact normal ${fault} boundary refuses substitution`,{timeout:60000},()=>{
 const caseId='C009.wrongThread__local.counterexample',root=isolated(caseId);try{
  let child=true;
  if(fault==='fixture'||fault==='outcome'){
   const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip),f=load(root,index[caseId].path);f[fault==='fixture'?'caseId':'outcome']='wrong';save(root,index[caseId].path,f);index[caseId].sha256=digest(readFileSync(join(root,index[caseId].path)));save(root,ip,index);child=fault!=='fixture';
  }else if(fault==='native'||fault==='local'){
   const marker="writeSync(3,JSON.stringify(receipt)+'\\n');";replace(root,'features/docs/coverage/bridge.mjs',marker,`receipt.trace.${fault==='native'?'nativeCalls':'localCalls'}=[];`+marker);
  }else {
   replace(root,adapter,'p.state();const setup=await native',`${fault==='dispatcher'?"w.host.harness.behavior.callAgentTool=async()=>({content:[]});":`w.store.semanticSnapshots.${fault==='commit'?'commitPage':'get'}=()=>({});`}p.state();const setup=await native`);child=false;
  }
  const r=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});assert.equal(r.signal,null);assert.notEqual(r.status,0);if(child)assert.match(r.stdout,/1 scenario \(1 passed\)/);assert.match(r.stdout+'\n'+r.stderr,/C009|fixture case|replaced/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
