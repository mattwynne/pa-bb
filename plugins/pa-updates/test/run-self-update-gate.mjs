// Original updater handlers/adapters with real native own replacement and BB
// launcher restart. Run only inside an owned disposable Linux container.
// node test/run-self-update-gate.mjs /path/to/bb-app /path/to/updater-source.tar
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
const host = await createGateHost(process.argv[2], { nativeRuntime: true });
const { root, command, cli, request, npm } = host, archive = resolve(process.argv[3]);
const source = join(host.repo, 'plugins', 'pa-updates'), counter = join(root, 'native-admissions'), mode = join(root, 'fixture-mode');
let completed = false, stage = 'isolation';
const rpc = async (method, input = null) => { const response = await request(`plugins/pa-updates/rpc/${method}`, input); assert.equal(response.body.ok, true); return response.body.result; };
const admissions = async () => (await readFile(counter, 'utf8')).trim().split('\n').filter(Boolean);
const info = async () => JSON.parse(await cli('plugin', 'list', '--json')).plugins.find(plugin => plugin.id === 'pa-updates');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function settle(jobId) {
  const deadline = Date.now() + 15 * 60_000; let disconnected = false;
  while (Date.now() < deadline) {
    let state;
    try { state = await rpc('applicationStatus'); } catch { disconnected = true; }
    if (state) {
      assert.equal(state.job?.id, jobId, 'native replacement/restart must retain the SAME job');
      if (!state.applying) { assert.equal(state.job.phase, 'complete', JSON.stringify(state.job)); return { state, disconnected }; }
    }
    await new Promise(resolve => setTimeout(resolve, 500)); // Only observation retries.
  }
  throw new Error('native_self_job_did_not_settle');
}
try {
  await host.assertNativeIsolation();
  await writeFile(counter, ''); await writeFile(mode, 'self');
  await mkdir(join(source, 'implementation'), { recursive: true });
  await command('tar', ['--no-same-owner', '-xf', archive, '-C', join(source, 'implementation')]);
  const manifest = JSON.parse(await readFile(join(source, 'implementation/package.json'), 'utf8'));
  manifest.version = '0.1.0'; manifest.bb.app = './implementation/app.tsx';
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'package-lock.json'), await readFile(join(source, 'implementation/package-lock.json')));
  // The only substitutions are discovery and which runtime scenario is in
  // scope. Own-source inspection, original builds, choice/apply, persistence,
  // native replacement and native BB preparation/apply/reconciliation are real.
  await writeFile(join(source, 'server.ts'), `import plugin from './implementation/server.ts';import{applicationPorts}from './implementation/adapters/application.ts';import{readFileSync,appendFileSync}from'node:fs';
export default bb=>{const ports=applicationPorts(bb,${JSON.stringify(host.repo)});const inspect=ports.runtime.inspect,applyBb=ports.runtime.applyBb,applySelf=ports.self.apply;
ports.runtime.inspect=(...args)=>readFileSync(${JSON.stringify(mode)},'utf8')==='self'?Promise.resolve({target:null,runningThreadCount:0,rows:[]}):inspect(...args);
ports.runtime.applyBb=(...args)=>{appendFileSync(${JSON.stringify(counter)},'bb\\n');return applyBb(...args)};
ports.self.apply=(...args)=>{appendFileSync(${JSON.stringify(counter)},'self\\n');return applySelf(...args)};
return plugin(bb,{feed:async()=>null,inventory:async()=>({installed:null,runtime:null})},ports)};`);
  const publish = async version => {
    manifest.version = version; await writeFile(join(source, 'package.json'), JSON.stringify(manifest));
    await command(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], source);
    await host.git('add', '.'); await host.git('commit', '-qm', `fixture updater ${version}`); return host.git('rev-parse', 'HEAD');
  };
  await host.git('init', '-q', '-b', 'main'); await host.git('config', 'user.name', 'Fixture'); await host.git('config', 'user.email', 'fixture@example.invalid');
  await publish('0.1.0'); stage = 'native-launcher'; await host.start();
  stage = 'install-owned-updater';
  await cli('plugin', 'install', `git:${host.repo}@main`, '--subdirectory', 'plugins/pa-updates', '--yes', '--json');
  assert.equal((await info()).status, 'running'); assert.equal((await info()).version, '0.1.0');
  stage = 'kept-self';
  await publish('0.1.1');
  const oldRoot = (await info()).rootDir, changedFile = join(oldRoot, 'server.ts');
  await writeFile(changedFile, (await readFile(changedFile, 'utf8')) + '\n// fixture installed-local edit\n');
  const keptHash = await hash(changedFile), reviewed = await rpc('review'), firstReview = reviewed.review;
  assert.equal(reviewed.failure, null); assert.equal(firstReview.rows.length, 1); assert.equal(firstReview.rows[0].id, 'pa-updates');
  assert.equal(firstReview.rows[0].local, 'custom'); assert.equal(firstReview.rows[0].decision, 'choose');
  assert.equal((await rpc('apply', { reviewId: firstReview.id, choices: [] })).job, null);
  assert.equal(await hash(changedFile), keptHash); assert.equal((await info()).version, '0.1.0'); assert.deepEqual(await admissions(), []);
  stage = 'native-self-only';
  const started = await rpc('apply', { reviewId: firstReview.id, choices: [{ id: 'pa-updates', choice: 'install' }] });
  const first = (await settle(started.job.id)).state;
  assert.equal(first.job.receipts[0].actual, '0.1.1'); assert.equal(first.job.receipts[0].outcome, 'updated'); assert.equal(first.job.reviewId, firstReview.id);
  assert.deepEqual(await admissions(), ['self']); assert.equal((await info()).version, '0.1.1');
  await cli('plugin', 'reload', 'pa-updates'); assert.deepEqual((await rpc('applicationStatus')).job, first.job); assert.deepEqual(await admissions(), ['self']);
  console.log(JSON.stringify({ stage, keptSelfUnchanged: true, nativeOwnReplacement: true, samePersistedReceiptAfterReload: true, oneAdmission: true }));
  // A reload starts automatic discovery. Let that snapshot finish BEFORE
  // publishing the next fixture release; an explicit check correctly joins
  // an already-running scan rather than rewriting its completed reads.
  const discoveryDeadline = Date.now() + 180000;
  let discovered;
  do {
    discovered = await rpc('applicationStatus');
    if (discovered.offers && !discovered.checking) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < discoveryDeadline);
  assert.ok(discovered.offers && !discovered.checking, 'reload discovery must settle before publishing the next scenario');
  stage = 'review-self-after-bb';
  await writeFile(mode, 'bb'); await publish('0.1.2');
  const secondState = await rpc('review'), secondReview = secondState.review;
  await writeFile(join(root, 'second-review.json'), JSON.stringify(secondState), { mode: 0o600 });
  assert.equal(secondState.failure, null);
  assert.equal(secondReview.rows.length, 1); assert.equal(secondReview.rows[0].id, 'pa-updates'); assert.equal(secondReview.rows[0].local, 'stock');
  assert.equal(secondReview.rows[0].decision, 'automatic');
  assert.equal(secondReview.runtime.rows.find(row => row.id === 'bb').state, 'ready');
  assert.equal(secondReview.runtime.runningThreadCount, 0); assert.ok(secondReview.runtime.target?.id);
  stage = 'native-bb-then-self';
  const secondStart = await rpc('apply', { reviewId: secondReview.id, choices: [], confirmInterruptingThreads: false });
  const second = await settle(secondStart.job.id), done = second.state;
  assert.equal(done.job.reviewId, secondReview.id); assert.equal(done.job.receipts[0].actual, '0.1.2'); assert.equal(done.job.receipts[0].outcome, 'updated');
  assert.equal(done.job.runtimeReceipts.length, 1); assert.equal(done.job.runtimeReceipts[0].id, 'bb'); assert.equal(done.job.runtimeReceipts[0].outcome, 'updated');
  assert.notEqual(done.job.runtimeReceipts[0].actual, done.job.runtimeReceipts[0].before);
  assert.deepEqual(await admissions(), ['self', 'bb', 'self']); assert.equal((await info()).version, '0.1.2');
  stage = 'reloaded-final-receipt'; await cli('plugin', 'reload', 'pa-updates');
  assert.deepEqual((await rpc('applicationStatus')).job, done.job); assert.deepEqual(await admissions(), ['self', 'bb', 'self']);
  await host.assertNativeIsolation(); completed = true;
  console.log(JSON.stringify({ evidence: 'Original updater handlers/adapters, real native own replacement and BB launcher, disposable Linux only', firstSelf: first.job.receipts, afterBb: done.job, admissions: await admissions(), selfLast: true, sameJobAfterBbAndSelf: true, noRegistrationOrDisposalDeadlock: true, noProviderCliInstallation: true, noNativeWriteRetry: true, disconnectedObserved: second.disconnected }));
} catch (error) { console.error('Self gate stage:', stage); throw error; }
finally { await host.finish(completed); }
