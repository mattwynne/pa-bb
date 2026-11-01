import test from 'node:test';
import {restoreHistoricalDCandidates} from './docs-semantic-isolation.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,cpSync,symlinkSync,readFileSync,writeFileSync,rmSync,existsSync,statSync,openSync,closeSync,ftruncateSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {packageRoot} from '../features/docs/coverage/runner.mjs';
import {digest} from '../features/docs/coverage/audit.mjs';
import {readJournal,publicationGuard,JOURNAL_LIMITS,childTimeout} from '../features/docs/coverage/execution-journal.mjs';
function isolated(){
 const root=mkdtempSync(join(tmpdir(),'docs-d-correction-'));
 for(const name of readdirSync(packageRoot))if(name==='features'||/\.(ts|tsx|mjs|json|css)$/.test(name))cpSync(join(packageRoot,name),join(root,name),{recursive:true});else symlinkSync(join(packageRoot,name),join(root,name));
 writeFileSync(join(root,'cucumber.mjs'),"export default {}; export const docs={paths:['features/docs/semantic-bridge-d.feature'],import:['features/docs/steps/bridge-d.steps.mjs'],format:['progress']};\n");
 writeFileSync(join(root,'features/docs/coverage/baseline.json'),'{"cases":[]}');writeFileSync(join(root,'features/docs/coverage/fixtures/index.json'),'{}');
 // D mutation tests intentionally execute only their original 12 candidates.
 writeFileSync(join(root,'features/docs/coverage/registry.json'),'{"operations":{},"exposed":[]}');
 const path=join(root,'features/docs/coverage/obligations.json'),manifest=JSON.parse(readFileSync(path));
 manifest.expansion.deliveryOverrides={};writeFileSync(path,JSON.stringify(manifest));restoreHistoricalDCandidates(root);return root;
}
function replace(root,path,from,to){const p=join(root,path),s=readFileSync(p,'utf8');assert.equal(s.split(from).length,2,from);writeFileSync(p,s.replace(from,to));}
const adapters='features/docs/coverage/execution-adapters.mjs',bridge='features/docs/coverage/bridge.mjs';
const publication="writeSync(3,JSON.stringify(receipt)+'\\n');";
function fixture(root,id,mutate){const p=join(root,'features/docs/coverage/bridge-cases.json'),index=JSON.parse(readFileSync(p)),entry=index[id],f=JSON.parse(readFileSync(join(root,entry.path)));mutate(f);const bytes=JSON.stringify(f,null,2)+'\n';writeFileSync(join(root,entry.path),bytes);entry.sha256=digest(bytes);writeFileSync(p,JSON.stringify(index,null,2)+'\n');}
function skipComparison(root){replace(root,adapters,'    compareExecution(record,fixture,trace);','    // Fault injection: independent parent comparison still required.');}
function run(change,env={}){
 const root=isolated();try{change?.(root);const r=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,...env}});return {...r,dir:r.stdout?.match(/Docs current-run evidence: (.+)/)?.[1]};}finally{rmSync(root,{recursive:true,force:true});}
}
const mutations=[
 ['nested before regex',r=>replace(r,'docs-semantic-schemas.mjs','before:headingSchema.optional()','before:z.object({...heading,regex:z.string().optional()}).strict().refine(oneHeading).optional()'),/independent recursive schema contract/],
 ['nested span passthrough',r=>replace(r,'docs-semantic-schemas.mjs','export const semanticSelectorSchema=z.union([\n  z.object({node:id}).strict(),z.object({span:z.object({from:id,to:id}).strict()}).strict(),','export const semanticSelectorSchema=z.union([\n  z.object({node:id}).strict(),z.object({span:z.object({from:id,to:id}).passthrough()}).strict(),'),/independent recursive schema contract/],
 ['metadata extra property',r=>replace(r,'server.ts','gdrive_get_file: z.object({ account, fileId: required })','gdrive_get_file: z.object({ account, fileId: required, futureField: z.string().optional() })'),/independent recursive schema contract/],
 ['annotation-named metadata property',r=>replace(r,'server.ts','gdrive_get_file: z.object({ account, fileId: required })','gdrive_get_file: z.object({ account, fileId: required, description: z.string().optional() })'),/independent recursive schema contract/],
 ['annotation-named nested property',r=>replace(r,'docs-semantic-schemas.mjs','before:headingSchema.optional()','before:z.object({...heading,description:z.string().optional()}).strict().refine(oneHeading).optional()'),/independent recursive schema contract/],
 ['nested array item type',r=>replace(r,'docs-semantic-schemas.mjs','z.object({ids:z.array(id).min(1).max(100)}).strict()','z.object({ids:z.array(z.number()).min(1).max(100)}).strict()'),/independent recursive schema contract/],
 ['nested requiredness',r=>replace(r,'docs-semantic-schemas.mjs','before:headingSchema.optional()','before:headingSchema'),/independent recursive schema contract/],
 ['nested numeric bound',r=>replace(r,'docs-semantic-schemas.mjs','level:z.number().int().min(1).max(6).optional()','level:z.number().int().min(1).max(7).optional()'),/independent recursive schema contract/],
 ['metadata passthrough policy',r=>replace(r,'server.ts','gdrive_get_file: z.object({ account, fileId: required })','gdrive_get_file: z.object({ account, fileId: required }).passthrough()'),/independent recursive schema contract/],
 ['metadata strict policy',r=>replace(r,'server.ts','gdrive_get_file: z.object({ account, fileId: required })','gdrive_get_file: z.object({ account, fileId: required }).strict()'),/independent recursive schema contract/],
 ['heading refinement absent',r=>replace(r,'docs-semantic-schemas.mjs',".refine(oneHeading,'Choose headingId, exact text or path');\nconst sectionSchema",';\nconst sectionSchema'),/heading refinement must reject/],
 ['section refinement absent',r=>replace(r,'docs-semantic-schemas.mjs',"before:headingSchema.optional()}).strict().refine(oneHeading,'Choose headingId, exact text or path')","before:headingSchema.optional()}).strict()"),/heading refinement must reject/],
 ['selector decision omitted',r=>replace(r,adapters,'output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);','output=structuredClone(fixture.expected.output);'),/exact actual local invocation count/],
 ['witness decision omitted',r=>replace(r,adapters,"output=evaluateWitness(snapshot,fp,{deliveries:record.outcomeVariant==='counterexample'?[]:deliveries});",'output=structuredClone(fixture.expected.output);'),/exact actual local invocation count/],
 ['store decision omitted',r=>replace(r,adapters,"try {const read=w.local.getSnapshot(setup.snapshotId,actualOwner,0);output={snapshotId:read.binding.snapshotId};}","try {output=structuredClone(fixture.expected.output);}"),/exact actual local invocation count/],
 ['wrong local function',r=>replace(r,adapters,'output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);',"w.local.getSnapshot(setup.snapshotId,owner,0);output=structuredClone(fixture.expected.output);"),/actual local function/],
 ['duplicate local decision',r=>replace(r,adapters,'output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);','resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);'),/exact actual local invocation count/],
 ['counterexample replaced by success',r=>{replace(r,adapters,'output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);',"output=resolveSelector(snapshot,fixture.args.scope,{text:{literal:'Bridge',cardinality:{exactly:1}}});output=structuredClone(fixture.expected.output);");skipComparison(r);},/actual local immutable arguments|actual local return binding/,true],
 ['store counterexample error hidden',r=>{replace(r,adapters,"catch(error){output={category:error.semanticCode};}","catch(error){output={category:'other'};}");skipComparison(r);},/actual store typed error/,true],
 ['local model binding replaced',r=>{replace(r,adapters,'output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);',"output=resolveSelector({...snapshot,revision:{...snapshot.revision,id:'other-revision'}},fixture.args.scope,fixture.args.selector);");skipComparison(r);},/actual local model binding/,true],
 ['local return corrupted after capture',r=>{replace(r,adapters,'output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);',"output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);output={...output,count:99};");skipComparison(r);},/actual local return binding/,true],
 ['local invocation reused across records',r=>{replace(r,bridge,'let inventory;','let inventory,firstLocalId;');replace(r,bridge,publication,"if(receipt.trace.localCalls.length){firstLocalId??=receipt.trace.localCalls[0].id;receipt.trace.localCalls=receipt.trace.localCalls.map(c=>({...c,id:firstLocalId}));}\n  "+publication);},/reused actual local invocation/,true],
 ['wrongSubject substituted with old wrong-thread fixture',r=>{
   fixture(r,'C005.text__read.wrongSubject',f=>{f.args.account='reader@example.test';f.threadId='other-thread';f.calls[1].args.account='reader@example.test';f.calls[1].threadId='other-thread';f.http.at(-1).response='identity';});skipComparison(r);
 },/wrongSubject must preserve thread/,true],
 ['wrongSubject same-principal missing-snapshot error',r=>{
   fixture(r,'C005.text__read.wrongSubject',f=>{f.args.account='reader@example.test';f.args.snapshotId='missing-snapshot';f.calls[1].args.account='reader@example.test';f.calls[1].args.snapshotId='missing-snapshot';f.http.at(-1).response='identity';});skipComparison(r);
 },/actual second verified principal/,true],
 ['wrongSubject generic schema failure',r=>{fixture(r,'C005.text__read.wrongSubject',f=>{f.args.snapshotId='';f.calls[1].args.snapshotId='';f.http.pop();f.expected.output=null;});skipComparison(r);},/wrong subject must fail actual access boundary/,true],
 ['oversized actual journal record',r=>replace(r,bridge,publication,"if(caseId==='C001.nativeDoc__read.success')writeSync(3,' '.repeat(4*1024*1024+1));\n  "+publication),/execution journal record byte limit/,true],
 ['oversized sparse aggregate journal',r=>replace(r,bridge,publication,publication+"\n  if(caseId==='C165.fileMetadata__read.success'){const fs=await import('node:fs');fs.ftruncateSync(3,64*1024*1024+1);}"),/execution journal aggregate byte limit/,true],
 ['too many actual journal records',r=>replace(r,bridge,publication,"if(caseId==='C001.nativeDoc__read.success')writeSync(3,'{}\\n'.repeat(1025));\n  "+publication),/execution journal record count limit/,true],
 ['partial actual journal',r=>replace(r,bridge,publication,"writeSync(3,JSON.stringify(receipt).slice(0,-1)+'\\n');"),/SyntaxError/,true],
 ['error after publication',r=>replace(r,bridge,publication,publication+"throw new Error('fault after publication');"),/Cucumber failed; no coverage credit/],
];
for(const [name,change,reason,childPass=false] of mutations)test('D correction actual runner refuses '+name,{timeout:40000},()=>{
 const r=run(change);assert.equal(r.signal,null,'outer safety timeout is not a passing rejection');assert.notEqual(r.status,0,r.stdout);assert.match(r.stdout+'\n'+r.stderr,reason);
 if(childPass)assert.match(r.stdout,/12 scenarios \(12 passed\)/);
 assert.doesNotMatch(r.stdout,/"bridgeCandidates":12/);assert.ok(r.dir&&existsSync(join(r.dir,'run.json')),'failed run artifacts retained');
});
test('D correction timeout after publication retains partial journal, never credit',{timeout:30000},()=>{
 const r=run(root=>replace(root,bridge,publication,publication+"await new Promise(resolve=>setTimeout(resolve,20000));"),{DOCS_ACCEPTANCE_TIMEOUT_MS:'8000'});
 assert.equal(r.signal,null);assert.notEqual(r.status,0);assert.match(r.stderr,/Cucumber timed out; no coverage credit/);assert.doesNotMatch(r.stdout,/"bridgeCandidates":12/);
 assert.equal(JSON.parse(readFileSync(join(r.dir,'child.json'))).error,'ETIMEDOUT');assert.ok(statSync(join(r.dir,'executions.ndjson')).size>0,'must timeout after actual publication');assert.ok(!existsSync(join(r.dir,'summary.json')));
});
test('D correction ordinary positive: exact subject, immutable local observations, no credential sentinels',{timeout:40000},()=>{
 const r=run();assert.equal(r.status,0,r.stderr);const receipts=readJournal(join(r.dir,'executions.ndjson'));
 const t=receipts.find(r=>r.caseId==='C005.text__read.wrongSubject').trace;
 assert.equal(t.calls[0].threadId,t.calls[1].threadId);assert.notEqual(t.authentication.at(-1).subject,t.snapshot.binding.subject);assert.equal(t.snapshotAccess[0].owner.subject,'subject-other');assert.equal(t.snapshotAccess[0].category,'snapshot');
 const local=receipts.flatMap(r=>r.trace.localCalls);assert.equal(local.length,6);assert.equal(new Set(local.map(c=>c.id)).size,6);
 const storeError=local.find(c=>c.operation==='semanticSnapshots.get'&&c.error);assert.deepEqual(storeError.error,{category:'snapshot'});
 assert.doesNotMatch(readFileSync(join(r.dir,'executions.ndjson'),'utf8'),/PRIVATE_/);
 const s=JSON.parse(readFileSync(join(r.dir,'summary.json')));assert.equal(s.bridgeCandidates,12);assert.equal(s.executedObligations,0);assert.equal(s.enabledVariants,0);
});
test('D journal limits accept 367 records; exact boundaries and positive timeout configuration',()=>{
 const root=mkdtempSync(join(tmpdir(),'journal-boundary-')),p=join(root,'journal');try{
  const bytes='{"n":1}\n';const limits={recordBytes:Buffer.byteLength(bytes),totalBytes:Buffer.byteLength(bytes)*367,records:367};
  const publish=publicationGuard(limits);for(let i=0;i<367;i++)publish({n:1});assert.throws(()=>publish({n:1}),/aggregate|count/);
  writeFileSync(p,bytes.repeat(367));assert.equal(readJournal(p,limits).length,367);assert.ok(JOURNAL_LIMITS.records>=367);
  assert.throws(()=>readJournal(p,{...limits,records:366}),/count/);assert.throws(()=>readJournal(p,{...limits,recordBytes:limits.recordBytes-1}),/record byte/);
  writeFileSync(p,'{}');assert.throws(()=>readJournal(p),/truncated/);
  writeFileSync(p,Buffer.from([0xff,10]));assert.throws(()=>readJournal(p),/encoded data/);
  const fd=openSync(p,'w');try{ftruncateSync(fd,JOURNAL_LIMITS.totalBytes+1);}finally{closeSync(fd);}assert.throws(()=>readJournal(p),/aggregate/);
  assert.equal(childTimeout({}),300000);assert.equal(childTimeout({DOCS_ACCEPTANCE_TIMEOUT_MS:'600000'}),600000);
  for(const value of ['0','-1','1.5','NaN','600001','Infinity'])assert.throws(()=>childTimeout({DOCS_ACCEPTANCE_TIMEOUT_MS:value}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
