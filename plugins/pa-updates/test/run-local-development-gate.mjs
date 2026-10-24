// Original updater handlers with fresh native local-path installations.
// Synthetic repositories/settings/secrets only; never use a live BB data dir.
// node test/run-local-development-gate.mjs /path/to/bb-app /path/to/updater.tar
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGateHost } from './gate-host.mjs';
import { createServer } from 'node:http';
const host = await createGateHost(process.argv[2]), archive = resolve(process.argv[3]);
const { root, command, cli, npm, request } = host;
const workspace = join(host.home, 'src', 'pa-bb'), origin = host.repo, seed = join(root, 'contributor');
const counter = join(root, 'self-admissions'), modeFile = join(root, 'runtime-mode'), generationFile = join(root, 'restart-generation');
let restartRequests = 0, restartCount = 0, restartTask, restartError = false;
const control = createServer((request, response) => {
  if (request.method !== 'POST') { response.writeHead(404).end(); return; }
  restartRequests++; restartCount++; response.writeHead(202).end();
  restartTask = host.restart().then(() => writeFile(generationFile, 'after')).catch(() => { restartError = true; });
});
await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
const controlUrl = `http://127.0.0.1:${control.address().port}`;
const ids = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian', 'pa-updates'];
let completed = false, stage = 'setup';
const git = async (cwd, ...args) => (await command('git', args, cwd)).trim();
const rpc = async (id, method, input = null) => {
  const response = await request(`plugins/${id}/rpc/${method}`, input);
  assert.equal(response.body.ok, true, `RPC ${method} must succeed`); return response.body.result;
};
async function settle(jobId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    assert.equal(restartError, false, 'test restart must succeed');
    let state; try { state = await rpc('pa-updates', 'applicationStatus'); } catch { /* replacement disconnect, observation only */ }
    if (state && !state.checking && !state.applying && state.review) {
      assert.equal(state.failure, null);
      // A replacement can answer before its queued initial discovery starts.
      // Wait for that real scan, not a guessed delay, before mutating Git.
      if (!state.offers && (!jobId || state.job?.selfIntent)) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      if (jobId) { assert.equal(state.job?.id, jobId); assert.equal(state.job?.phase, 'complete', JSON.stringify(state.job)); }
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('local-development deadline');
}
const check = async () => { await rpc('pa-updates', 'review'); return settle(); };
const applyLocal = async () => {
  const review = (await check()).review, started = await rpc('pa-updates', 'applyLocal', { reviewId: review.id });
  assert.ok(started.job); return settle(started.job.id);
};
try {
  await mkdir(workspace, { recursive: true }); await writeFile(counter, ''); await writeFile(modeFile, 'none'); await writeFile(generationFile, 'before');
  await git(origin, 'init', '--bare', '--initial-branch=main');
  await git(workspace, 'init', '-b', 'main');
  await git(workspace, 'config', 'user.name', 'Fixture'); await git(workspace, 'config', 'user.email', 'fixture@example.invalid');
  await git(workspace, 'remote', 'add', 'origin', origin);
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\ndist/\n');
  for (const id of ids.filter(id => id !== 'pa-updates')) {
    const directory = join(workspace, 'plugins', id); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `bb-plugin-${id}`, version: '1.0.0', type: 'module', dependencies: { zod: '4.6.5' },
      engines: { bb: '>=0.46.0', bbPluginSdk: '>=0.6.37 <1' }, bb: { name: 'Synthetic source', description: 'Disposable development fixture.', branding: { icon: 'Calendar' }, server: './server.ts' } }));
    await writeFile(join(directory, 'marker.ts'), 'export const marker = "A";\n');
    await writeFile(join(directory, 'server.ts'), `import{z}from'zod';import{marker}from'./marker.ts';export default async function(bb){
const settings=bb.settings.define({note:{type:'string',label:'Setting',default:''},credential:{type:'string',label:'Secret',secret:true}});
if(await bb.storage.kv.get('sentinel')==null)await bb.storage.kv.set('sentinel','SYNTHETIC_STATE');
bb.rpc.register({status:{input:z.null(),output:z.object({marker:z.string(),state:z.boolean(),setting:z.boolean(),secret:z.boolean()})}},{status:async()=>{const value=await settings.get();return{marker,state:await bb.storage.kv.get('sentinel')==='SYNTHETIC_STATE',setting:value.note==='SYNTHETIC_SETTING',secret:value.credential==='SYNTHETIC_SECRET'}}});}`);
  }
  const updater = join(workspace, 'plugins', 'pa-updates'); await mkdir(join(updater, 'implementation'), { recursive: true });
  await command('tar', ['--no-same-owner', '-xf', archive, '-C', join(updater, 'implementation')]);
  const manifest = JSON.parse(await readFile(join(updater, 'implementation/package.json'), 'utf8'));
  manifest.version = '1.0.0'; manifest.bb.app = './implementation/app.tsx';
  await writeFile(join(updater, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(updater, 'package-lock.json'), await readFile(join(updater, 'implementation/package-lock.json')));
  await writeFile(join(updater, 'fixture-marker.ts'), 'export const marker = "A";\n');
  await writeFile(join(updater, 'server.ts'), `import plugin from'./implementation/server.ts';import{applicationPorts}from'./implementation/adapters/application.ts';import{appendFileSync,readFileSync}from'node:fs';import{z}from'zod';import{marker}from'./fixture-marker.ts';
export default bb=>{const ports=applicationPorts(bb,${JSON.stringify(origin)},async()=>${JSON.stringify(workspace)});
const restarted=()=>readFileSync(${JSON.stringify(generationFile)},'utf8')==='after';
ports.runtime={inspect:async()=>({target:readFileSync(${JSON.stringify(modeFile)},'utf8')==='restart'?{id:'fixture-host',name:'Fixture'}:null,runningThreadCount:0,rows:readFileSync(${JSON.stringify(modeFile)},'utf8')==='restart'?[{id:'bb',installed:${JSON.stringify(host.pkg.version)},available:restarted()?null:${JSON.stringify(host.pkg.version)},source:'source',fingerprint:restarted()?'after':'before',state:restarted()?'current':'ready',reason:null}]:[]}),
updateCli:async()=>{throw new Error('No CLI installation')},prepareBb:async()=>({previousResultId:null,requestedAt:new Date().toISOString(),fromVersion:${JSON.stringify(host.pkg.version)},fromCommit:null,hostId:'fixture-host'}),
applyBb:async()=>{await fetch(${JSON.stringify(controlUrl)},{method:'POST'})},reconcileBb:async()=>restarted()?{state:'updated',actual:${JSON.stringify(host.pkg.version)}}:{state:'pending',actual:null}};
const apply=ports.self.apply;ports.self.apply=(...args)=>{appendFileSync(${JSON.stringify(counter)},'self\\n');return apply(...args)};
const api=new Proxy(bb,{get(target,key){if(key!=='rpc')return Reflect.get(target,key,target);return{...target.rpc,register(contract,handlers){return target.rpc.register({...contract,applicationStatus:{...contract.applicationStatus,output:contract.applicationStatus.output.extend({fixtureMarker:z.string()})}},{...handlers,applicationStatus:async(...args)=>({...await handlers.applicationStatus(...args),fixtureMarker:marker})})}}}});
return plugin(api,undefined,ports)};`);
  for (const directory of [join(workspace, 'plugins/google-calendar'), updater]) await command(process.execPath, [npm, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'initial'); await git(workspace, 'push', 'origin', 'main');
  stage = 'install'; await host.start();
  await cli('plugin', 'install', `path:${join(workspace, 'plugins/google-calendar')}`, '--yes', '--json');
  await cli('plugin', 'config', 'google-calendar', 'set', 'note', 'SYNTHETIC_SETTING');
  await cli('plugin', 'config', 'google-calendar', 'set', 'credential', 'SYNTHETIC_SECRET');
  await cli('plugin', 'install', `path:${updater}`, '--yes', '--json'); await settle();
  stage = 'confirm-initial-path-loads';
  const initial = await check(); assert.equal(initial.review.localRows.length, 2);
  const first = await applyLocal(); assert.equal(first.fixtureMarker, 'A'); assert.equal(first.job.mode, 'local');
  assert.equal(first.job.receipts.length, 2); assert.ok(first.job.receipts.every(row => row.actual === '1.0.0'));
  assert.equal((await check()).review.localRows.length, 0);
  stage = 'edit-try-before-push';
  await writeFile(join(workspace, 'plugins/google-calendar/marker.ts'), 'export const marker = "B";\n');
  await writeFile(join(updater, 'fixture-marker.ts'), 'export const marker = "B";\n');
  assert.equal((await rpc('google-calendar', 'status')).marker, 'A');
  const beforePush = await git(workspace, 'rev-parse', 'HEAD');
  const local = await applyLocal(); assert.equal(local.fixtureMarker, 'B');
  assert.deepEqual(await rpc('google-calendar', 'status'), { marker: 'B', state: true, setting: true, secret: true });
  assert.ok(local.job.receipts.every(row => row.outcome === 'updated' && row.actual === '1.0.0'));
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), beforePush, 'applying did not commit');
  assert.equal(await git(origin, 'rev-parse', 'main'), beforePush, 'applying did not push');
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-m', 'local work tried first'); await git(workspace, 'push', 'origin', 'main');
  const pushed = await check(); await writeFile(join(root, 'pushed-state.json'), JSON.stringify(pushed), { mode: 0o600 }); assert.ok(pushed.review.inventory.every(row => row.workspace && !row.workspace.local && row.applied === row.workspace.working));
  stage = 'another-contributor';
  await git(root, 'clone', origin, seed); await git(seed, 'config', 'user.name', 'Contributor'); await git(seed, 'config', 'user.email', 'contributor@example.invalid');
  await writeFile(join(seed, 'plugins/google-calendar/marker.ts'), 'export const marker = "C";\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'origin code without a version bump'); await git(seed, 'push', 'origin', 'main');
  const incoming = await check(); assert.equal(incoming.review.workspace.behind, true); assert.deepEqual(incoming.review.rows.map(row => row.id), ['google-calendar']);
  const started = await rpc('pa-updates', 'apply', { reviewId: incoming.review.id, choices: [] }), updated = await settle(started.job.id);
  assert.equal(updated.job.sourceUpdate.outcome, 'updated'); assert.equal(updated.job.receipts[0].actual, '1.0.0');
  assert.deepEqual(await rpc('google-calendar', 'status'), { marker: 'C', state: true, setting: true, secret: true });
  assert.equal(await git(workspace, 'rev-parse', 'HEAD'), await git(origin, 'rev-parse', 'main'));
  assert.equal(await git(workspace, 'status', '--porcelain'), '');
  stage = 'source-only-update';
  await writeFile(join(seed, 'README.md'), 'Repository documentation update.\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'source-only update'); await git(seed, 'push', 'origin', 'main');
  const sourceOnly = await check(); assert.deepEqual(sourceOnly.review.rows, []); assert.equal(sourceOnly.review.workspace.behind, true);
  const sync = await rpc('pa-updates', 'apply', { reviewId: sourceOnly.review.id, choices: [] }), synced = await settle(sync.job.id);
  assert.deepEqual(synced.job.receipts, []); assert.equal(synced.job.sourceUpdate.outcome, 'updated');
  assert.equal((await rpc('google-calendar', 'status')).marker, 'C');
  stage = 'self-loaded-by-bb-restart';
  await writeFile(join(seed, 'plugins/pa-updates/fixture-marker.ts'), 'export const marker = "C";\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'updater source for restart'); await git(seed, 'push', 'origin', 'main');
  await writeFile(modeFile, 'restart');
  const beforeRestart = await check(); assert.deepEqual(beforeRestart.review.rows.map(row => row.id), ['pa-updates']);
  const restartStart = await rpc('pa-updates', 'apply', { reviewId: beforeRestart.review.id, choices: [] }), restarted = await settle(restartStart.job.id);
  assert.equal(restarted.fixtureMarker, 'C'); assert.equal(restarted.job.receipts[0].outcome, 'updated');
  assert.equal(restarted.job.runtimeReceipts[0].outcome, 'updated'); assert.equal(restartRequests, 1);
  assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 2, 'BB startup applied path self; no extra self reload');
  assert.deepEqual(await rpc('google-calendar', 'status'), { marker: 'C', state: true, setting: true, secret: true });
  await writeFile(modeFile, 'none');
  stage = 'out-of-band-restart-and-source-restore';
  const calendarMarker = join(workspace, 'plugins/google-calendar/marker.ts');
  await writeFile(calendarMarker, 'export const marker = "TEMPORARY";\n');
  restartCount++; await host.restart(); await settle();
  assert.equal((await rpc('google-calendar', 'status')).marker, 'TEMPORARY');
  await writeFile(calendarMarker, 'export const marker = "C";\n');
  const restored = await check(), restoredRow = restored.review.inventory.find(row => row.id === 'google-calendar');
  assert.equal(restoredRow.workspace.local, false); assert.equal(restoredRow.workspace.working, restoredRow.workspace.origin);
  assert.equal(restoredRow.applied, null, 'persisted source content must not falsely certify code loaded before source was restored');
  assert.ok(restored.review.localRows.some(row => row.id === 'google-calendar'));
  assert.equal((await rpc('google-calendar', 'status')).marker, 'TEMPORARY', 'restoring files did not reload the plugin');
  await applyLocal(); assert.equal((await rpc('google-calendar', 'status')).marker, 'C');
  stage = 'both-sides-kept';
  await writeFile(join(workspace, 'plugins/google-calendar/marker.ts'), 'export const marker = "LOCAL";\n');
  await writeFile(join(seed, 'plugins/google-calendar/marker.ts'), 'export const marker = "REMOTE";\n');
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'both sides'); await git(seed, 'push', 'origin', 'main');
  const both = await check(), cloud = both.review.inventory.find(row => row.id === 'google-calendar');
  assert.equal(cloud.workspace.local, true); assert.equal(cloud.workspace.upstream, true);
  const oldJob = both.job?.id;
  const kept = await rpc('pa-updates', 'apply', { reviewId: both.review.id, choices: [] }); assert.equal(kept.job?.id, oldJob);
  assert.equal(await readFile(join(workspace, 'plugins/google-calendar/marker.ts'), 'utf8'), 'export const marker = "LOCAL";\n');
  assert.equal((await rpc('google-calendar', 'status')).marker, 'C');
  assert.equal((await readFile(counter, 'utf8')).trim().split('\n').length, 2, 'self reload admitted exactly once per local job');
  console.log(JSON.stringify({ bb: host.pkg.version, originalHandlers: true, freshPathMode: true, editTryBeforePush: true,
    sameVersionLocalAndOriginCodeChanges: true, nativeSelfReplacement: true, sameJobAfterSelf: true, sourceOnlyUpdate: true,
    bothSidesKept: true, settingsSecretsKvPreserved: true, noLocalCommitOrPushOnApply: true,
    sameBinaryBbRestartLoadsSelfOnce: true, actualBbRestartCount: restartCount, restoredFilesNeverFalselyCertifyRunningCode: true,
    notProven: ['existing managed-Git-to-path transition', 'BB binary upgrade', 'real provider activity', 'rendered UI'] }));
  completed = true;
} catch (error) { console.error('Local development gate stage:', stage); throw error; }
finally { await restartTask; control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); await host.finish(completed); }
