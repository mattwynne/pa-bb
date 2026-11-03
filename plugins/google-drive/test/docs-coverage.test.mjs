import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, openSync, closeSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expand, exposureClosure, allClosures } from '../features/docs/coverage/expand.mjs';
import { readManifest, auditControl, corruptControl } from '../features/docs/coverage/control.mjs';
import { auditEvidence, cucumberResults, digest } from '../features/docs/coverage/audit.mjs';
import { packageRoot, sourceDigest, auditBaseline } from '../features/docs/coverage/runner.mjs';

test('total deterministic expansion retains all rows, modes and sibling outcomes without future files', () => {
  const m = readManifest(), r = expand(m);
  assert.equal(Object.keys(m.rows).length,211); assert.equal(r.length,11197);
  assert.equal(new Set(r.map(x => `${x.ledgerId}/${x.operation}/${x.base}`)).size,1190);
  assert.equal(new Set(r.map(x => `${x.ledgerId}/${x.operation}/${x.semanticVariant}`)).size,1579);
  assert.equal(allClosures(m,r).size,1036); assert.deepEqual(r,expand(m));
  // This S01 control is the all-planned inventory, not a claim that later
  // normal executions may be omitted from the current product manifest.
  m.expansion.deliveryOverrides={};
  const result = auditEvidence({manifest:m, registry:{operations:{},exposed:[]},cases:[],results:[],fixtures:{},root:packageRoot,runId:'no-execution'});
  assert.deepEqual(result,{plannedKeys:11197,executedObligations:0,enabledVariants:0});
  assert.ok(r.every(x => x.status === 'planned'));
  for (const x of r.filter(x => x.requestedMode === 'suggest')) assert.ok(parseInt(x.earliestSlice.slice(1),10) >= 10);
});
test('complete dependencies are not interchangeable with success; direct and suggest have independent closures', () => {
  const m=readManifest(),r=expand(m),d=exposureClosure(m,r,'docs_plan_style.text/bold__direct'),s=exposureClosure(m,r,'docs_plan_style.text/bold__suggest');
  assert.equal(d.length,314);
  for (const outcome of ['success','lostReply','finalAuthGate']) assert.ok(d.some(x => x.base === 'bold' && x.outcomeVariant === outcome));
  assert.ok(d.some(x => x.base === 'setResetConflict' && x.requestedMode === 'direct' && x.outcomeVariant === 'acceptedControl'));
  assert.ok(!d.some(x => x.requestedMode === 'suggest'));
  assert.ok(s.some(x => x.base === 'setResetConflict' && x.requestedMode === 'suggest'));
  assert.ok(s.some(x => x.ledgerId === 'C120'));
  assert.equal(exposureClosure(m,r,'docs_operation_status.observe/noRetry__local').length,14);
  assert.equal(exposureClosure(m,r,'docs_operation_status.legacy/formatPage__local').length,18);
  assert.equal(exposureClosure(m,r,'docs_review_example.show/fixedPayload__local').length,6);
});
test('dependency staging exceptions and Markdown integrations retain exact drivers', () => {
  const m=readManifest(),r=expand(m);
  const ordinary=exposureClosure(m,r,'docs_plan_content.insert/before__direct');
  assert.deepEqual([...new Set(ordinary.filter(x=>x.ledgerId==='C025').map(x=>x.base))].sort(),['blocks','inline','text']);
  const md=exposureClosure(m,r,'docs_plan_content.markdownRich/footnotes__suggest');
  assert.ok(md.some(x=>x.ledgerId==='C130')); assert.ok(md.some(x=>x.ledgerId==='C134'));
  assert.ok(r.filter(x=>x.ledgerId==='C131'&&x.kind==='product').every(x=>x.driver==='docs_plan_content'&&x.schema==='content.insert.markdown'));
  assert.ok(!exposureClosure(m,r,'docs_plan_file_write.markdown/frontmatter__route').some(x=>['C156','C158'].includes(x.ledgerId)));
  assert.ok(exposureClosure(m,r,'docs_plan_file_write.word/literal__route').some(x=>x.ledgerId==='C158'));
});
test('every individual key in the bold closure is mandatory (314 independent omission probes)', () => {
  const c=auditControl(); try {
    for (const victim of c.cases) {
      const cases=c.cases.filter(r=>r!==victim), manifest=structuredClone(c.manifest); delete manifest.expansion.deliveryOverrides[victim.key];
      assert.throws(()=>auditEvidence({...c,manifest,cases}),/missing evidence/);
    }
  } finally {c.dispose();}
});
test('guard controls cannot be swapped to suggest-refused; all explicit negatives reject', () => {
  for(const probe of ['successOnly','lostReply','finalAuthGate','validation','invariant','missingExample','missingFixture','unregistered','phantom','duplicate','wrongMode','wrongDriver','guardAsSuccess','missingMode','refusalN','stale','externalUnit','fixtureTamper','enabledPlanned']) {
    const c=auditControl(); try {corruptControl(c,probe);assert.throws(()=>auditEvidence(c),undefined,probe);}finally{c.dispose();}
  }
});
test('actual Cucumber messages: nonce, Examples rows, source/fixture identities and every executed step are required', {timeout:120000}, () => {
  const dir=mkdtempSync(join(tmpdir(),'docs-runner-contract-')),runId='runner-contract-'+Date.now(), fingerprint=sourceDigest();
  try {
    const output=join(dir,'messages.ndjson'),config=join(dir,'config.mjs');
    writeFileSync(config,`export default {};\nexport const docs=${JSON.stringify({paths:['features/docs/formatting.feature','features/docs/contracts/boundaries.feature'],import:['features/docs/steps/formatting.steps.mjs','features/docs/contracts/steps/boundaries.steps.mjs'],format:['progress']})};\n`);
    const fd=openSync(join(dir,'executions.ndjson'),'wx'),childStarted=Date.now();let p;
    try { p=spawnSync(process.execPath,['node_modules/@cucumber/cucumber/bin/cucumber.js','--config',relative(packageRoot,config),'--profile','docs','--format',`message:${output}`],{cwd:packageRoot,encoding:'utf8',timeout:120000,killSignal:'SIGKILL',maxBuffer:1024*1024,stdio:['pipe','pipe','pipe',fd],env:{...process.env,DOCS_ACCEPTANCE_RUN_ID:runId,DOCS_ACCEPTANCE_SOURCE_DIGEST:fingerprint,DOCS_EXECUTION_FD:'3'}}); }
    finally {closeSync(fd);}
    writeFileSync(join(dir,'child.json'),JSON.stringify({pid:p.pid,status:p.status,signal:p.signal,error:p.error?.code??null,elapsedMs:Date.now()-childStarted,runId,sourceDigest:fingerprint}));
    writeFileSync(join(dir,'stdout.log'),p.stdout??'');writeFileSync(join(dir,'stderr.log'),p.stderr??'');
    assert.ifError(p.error);assert.equal(p.signal,null);assert.equal(p.status,0,p.stdout+p.stderr);
    const messages=readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(auditBaseline(messages,runId,fingerprint),{baseline:30,s01ApplicationCases:3});
    const expectedIds=[
      ...['docs403','metadata403','storage','reject403','reject400','auth403','finalAuth403','lost'].map(f=>`S00.format.${f}`),
      ...['policy','account','subject','cancel','expiry'].map(f=>`S00.format.auth.${f}`),
      ...['policy','account','subject','cancel'].map(f=>`S00.replace.auth.${f}`),
      ...['policy','cancel','expiry'].map(f=>`S00.format.claim.${f}`),
      ...['cancel','expiry'].map(f=>`S00.format.policy.${f}`),'S00.format.intent.policy',
      ...['policy','cancel'].map(f=>`S00.replace.claim.${f}`),'S00.replace.policy.cancel',
      ...['format','replace'].flatMap(kind=>['off','on'].map(policy=>`S00.${kind}.consent.${policy}`)),
      'S01.format.appliedLost','S01.format.wirePreservation','S01.replace.wirePreservation'
    ];
    const actual=cucumberResults(messages,runId);assert.equal(expectedIds.length,33);assert.deepEqual(actual.map(r=>r.caseId).sort(),expectedIds.sort());
    assert.deepEqual([...new Set(messages.filter(m=>m.pickle).map(m=>m.pickle.uri))].sort(),['features/docs/contracts/boundaries.feature','features/docs/formatting.feature']);
    writeFileSync(join(dir,'baseline-identities.json'),JSON.stringify({runId,sourceDigest:fingerprint,childPid:p.pid,caseIds:expectedIds,pickles:messages.filter(m=>m.pickle).length,finished:messages.filter(m=>m.testCaseFinished).length}));
    assert.throws(()=>auditBaseline(messages,'other-run',fingerprint),/stale result/);
    assert.throws(()=>auditBaseline(messages,runId,'old-source'),/stale result source/);
    const mutated=structuredClone(messages), step=mutated.find(x=>x.testStepFinished);step.testStepFinished.testStepResult.status='SKIPPED';
    assert.throws(()=>cucumberResults(mutated,runId),/not passed/);
    assert.throws(()=>cucumberResults(messages.filter(x=>!x.testCaseFinished || x!==messages.find(y=>y.testCaseFinished)),runId),/missing current results/);
    const missingRow=structuredClone(messages),doc=missingRow.find(x=>x.gherkinDocument?.uri==='features/docs/formatting.feature');
    doc.gherkinDocument.feature.children.find(x=>x.scenario?.examples?.length).scenario.examples[0].tableBody.shift();
    assert.throws(()=>auditBaseline(missingRow,runId,fingerprint),/missing Examples/);
    const phantom=structuredClone(messages);phantom.find(x=>x.testCase).testCase.pickleId='phantom';
    assert.throws(()=>cucumberResults(phantom,runId),/phantom scenario/);
    assert.equal(sourceDigest(),fingerprint);
  } finally {
    if(process.env.DOCS_COST_PROOF_DIR) {
      const proof=mkdtempSync(join(process.env.DOCS_COST_PROOF_DIR,'docs-message-proof-'));cpSync(dir,proof,{recursive:true});console.log(`Direct message test-owned provenance: ${proof}`);
    }
    rmSync(dir,{recursive:true,force:true});
  }
});
