// Actual native Pi/Codex updates and BB launcher restart on disposable Linux.
// The gate owns HOME, BB data, PATH, npm global prefix/config/cache and providers.
// node test/run-runtime-update-gate.mjs /path/to/bb-app /path/to/updater-source.tar
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createGateHost } from './gate-host.mjs';
const host = await createGateHost(process.argv[2], { nativeRuntime: true });
const { root, npm, command, cli, request } = host;
const archive = resolve(process.argv[3]);
let completed = false, stage = 'isolation';
const rpc = async (method, input = null) => {
  const response = await request(`plugins/pa-updates/rpc/${method}`, input);
  assert.equal(response.body.ok, true, 'Original application RPC must succeed'); return response.body.result;
};
try {
  await host.assertNativeIsolation();
  console.log(JSON.stringify({ stage: 'isolation', linux: true, separateHomeAndData: true, separatePathAndNpmGlobalPrefix: true, noInheritedCredentials: true, parentProviderExecutablesExcluded: true }));
  stage = 'seed-owned-clis';
  const installedBefore = {};
  for (const [id, name] of [['pi', '@earendil-works/pi-coding-agent'], ['codex', '@openai/codex']]) {
    const latest = (await command(process.execPath, [npm, 'view', name, 'dist-tags.latest'])).trim();
    assert.match(latest, /^\d+\.\d+\.\d+$/);
    const versions = JSON.parse(await command(process.execPath, [npm, 'view', name, 'versions', '--json']));
    const compare = (a, b) => { const aa = a.split('.').map(Number), bb = b.split('.').map(Number); return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]; };
    const previous = versions.filter(value => /^\d+\.\d+\.\d+$/.test(value) && compare(value, latest) < 0).sort(compare).at(-1);
    assert.ok(previous, 'A published older CLI is required for the fixture');
    await command(process.execPath, [npm, 'install', '--global', `${name}@${previous}`, '--no-audit', '--no-fund']);
    installedBefore[id] = previous;
  }
  await host.assertNativeIsolation();
  stage = 'native-launcher'; await host.start();
  // Keep one managed integration across the real BB restart, then update it
  // again with the new builder. This is ordinary update continuity, not pins.
  const integration = join(host.repo, 'plugins', 'google-calendar'); await mkdir(integration, { recursive: true });
  const integrationManifest = { name: 'bb-plugin-google-calendar', version: '0.3.1', type: 'module', dependencies: { zod: '4.6.5' }, engines: { bb: '>=0.45.0', bbPluginSdk: '>=0.6.15 <1' }, bb: { name: 'Synthetic Calendar', description: 'Disposable builder continuity fixture.', branding: { icon: 'Calendar' }, server: './server.ts' } };
  await writeFile(join(integration, 'package.json'), JSON.stringify(integrationManifest));
  await writeFile(join(integration, 'server.ts'), `import {z} from 'zod';export default bb=>bb.rpc.register({status:{input:z.null(),output:z.object({synthetic:z.literal(true)})}},{status:()=>({synthetic:true})});`);
  await command(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], integration);
  await host.git('init', '-q', '-b', 'main'); await host.git('config', 'user.name', 'Synthetic'); await host.git('config', 'user.email', 'synthetic@example.invalid'); await host.git('add', '.'); await host.git('commit', '-qm', 'original integration');
  let sourceCommit = await host.git('rev-parse', 'HEAD');
  await cli('plugin', 'install', `git:${host.repo}@main`, '--subdirectory', 'plugins/google-calendar', '--yes', '--json');
  const bridge = join(root, 'updater'); await mkdir(join(bridge, 'implementation'), { recursive: true });
  await command('tar', ['--no-same-owner', '-xf', archive, '-C', join(bridge, 'implementation')]);
  const manifest = JSON.parse(await readFile(join(bridge, 'implementation/package.json'), 'utf8')); manifest.bb.app = './implementation/app.tsx';
  await writeFile(join(bridge, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(bridge, 'package-lock.json'), await readFile(join(bridge, 'implementation/package-lock.json')));
  const counter = join(root, 'native-admissions'); await writeFile(counter, '');
  // Only discovery/integration inventory is suppressed. Original runtime
  // adapters, application job, persistence and RPC handlers remain unchanged.
  // Admission counts observe calls; they do not substitute native operations.
  await writeFile(join(bridge, 'server.ts'), `import plugin from './implementation/server.ts';import {applicationPorts} from './implementation/adapters/application.ts';import {appendFileSync} from 'node:fs';
export default bb=>{const ports=applicationPorts(bb);ports.inspect=async()=>[];const runtime=ports.runtime;const updateCli=runtime.updateCli,applyBb=runtime.applyBb;runtime.updateCli=(id,...args)=>{appendFileSync(${JSON.stringify(counter)},id+'\\n');return updateCli(id,...args);};runtime.applyBb=(...args)=>{appendFileSync(${JSON.stringify(counter)},'bb\\n');return applyBb(...args);};return plugin(bb,{feed:async()=>null,inventory:async()=>({installed:null,runtime:null})},ports);};`);
  await command(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], bridge);
  const baselineScript = join(bridge, 'baseline-proof.mjs');
  await writeFile(baselineScript, `import {Baselines} from './implementation/adapters/baseline.ts';const [source,root,commit,cli]=process.argv.slice(2);const baseline=new Baselines(source,cli);try{console.log(JSON.stringify(await baseline.inspect('google-calendar',root,commit)));}finally{await baseline.close();}`);
  const inspectBaseline = async cliHint => {
    const item = JSON.parse(await cli('plugin', 'list', '--json')).plugins.find(item => item.id === 'google-calendar');
    const result = JSON.parse(await command(process.execPath, [baselineScript, host.repo, item.rootDir, sourceCommit, cliHint]));
    assert.equal(result.local, 'stock', 'Recorded builder must reconstruct untouched integration after BB changes');
    return JSON.parse(await readFile(join(item.rootDir, 'dist/server.meta.json'), 'utf8')).builtWith.bbVersion;
  };
  assert.equal(await inspectBaseline(host.env.BB_CLI), host.pkg.version);
  stage = 'install-original-handlers';
  assert.equal(JSON.parse(await cli('plugin', 'install', bridge, '--yes', '--json')).plugin.status, 'running');
  let review;
  const reviewDeadline = Date.now() + 180000;
  do {
    const state = await rpc('review'); review = state.review;
    if (review?.runtime?.rows.every(row => row.state === 'ready')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < reviewDeadline);
  assert.equal(review.runtime.rows.length, 3);
  assert.ok(review.runtime.rows.every(row => row.state === 'ready'), 'All three native releases must be offered');
  assert.ok(review.runtime.target?.id); assert.equal(review.runtime.runningThreadCount, 0);
  for (const id of ['pi', 'codex']) assert.equal(review.runtime.rows.find(row => row.id === id).installed, installedBefore[id]);
  const preview = review.runtime.rows.map(row => ({ id: row.id, installed: row.installed, available: row.available, source: row.source }));
  console.log(JSON.stringify({ stage: 'review', preview, primaryHostBound: true }));
  stage = 'apply-and-native-restart';
  const started = await rpc('apply', { reviewId: review.id, choices: [], confirmInterruptingThreads: false });
  const jobId = started.job.id; let final, disconnected = false;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const state = await rpc('applicationStatus');
      assert.equal(state.job.id, jobId, 'Native restart must retain the same job');
      if (!state.applying) { final = state; break; }
    } catch { disconnected = true; /* Only status reads retry across restart. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(final, 'Native job must settle'); assert.equal(final.job.phase, 'complete', JSON.stringify(final.job));
  for (const receipt of final.job.runtimeReceipts) {
    assert.equal(receipt.outcome, 'updated'); assert.ok(receipt.actual); assert.notEqual(receipt.actual, receipt.before);
    if (receipt.id !== 'bb') assert.equal(receipt.source, 'npmGlobal');
  }
  assert.deepEqual((await readFile(counter, 'utf8')).trim().split('\n'), ['pi', 'codex', 'bb']);
  stage = 'reload-and-receipts';
  await cli('plugin', 'reload', 'pa-updates');
  const reloaded = await rpc('applicationStatus'); assert.deepEqual(reloaded.job, final.job);
  const fresh = await rpc('review'); assert.equal(fresh.review.runtime.target.id, review.runtime.target.id);
  for (const receipt of final.job.runtimeReceipts) assert.equal(fresh.review.runtime.rows.find(row => row.id === receipt.id).installed, receipt.actual);
  assert.deepEqual((await readFile(counter, 'utf8')).trim().split('\n'), ['pi', 'codex', 'bb']);
  stage = 'baseline-after-native-restart';
  const bbActual = final.job.runtimeReceipts.find(row => row.id === 'bb').actual;
  const newCli = join(host.env.BB_DATA_DIR, 'app-versions', bbActual, 'node_modules', 'bb-app', 'host-daemon', 'dist', 'bb');
  assert.equal(await inspectBaseline(newCli), host.pkg.version, 'Original artifact still uses its recorded old builder');
  integrationManifest.version = '0.3.2'; await writeFile(join(integration, 'package.json'), JSON.stringify(integrationManifest));
  await command(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], integration);
  await host.git('add', '.'); await host.git('commit', '-qm', 'next ordinary integration release'); sourceCommit = await host.git('rev-parse', 'HEAD');
  const updated = await request('plugins/google-calendar/update', {}); assert.equal(updated.status, 200); assert.equal(updated.body.applied, true);
  assert.equal(await inspectBaseline(newCli), bbActual, 'Later native plugin update uses the new BB builder, without customization false positives');
  await host.assertNativeIsolation();
  completed = true;
  console.log(JSON.stringify({ evidence: 'Original handlers and adapters, real native installers and launcher, disposable Linux only', preview, receipts: final.job.runtimeReceipts, sameJobAfterNativeRestart: true, noDuplicateNativeAdmissions: true, independentOldBaselineAfterBbRestart: true, subsequentPluginUpdateWithNewBuilder: true, actualInstalledVersionsVerifiedAgain: true, separateNpmGlobalPrefix: true, disconnectedObserved: disconnected, existingProviderSessionsNotRestartedOrClaimedFresh: true }));
} catch (error) {
  console.error('Runtime gate stage:', stage); throw error;
} finally { await host.finish(completed); }
