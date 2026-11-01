// Actual Cucumber CHILD + normal runner intake in disposable source trees.
// No reviewer helpers, checkout writes, provider network or production storage.
import test from 'node:test';
import {restoreHistoricalDCandidates} from './docs-semantic-isolation.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync,readdirSync,cpSync,symlinkSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../features/docs/coverage/runner.mjs';
import { digest } from '../features/docs/coverage/audit.mjs';
import { expand } from '../features/docs/coverage/expand.mjs';
function isolated() {
  const root=mkdtempSync(join(tmpdir(),'docs-d-negative-'));
  for(const name of readdirSync(packageRoot)){
    if(name==='features'||/\.(ts|tsx|mjs|json|css)$/.test(name))cpSync(join(packageRoot,name),join(root,name),{recursive:true});
    else symlinkSync(join(packageRoot,name),join(root,name));
  }
  // Explicit isolated candidate inventory; normal full-run discovery remains
  // untouched. No baseline result is claimed by these short negative runs.
  writeFileSync(join(root,'cucumber.mjs'),"export default {}; export const docs={paths:['features/docs/semantic-bridge-d.feature'],import:['features/docs/steps/bridge-d.steps.mjs'],format:['progress']};\n");
  writeFileSync(join(root,'features/docs/coverage/baseline.json'),'{"cases":[]}');
  writeFileSync(join(root,'features/docs/coverage/fixtures/index.json'),'{}');
  // Preserve D's original bounded 12-candidate contract, without unrelated E
  // normal fixtures/registrations masking the deliberately injected failure.
  writeFileSync(join(root,'features/docs/coverage/registry.json'),'{"operations":{},"exposed":[]}');
  const path=join(root,'features/docs/coverage/obligations.json'),manifest=JSON.parse(readFileSync(path));
  manifest.expansion.deliveryOverrides={};writeFileSync(path,JSON.stringify(manifest));
  restoreHistoricalDCandidates(root);
  return root;
}
const load=(root,path)=>JSON.parse(readFileSync(join(root,path)));
const save=(root,path,data)=>writeFileSync(join(root,path),JSON.stringify(data,null,2)+'\n');
function replace(root,path,oldText,newText){const text=readFileSync(join(root,path),'utf8');assert.ok(text.includes(oldText));writeFileSync(join(root,path),text.replace(oldText,newText));}
function fixture(root,id,change){const path='features/docs/coverage/bridge-cases.json',index=load(root,path),entry=index[id],f=load(root,entry.path);change(f);save(root,entry.path,f);entry.sha256=digest(readFileSync(join(root,entry.path)));save(root,path,index);}
function skipChildComparison(root){replace(root,'features/docs/coverage/execution-adapters.mjs','    compareExecution(record,fixture,trace);','    // Fault injection: parent must independently compare.');}
function corruptRecord(root,code) {
  replace(root,'features/docs/coverage/bridge.mjs',"writeSync(3,JSON.stringify(receipt)+'\\n');",`${code}\n  writeSync(3,JSON.stringify(receipt)+'\\n');`);
}
const probes=[
  ['attachment-only all true',root=>replace(root,'features/docs/steps/bridge-d.steps.mjs',"const reference=await executeBridgeCase(root,pickle,testCaseStartedId,caseId);",`const {readFileSync}=await import('node:fs');const {expand}=await import('../coverage/expand.mjs');
    const r=expand(JSON.parse(readFileSync(root+'/features/docs/coverage/obligations.json'))).find(r=>r.caseId===caseId);
    const f=JSON.parse(readFileSync(root+'/features/docs/coverage/bridge-cases.json'))[caseId];
    const reference={...r,observedOutcome:r.outcomeVariant,fixtureId:caseId,fixtureDigest:f.sha256,runId:process.env.DOCS_ACCEPTANCE_RUN_ID,sourceDigest:process.env.DOCS_ACCEPTANCE_SOURCE_DIGEST,applicationInvoked:true,realSqlite:true,closedHttp:true,passed:true};`),/missing actual adapter invocation record/],
  ['registry without adapter',root=>save(root,'features/docs/coverage/registry.json',{operations:{phantom:{variants:{phantom:{}}}},exposed:[]}),/no implemented semantic driver/],
  ['registry only implemented route',root=>save(root,'features/docs/coverage/registry.json',{operations:{'docs_read.projection':{variants:{structured__read:{driver:'docs_read',schema:'read.scope-format-view',requestedMode:'read'}}}},exposed:[]}),/missing implemented semantic driver/],
  ['driver without actual invocation',root=>corruptRecord(root,"receipt.trace.calls[0].invocation=null;"),/missing actual invocation/],
  ['wrong observed method',root=>corruptRecord(root,"receipt.trace.http[0].method='POST';"),/actual HTTP sequence/],
  ['wrong observed view',root=>corruptRecord(root,"if(receipt.trace.snapshot)receipt.trace.snapshot.binding={...receipt.trace.snapshot.binding,view:'acceptedPreview'};"),/verified owner\/view\/provenance/],
  ['wrong observed owner',root=>corruptRecord(root,"if(receipt.trace.snapshot)receipt.trace.snapshot.binding={...receipt.trace.snapshot.binding,subject:'other'};"),/verified owner\/view\/provenance/],
  ['wrong observed read ID',root=>corruptRecord(root,"if(receipt.trace.deliveries.length)receipt.trace.deliveries[0].readId='other';"),/actual persisted read state/],
  ['wrong fixture binding',root=>corruptRecord(root,"receipt.fixtureId='other';"),/execution fixtureId binding/],
  ['wrong driver binding',root=>corruptRecord(root,"receipt.driver='docs_operation_status';"),/execution driver binding/],
  ['wrong mode binding',root=>corruptRecord(root,"receipt.requestedMode='direct';"),/execution requestedMode binding/],
  ['wrong schema binding',root=>corruptRecord(root,"receipt.schema='phantom';"),/execution schema binding/],
  ['local control substitution',root=>corruptRecord(root,"if(receipt.trace.internal)receipt.trace.internal.function='auditControl';"),/local control substitution/],
  ['duplicate execution reuse',root=>corruptRecord(root,"writeSync(3,JSON.stringify(receipt)+'\\n');"),/orphan\/interrupted\/replayed execution record/],
  ['stale nonce',root=>corruptRecord(root,"receipt.runId='old-run';"),/execution runId binding/],
  ['stale source',root=>corruptRecord(root,"receipt.sourceDigest='old-source';"),/execution sourceDigest binding/],
  ['wrong Examples instance',root=>corruptRecord(root,"receipt.testCaseStartedId='old-instance';"),/execution instance/],
  ['wrong AST identity',root=>corruptRecord(root,"receipt.astNodeIds=['invented'];"),/execution AST\/Examples/],
  ['missing record',root=>replace(root,'features/docs/coverage/bridge.mjs',"writeSync(3,JSON.stringify(receipt)+'\\n');",'// interrupted before publish'),/missing actual adapter invocation record/],
  ['inventory extra variant',root=>corruptRecord(root,"receipt.inventory.bindings['docs_read.projection/markdown__read']={};"),/actual inventory drift/],
  ['inventory missing adapter',root=>corruptRecord(root,"delete receipt.inventory.bindings['coverage.witness/broadDelivered__local'];"),/actual inventory drift/],
  ['structured read mislabeled text after passing child',root=>{
    fixture(root,'C005.text__read.success',f=>{f.args.format='structured';f.calls[1].args.format='structured';});skipChildComparison(root);
  },/actual text discriminator/],
  ['single run mislabeled cross-run after passing child',root=>{
    fixture(root,'C012.crossRun__read.success',f=>{f.provider.document.tabs[0].documentTab.body.content[0].paragraph.elements=[{startIndex:1,endIndex:8,textRun:{content:'Bridge\\n'}}];});skipChildComparison(root);
  },/actual cross-run discriminator/],
  ['all cardinality mislabeled exactly-one after passing child',root=>{
    fixture(root,'C015.exactlyOne__local.success',f=>{f.args.selector.text.cardinality={all:1};});skipChildComparison(root);
  },/actual exactly-one discriminator/],
  ['narrow delivery mislabeled broad after passing child',root=>{
    fixture(root,'C021.broadDelivered__local.success',f=>{f.args.selector={node:'snap-d:3'};f.calls[1].args.selector={node:'snap-d:3'};});skipChildComparison(root);
  },/actual broad-delivery discriminator/],
  ['phantom manifest schema',root=>{const path='features/docs/coverage/obligations.json',m=load(root,path);m.bindingCatalog.prefixBindings['docs_read.'].schema='phantom';save(root,path,m);},/adapter schema/,false],
  ['unavailable actual variant',root=>{
    const old='C005.text__read.success',id='C005.markdown__read.success',path='features/docs/coverage/bridge-cases.json',index=load(root,path),entry=index[old];
    delete index[old];index[id]={...entry,caseId:id};const f=load(root,entry.path);f.caseId=id;save(root,entry.path,f);index[id].sha256=digest(readFileSync(join(root,entry.path)));save(root,path,index);
    replace(root,'features/docs/semantic-bridge-d.feature',old,id);
  },/missing implemented semantic driver/,false],
  ['ordinary success mislabeled bounds',root=>{
    const old='C005.text__read.success',id='C005.text__read.bounds',path='features/docs/coverage/bridge-cases.json',index=load(root,path),entry=index[old];
    delete index[old];index[id]={...entry,caseId:id};const f=load(root,entry.path);f.caseId=id;save(root,entry.path,f);index[id].sha256=digest(readFileSync(join(root,entry.path)));save(root,path,index);
    replace(root,'features/docs/semantic-bridge-d.feature',old,id);
  },/unimplemented adapter outcome discriminator/,false],
  ['same reference across different cases',root=>{
    replace(root,'features/docs/coverage/bridge.mjs','let inventory;','let inventory,firstRef;');
    corruptRecord(root,'firstRef??=receipt.ref;receipt.ref=firstRef;');
    replace(root,'features/docs/coverage/bridge.mjs','return {ref,runId','return {ref:receipt.ref,runId');
  },/duplicate execution reuse/],
  ['source schema grows a well-typed later selector',root=>replace(root,'docs-semantic-schemas.mjs',"export const semanticSelectorSchema=z.union([","export const semanticSelectorSchema=z.union([z.object({table:z.string()}).strict(),"),/unjoined selector discriminator/,false],
  ['source schema grows regex query',root=>replace(root,'docs-semantic-schemas.mjs',"const text={literal:","const text={regex:z.string().optional(),literal:"),/deep-equal/,false],
  ['source schema grows an unavailable format',root=>replace(root,'docs-semantic-schemas.mjs',"z.enum(['text','structured'])","z.enum(['text','structured','markdown'])"),/unavailable read format/,false],
  ['fixture mismatch despite passing child and attachment',root=>{
    fixture(root,'C005.text__read.success',f=>{f.expected.records[0].text='Counterfeit';});
    replace(root,'features/docs/coverage/execution-adapters.mjs','    compareExecution(record,fixture,trace);','    // Simulated missing child comparator: parent must independently refuse.');
  },/independent text output/],
  ['caught ambient fetch',root=>replace(root,'features/docs/coverage/execution-adapters.mjs','    compareExecution(record,fixture,trace);',"    try{await fetch('https://example.invalid/');}catch{}\n    compareExecution(record,fixture,trace);"),/unacknowledged ambient network fault/,false],
  ['caught ambient DNS',root=>replace(root,'features/docs/coverage/execution-adapters.mjs','    compareExecution(record,fixture,trace);',"    const dns=await import('node:dns');try{dns.lookup('example.invalid',()=>{});}catch{}\n    compareExecution(record,fixture,trace);"),/unacknowledged ambient network fault/,false],
  ['caught ambient HTTPS',root=>replace(root,'features/docs/coverage/execution-adapters.mjs','    compareExecution(record,fixture,trace);',"    const https=await import('node:https');try{https.request('https://example.invalid/');}catch{}\n    compareExecution(record,fixture,trace);"),/unacknowledged ambient network fault/,false],
  ['actual fixture mismatch',root=>fixture(root,'C005.text__read.success',f=>{f.expected.records[0].text='Counterfeit';}),/independent text output/,false],
  ['actual method mismatch',root=>fixture(root,'C001.nativeDoc__read.success',f=>{f.http[0].method='POST';}),/unacknowledged transport journal fault/,false],
  ['actual provider view mismatch',root=>fixture(root,'C001.nativeDoc__read.success',f=>{f.provider.document.suggestionsViewMode='PREVIEW_SUGGESTIONS_ACCEPTED';}),/actual persisted snapshot required/,false],
  ['actual provider owner mismatch',root=>fixture(root,'C001.nativeDoc__read.success',f=>{f.provider.identity.sub='other';f.http=f.http.slice(0,1);}),/actual persisted snapshot required/,false],
];
for(const [name,change,reason,cucumberPass=true] of probes)test(`D real runner refuses ${name}`,{timeout:120000},()=>{
  const root=isolated();try{
    change(root);
    const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8'});
    assert.notEqual(run.status,0,run.stdout);assert.match(run.stdout+'\n'+run.stderr,reason);
    if(cucumberPass)assert.match(run.stdout,/12 scenarios \(12 passed\)/,'must reach real successful Cucumber child before intake refusal');
    assert.doesNotMatch(run.stdout,/"bridgeCandidates":12/,'negative cannot grant candidate credit');
  }finally{rmSync(root,{recursive:true,force:true});}
});

