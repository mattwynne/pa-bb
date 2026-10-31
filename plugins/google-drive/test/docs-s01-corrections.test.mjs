import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,cpSync,symlinkSync,readFileSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {sourceDigest,packageRoot} from '../features/docs/coverage/runner.mjs';
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
test('R1 real runner rejects counterfeit delivery from JSON, including all true booleans', {timeout:120000},()=>{
  const root=isolated(),load=p=>JSON.parse(readFileSync(join(root,p))),save=(p,v)=>writeFileSync(join(root,p),JSON.stringify(v));
  try {
    const caseId='C193.noRetry__local.success',key='C193/docs_operation_status.observe/noRetry__local/success';
    const m=load('features/docs/coverage/obligations.json');m.expansion.deliveryOverrides[key]={status:'delivered'};save('features/docs/coverage/obligations.json',m);
    const registry=load('features/docs/coverage/registry.json');registry.operations['docs_operation_status.observe']={variants:{noRetry__local:{driver:'docs_operation_status',schema:'K6.status-key-or-handle',requestedMode:'local',requests:['documents.get','files.get'],capability:'arbitrary-truthy-label'}}};save('features/docs/coverage/registry.json',registry);
    const path='features/docs/coverage/fixtures/counterfeit.json',provenance={source:'synthetic negative test',authorship:'original test; no application ran'};
    writeFileSync(join(root,'features/docs/contracts/counterfeit.feature'),`@docs @F_EXEC @S_RECOVERY\nFeature: Counterfeit delivery\n  Scenario: JSON is not invocation [${caseId}]\n    When counterfeit JSON is attached\n`);
    for(const synthetic of [true,false]) {
      const vector={provenance,auditControlOnly:synthetic,before:{text:'never read'},after:{text:'never read'}};save(path,vector);
      const sha256=digest(readFileSync(join(root,path))),f=load('features/docs/coverage/fixtures/index.json');f[caseId]={caseId,path,sha256,provenance};save('features/docs/coverage/fixtures/index.json',f);
      writeFileSync(join(root,'features/docs/contracts/steps/counterfeit.steps.mjs'),`import {When} from '@cucumber/cucumber';\nWhen('counterfeit JSON is attached',async function(){await this.attach(JSON.stringify({key:${JSON.stringify(key)},caseId:${JSON.stringify(caseId)},fixtureId:${JSON.stringify(caseId)},fixtureDigest:${JSON.stringify(sha256)},driver:'docs_operation_status',schema:'K6.status-key-or-handle',kind:'control',requestedMode:'local',observedOutcome:'success',runId:process.env.DOCS_ACCEPTANCE_RUN_ID,sourceDigest:process.env.DOCS_ACCEPTANCE_SOURCE_DIGEST,applicationInvoked:${!synthetic},realSqlite:${!synthetic},closedHttp:${!synthetic}}),'application/vnd.pa.docs-evidence+json');});\n`);
      const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8'});
      assert.notEqual(run.status,0);assert.match(run.stdout,/scenarios \(\d+ passed\)/,'counterfeit must reach successful real Cucumber execution');
      assert.match(run.stderr,synthetic?/auditControlOnly fixture forbidden/:/missing implemented semantic driver/);
      assert.doesNotMatch(run.stdout,/"executedObligations":1/);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('R1 product registry and delivered overrides require code-owned implemented adapters in both directions',()=>{
  const m=readManifest(),input={manifest:m,registry:{operations:{},exposed:[]},results:[],fixtures:{},root:packageRoot};
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
