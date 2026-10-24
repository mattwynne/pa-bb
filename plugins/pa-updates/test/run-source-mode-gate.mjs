// Owned Linux container only: original Application handlers + adapter + finite
// runner, BB's shipped public native installer/remover, synthetic state only.
// node test/run-source-mode-gate.mjs /path/to/bb-app /work/updater.tar /work/pause.tar
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
import { fixtureSource } from './source-mode-fixtures.mjs';
assert.equal(process.platform, 'linux');
assert.ok(await access('/.dockerenv').then(() => true, () => false), 'Run in the owned disposable container, not a host');
const archive = resolve(process.argv[3]), pauseArchive = resolve(process.argv[4]);
const host = await createGateHost(process.argv[2], { retainEvidence: true });
const { root, command, npm, cli, request } = host;
const workspace = join(host.home, 'src/pa-bb'), origin = host.repo, receipts = join(root, 'source-receipts');
const digest = path => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'));
const archiveDigest = await digest(archive), pauseDigest = await digest(pauseArchive);
const testedIds = ['google-calendar', 'pa-updates', 'icloud', 'obsidian'];
const localPath = id => join(workspace, 'plugins', id);
const git = async (cwd, ...args) => (await command('git', args, cwd)).trim();
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const raw = () => readJson(join(receipts, 'receipt.json'));
const mode = value => writeFile(join(root, 'mode.json'), JSON.stringify(value));
const events = async () => (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const rpcResponse = (id, method, input = null) => request(`plugins/${id}/rpc/${method}`, input);
const rpc = async (id, method, input = null) => {
  const response = await rpcResponse(id, method, input);
  assert.equal(response.status, 200, `RPC ${id}/${method} HTTP boundary`);
  assert.equal(response.body.ok, true, `RPC ${id}/${method} rejected`); return response.body.result;
};
const updater = (method, input = null) => rpc('pa-updates', method, input);
const info = async id => (await request('plugins')).body.plugins.find(p => p.id === id);
const source = async id => { const response = await request(`plugins/${id}/source`); assert.equal(response.status, 200); return response.body; };
const fixture = id => rpc(id, 'fixtureStatus');
const snapshots = [], results = [], mutations = [], nativeJobHistory = new Map();
let completed = false, stage = 'setup';
async function until(label, condition, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await condition(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Native gate deadline: ${label}`);
}
async function idle() {
  return until('updater idle discovery', async () => {
    let state; try { state = await updater('applicationStatus'); } catch { return false; }
    assert.equal(state.failure, null, 'Original updater inspection must not fail');
    return !state.checking && !state.applying ? state : false;
  });
}
async function check() { await idle(); const state = await updater('review'); assert.equal(state.failure, null); assert.ok(state.review?.inventory); return state; }
async function admit(id, target) {
  const state = await check(), reviewId = state.review.id;
  // One RPC write only. Real updater self-removal may disconnect its response.
  let response;
  try { response = await updater('switchSource', { reviewId, id, target, confirmLoss: true }); }
  catch (error) { if (id !== 'pa-updates') throw error; }
  const receipt = await until('durable admission', async () => { const r = await raw().catch(() => null); return r?.reviewId === reviewId ? r : false; });
  assert.equal(receipt.id, id); assert.equal(receipt.target, target);
  if (response) assert.equal(response.sourceSwitch.jobId, receipt.jobId);
  mutations.push({ jobId: receipt.jobId, id, target }); return receipt.jobId;
}
async function terminal(jobId, phase = 'complete') {
  const receipt = await until('finite runner terminal', async () => {
    const r = await raw(); assert.equal(r.jobId, jobId); return ['complete', 'attention'].includes(r.phase) ? r : false;
  });
  assert.equal(receipt.phase, phase, `Unexpected runner terminal boundary: ${receipt.reason}`);
  const state = await until('replacement observes receipt', async () => {
    let value; try { value = await updater('applicationStatus'); } catch { return false; }
    return value.sourceSwitch?.jobId === jobId && !value.applying && !value.sourceSwitch.syncReserved ? value : false;
  });
  assert.equal(state.sourceSwitch.phase, phase); snapshots.push(structuredClone(state.sourceSwitch)); return state;
}
async function attention(jobId) {
  return until('attention visible', async () => {
    const response = await rpcResponse('pa-updates', 'applicationStatus');
    if (response.status === 503) return false; // Native registration is still loading.
    assert.equal(response.status, 200); assert.equal(response.body.ok, true);
    const state = response.body.result; assert.equal(state.sourceSwitch?.jobId, jobId);
    return state.sourceSwitch.phase === 'attention' ? state : false;
  });
}
async function healthy(id, target, marker) {
  const p = await info(id), s = await source(id), state = await fixture(id);
  assert.equal(p.enabled, true); assert.ok(['running', 'needs-configuration'].includes(p.status)); assert.equal(p.statusDetail, null);
  assert.equal(state.marker, marker);
  if (target === 'local') { assert.equal(s.requested, `path:${localPath(id)}`); assert.equal(p.rootDir, localPath(id)); assert.ok(!s.subdirectory); }
  else { assert.ok([`git:${origin}@main`, `git:${origin}@ref:main`].includes(s.requested)); assert.equal(s.subdirectory, `plugins/${id}`); assert.notEqual(p.rootDir, localPath(id)); }
  return { p, s, state };
}
async function jobs() {
  const r = await request('plugins/install-jobs'); assert.equal(r.status, 200);
  for (const job of r.body.jobs) nativeJobHistory.set(job.id, job);
  return r.body.jobs;
}
function noNewJobs(current, previous) { assert.ok(current.every(id => previous.includes(id)), 'No new native install admission'); }
async function nativeRemovals() {
  const lines = (await readFile(join(host.env.BB_DATA_DIR, 'logs/server.1.log'), 'utf8')).trim().split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line)).map(entry => /^plugin (google-calendar|pa-updates|icloud|obsidian) removed from /.exec(entry.msg ?? '')?.[1]).filter(Boolean);
}
async function runtimeConfiguration() {
  const configuration = {};
  for (const id of ['provider-pi', 'provider-codex', 'provider-claude-code']) {
    const response = await until('configured provider factory loaded', async () => {
      const value = await request(`plugins/${id}/settings`);
      if ([404, 503].includes(value.status)) return false;
      assert.equal(value.status, 200); assert.equal(value.body.ok, true); return value;
    });
    configuration[id] = response.body;
  }
  return configuration;
}
async function nativeInstall(id, target) {
  const nativeResponse = await fetch(host.env.BB_SERVER_URL + '/api/v1/plugins/install', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' }, body: JSON.stringify(target === 'local' ? { source: `path:${localPath(id)}`, selection: { kind: 'root' } }
      : { source: `git:${origin}@main`, selection: { kind: 'subdirectory', path: `plugins/${id}` } }) });
  const response = { status: nativeResponse.status, body: await nativeResponse.json() };
  assert.equal(response.status, 202); assert.equal(response.body.ok, true);
  const jobId = response.body.job.id;
  const job = await until('manual supported install', async () => {
    const r = await request(`plugins/install-jobs/${jobId}`); return ['succeeded', 'failed', 'cancelled'].includes(r.body.job.state) ? r.body.job : false;
  });
  assert.equal(job.state, 'succeeded'); return jobId;
}
async function refusedRecovery() { const result = await rpcResponse('pa-updates', 'acknowledgeSourceRecovery', { jobId: (await raw()).jobId }); assert.notEqual(result.body.ok, true); }
async function noReplay(label, jobId, { restart = false } = {}) {
  const beforeJobs = (await jobs()).map(j => j.id).sort(), before = await raw(), beforeDisposes = (await events()).filter(e => e.operation === 'dispose-enter').length, beforeRemovals = await nativeRemovals();
  if (restart) await host.restart(); else await cli('plugin', 'reload', 'pa-updates');
  const observed = await until('observer reload', async () => { let s; try { s = await updater('applicationStatus'); } catch { return false; } return s.sourceSwitch?.jobId === jobId ? s : false; });
  assert.equal(observed.sourceSwitch.jobId, jobId);
  await until('observer initial discovery completed', async () => {
    const state = await updater('applicationStatus'); return !!state.offers && !state.checking && !state.applying;
  });
  assert.deepEqual(await nativeRemovals(), beforeRemovals, 'No native removal on observer reload/restart');
  const afterJobs = (await jobs()).map(j => j.id).sort();
  // BB's install-job registry is process-local; restart legitimately clears it.
  if (restart) noNewJobs(afterJobs, beforeJobs); else assert.deepEqual(afterJobs, beforeJobs, 'No new install admission on observer reload');
  assert.equal((await raw()).jobId, before.jobId); assert.equal((await raw()).removalAttempted, before.removalAttempted);
  // Exactly the explicit observer reload (or each registered plugin on restart)
  // is disposed; further source removals must not appear in lifecycle evidence.
  const after = (await events()).slice().filter(e => e.operation === 'dispose-enter').length;
  assert.equal(after - beforeDisposes, restart ? testedIds.length : 1);
  results.push({ case: label, sameJob: true, noInstallReplay: true, explicitObserverRestart: restart });
}
async function assertPaused() {
  const state = await fixture('icloud'); assert.equal(state.updatePause.jobId, null); assert.equal(state.owned, null);
  assert.ok(state.mirrors.every(m => !m.enabled && m.phase !== 'running'));
  assert.equal((await events()).filter(e => e.operation === 'AUTOMATIC-ENABLE').length, 0); return state;
}
try {
  await mkdir(workspace, { recursive: true }); await writeFile(join(root, 'events.jsonl'), ''); await mode({});
  await git(workspace, 'init', '-b', 'main'); await git(workspace, 'config', 'user.name', 'Fixture'); await git(workspace, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\ndist/\n');
  // Workspace comparison covers all six enum entries even when only four are installed.
  for (const id of [...testedIds, 'fastmail', 'google-drive']) {
    const directory = localPath(id); await mkdir(directory, { recursive: true });
    let manifest = { name: `bb-plugin-${id}`, version: id === 'icloud' ? '0.3.2' : id === 'obsidian' ? '0.3.1' : '0.4.0', type: 'module',
      engines: { node: '>=22.18', bb: '>=0.46.0', bbPluginSdk: '>=0.6.37 <1' }, dependencies: { zod: '4.6.5' },
      bb: { name: 'Synthetic source mode', description: 'Owned native gate.', branding: { icon: 'Calendar' }, server: './server.ts' } };
    if (id === 'pa-updates') {
      await mkdir(join(directory, 'implementation')); await command('tar', ['--no-same-owner', '-xf', archive, '-C', join(directory, 'implementation')]);
      const production = await readJson(join(directory, 'implementation/package.json')); assert.equal(production.version, '0.4.0');
      manifest = { ...production, bb: { ...production.bb, app: './implementation/app.tsx' } };
      await writeFile(join(directory, 'package-lock.json'), await readFile(join(directory, 'implementation/package-lock.json')));
    }
    if (id === 'icloud') { await mkdir(join(directory, 'pause')); await command('tar', ['--no-same-owner', '-xf', pauseArchive, '-C', join(directory, 'pause')]); }
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'server.ts'), fixtureSource({ id, root, origin, workspace, receipts, updater: id === 'pa-updates', cloud: id === 'icloud' }));
    await writeFile(join(directory, 'marker.ts'), 'export const marker="MANAGED";\n');
    await command(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  }
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'owned synthetic fixture baseline');
  await rm(origin, { recursive: true }); await git(root, 'clone', '--bare', workspace, origin); await git(workspace, 'remote', 'add', 'origin', origin); await git(workspace, 'fetch', 'origin');
  await writeFile(join(workspace, 'README.md'), 'Synthetic unpushed commit retained.\n'); await git(workspace, 'add', 'README.md'); await git(workspace, 'commit', '-m', 'owned unpushed fixture work');
  for (const id of testedIds) await writeFile(join(localPath(id), 'marker.ts'), 'export const marker="LOCAL";\n');
  const originalHead = await git(workspace, 'rev-parse', 'HEAD'), originalOrigin = await git(origin, 'rev-parse', 'main'), originalDirty = await git(workspace, 'status', '--porcelain');
  assert.notEqual(originalHead, originalOrigin); assert.ok(originalDirty);
  await writeFile(join(root, 'inputs.json'), JSON.stringify({ archiveDigest, pauseDigest, updaterVersion: '0.4.0', bb: host.pkg.version, originalHead, originalOrigin }, null, 2));
  stage = 'native-install-fixtures'; await host.start();
  for (const id of testedIds) await cli('plugin', 'install', `git:${origin}@main`, '--subdirectory', `plugins/${id}`, '--yes', '--json');
  await idle();
  const siblingInventory = (await request('plugins')).body.plugins.filter(p => !testedIds.includes(p.id)).map(p => ({ id: p.id, rootDir: p.rootDir, enabled: p.enabled, version: p.version }));
  const versionBefore = (await request('system/version')).body, runtimeBefore = await runtimeConfiguration();
  for (const id of testedIds) { const seeded = await rpc(id, 'seed'); assert.ok(seeded.kv && seeded.database && seeded.setting && seeded.secret && seeded.note); }
  const dataBefore = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar'));
  const dbBefore = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar/data.db'));
  assert.ok((await info('google-calendar')).schedules.some(s => s.name === 'fixture-once'));
  stage = 'pre-removal-refusals';
  const calendarManifest = join(localPath('google-calendar'), 'package.json'), manifestBytes = await readFile(calendarManifest, 'utf8');
  for (const reason of ['identity', 'dependency', 'disabled']) {
    const beforeSource = await source('google-calendar'), beforeJobs = (await jobs()).map(j => j.id).sort(), beforeEvents = (await events()).length;
    if (reason === 'identity') await writeFile(calendarManifest, JSON.stringify({ ...JSON.parse(manifestBytes), name: 'bb-plugin-unrelated' }));
    if (reason === 'dependency') await writeFile(calendarManifest, JSON.stringify({ ...JSON.parse(manifestBytes), dependencies: { 'fixture-private-missing-dependency': '1.0.0' } }));
    if (reason === 'disabled') await cli('plugin', 'disable', 'google-calendar');
    const jobId = await admit('google-calendar', 'local'); await terminal(jobId, 'attention');
    assert.equal((await raw()).removalAttempted, false); assert.equal((await raw()).configuration, 'reset_expected');
    assert.deepEqual(await source('google-calendar'), beforeSource); assert.deepEqual((await jobs()).map(j => j.id).sort(), beforeJobs);
    if (reason === 'disabled') await cli('plugin', 'enable', 'google-calendar');
    const state = await fixture('google-calendar'); assert.equal(state.marker, 'MANAGED'); assert.ok(state.setting && state.secret && state.kv && state.database);
    assert.equal((await events()).slice(beforeEvents).filter(e => e.operation === 'dispose-enter').length, reason === 'disabled' ? 1 : 0);
    await writeFile(calendarManifest, manifestBytes); results.push({ case: `refusal-${reason}`, removalAttempted: false, originalStateRetained: true });
  }
  stage = 'calendar-roundtrip';
  for (const target of ['local', 'github']) {
    const jobId = await admit('google-calendar', target); await terminal(jobId); const state = await healthy('google-calendar', target, target === 'local' ? 'LOCAL' : 'MANAGED');
    assert.equal(state.p.version, '0.4.0'); assert.equal(state.state.setting, false); assert.equal(state.state.secret, false);
    assert.ok(state.state.kv && state.state.database && state.state.note); assert.ok(!state.p.schedules.some(s => s.name === 'fixture-once'));
  }
  const dataAfter = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar')), dbAfter = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar/data.db'));
  assert.equal(dataAfter.ino, dataBefore.ino); assert.equal(dataAfter.dev, dataBefore.dev); assert.equal(dbAfter.ino, dbBefore.ino);
  results.push({ case: 'calendar-git-path-git', sameVersionDifferentBehavior: true, settingsSecretsSchedulesDeleted: true, kvDatabaseNoteAndInodesRetained: true });
  stage = 'updater-self-roundtrip';
  for (const target of ['local', 'github']) {
    const old = await info('pa-updates'), jobId = await admit('pa-updates', target); const state = await terminal(jobId);
    await healthy('pa-updates', target, target === 'local' ? 'LOCAL' : 'MANAGED'); assert.equal(state.sourceSwitch.jobId, jobId);
    if (target === 'local') assert.equal(await access(old.rootDir).then(() => true, () => false), false, 'Native self-remove deletes the managed snapshot');
    const self = await fixture('pa-updates'); assert.ok(self.kv && self.database && self.note); assert.equal(self.setting, false); assert.equal(self.secret, false);
    await noReplay(`self-${target}-observer-reload`, jobId);
  }
  await noReplay('self-final-process-restart', (await raw()).jobId, { restart: true }); await idle();
  results.push({ case: 'updater-real-native-self-roundtrip', actualDisposal: true, sameDurableJobAcrossReplacement: true });
  stage = 'native-install-failure';
  await terminal(await admit('google-calendar', 'local'));
  await mode({ hideOriginOnDispose: 'google-calendar' });
  const failedJob = await admit('google-calendar', 'github');
  const failedReceipt = await until('native install failure', async () => { const r = await raw(); return r.jobId === failedJob && r.phase === 'attention' ? r : false; });
  assert.equal(failedReceipt.removed, true); assert.equal(failedReceipt.configuration, 'deleted'); assert.equal(failedReceipt.installAdmitted, true); assert.equal(failedReceipt.reason, 'install_failed');
  assert.equal(await info('google-calendar'), undefined);
  const failedNativeJobs = (await jobs()).filter(j => j.state === 'failed'); assert.ok(failedNativeJobs.length > 0);
  // Observer reload with an absent Calendar has one fewer registered fixture.
  await cli('plugin', 'reload', 'pa-updates'); const failedObserve = await attention(failedJob); assert.equal(failedObserve.sourceSwitch.configuration, 'deleted');
  const beforeRestartJobs = (await jobs()).map(j => j.id).sort(); await host.restart(); await attention(failedJob);
  noNewJobs((await jobs()).map(j => j.id).sort(), beforeRestartJobs); assert.equal(await info('google-calendar'), undefined);
  await mode({}); await rename(origin + '.offline', origin);
  await nativeInstall('google-calendar', 'github'); const recoveryJobs = (await jobs()).map(j => j.id).sort();
  const removalsBeforeAcknowledgment = await nativeRemovals();
  const recovered = await updater('acknowledgeSourceRecovery', { jobId: failedJob });
  assert.deepEqual(await nativeRemovals(), removalsBeforeAcknowledgment, 'Recovery is verification, not another DELETE'); assert.equal(recovered.sourceSwitch.phase, 'complete'); assert.equal(recovered.sourceSwitch.recovery, 'target_verified');
  assert.deepEqual((await jobs()).map(j => j.id).sort(), recoveryJobs); await healthy('google-calendar', 'github', 'MANAGED'); await idle();
  results.push({ case: 'native-install-failure-after-delete', nativeFailedJobs: failedNativeJobs.length, configuration: 'deleted', noReplayOnReloadOrRestart: true, manualNativeInstallThenVerifyOnly: true });
  stage = 'real-update-pause-drain-and-source-resets';
  await mode({ draining: true }); const drainEvents = (await events()).length, cloudJob = await admit('icloud', 'local');
  await until('native updater reserves active drain', async () => { const s = await fixture('icloud'); return s.updatePause.jobId === cloudJob && s.mirrors.some(m => m.phase === 'running'); });
  assert.equal((await raw()).removalAttempted, false); assert.equal((await raw()).syncReserved, true);
  assert.ok(!(await events()).slice(drainEvents).some(e => e.id === 'icloud' && e.operation === 'dispose-enter'));
  await mode({}); await terminal(cloudJob); await healthy('icloud', 'local', 'LOCAL'); await assertPaused();
  const resets = [['icloud', 'github'], ['obsidian', 'local'], ['obsidian', 'github']];
  for (const [id, target] of resets) {
    await rpc('icloud', 'reset'); const job = await admit(id, target); await terminal(job); await healthy(id, target, target === 'local' ? 'LOCAL' : 'MANAGED'); await assertPaused();
  }
  const pauseEvents = (await events()).slice(drainEvents), reserves = pauseEvents.filter(e => e.operation === 'reserve'), userPauses = pauseEvents.filter(e => e.operation === 'user-pause');
  assert.ok(reserves.length >= 4 && reserves.every(e => e.caller === 'plugin' && e.callerPlugin === 'pa-updates'));
  assert.equal(userPauses.length, 16); assert.ok(userPauses.every(e => e.caller === 'client'));
  assert.ok(pauseEvents.filter(e => e.operation === 'release').every(e => e.ownedIds.length === 0));
  assert.ok(pauseEvents.filter(e => e.id === 'icloud' && e.operation === 'dispose-enter').every(e => e.ownedIds.length === 0 && e.mirrors.every(m => !m.enabled && m.phase !== 'running')));
  for (const id of ['icloud', 'obsidian']) { const state = await fixture(id); assert.ok(state.kv && state.database && state.note); assert.equal(state.setting, false); assert.equal(state.secret, false); }
  results.push({ case: 'original-UpdatePause-native-callers-and-drain', allFourMirrorClasses: true, helperClientPauses: userPauses.length, pluginCallerReservations: reserves.length, emptyResumeRightsAtReplacementAndRelease: true, automaticEnables: 0, pairedVersions: ['0.3.2', '0.3.1'], noteKvDatabaseRetained: true });
  stage = 'owned-runner-death-pending-delete';
  await mode({ blockDispose: 'google-calendar' }); const deathStart = (await events()).length, deathJob = await admit('google-calendar', 'local');
  await until('native DELETE entered actual disposal', async () => (await events()).slice(deathStart).some(e => e.id === 'google-calendar' && e.operation === 'dispose-enter'));
  const launch = await readJson(join(receipts, 'launch.json'));
  assert.equal(launch.jobId, deathJob); assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
  for (const name of ['ready.json', 'permit.json']) assert.deepEqual(await readJson(join(receipts, name)), launch);
  process.kill(launch.pid, 0); await refusedRecovery(); // Alive owned runner never grants recovery.
  process.kill(launch.pid, 'SIGKILL'); // ONLY the positive PID bound to this owned UUID.
  await until('owned runner positively gone', async () => { try { process.kill(launch.pid, 0); return false; } catch (e) { assert.equal(e.code, 'ESRCH'); return true; } });
  const afterDeathDisk = await readFile(join(receipts, 'receipt.json'), 'utf8');
  const deadState = await attention(deathJob); assert.equal(deadState.sourceSwitch.reason, 'interrupted');
  assert.equal(await readFile(join(receipts, 'receipt.json'), 'utf8'), afterDeathDisk, 'Observation cannot transfer disk ownership');
  assert.equal((await raw()).phase, 'running'); assert.equal((await raw()).removed, false); assert.equal((await raw()).configuration, 'possibly_deleted');
  await refusedRecovery(); // Pending DELETE remains unsafe while admitting BB lives.
  await mode({}); await until('native DELETE settles after release', async () => !(await info('google-calendar')));
  await nativeInstall('google-calendar', 'local'); await refusedRecovery();
  const oldPid = (await readJson(join(receipts, 'intent.json'))).serverPid, beforeDeathRestartJobs = (await jobs()).map(j => j.id).sort();
  await host.restart(); await attention(deathJob);
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' }); noNewJobs((await jobs()).map(j => j.id).sort(), beforeDeathRestartJobs);
  const acknowledged = await updater('acknowledgeSourceRecovery', { jobId: deathJob });
  assert.equal(acknowledged.sourceSwitch.recovery, 'target_verified'); assert.equal(acknowledged.sourceSwitch.configuration, 'possibly_deleted');
  assert.equal(acknowledged.sourceSwitch.removed, false); assert.equal(acknowledged.sourceSwitch.installAdmitted, false);
  await healthy('google-calendar', 'local', 'LOCAL'); await idle();
  results.push({ case: 'real-owned-runner-SIGKILL-during-DELETE', immediateObserveOnlyAttention: true, aliveOwnerAndLiveOriginalServerRefused: true, explicitSameBinaryRestartRequired: true, mutationUncertaintyRetained: true });
  stage = 'failed-initial-reserve-null-hold';
  await rpc('icloud', 'allPaused'); await mode({ failInitial: true }); const nullHoldEvents = (await events()).length, nullJob = await admit('icloud', 'local');
  await until('pre-removal reserve refusal', async () => { const r = await raw(); return r.jobId === nullJob && r.phase === 'attention'; });
  const nullReceipt = await raw(); assert.equal(nullReceipt.removalAttempted, false); assert.equal(nullReceipt.syncReserved, true); assert.equal(nullReceipt.pauseHandoff, false);
  assert.equal((await fixture('icloud')).updatePause.jobId, null); const nullSource = await source('icloud');
  await refusedRecovery(); await mode({}); await refusedRecovery();
  const nullOldPid = (await readJson(join(receipts, 'intent.json'))).serverPid;
  await host.restart(); await attention(nullJob); assert.throws(() => process.kill(nullOldPid, 0), { code: 'ESRCH' });
  const cleanupJobs = (await jobs()).map(j => j.id).sort();
  const cleaned = await updater('acknowledgeSourceRecovery', { jobId: nullJob }); assert.equal(cleaned.sourceSwitch.recovery, 'aborted_before_removal'); assert.equal(cleaned.sourceSwitch.syncReserved, false); assert.equal(cleaned.sourceSwitch.manualRecovery, false);
  assert.deepEqual(await source('icloud'), nullSource); assert.deepEqual((await jobs()).map(j => j.id).sort(), cleanupJobs); await assertPaused();
  const cleanupEvents = (await events()).slice(nullHoldEvents); const barrier = cleanupEvents.filter(e => e.operation === 'reserve');
  assert.equal(barrier.length, 2); assert.ok(barrier.every(e => e.updateJob === nullJob && e.callerPlugin === 'pa-updates'));
  assert.equal(cleanupEvents.filter(e => e.operation === 'user-pause').length, 4); assert.ok(cleanupEvents.filter(e => e.operation === 'release').every(e => e.ownedIds.length === 0));
  results.push({ case: 'failed-initial-Pause-null-hold', preRestartRecoveryRefused: true, originalServerPositivelyGone: true, sameUuidSerialBarrier: true, allMirrorClientPauses: 4, zeroAutomaticEnables: true });
  stage = 'final-invariants-and-evidence';
  // A deliberately rejected native RPC sets BB's sticky statusDetail. Exercise
  // that authorization boundary last, rather than hiding it with a reload.
  const denied = await rpcResponse('icloud', 'pause', { updateJob: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }); assert.notEqual(denied.body.ok, true, 'A REST client cannot impersonate updater caller');
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), originalHead); assert.equal(await git(origin, 'rev-parse', 'main'), originalOrigin); assert.equal(await git(workspace, 'status', '--porcelain'), originalDirty);
  assert.deepEqual((await request('plugins')).body.plugins.filter(p => !testedIds.includes(p.id)).map(p => ({ id: p.id, rootDir: p.rootDir, enabled: p.enabled, version: p.version })), siblingInventory);
  assert.deepEqual((await request('system/version')).body, versionBefore); assert.deepEqual(await runtimeConfiguration(), runtimeBefore);
  const allEvents = await events(); await jobs(); const allJobs = [...nativeJobHistory.values()], removalIds = await nativeRemovals();
  const nativeRemovalsById = Object.fromEntries(testedIds.map(id => [id, removalIds.filter(removed => removed === id).length]));
  assert.deepEqual(nativeRemovalsById, { 'google-calendar': 5, 'pa-updates': 2, icloud: 2, obsidian: 2 });
  assert.equal(allJobs.length, 16); assert.equal(allJobs.filter(job => job.state === 'succeeded').length, 15); assert.equal(allJobs.filter(job => job.state === 'failed').length, 1);
  const log = (await Promise.all([join(root, 'server.log'), join(host.env.BB_DATA_DIR, 'logs/server.1.log'), ...testedIds.map(id => join(host.env.BB_DATA_DIR, 'plugins', id, 'logs/plugin.log'))].map(path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })))).join('\n');
  const receiptText = await readFile(join(receipts, 'receipt.json'), 'utf8');
  assert.ok(!log.includes('PRIVATE_SENTINEL')); assert.ok(!receiptText.includes('PRIVATE_SENTINEL')); assert.ok(log.includes('icloud stage=update_pause outcome=unavailable'));
  await writeFile(join(root, 'receipts-summary.json'), JSON.stringify(snapshots, null, 2));
  await writeFile(join(root, 'install-jobs.json'), JSON.stringify(allJobs, null, 2));
  const summary = { bb: host.pkg.version, updater: '0.4.0', archiveDigest, pauseDigest, originalHandlersAndSourceRunner: true, nativeRuntime: false,
    results, nativeRemovals: removalIds.length, nativeRemovalsById, successfulRunnerSwitches: snapshots.filter(s => s.phase === 'complete').length, installJobs: { total: allJobs.length, succeeded: allJobs.filter(j => j.state === 'succeeded').length, failed: allJobs.filter(j => j.state === 'failed').length },
    sourceAdmissions: mutations, automaticMirrorEnables: allEvents.filter(e => e.operation === 'AUTOMATIC-ENABLE').length, sourceFilesDirtyAndUnpushedCommitRetained: true, siblingInventoryAndBbVersionUnchanged: true, configuredProviderRuntimesUnchanged: true,
    diagnostics: { boundedFailurePresent: true, sentinelAbsentFromHostLogAndReceipt: true }, evidence: root,
    notProven: ['real Apple/rclone activity (separate previously accepted gate)', 'BB binary upgrade', 'rendered UI', 'atomic mutable Git @main or local-source final parse', 'unknown process permissions/PID reuse beyond Stage A unit regressions'] };
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary)); completed = true;
} catch (error) {
  const facts = {};
  for (const path of ['plugins', 'plugins/icloud/source', 'plugins/install-jobs', 'plugins/update-jobs']) {
    try { facts[path] = await request(path); } catch { facts[path] = 'unavailable'; }
  }
  await writeFile(join(root, 'failure-native-facts.json'), JSON.stringify(facts, null, 2));
  await writeFile(join(root, 'failure.json'), JSON.stringify({ stage, name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 1000) }, null, 2));
  console.error('Source mode native gate stage:', stage); throw error;
} finally { await host.finish(completed); }
