import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,readdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {packageRoot} from '../features/docs/coverage/runner.mjs';
import {expand,allClosures} from '../features/docs/coverage/expand.mjs';
import {cucumberResults,digest} from '../features/docs/coverage/audit.mjs';
import {assertProductIntake} from '../features/docs/coverage/product-intake.mjs';
import {compareC005} from '../features/docs/coverage/c005-execution.mjs';
import {readJournal} from '../features/docs/coverage/execution-journal.mjs';
const json=p=>JSON.parse(readFileSync(p));
const manifest=json(join(packageRoot,'features/docs/coverage/obligations.json')),records=expand(manifest),rows=records.filter(r=>r.ledgerId==='C005'&&r.earliestSlice==='S02');
const variants=['text','structured','styleAnnotations','reviewAnnotations','omitImages','continuation'],outcomes=['success','invalid','preservation','bounds','wrongSubject'];
test('C005 exact30 normal joins preserve accepted18, all future keys and exposure boundary',{timeout:240000},()=>{
 assert.equal(Object.keys(manifest.rows).length,211);assert.equal(records.length,11197);assert.equal(rows.length,30);
 assert.deepEqual(rows.map(r=>r.caseId).sort(),variants.flatMap(v=>outcomes.map(o=>`C005.${v}__read.${o}`)).sort());
 const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:packageRoot,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});assert.equal(run.status,0,run.stdout+run.stderr);
 const dir=run.stdout.match(/Docs current-run evidence: (.+)/)[1],summary=json(join(dir,'summary.json')),account=json(join(dir,'s02-accounting.json'));
 assert.equal(summary.executedObligations,238);assert.equal(summary.bridgeCandidates,4);assert.equal(summary.implementedAdapterVariants,59);assert.equal(summary.enabledVariants,0);
 assert.deepEqual(summary.s02,{required:367,executed:238,remaining:129,readVariants:59,completeReadClosures:42});
 const expected=records.filter(r=>rows.includes(r)||r.ledgerId==='C009'||r.operation==='policy.publicRawMask'||['docs_read.structure','docs_read.richCell','docs_read.opaque','docs_read.segment','docs_read.view','docs_read.reviewView','docs_find.literal','docs_find.normalization','selector.cardinality'].includes(r.operation));assert.equal(expected.length,238);
 assert.deepEqual(account.executedKeys.sort(),expected.map(r=>r.key).sort());assert.deepEqual(account.remainingKeys,records.filter(r=>r.earliestSlice==='S02'&&!expected.includes(r)).map(r=>r.key));
 const closures=allClosures(manifest,records);for(const [key,c]of Object.entries(account.readClosures)){assert.deepEqual(c.required,closures.get(key).map(r=>r.key));assert.equal(c.missing.length,/^(docs_read\.(projection|structure|richCell|opaque|segment|view|reviewView)|docs_find\.(literal|normalization))\//.test(key)?0:5);}
 assert.equal(new Set(Object.values(account.readClosures).flatMap(c=>c.required)).size,311);assert.equal(new Set(Object.values(account.readClosures).flatMap(c=>c.missing)).size,85);
 assert.deepEqual(manifest.expansion.variantExposure,{});
 const fixtures=json(join(packageRoot,'features/docs/coverage/fixtures/index.json')),candidates=json(join(packageRoot,'features/docs/coverage/bridge-cases.json'));assert.equal(Object.keys(candidates).length,4);
 for(const r of rows){assert.ok(fixtures[r.caseId]);assert.equal(candidates[r.caseId],undefined);}
 const receipts=readJournal(join(dir,'executions.ndjson')),messages=readJournal(join(dir,'messages.ndjson'),{recordBytes:4*1024*1024,totalBytes:64*1024*1024,records:100000});
 const results=cucumberResults(messages,summary.runId).filter(r=>r.caseId.startsWith('C'));
 const input={manifest,registry:json(join(packageRoot,'features/docs/coverage/registry.json')),results,fixtures:{...fixtures,...candidates},root:packageRoot,receipts,inventory:receipts[0].inventory,runId:summary.runId,fingerprint:summary.sourceDigest};assertProductIntake(input);
 const joined=receipts.filter(r=>r.caseId.startsWith('C005.'));assert.equal(joined.length,30);assert.equal(new Set(joined.map(r=>r.fixtureDigest)).size,30);assert.equal(new Set(joined.map(r=>r.pickleId)).size,30);
 for(const r of rows){
  assert.throws(()=>assertProductIntake({...input,receipts:receipts.filter(x=>x.caseId!==r.caseId)}),/missing actual adapter invocation record/,r.key);
  assert.throws(()=>assertProductIntake({...input,results:results.filter(x=>x.caseId!==r.caseId),receipts:receipts.filter(x=>x.caseId!==r.caseId)}),/semantic delivery lacks implemented invocation/,r.key);
  const changed=structuredClone(results);changed.find(x=>x.caseId===r.caseId).observedOutcome='counterexample';assert.throws(()=>assertProductIntake({...input,results:changed}),/execution observedOutcome binding/,r.key);
  const receipt=joined.find(x=>x.caseId===r.caseId),f=json(join(packageRoot,fixtures[r.caseId].path));assert.ok(compareC005(r,f,receipt.trace));
  for(const field of ['nativeCalls','localCalls','snapshotCalls']){const t=structuredClone(receipt.trace);t[field]=[];assert.throws(()=>compareC005(r,f,t),/C005 missing actual|C005 missing private/,r.caseId+'/'+field);}
  const swapped=structuredClone(receipt.trace);swapped.snapshotCalls[0].nativeCallId=swapped.nativeCalls[0].id;assert.throws(()=>compareC005(r,f,swapped),/C005 actual original get\/peek binding|C005 real owner\/token refusal/);
  const t=structuredClone(receipt.trace),call=t.nativeCalls.find(c=>c.name==='docs_read'&&c.result&&!c.result.isError);if(call){const result=JSON.parse(call.result.content[0].text);result.coverage.editReady=true;call.result.content[0].text=JSON.stringify(result);assert.throws(()=>compareC005(r,f,t),/C005 complete public envelope/);}
 }
 for(const kind of ['local','native','connection','database']){const copy=structuredClone(receipts),pair=copy.filter(r=>r.caseId.startsWith('C005.')).slice(0,2);
  if(kind==='local')pair[1].trace.localCalls[0].id=pair[0].trace.localCalls[0].id;
  if(kind==='native')pair[1].trace.nativeCalls[0].id=pair[0].trace.nativeCalls[0].id;
  if(kind==='connection')for(const c of pair[1].trace.localCalls){c.connectionId=pair[0].trace.localCalls[0].connectionId;if(c.operation==='sqlite.observe')c.result.connectionId=c.connectionId;}
  if(kind==='database')for(const c of pair[1].trace.localCalls)if(c.operation==='sqlite.observe')c.result.fileDigest=pair[0].trace.localCalls[0].result.fileDigest;
  const changed=structuredClone(results);for(const r of pair)changed.find(x=>x.caseId===r.caseId).executionDigest=digest(JSON.stringify(r.trace));assert.throws(()=>assertProductIntake({...input,receipts:copy,results:changed}),/reused actual/,kind);
 }
 for(const r of records.filter(r=>r.ledgerId==='C005'&&r.earliestSlice==='S12'))assert.equal(manifest.expansion.deliveryOverrides[r.key],undefined);
});
const load=(root,p)=>json(join(root,p)),save=(root,p,v)=>writeFileSync(join(root,p),JSON.stringify(v,null,2)+'\n');
function replace(root,p,from,to){const path=join(root,p),s=readFileSync(path,'utf8');assert.equal(s.split(from).length,2,from);writeFileSync(path,s.replace(from,to));}
const adapter='features/docs/coverage/c005-execution.mjs';
function isolated(caseId){const root=mkdtempSync(join(tmpdir(),'c005-parent-negative-'));
 for(const n of readdirSync(packageRoot))if(['features','core'].includes(n)||/\.(ts|tsx|mjs|json|css)$/.test(n))cpSync(join(packageRoot,n),join(root,n),{recursive:true});else symlinkSync(join(packageRoot,n),join(root,n));
 const r=rows.find(r=>r.caseId===caseId);assert.ok(r);
 writeFileSync(join(root,'cucumber.mjs'),"export default {};export const docs={paths:['features/docs/semantic-c005-e.feature'],import:['features/docs/steps/bridge-d.steps.mjs'],format:['progress']};\n");
 writeFileSync(join(root,'features/docs/semantic-c005-e.feature'),`@docs @bridgeExecution @C005 @F_READ @S_PROJECTIONS\nFeature: Exact single C005 control\n Scenario: Normal execution [${caseId}]\n  When the offline production bridge executes "${caseId}"\n`);
 save(root,'features/docs/coverage/baseline.json',{cases:[]});save(root,'features/docs/coverage/bridge-cases.json',{});
 const ip='features/docs/coverage/fixtures/index.json',index=load(root,ip);save(root,ip,{[caseId]:index[caseId]});
 const rp='features/docs/coverage/registry.json',registry=load(root,rp);save(root,rp,{operations:{'docs_read.projection':{variants:{[r.semanticVariant]:registry.operations['docs_read.projection'].variants[r.semanticVariant]}}},exposed:[]});
 const mp='features/docs/coverage/obligations.json',m=load(root,mp);m.expansion.deliveryOverrides={[r.key]:m.expansion.deliveryOverrides[r.key]};save(root,mp,m);
 replace(root,'features/docs/coverage/execution-adapters.mjs','    compareC005(record,fixture,trace);','    // Parent-only control: child success is never semantic credit.');return root;
}
for(const v of variants)for(const outcome of outcomes)test(`C005 parent rejects actual ${v}/${outcome} fault after passing child`,{timeout:60000},()=>{
 const caseId=`C005.${v}__read.${outcome}`,root=isolated(caseId);try{
  if(outcome==='success'){
   const reader='core/docs-semantic/reader.mjs';
   if(v==='structured')replace(root,reader,'records.push({...record,...(!styles?','records.push({...record,children:[],...(!styles?');
   else if(v==='styleAnnotations')replace(root,reader,'...(styles?{style:n.style}:{})','...(styles?{style:{}}:{})');
   else if(v==='reviewAnnotations')replace(root,reader,'...(review?{review:n.review}:{})','...(review?{review:{}}:{})');
   else if(v==='omitImages')replace(root,reader,"losses.push({node:id,kind:'omittedImage'});continue;","continue;");
   else replace(root,reader,'text:n.text,extent:n.extent','text:n.text.replace(/A/g,"Z"),extent:n.extent');
  }else if(outcome==='invalid')replace(root,adapter,"else {try{result=decode({result:await w.invokeNative(a.name,a.args,owner.threadId)});}","else {try{result=a.expect==='schema'?null:decode({result:await w.invokeNative(a.name,a.args,owner.threadId)});}");
  else if(outcome==='wrongSubject')replace(root,adapter,'w.invokeNative(a.name,a.args,owner.threadId)',"w.invokeNative(a.name,a.args.account==='other@example.test'?{...a.args,snapshotId:'missing'}:a.args,owner.threadId)");
  else if(outcome==='preservation'){
   replace(root,adapter,'const plan=program(f);let step=plan.next();while(!step.done){const a=step.value;let result;','const plan=program(f);let step=plan.next(),gets=0;while(!step.done){const a=step.value;let result;');
   replace(root,adapter,"else if(a.op==='get')result=p.get(id,owner);","else if(a.op==='get'){if(++gets===2)w.store.semanticSnapshots.chargeReadWork(id,owner,'unexpected',1,0);result=p.get(id,owner);}");
  }else if(v==='omitImages')replace(root,adapter,'w.invokeNative(a.name,a.args,owner.threadId)',"w.invokeNative(a.name,a.name==='docs_read'&&!a.args.cursor?{...a.args,omitImages:false}:a.args,owner.threadId)");
  else replace(root,adapter,'w.invokeNative(a.name,a.args,owner.threadId)',"w.invokeNative(a.name,a.expect==='budget'?{...a.args,snapshotId:'missing'}:a.args,owner.threadId)");
  const r=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
  assert.equal(r.signal,null,'timeout is not semantic rejection');assert.notEqual(r.status,0);assert.match(r.stdout,/1 scenario \(1 passed\)/);assert.match(r.stderr,/C005/);assert.doesNotMatch(r.stdout,/"executedObligations":1/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