for(const candidate of [true,false])test(`D actual child rejects ${candidate?'registry-only':'result-only'} join`,{timeout:120000},()=>{
  const root=isolated();try{
    const id='C001.nativeDoc__read.success',entry=load(root,'features/docs/coverage/bridge-cases.json')[id];
    const record=expand(load(root,'features/docs/coverage/obligations.json')).find(r=>r.caseId===id);
    save(root,'features/docs/coverage/bridge-cases.json',candidate?{[id]:entry}:{});
    save(root,'features/docs/coverage/fixtures/index.json',candidate?{}:{[id]:entry});
    writeFileSync(join(root,'features/docs/semantic-bridge-d.feature'),`@docs ${candidate?'@bridgeCandidate':'@bridgeExecution'} @${record.featureId} @${record.scenarioId}\nFeature: Isolated exact join\n Scenario: Native execution [${id}]\n  When the offline production bridge executes "${id}"\n`);
    if(candidate)save(root,'features/docs/coverage/registry.json',{operations:{'gdrive_get_file.metadata':{variants:{fileMetadata__read:{driver:'gdrive_get_file',schema:'drive-file.metadata',requestedMode:'read'}}}},exposed:[]});
    const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8'});
    assert.notEqual(run.status,0);assert.match(run.stdout,/1 scenario \(1 passed\)/);assert.match(run.stderr,candidate?/registry-only without actual execution/:/result-only without registry/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('D isolated positive uses the same real runner and remains planned',{timeout:120000},()=>{
  const root=isolated();try{
    const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);const summary=JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.equal(summary.bridgeCandidates,12);assert.equal(summary.executedObligations,0);assert.equal(summary.enabledVariants,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
