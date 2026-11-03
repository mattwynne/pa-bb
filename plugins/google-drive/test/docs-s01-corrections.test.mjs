import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,cpSync,symlinkSync,readFileSync,writeFileSync,appendFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runR1Child} from './docs-r1-owned-child.mjs';
import {readJournal,MESSAGE_LIMITS} from '../features/docs/coverage/execution-journal.mjs';
import {decodeCurrentJournal} from '../features/docs/coverage/inventory-envelope.mjs';
import {sourceDigest,packageRoot,auditBaseline} from '../features/docs/coverage/runner.mjs';
import {assertProductIntake} from '../features/docs/coverage/product-intake.mjs';
import {digest,auditEvidence} from '../features/docs/coverage/audit.mjs';
import {auditControl,readManifest} from '../features/docs/coverage/control.mjs';
import {expand,exposureClosure,allClosures} from '../features/docs/coverage/expand.mjs';
import {breakStructure} from '../features/docs/coverage/structure-probes.mjs';
import {validateRequest} from '../features/docs/coverage/wire.mjs';
import {wireProbe} from '../features/docs/coverage/wire-probes.mjs';
import {DocsWorld} from '../features/docs/support/world.mjs';
import {assetBoundary} from '../features/docs/support/assets.mjs';
function isolated() {
  const root=mkdtempSync(join(tmpdir(),'docs-s01-intake-'));
  for(const name of readdirSync(packageRoot)) {
    if(name==='features' || /\.(ts|tsx|mjs|json|css)$/.test(name)) cpSync(join(packageRoot,name),join(root,name),{recursive:true});
    else symlinkSync(join(packageRoot,name),join(root,name));
  }
  return root;
}
test('R1 real runner rejects counterfeit delivery from JSON, including all true booleans', {timeout:120000},async()=>{
  // Shared elapsed budget includes setup; synchronous clone/hash/copy is not preemptible.
  const deadline=Date.now()+119000,root=isolated(),load=p=>JSON.parse(readFileSync(join(root,p))),save=(p,v)=>writeFileSync(join(root,p),JSON.stringify(v));
  const proof=mkdtempSync(join(process.env.DOCS_COST_PROOF_DIR??tmpdir(),'docs-r1-proof-'));
  console.log(`R1 test-owned provenance: ${proof}`);
  try {
    const caseId='C193.noRetry__local.success',key='C193/docs_operation_status.observe/noRetry__local/success';
    const carrierKey='C165/gdrive_get_file.metadata/fileMetadata__read/success';
    const m=load('features/docs/coverage/obligations.json');m.expansion.deliveryOverrides={[carrierKey]:m.expansion.deliveryOverrides[carrierKey],[key]:{status:'delivered'}};m.expansion.variantExposure={};save('features/docs/coverage/obligations.json',m);
    assert.equal(Object.keys(m.rows).length,211);assert.equal(expand(m).length,11197);assert.equal(allClosures(m,expand(m)).size,1036);
    assert.equal(m.expansion.deliveryOverrides[carrierKey].status,'delivered');assert.deepEqual(Object.keys(m.expansion.deliveryOverrides).sort(),[carrierKey,key].sort());
    const registry=load('features/docs/coverage/registry.json'),metadata=registry.operations['gdrive_get_file.metadata'].variants.fileMetadata__read;
    registry.operations={'gdrive_get_file.metadata':{variants:{fileMetadata__read:metadata}}};registry.exposed=[];registry.operations['docs_operation_status.observe']={variants:{noRetry__local:{driver:'docs_operation_status',schema:'K6.status-key-or-handle',requestedMode:'local',requests:['documents.get','files.get'],capability:'arbitrary-truthy-label'}}};save('features/docs/coverage/registry.json',registry);
    save('features/docs/coverage/bridge-cases.json',{});
    assert.equal(Object.keys(registry.operations).length,2);
    writeFileSync(join(root,'features/docs/contracts/r1-carrier.feature'),`@docs @bridgeExecution @C165 @F_ADJACENT @S_METADATA\nFeature: R1 genuine metadata journal carrier\n  Scenario: Actual metadata execution [C165.fileMetadata__read.success]\n    When the offline production bridge executes "C165.fileMetadata__read.success"\n`);
    writeFileSync(join(root,'cucumber.mjs'),`export default {};\nexport const docs=${JSON.stringify({paths:['features/docs/formatting.feature','features/docs/contracts/boundaries.feature','features/docs/contracts/r1-carrier.feature','features/docs/contracts/counterfeit.feature'],import:['features/docs/steps/formatting.steps.mjs','features/docs/contracts/steps/boundaries.steps.mjs','features/docs/steps/bridge-d.steps.mjs','features/docs/contracts/steps/counterfeit.steps.mjs'],format:['progress']})};\n`);
    const path='features/docs/coverage/fixtures/counterfeit.json',provenance={source:'synthetic negative test',authorship:'original test; no application ran'};
    writeFileSync(join(root,'features/docs/contracts/counterfeit.feature'),`@docs @F_EXEC @S_RECOVERY\nFeature: Counterfeit delivery\n  Scenario: JSON is not invocation [${caseId}]\n    When counterfeit JSON is attached\n`);
    for(const synthetic of [true,false]) {
      const vector={provenance,auditControlOnly:synthetic,before:{text:'never read'},after:{text:'never read'}};save(path,vector);
      const sha256=digest(readFileSync(join(root,path))),f=load('features/docs/coverage/fixtures/index.json');f[caseId]={caseId,path,sha256,provenance};save('features/docs/coverage/fixtures/index.json',f);
      writeFileSync(join(root,'features/docs/contracts/steps/counterfeit.steps.mjs'),`import {When} from '@cucumber/cucumber';\nWhen('counterfeit JSON is attached',async function(){await this.attach(JSON.stringify({key:${JSON.stringify(key)},caseId:${JSON.stringify(caseId)},fixtureId:${JSON.stringify(caseId)},fixtureDigest:${JSON.stringify(sha256)},driver:'docs_operation_status',schema:'K6.status-key-or-handle',kind:'control',requestedMode:'local',observedOutcome:'success',runId:process.env.DOCS_ACCEPTANCE_RUN_ID,sourceDigest:process.env.DOCS_ACCEPTANCE_SOURCE_DIGEST,applicationInvoked:${!synthetic},realSqlite:${!synthetic},closedHttp:${!synthetic}}),'application/vnd.pa.docs-evidence+json');});\n`);
      const sample=join(proof,String(synthetic));mkdirSync(sample);
      for(const p of ['cucumber.mjs','features/docs/coverage/obligations.json','features/docs/coverage/registry.json','features/docs/coverage/bridge-cases.json',path,'features/docs/coverage/fixtures/index.json','features/docs/contracts/counterfeit.feature','features/docs/contracts/r1-carrier.feature','features/docs/contracts/steps/counterfeit.steps.mjs']) {
        const dest=join(sample,p);mkdirSync(join(dest,'..'),{recursive:true});cpSync(join(root,p),dest);
      }
      const fingerprint=sourceDigest(root);
      let run;
      try {run=await runR1Child({cwd:root,deadline,confirmWindowsCompletion:actual=>{
        // Normal Windows root close alone is insufficient. Validate the known
        // runner's actual child/journal contract; never taskkill an exited PID.
        const artifact=actual.stdout.match(/Docs current-run evidence: ([^\r\n]+)/)?.[1];assert.ok(artifact);
        const meta=JSON.parse(readFileSync(join(artifact,'run.json'))),child=JSON.parse(readFileSync(join(artifact,'child.json')));
        assert.equal(meta.sourceDigest,fingerprint);assert.ok(child.pid>0&&child.pid!==actual.pid);assert.equal(child.status,0);assert.equal(child.signal,null);assert.equal(child.error,null);
        const rows=readJournal(join(artifact,'executions.ndjson'));
        const envelope=decodeCurrentJournal(rows,{inventory:rows[0].inventory,runId:meta.runId,sourceDigest:fingerprint,childPid:child.pid});
        assert.equal(envelope.receipts.length,1);assert.equal(envelope.receipts[0].key,carrierKey);
        return true;
      }});}
      catch(error){if(error.result)writeFileSync(join(sample,'lifecycle-failure.json'),JSON.stringify(error.result));throw error;}
      writeFileSync(join(sample,'runner.json'),JSON.stringify(run));
      assert.equal(run.cleanupEstablished,true);assert.equal(run.signal,null);
      const artifact=run.stdout.match(/Docs current-run evidence: ([^\r\n]+)/)?.[1];assert.ok(artifact,'real runner artifact required');
      const meta=JSON.parse(readFileSync(join(artifact,'run.json'))),child=JSON.parse(readFileSync(join(artifact,'child.json')));
      assert.equal(meta.timeout,300000);assert.equal(meta.sourceDigest,fingerprint);assert.ok(child.pid>0&&child.pid!==run.pid);assert.equal(child.status,0);assert.equal(child.signal,null);assert.equal(child.error,null);
      const messages=readJournal(join(artifact,'messages.ndjson'),MESSAGE_LIMITS);assert.deepEqual(auditBaseline(messages,meta.runId,fingerprint,root),{baseline:30,s01ApplicationCases:3});
      const rows=readJournal(join(artifact,'executions.ndjson')),envelope=decodeCurrentJournal(rows,{inventory:rows[0].inventory,runId:meta.runId,sourceDigest:fingerprint,childPid:child.pid});
      assert.equal(rows.filter(r=>r.kind==='inventoryContext').length,1);assert.equal(envelope.receipts.length,1);assert.equal(envelope.receipts[0].key,carrierKey);assert.equal(envelope.receipts[0].caseId,'C165.fileMetadata__read.success');
      const companions=JSON.parse(readFileSync(join(artifact,'companions.json')));assert.equal(companions.semanticNative,undefined);assert.equal(companions.draft,undefined);for(const k of ['native','discovery','metadata','selection','persistence'])assert.ok(companions[k].length>0,k);assert.ok(companions.witness);
      writeFileSync(join(sample,'artifact-provenance.json'),JSON.stringify({artifact,run:meta,child,runnerPid:run.pid,elapsedMs:run.elapsedMs,cleanupEstablished:run.cleanupEstablished,cleanup:run.cleanup,physicalRecords:envelope.physicalRecords,receiptKeys:envelope.receipts.map(r=>r.key),baseline:{baseline:30,s01ApplicationCases:3},declaredKeys:Object.keys(m.expansion.deliveryOverrides)},null,2));
      assert.notEqual(run.status,0);assert.match(run.stdout,/scenarios \(\d+ passed\)/,'counterfeit must reach successful real Cucumber execution');
      assert.match(run.stderr,synthetic?/auditControlOnly fixture forbidden/:/missing implemented semantic driver/);
      assert.doesNotMatch(run.stdout,/"executedObligations":1/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('R1 product registry and delivered overrides require code-owned implemented adapters in both directions',()=>{
  const m=readManifest(),input={manifest:m,registry:{operations:{},exposed:[]},results:[],fixtures:{},root:packageRoot};
  // Current E declarations cannot pass without their real execution. The
  // original S01 empty-inventory control then runs without inherited delivery.
  assert.throws(()=>assertProductIntake(input),/lacks implemented invocation/);
  m.expansion.deliveryOverrides={};
  assert.doesNotThrow(()=>assertProductIntake(input));
  assert.throws(()=>assertProductIntake({...input,registry:{operations:{phantom:{variants:{}}},exposed:[]}}),/no implemented semantic driver/);
  m.expansion.deliveryOverrides.phantom={status:'delivered'};assert.throws(()=>assertProductIntake(input),/lacks implemented/);
});
test('R1 fingerprint includes top-level schema, server, diagnostics, shared helpers and dependency lock',()=>{
  const root=isolated();try{
    for(const file of ['docs-format-tools.ts','server.ts','contract.ts','diagnostic.mjs','package-lock.json']){
      const before=sourceDigest(root);appendFileSync(join(root,file),'\n ');assert.notEqual(sourceDigest(root),before,file);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('R2 unresolved dependency cannot reduce valid 314-key closure to 311',()=>{
  const c=auditControl();try{
    assert.equal(c.cases.length,314);
    c.manifest.dependencyRules.crossOperationValidations[0].bases=['C034/setResetConflcit'];
    for(const r of c.cases.filter(r=>r.base==='setResetConflict'))delete c.manifest.expansion.deliveryOverrides[r.key];
    c.cases=c.cases.filter(r=>r.base!=='setResetConflict');assert.equal(c.cases.length,311);
    assert.throws(()=>auditEvidence(c),/unresolved cross-operation validation/);
  }finally{c.dispose();}
});
for(const probe of ['crossTypo','crossDeleted','crossEmpty','stagedTypo','stagedDeleted','fullListTypo','operationTypo','rowTypo','missingMode','unknownOutcome','unknownExclusion','overlap'])test(`R2 empty-exposure structure rejects ${probe}`,()=>{
  const m=readManifest();breakStructure(m,probe);assert.throws(()=>auditEvidence({manifest:m,registry:{operations:{},exposed:[]},cases:[],results:[],fixtures:{},root:packageRoot,runId:'none'}));
});
test('R2 approved expansion and dependency control are unchanged',()=>{
  const m=readManifest(),r=expand(m);assert.equal(r.length,11197);assert.equal(allClosures(m,r).size,1036);assert.equal(exposureClosure(m,r,'docs_plan_style.text/bold__direct').length,314);
});
for(const [name,valid]of [['namedBorderComplete',true],['namedBorderIncomplete',false],['weightedFontValid',true],['weightedFontEmpty',false],['dateEmptyLocation',false],['unknownClearAll',false],['clearAllNonempty',false],['setMaskMismatch',false]])test(`R3 ${name}`,()=>{
  const v=wireProbe(name);if(valid)assert.doesNotThrow(()=>validateRequest(v.request,v.effects));else assert.throws(()=>validateRequest(v.request,v.effects));
});
test('R3 declared effects cannot add unknown/duplicate/non-array or overlapping reset/clear masks',()=>{
  const v=wireProbe('namedStyleClear');
  for(const effects of [{clearAll:['textStyle','textStyle']},{clearAll:['textStyle'],set:['textStyle']},{clearAll:'textStyle'},{unknown:[]}])assert.throws(()=>validateRequest(v.request,effects));
});
test('R4 all installed boundaries checked; exact acknowledgement cannot hide later faults; cleanup always runs',async()=>{
  const w=new DocsWorld();await w.init();const db=w.host.bb.storage.database(),first=assetBoundary(),second=assetBoundary('httpsContract');
  w.asset=first;await assert.rejects(()=>first.assets.inspect('https://wrong.example.test/red.png'));
  first.acknowledge('unexpected DNS');
  await assert.rejects(()=>first.assets.inspect('https://wrong.example.test/red.png'));
  w.asset=second;await assert.rejects(()=>second.assets.inspect('https://art.example.test/red.png'));
  try {await assert.rejects(()=>w.close(),e=>e.message==='closed-network teardown failed'&&e.errors.length===2);assert.equal(db.open,false);}
  finally {first.acknowledge('unexpected DNS');second.acknowledge('HTTPS contract');await w.close();}
});
