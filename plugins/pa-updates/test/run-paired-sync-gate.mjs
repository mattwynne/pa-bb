// One opt-in, generated native iCloud/Obsidian scenario. Run only in a fresh,
// unprivileged Linux container with no mounts, credentials or personal data.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
const [bbPath, updaterArchive, pairArchive] = process.argv.slice(2);
assert.ok(bbPath && updaterArchive && pairArchive, 'BB_APP UPDATER_SOURCE_TAR PAIR_SOURCE_TAR required');
const gate = await createGateHost(bbPath, { nativeRuntime: true }), here = dirname(fileURLToPath(import.meta.url));
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const eventsPath = join(gate.root, 'paired-events.jsonl'), alias = join(gate.root, 'alias');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let stage = 'isolation', completed = false;
const at = value => { stage = value; console.log(JSON.stringify({ stage })); };
const rpc = async (id, method, input = null) => {
  const result = await gate.request(`plugins/${id}/rpc/${method}`, input);
  assert.equal(result.status, 200, `generated ${id}/${method} RPC`); assert.equal(result.body.ok, true); return result.body.result;
};
const events = async () => (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
async function wait(test, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await test(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`generated gate timeout: ${stage}`);
}
const tool = async (name, input) => {
  const result = await rpc('obsidian', 'fixtureInvoke', { name, input }); assert.equal(result.isError, false, `original ${name} handler`); return JSON.parse(result.text);
};
const build = async id => {
  const root = join(gate.repo, 'plugins', id);
  await gate.command(process.execPath, [gate.npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  await gate.cli('plugin', 'build', root);
};
const version = async (id, value) => {
  const root = join(gate.repo, 'plugins', id), manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  manifest.version = lock.version = lock.packages[''].version = value;
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n'); await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
};
try {
  await gate.assertNativeIsolation(); await writeFile(eventsPath, '', { mode: 0o600 });
  await mkdir(join(alias, 'enabled'), { recursive: true }); await mkdir(join(alias, 'paused'));
  // Ordinary bisync refuses an empty prior listing. Match the archived
  // generated-alias recipe; never reset a failed source to manufacture a pass.
  for (const folder of ['enabled', 'paused']) await writeFile(join(alias, folder, 'Seed.md'), '# Generated baseline seed\n');
  Object.assign(gate.env, { BB_GENERATED_ALIAS_ROOT: alias, BB_FIXTURE_EVENTS: eventsPath, PA_GENERATED_NATIVE_GATE: '1' });
  at('packages'); await gate.command('tar', ['--no-same-owner', '-xf', pairArchive, '-C', gate.repo]);
  const updater = join(gate.repo, 'plugins', 'pa-updates'); await mkdir(updater, { recursive: true }); await gate.command('tar', ['--no-same-owner', '-xf', updaterArchive, '-C', updater]);
  for (const id of ['icloud', 'obsidian']) {
    const root = join(gate.repo, 'plugins', id); await rename(join(root, 'server.ts'), join(root, 'production.ts'));
    await writeFile(join(root, 'server.ts'), await readFile(join(here, 'paired-fixtures', `${id}-server.txt`)));
    await version(id, '0.3.1'); await build(id);
  }
  await rename(join(updater, 'server.ts'), join(updater, 'production.ts'));
  await writeFile(join(updater, 'server.ts'), `import plugin from './production.ts';import {applicationPorts} from './adapters/application.ts';import {appendFile} from 'node:fs/promises';export default async function(bb){const ports=applicationPorts(bb,${JSON.stringify(gate.repo)});ports.runtime=undefined;const update=ports.update;ports.update=async(...args)=>{await appendFile(process.env.BB_FIXTURE_EVENTS,JSON.stringify({event:'update-admission',id:args[0],at:Date.now()})+'\\n');return update(...args);};return plugin(bb,{feed:async()=>null,inventory:async()=>({installed:null,runtime:null})},ports);}`);
  await build('pa-updates'); await writeFile(join(gate.repo, '.gitignore'), 'node_modules/\ndist/\n');
  await gate.git('init', '-q', '-b', 'main'); await gate.git('config', 'user.name', 'Generated fixture'); await gate.git('config', 'user.email', 'fixture@example.invalid'); await gate.git('config', 'commit.gpgsign', 'false');
  await gate.git('add', '.'); await gate.git('commit', '-qm', 'generated supported pair');
  at('install'); await gate.start();
  for (const id of ['icloud', 'obsidian', 'pa-updates']) {
    const result = JSON.parse(await gate.cli('plugin', 'install', `git:${gate.repo}@ref:main`, '--subdirectory', `plugins/${id}`, '--yes', '--json'));
    assert.equal(result.plugin.status, 'running', `${id} real factory starts`);
    if (id === 'icloud') for (const sourceId of ids) await rpc('icloud', 'pause', { id: sourceId });
  }
  await wait(async () => { const state = await rpc('pa-updates', 'applicationStatus'); assert.equal(state.failure, null); return state.review && !state.checking; });
  at('generated-notes'); const notes = [];
  for (const [index, vaultId] of ids.entries()) {
    await rpc('obsidian', 'connect', { vaultId }); const path = 'Generated.md', text = `# Generated ${index ? 'paused' : 'enabled'} note\nPreserve this local operation.\n`;
    const created = await tool('obsidian_create_note', { vaultId, path, text }); assert.equal(created.receipt.outcome, 'saved_locally_pending_sync');
    const status = await tool('obsidian_status', { vaultId, path, operationId: created.operationId });
    const receipt = status.receipts.find(row => row.operationId === created.operationId); assert.ok(receipt);
    notes.push({ vaultId, path, text, hash: (await tool('obsidian_read_note', { vaultId, path })).hash, operationId: created.operationId, receipt });
  }
  at('publish'); for (const id of ['icloud', 'obsidian']) { await version(id, '0.3.2'); await build(id); }
  await gate.git('add', '.'); await gate.git('commit', '-qm', 'next ordinary generated pair');
  const review = await rpc('pa-updates', 'review'); assert.equal(review.failure, null); assert.deepEqual(review.review.rows.map(row => row.id).sort(), ['icloud', 'obsidian']);
  for (const row of review.review.rows) { assert.equal(row.local, 'stock'); assert.equal(row.available, '0.3.2'); }
  at('active-native-sync'); const initialReady = (await events()).find(row => row.event === 'icloud-ready'), mirror = join(initialReady.root, 'mirrors', ids[0]);
  const bulk = Buffer.alloc(8 * 1024 * 1024, 'generated-transfer-'); await writeFile(join(alias, 'enabled', 'Generated.bin'), bulk);
  await rpc('icloud', 'enable', { id: ids[0] });
  // Use the untouched minute schedule, not a synthetic sync implementation.
  await wait(async () => { const cloud = await rpc('icloud', 'status'), source = cloud.mirrors.find(row => row.id === ids[0]); assert.equal(source.failure, null, 'Generated sync must be healthy'); return source.phase === 'running' && (await readdir(mirror)).some(name => name.endsWith('.partial')); }, 90000);
  const started = (await events()).filter(row => row.event === 'native-start' && row.id === ids[0]).at(-1); assert.ok(started);
  at('reserve-and-drain'); const admitted = await rpc('pa-updates', 'apply', { reviewId: review.review.id, choices: [] });
  const held = await wait(async () => {
    const state = await rpc('pa-updates', 'applicationStatus'), cloud = await rpc('icloud', 'status');
    assert.equal(cloud.mirrors.find(row => row.id === ids[1]).enabled, false);
    return state.job.phase === 'quiescing' && cloud.updatePause.jobId === admitted.job.id && cloud.mirrors.some(row => row.phase === 'running') ? { state, cloud } : false;
  });
  assert.equal(held.cloud.updatePause.version, 1);
  at('native-update-and-restore');
  const done = await wait(async () => { const state = await rpc('pa-updates', 'applicationStatus'); return !state.applying && ['complete', 'attention'].includes(state.job.phase) ? state : false; });
  assert.equal(done.job.phase, 'complete'); assert.equal(done.job.failure, null); assert.equal(done.job.syncReserved, false);
  assert.equal(done.job.id, admitted.job.id); assert.equal(done.job.receipts.length, 2);
  for (const receipt of done.job.receipts) { assert.equal(receipt.outcome, 'updated'); assert.equal(receipt.actual, '0.3.2'); }
  const history = await events(), disposed = history.find(row => row.event === 'icloud-dispose' && row.reservation?.jobId === done.job.id);
  const reloaded = history.find(row => row.event === 'icloud-ready' && row.reservation?.jobId === done.job.id);
  const drained = history.find(row => row.event === 'native-end' && row.id === ids[0] && row.at >= started.at);
  assert.ok(disposed && reloaded && drained); assert.equal(drained.success, true); assert.ok(drained.at <= disposed.at && disposed.at <= reloaded.at);
  for (const point of [disposed, reloaded]) { assert.deepEqual(point.reservation.ownedIds, [ids[0]]); assert.deepEqual(point.enabledIds, []); }
  const cloud = await rpc('icloud', 'status'); assert.equal(cloud.updatePause.jobId, null);
  assert.deepEqual(cloud.mirrors.filter(row => row.enabled).map(row => row.id), [ids[0]]);
  assert.equal(sha(await readFile(join(mirror, 'Generated.bin'))), sha(bulk));
  at('resumed-native-schedule');
  await wait(async () => (await events()).find(row => row.event === 'native-end' && row.id === ids[0] && row.at > reloaded.at && row.success), 90000);
  assert.equal((await events()).some(row => row.event === 'native-start' && row.id === ids[1]), false, 'The user-paused sibling never starts a native run');
  at('preserved-notes-and-receipts');
  for (const note of notes) {
    const read = await tool('obsidian_read_note', { vaultId: note.vaultId, path: note.path }); assert.equal(read.text, note.text); assert.equal(read.hash, note.hash);
    const status = await tool('obsidian_status', { vaultId: note.vaultId, path: note.path, operationId: note.operationId });
    assert.deepEqual(status.receipts.find(row => row.operationId === note.operationId), note.receipt); assert.deepEqual(status.receiptFailures, []);
  }
  assert.equal(await readFile(join(alias, 'enabled', 'Generated.md'), 'utf8'), notes[0].text);
  assert.equal((await readdir(join(alias, 'paused'))).includes('Generated.md'), false, 'User-paused note remains local, not silently synchronized');
  const status = await rpc('obsidian', 'status'); assert.deepEqual(status.vaults.map(row => row.vaultId).sort(), [...ids].sort());
  for (const id of ['icloud', 'obsidian']) assert.equal(history.filter(row => row.event === 'update-admission' && row.id === id).length, 1);
  assert.equal(history.filter(row => row.event === 'obsidian-ready').length, 2);
  at('saved-result-reload'); await gate.cli('plugin', 'disable', 'pa-updates'); await gate.cli('plugin', 'enable', 'pa-updates');
  const restored = await wait(async () => { const state = await rpc('pa-updates', 'applicationStatus'); return !state.checking ? state : false; });
  assert.deepEqual(restored.job, done.job); assert.equal(restored.review.id, restored.job.reviewId, 'Startup discovery must retain visible receipts');
  const result = { evidence: 'Generated local alias; real factories, original Obsidian handlers and native BB integration updates; no accounts or provider sessions', bb: gate.pkg.version, node: process.version, platform: `${process.platform}-${process.arch}`, rclone: '1.75.2', fixtureVersions: { before: '0.3.1', installed: '0.3.2' }, nativeRunMs: drained.at - started.at, observedNativePartial: true, reservedWhileNativeSyncRunning: true, reservationSurvivedNativeDisposalAndReload: true, nativeDrainBeforeDisposal: true, resumedNativeScheduleCompleted: true, restoredPreviouslyEnabledFolders: 1, preservedUserPausedFolders: 1, preservedGeneratedNotesAndReceipts: notes.length, nativeWriteAdmissions: { icloud: 1, obsidian: 1 }, updaterReloadRetainedVisibleResult: true, sourceArchives: { updaterSha256: sha(await readFile(updaterArchive)), pairSha256: sha(await readFile(pairArchive)) } };
  await writeFile(join(gate.root, 'paired-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result)); completed = true;
} catch (error) { console.error('Generated paired gate failed at:', stage); throw error; }
finally { await gate.finish(completed); }
