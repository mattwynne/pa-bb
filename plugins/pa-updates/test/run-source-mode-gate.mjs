// Owned Linux container only: original Application handlers + adapter + finite
// runner, the selected BB fork's public direct native installer, synthetic state only.
// node test/run-source-mode-gate.mjs /path/to/fork/packages/bb-app /work/updater.tar /work/pause.tar
// BB_SOURCE_GATE_PACKAGE may supply the fork artifact instead of argv[2].
// Requires experimental_directPluginSourceMoves:true; stock BB is NOT a fallback.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
import { fixtureSource } from './source-mode-fixtures.mjs';
assert.equal(process.platform, 'linux');
assert.ok(await access('/.dockerenv').then(() => true, () => false), 'Run in the owned disposable container, not a host');
const inputs = process.argv.slice(2);
const forkPackage = process.env.BB_SOURCE_GATE_PACKAGE ?? inputs.shift();
assert.ok(forkPackage, 'Supply the built direct-source-move BB fork artifact');
assert.equal(inputs.length, 2, 'Supply updater and Pause archives after the fork artifact (or use BB_SOURCE_GATE_PACKAGE)');
const archive = resolve(inputs[0]), pauseArchive = resolve(inputs[1]);
const host = await createGateHost(forkPackage, { retainEvidence: true });
const { root, command, npm, cli, request } = host;
const workspace = join(host.home, 'src/pa-bb'), remote = host.repo, origin = 'https://source-modes.example.invalid/pa-bb.git', receipts = join(root, 'source-receipts');
const digest = path => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'));
const archiveDigest = await digest(archive), pauseDigest = await digest(pauseArchive);
const testedIds = ['google-calendar', 'google-drive', 'fastmail', 'pa-updates', 'icloud', 'obsidian'];
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
  // One RPC write only. Real updater self-replacement may disconnect its response.
  let response;
  try { response = await updater('switchSource', { reviewId, id, target, confirmSwitch: true }); }
  catch (error) { if (id !== 'pa-updates') throw error; }
  const receipt = await until('durable admission', async () => { const r = await raw().catch(() => null); return r?.reviewId === reviewId ? r : false; });
  assert.equal(receipt.id, id); assert.equal(receipt.target, target);
  assert.equal(receipt.configuration, 'preserved'); assert.equal(receipt.removalAttempted, false); assert.equal(receipt.removed, false);
  if (response) assert.equal(response.sourceSwitch.jobId, receipt.jobId);
  mutations.push({ jobId: receipt.jobId, id, target }); return receipt.jobId;
}
async function terminal(jobId, phase = 'complete') {
  const receipt = await until('finite runner terminal', async () => {
    const r = await raw(); assert.equal(r.jobId, jobId); return ['complete', 'attention'].includes(r.phase) ? r : false;
  });
  assert.equal(receipt.phase, phase, `Unexpected runner terminal boundary: ${receipt.reason}`);
  let state = await until('replacement observes receipt', async () => {
    let value; try { value = await updater('applicationStatus'); } catch { return false; }
    return value.sourceSwitch?.jobId === jobId && !value.applying && !value.sourceSwitch.syncReserved ? value : false;
  });
  if (phase === 'complete' && state.sourceSwitch.phase === 'attention') {
    // The existing provider refuses to auto-enable failed folders. This is a
    // visible manual-recovery result, not permission to broaden resume rights.
    assert.equal(state.sourceSwitch.reason, 'pause_required'); assert.equal(state.sourceSwitch.manualRecovery, true);
    snapshots.push(structuredClone(state.sourceSwitch));
    await runnerGone(); state = await updater('acknowledgeSourceRecovery', { jobId });
    results.push({ case: 'failed-folder-stays-paused', explicitVerificationAfterProviderManualRecovery: true });
  }
  assert.equal(state.sourceSwitch.phase, phase); assert.equal(state.sourceSwitch.configuration, 'preserved');
  assert.equal(state.sourceSwitch.removalAttempted, false); assert.equal(state.sourceSwitch.removed, false); snapshots.push(structuredClone(state.sourceSwitch)); return state;
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
async function runnerGone() {
  await until('owned finished runner exits', async () => {
    const launch = await readJson(join(receipts, 'launch.json'));
    try { process.kill(launch.pid, 0); return false; } catch (error) { assert.equal(error.code, 'ESRCH'); return true; }
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
  return lines.map(line => JSON.parse(line)).map(entry => /^plugin (google-calendar|google-drive|fastmail|pa-updates|icloud|obsidian) removed from /.exec(entry.msg ?? '')?.[1]).filter(Boolean);
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
async function refusedRecovery() { const result = await rpcResponse('pa-updates', 'acknowledgeSourceRecovery', { jobId: (await raw()).jobId }); assert.notEqual(result.body.ok, true); }
async function noReplay(label, jobId, { restart = false } = {}) {
  const beforeJobs = (await jobs()).map(j => j.id).sort(), before = await raw(), beforeDisposes = (await events()).filter(e => e.operation === 'dispose-enter').length, beforeRemovals = await nativeRemovals();
  if (restart) await host.restart(); else await cli('plugin', 'reload', 'pa-updates');
  const observed = await until('observer reload', async () => { let s; try { s = await updater('applicationStatus'); } catch { return false; } return s.sourceSwitch?.jobId === jobId ? s : false; });
  assert.equal(observed.sourceSwitch.jobId, jobId);
  await until('observer initial discovery completed', async () => {
    const state = await updater('applicationStatus'); return (state.sourceSwitch?.manualRecovery || !!state.offers) && !state.checking && !state.applying;
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
async function assertRestored() {
  const state = await fixture('icloud'); assert.equal(state.updatePause.jobId, null); assert.equal(state.owned, null);
  assert.deepEqual(state.mirrors.map(m => m.enabled), [true, false, false, false], 'only originally enabled healthy folders resume; failed/paused/retained stay paused');
  return state;
}
async function assertPaused() {
  const state = await fixture('icloud'); assert.equal(state.updatePause.jobId, null); assert.equal(state.owned, null);
  assert.ok(state.mirrors.every(m => !m.enabled && m.phase !== 'running'));
  return state;
}
try {
  const transport = join(root, 'transport-bin'); await mkdir(transport);
  await writeFile(join(transport, 'git'), `#!/bin/sh\nexec /usr/bin/git -c ${JSON.stringify('url.' + remote + '.insteadOf=' + origin)} "$@"\n`, { mode: 0o755 });
  host.env.PATH = transport + ':' + host.env.PATH;
  await mkdir(workspace, { recursive: true }); await writeFile(join(root, 'events.jsonl'), ''); await mode({});
  await git(workspace, 'init', '-b', 'main'); await git(workspace, 'config', 'user.name', 'Fixture'); await git(workspace, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\ndist/\n');
  // Workspace comparison covers all six enum entries even when only four are installed.
  for (const id of testedIds) {
    const directory = localPath(id); await mkdir(directory, { recursive: true });
    let manifest = { name: `bb-plugin-${id}`, version: id === 'icloud' ? '0.3.2' : id === 'obsidian' ? '0.3.1' : id === 'fastmail' ? '0.1.7' : '0.1.1', type: 'module',
      engines: { node: '>=22.18', bb: '>=0.46.0', bbPluginSdk: '>=0.6.37 <1' }, dependencies: { zod: '4.6.5' },
      bb: { name: 'Synthetic source mode', description: 'Owned native gate.', branding: { icon: 'Calendar' }, server: './server.ts' } };
    if (id === 'pa-updates') {
      await mkdir(join(directory, 'implementation')); await command('tar', ['--no-same-owner', '-xf', archive, '-C', join(directory, 'implementation')]);
      const production = await readJson(join(directory, 'implementation/package.json')); assert.equal(production.version, '0.5.1');
      manifest = { ...production, bb: { ...production.bb, app: './implementation/app.tsx' } };
      await writeFile(join(directory, 'package-lock.json'), await readFile(join(directory, 'implementation/package-lock.json')));
    }
    if (id === 'icloud') { await mkdir(join(directory, 'pause')); await command('tar', ['--no-same-owner', '-xf', pauseArchive, '-C', join(directory, 'pause')]); }
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'server.ts'), fixtureSource({ id, root, origin, remote, workspace, receipts, updater: id === 'pa-updates', cloud: id === 'icloud' }));
    await writeFile(join(directory, 'marker.ts'), 'export const marker="MANAGED";\n');
    await command(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  }
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'owned synthetic fixture baseline');
  await rm(remote, { recursive: true }); await git(root, 'clone', '--bare', workspace, remote); await git(workspace, 'remote', 'add', 'origin', origin); await git(workspace, 'fetch', 'origin');
  await writeFile(join(workspace, 'README.md'), 'Synthetic unpushed commit retained.\n'); await git(workspace, 'add', 'README.md'); await git(workspace, 'commit', '-m', 'owned unpushed fixture work');
  for (const id of testedIds) await writeFile(join(localPath(id), 'marker.ts'), 'export const marker="LOCAL";\n');
  const originalHead = await git(workspace, 'rev-parse', 'HEAD'), originalOrigin = await git(remote, 'rev-parse', 'main'), originalDirty = await git(workspace, 'status', '--porcelain');
  assert.notEqual(originalHead, originalOrigin); assert.ok(originalDirty);
  await writeFile(join(root, 'inputs.json'), JSON.stringify({ archiveDigest, pauseDigest, updaterVersion: '0.5.1', bb: host.pkg.version, originalHead, originalOrigin }, null, 2));
  stage = 'native-install-fixtures'; await host.start();
  assert.equal((await request('system/version')).body.experimental_directPluginSourceMoves, true, 'Gate requires the actual fork capability, never version inference or destructive fallback');
  assert.equal((await request('system/version')).body.experimental_catalogGitToLocalSourceMoves, true);
  const marketplace = join(root, 'marketplace'); await mkdir(marketplace);
  await writeFile(join(marketplace, 'marketplace.json'), JSON.stringify({ schemaVersion: 2, name: 'pa-for-bb', displayName: 'Synthetic PA marketplace', plugins: testedIds.map(id => ({ id, displayName: id, description: 'Owned fixture.', icon: 'Folder', author: { name: 'Fixture' }, source: { git: { url: origin, ref: 'main', subdir: 'plugins/' + id } } })) }));
  await cli('marketplace', 'add', 'path:' + marketplace, '--json');
  for (const id of testedIds) {
    await cli('plugin', 'install', id + '@pa-for-bb', '--yes', '--json');
    const p = await info(id); assert.equal(p.provenance, 'catalog'); assert.equal(p.catalogEntryId, id); assert.equal(p.catalogMarketplaceName, 'pa-for-bb');
  }
  results.push({ case: 'all-six-seeded-through-real-marketplace', provenance: 'catalog', count: 6 });
  const update = await fetch(host.env.BB_SERVER_URL + '/api/v1/plugins/fastmail/update', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' }, body: '{}' });
  assert.equal(update.status, 202); const updateJob = (await update.json()).job; assert.equal(typeof updateJob.id, 'string');
  await until('real native update settled', async () => {
    const j = (await request('plugins/update-jobs')).body.jobs.find(j => j.id === updateJob.id);
    assert.notEqual(j?.state, 'failed'); return j?.state === 'completed';
  });
  results.push({ case: 'completed-real-update-does-not-block-source-switch', state: 'completed' });
  await idle();
  const siblingInventory = (await request('plugins')).body.plugins.filter(p => !testedIds.includes(p.id)).map(p => ({ id: p.id, rootDir: p.rootDir, enabled: p.enabled, version: p.version }));
  const versionBefore = (await request('system/version')).body, runtimeBefore = await runtimeConfiguration();
  for (const id of testedIds) { const seeded = await rpc(id, 'seed'); assert.ok(seeded.kv && seeded.database && seeded.setting && seeded.secret && seeded.note); }
  const dataBefore = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar'));
  const dbBefore = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar/data.db'));
  assert.ok((await info('google-calendar')).schedules.some(s => s.name === 'fixture-sweep'));
  stage = 'pre-install-refusals';
  const calendarManifest = join(localPath('google-calendar'), 'package.json'), manifestBytes = await readFile(calendarManifest, 'utf8');
  for (const reason of ['identity', 'dependency', 'disabled']) {
    const beforeSource = await source('google-calendar'), beforeJobs = (await jobs()).map(j => j.id).sort(), beforeEvents = (await events()).length;
    if (reason === 'identity') await writeFile(calendarManifest, JSON.stringify({ ...JSON.parse(manifestBytes), name: 'bb-plugin-unrelated' }));
    if (reason === 'dependency') await writeFile(calendarManifest, JSON.stringify({ ...JSON.parse(manifestBytes), dependencies: { 'fixture-private-missing-dependency': '1.0.0' } }));
    if (reason === 'disabled') await cli('plugin', 'disable', 'google-calendar');
    const jobId = await admit('google-calendar', 'local'); await terminal(jobId, 'attention');
    assert.equal((await raw()).removalAttempted, false); assert.equal((await raw()).configuration, 'preserved');
    assert.deepEqual(await source('google-calendar'), beforeSource); assert.deepEqual((await jobs()).map(j => j.id).sort(), beforeJobs);
    if (reason === 'disabled') await cli('plugin', 'enable', 'google-calendar');
    const state = await fixture('google-calendar'); assert.equal(state.marker, 'MANAGED'); assert.ok(state.setting && state.secret && state.kv && state.database);
    assert.equal((await events()).slice(beforeEvents).filter(e => e.operation === 'dispose-enter').length, reason === 'disabled' ? 1 : 0);
    await writeFile(calendarManifest, manifestBytes); results.push({ case: `refusal-${reason}`, removalAttempted: false, originalStateRetained: true });
  }
  stage = 'calendar-roundtrip';
  for (const target of ['local', 'github']) {
    const jobId = await admit('google-calendar', target); await terminal(jobId); const state = await healthy('google-calendar', target, target === 'local' ? 'LOCAL' : 'MANAGED');
    assert.equal(state.p.version, '0.1.1'); assert.equal(state.state.setting, true); assert.equal(state.state.secret, true);
    assert.ok(state.state.kv && state.state.database && state.state.note); assert.ok(state.p.schedules.some(s => s.name === 'fixture-sweep')); assert.equal(state.p.id, 'google-calendar');
  }
  const dataAfter = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar')), dbAfter = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-calendar/data.db'));
  assert.equal(dataAfter.ino, dataBefore.ino); assert.equal(dataAfter.dev, dataBefore.dev); assert.equal(dbAfter.ino, dbBefore.ino);
  results.push({ case: 'calendar-git-path-git', sameVersionDifferentBehavior: true, settingsSecretsSchedulesAndIdentityRetained: true, kvDatabaseNoteAndInodesRetained: true });
  stage = 'drive-marketplace-roundtrip';
  const driveBefore = await stat(join(host.env.BB_DATA_DIR, 'plugins/google-drive/data.db'));
  for (const target of ['local', 'github']) {
    const jobId = await admit('google-drive', target); await terminal(jobId);
    const state = await healthy('google-drive', target, target === 'local' ? 'LOCAL' : 'MANAGED');
    assert.ok(state.state.setting && state.state.secret && state.state.kv && state.state.database && state.state.note);
    assert.equal(state.p.provenance, 'direct'); assert.equal(state.p.catalogEntryId ?? null, null);
  }
  assert.equal((await stat(join(host.env.BB_DATA_DIR, 'plugins/google-drive/data.db'))).ino, driveBefore.ino);
  results.push({ case: 'drive-marketplace-local-direct-git', configurationAndDirtyWorkKept: true, explicitDirectOwnershipAfterMove: true });
  stage = 'updater-self-roundtrip';
  for (const target of ['local', 'github']) {
    const jobId = await admit('pa-updates', target); const state = await terminal(jobId);
    await healthy('pa-updates', target, target === 'local' ? 'LOCAL' : 'MANAGED'); assert.equal(state.sourceSwitch.jobId, jobId);
    const self = await fixture('pa-updates'); assert.ok(self.kv && self.database && self.note); assert.equal(self.setting, true); assert.equal(self.secret, true);
    await noReplay(`self-${target}-observer-reload`, jobId);
  }
  await noReplay('self-final-process-restart', (await raw()).jobId, { restart: true }); await idle();
  results.push({ case: 'updater-real-native-self-roundtrip', actualDisposal: true, sameDurableJobAcrossReplacement: true });
  stage = 'native-install-failure';
  await terminal(await admit('google-calendar', 'local'));
  const previousRegistration = await source('google-calendar'), previousInfo = await info('google-calendar');
  await mode({ hideOriginAfterPrepare: 'google-calendar' });
  const failedJob = await admit('google-calendar', 'github');
  const failedReceipt = await until('native install failure', async () => { const r = await raw(); return r.jobId === failedJob && r.phase === 'attention' ? r : false; });
  assert.equal(failedReceipt.removed, false); assert.equal(failedReceipt.removalAttempted, false); assert.equal(failedReceipt.configuration, 'preserved');
  assert.equal(failedReceipt.installAdmitted, true); assert.equal(failedReceipt.reason, 'install_failed'); assert.ok(failedReceipt.nativeJobId);
  assert.deepEqual(await source('google-calendar'), previousRegistration); assert.equal((await info('google-calendar')).rootDir, previousInfo.rootDir);
  const retainedFailureState = await fixture('google-calendar'); assert.ok(retainedFailureState.setting && retainedFailureState.secret && retainedFailureState.kv && retainedFailureState.database && retainedFailureState.note);
  const failedNativeJobs = (await jobs()).filter(j => j.state === 'failed'); assert.ok(failedNativeJobs.some(j => j.id === failedReceipt.nativeJobId));
  await noReplay('failed-native-install-observer-reload', failedJob);
  await mode({}); await rename(remote + '.offline', remote);
  const recoveryJobs = (await jobs()).map(j => j.id).sort(), removalsBeforeAcknowledgment = await nativeRemovals();
  await runnerGone(); const recovered = await updater('acknowledgeSourceRecovery', { jobId: failedJob });
  assert.deepEqual(await nativeRemovals(), removalsBeforeAcknowledgment, 'Recovery is verification, not another write');
  assert.equal(recovered.sourceSwitch.phase, 'attention'); assert.equal(recovered.sourceSwitch.recovery, 'original_verified'); assert.equal(recovered.sourceSwitch.manualRecovery, false);
  assert.deepEqual((await jobs()).map(j => j.id).sort(), recoveryJobs); await healthy('google-calendar', 'local', 'LOCAL'); await idle();
  await noReplay('failed-native-install-process-restart', failedJob, { restart: true }); await idle();
  results.push({ case: 'native-install-failure-keeps-previous-registration', nativeFailedJobs: failedNativeJobs.length, configuration: 'preserved', noReplayOnReloadOrRestart: true, originalVerifiedWithoutInstall: true });
  await terminal(await admit('google-calendar', 'github'));
  stage = 'real-update-pause-drain-and-preserving-source-moves';
  await mode({ draining: true }); const drainEvents = (await events()).length, cloudJob = await admit('icloud', 'local');
  await until('native updater reserves active drain', async () => { const s = await fixture('icloud'); return s.updatePause.jobId === cloudJob && s.mirrors.some(m => m.phase === 'running'); });
  assert.equal((await raw()).removalAttempted, false); assert.equal((await raw()).syncReserved, true);
  assert.ok(!(await events()).slice(drainEvents).some(e => e.id === 'icloud' && e.operation === 'dispose-enter'));
  await mode({}); await terminal(cloudJob); await healthy('icloud', 'local', 'LOCAL'); await assertRestored();
  const moves = [['icloud', 'github'], ['obsidian', 'local'], ['obsidian', 'github']];
  for (const [id, target] of moves) {
    await rpc('icloud', 'reset'); const job = await admit(id, target); await terminal(job); await healthy(id, target, target === 'local' ? 'LOCAL' : 'MANAGED'); await assertRestored();
  }
  const pauseEvents = (await events()).slice(drainEvents), reserves = pauseEvents.filter(e => e.operation === 'reserve'), userPauses = pauseEvents.filter(e => e.operation === 'user-pause');
  assert.ok(reserves.length >= 4 && reserves.every(e => e.caller === 'plugin' && e.callerPlugin === 'pa-updates'));
  assert.equal(userPauses.length, 0, 'configuration-preserving helper never user-pauses');
  assert.ok(pauseEvents.filter(e => e.operation === 'release').every(e => JSON.stringify(e.ownedIds.slice().sort()) === JSON.stringify(['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'])));
  assert.ok(pauseEvents.filter(e => e.id === 'icloud' && e.operation === 'dispose-enter').every(e => JSON.stringify(e.ownedIds.slice().sort()) === JSON.stringify(['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333']) && e.mirrors.every(m => !m.enabled && m.phase !== 'running')));
  for (const id of ['icloud', 'obsidian']) { const state = await fixture(id); assert.ok(state.kv && state.database && state.note); assert.equal(state.setting, true); assert.equal(state.secret, true); }
  results.push({ case: 'original-UpdatePause-native-callers-and-drain', allFourMirrorClasses: true, helperClientPauses: userPauses.length, pluginCallerReservations: reserves.length, originalResumeRightsAtReplacementAndRelease: true, automaticEnables: pauseEvents.filter(e => e.operation === 'AUTOMATIC-ENABLE').length, pairedVersions: ['0.3.2', '0.3.1'], noteKvDatabaseRetained: true });
  stage = 'owned-runner-death-pending-native-install';
  await mode({ blockDispose: 'google-calendar' }); const deathStart = (await events()).length, deathJob = await admit('google-calendar', 'local');
  await until('native install entered actual disposal', async () => (await events()).slice(deathStart).some(e => e.id === 'google-calendar' && e.operation === 'dispose-enter'));
  await until('native job identity persisted', async () => (await raw()).nativeJobId);
  const launch = await readJson(join(receipts, 'launch.json'));
  assert.equal(launch.jobId, deathJob); assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
  for (const name of ['ready.json', 'permit.json']) assert.deepEqual(await readJson(join(receipts, name)), launch);
  process.kill(launch.pid, 0); await refusedRecovery();
  process.kill(launch.pid, 'SIGKILL'); // ONLY the positive PID bound to this owned UUID.
  await until('owned runner positively gone', async () => { try { process.kill(launch.pid, 0); return false; } catch (e) { assert.equal(e.code, 'ESRCH'); return true; } });
  const afterDeathDisk = await readFile(join(receipts, 'receipt.json'), 'utf8');
  const deadState = await attention(deathJob); assert.equal(deadState.sourceSwitch.reason, 'interrupted');
  assert.equal(await readFile(join(receipts, 'receipt.json'), 'utf8'), afterDeathDisk, 'Observation cannot transfer disk ownership');
  const interrupted = await raw(); assert.equal(interrupted.phase, 'running'); assert.equal(interrupted.removed, false); assert.equal(interrupted.configuration, 'preserved'); assert.equal(interrupted.installAdmitted, true);
  await refusedRecovery(); // A positively dead helper cannot settle a running native write.
  await mode({}); await until('native job settles after release', async () => {
    const job = (await request('plugins/install-jobs/' + interrupted.nativeJobId)).body.job; return job.state === 'succeeded';
  });
  await healthy('google-calendar', 'local', 'LOCAL');
  const beforeAcknowledgmentJobs = (await jobs()).map(j => j.id).sort();
  const acknowledged = await updater('acknowledgeSourceRecovery', { jobId: deathJob });
  assert.equal(acknowledged.sourceSwitch.recovery, 'target_verified'); assert.equal(acknowledged.sourceSwitch.configuration, 'preserved');
  assert.equal(acknowledged.sourceSwitch.removed, false); assert.equal(acknowledged.sourceSwitch.installAdmitted, true);
  assert.deepEqual((await jobs()).map(j => j.id).sort(), beforeAcknowledgmentJobs); await idle();
  results.push({ case: 'real-owned-runner-SIGKILL-during-native-install', immediateObserveOnlyAttention: true, aliveOwnerAndActiveNativeJobRefused: true, knownSettledNativeJobAllowsVerificationWithoutRestart: true, noWriteReplay: true });
  stage = 'failed-initial-reserve-null-hold';
  await rpc('icloud', 'allPaused'); await mode({ failInitial: true }); const nullHoldEvents = (await events()).length, nullJob = await admit('icloud', 'local');
  await until('pre-install reserve refusal', async () => { const r = await raw(); return r.jobId === nullJob && r.phase === 'attention'; });
  const nullReceipt = await raw(); assert.equal(nullReceipt.removalAttempted, false); assert.equal(nullReceipt.syncReserved, true); assert.equal(nullReceipt.pauseHandoff, false);
  assert.equal((await fixture('icloud')).updatePause.jobId, null); const nullSource = await source('icloud');
  await refusedRecovery(); await mode({}); await refusedRecovery();
  const nullOldPid = (await readJson(join(receipts, 'intent.json'))).serverPid;
  await host.restart(); await attention(nullJob); assert.throws(() => process.kill(nullOldPid, 0), { code: 'ESRCH' });
  const cleanupJobs = (await jobs()).map(j => j.id).sort();
  const cleaned = await updater('acknowledgeSourceRecovery', { jobId: nullJob }); assert.equal(cleaned.sourceSwitch.recovery, 'original_verified'); assert.equal(cleaned.sourceSwitch.syncReserved, false); assert.equal(cleaned.sourceSwitch.manualRecovery, false);
  assert.deepEqual(await source('icloud'), nullSource); assert.deepEqual((await jobs()).map(j => j.id).sort(), cleanupJobs); await assertPaused();
  const cleanupEvents = (await events()).slice(nullHoldEvents); const barrier = cleanupEvents.filter(e => e.operation === 'reserve');
  assert.equal(barrier.length, 2); assert.ok(barrier.every(e => e.updateJob === nullJob && e.callerPlugin === 'pa-updates'));
  assert.equal(cleanupEvents.filter(e => e.operation === 'user-pause').length, 0); assert.ok(cleanupEvents.filter(e => e.operation === 'release').every(e => e.ownedIds.length === 0));
  results.push({ case: 'failed-initial-Pause-null-hold', preRestartRecoveryRefused: true, originalServerPositivelyGone: true, sameUuidSerialBarrier: true, allMirrorClientPauses: 0, zeroAutomaticEnables: true });
  stage = 'final-invariants-and-evidence';
  // A deliberately rejected native RPC sets BB's sticky statusDetail. Exercise
  // that authorization boundary last, rather than hiding it with a reload.
  const denied = await rpcResponse('icloud', 'pause', { updateJob: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }); assert.notEqual(denied.body.ok, true, 'A REST client cannot impersonate updater caller');
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), originalHead); assert.equal(await git(remote, 'rev-parse', 'main'), originalOrigin); assert.equal(await git(workspace, 'status', '--porcelain'), originalDirty);
  assert.deepEqual((await request('plugins')).body.plugins.filter(p => !testedIds.includes(p.id)).map(p => ({ id: p.id, rootDir: p.rootDir, enabled: p.enabled, version: p.version })), siblingInventory);
  assert.deepEqual((await request('system/version')).body, versionBefore); assert.deepEqual(await runtimeConfiguration(), runtimeBefore);
  const allEvents = await events(); await jobs(); const allJobs = [...nativeJobHistory.values()], removalIds = await nativeRemovals();
  const nativeRemovalsById = Object.fromEntries(testedIds.map(id => [id, removalIds.filter(removed => removed === id).length]));
  assert.deepEqual(nativeRemovalsById, Object.fromEntries(testedIds.map(id => [id, 0])));
  assert.equal(allJobs.filter(job => job.state === 'failed').length, 1);
  assert.ok(mutations.length >= 12); assert.equal(allEvents.filter(e => e.operation === 'user-pause').length, 0);
  assert.ok(allEvents.filter(e => e.operation === 'AUTOMATIC-ENABLE').every(e => e.mirrorId === '11111111-1111-4111-8111-111111111111'));
  const log = (await Promise.all([join(root, 'server.log'), join(host.env.BB_DATA_DIR, 'logs/server.1.log'), ...testedIds.map(id => join(host.env.BB_DATA_DIR, 'plugins', id, 'logs/plugin.log'))].map(path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })))).join('\n');
  const receiptText = await readFile(join(receipts, 'receipt.json'), 'utf8');
  assert.ok(!log.includes('PRIVATE_SENTINEL')); assert.ok(!receiptText.includes('PRIVATE_SENTINEL')); assert.ok(log.includes('icloud stage=update_pause outcome=unavailable'));
  await writeFile(join(root, 'receipts-summary.json'), JSON.stringify(snapshots, null, 2));
  await writeFile(join(root, 'install-jobs.json'), JSON.stringify(allJobs, null, 2));
  const summary = { bb: host.pkg.version, forkPackage: resolve(forkPackage), directSourceMovesCapability: true, catalogGitToLocalCapability: true, initialMarketplaceInstalls: 6, updater: '0.5.1', archiveDigest, pauseDigest, originalHandlersAndSourceRunner: true, nativeRuntime: false,
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
