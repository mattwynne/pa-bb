// HISTORICAL characterization of the now-SUPERSEDED exact-target requirement.
// Do not use its BLOCKED result to gate ordinary compatible channel updates.
// See docs/plans/018-pa-platform-updates.md for the owner's revised scope.
// This is not an application implementation or a current acceptance harness.
// Run with: node test/run-installation-gate.mjs /absolute/path/to/bb-app
// Exit 2 means the known blocker was reproduced, NOT a passing installation gate.
// Exit 1 means the harness could not establish that result.
// Uses only public HTTP/CLI lifecycle APIs. Creates its own HOME/data/repository;
// never connects to an existing BB server, account, or provider.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const bb = resolve(process.argv[2] ?? 'node_modules/bb-app');
const pkg = JSON.parse(await readFile(join(bb, 'package.json'), 'utf8'));
// Inspect the shipped version constant; do not import private server modules.
const sdk = (await readFile(join(bb, 'server/dist/start-server.js'), 'utf8')).match(/PLUGIN_SDK_VERSION = "([0-9.]+)"/)?.[1];
assert.ok(sdk, 'shipped SDK version must be identifiable');
const root = await mkdtemp(join(tmpdir(), 'pa-installation-gate-'));
const home = join(root, 'home');
const repo = join(root, 'remote');
await mkdir(home); await mkdir(repo);
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const port = await freePort();
let daemonPort = await freePort();
while (daemonPort === port) daemonPort = await freePort();
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, NODE_ENV: 'production',
  BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1',
  BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_HOST_DAEMON_PORT: String(daemonPort),
  BB_MARKETPLACE_URL: `http://127.0.0.1:${port}/synthetic-no-marketplace` };
const git = async (...args) => (await exec('git', args, { cwd: repo, env, timeout: 15000 })).stdout.trim();
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args],
  { cwd: root, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const request = async (path, body) => {
  const response = await fetch(env.BB_SERVER_URL + '/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
  });
  return { status: response.status, body: await response.json() };
};
const rpc = async id => {
  const response = await request(`plugins/${id}/rpc/identity`, null);
  assert.equal(response.body.ok, true, 'fixture identity RPC must succeed');
  return response.body.result;
};
const ids = ['gate-calendar', 'gate-drive', 'gate-pinned', 'gate-ranged'];
const [calendarId, driveId, pinnedId, rangedId] = ids;
const changedIds = [calendarId, pinnedId, rangedId];
const fixture = async (id, marker, version) => {
  const dir = join(repo, 'plugins', id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `bb-plugin-${id}`, version, type: 'module', dependencies: { zod: '4.6.5' },
    engines: { bb: '>=0.45.0', bbPluginSdk: '>=0.6.15 <1' },
    bb: { name: `Synthetic ${id}`, description: 'Disposable installation proof; no provider access.', branding: { icon: 'FlaskConical' }, server: './server.ts' } }));
  await writeFile(join(dir, 'server.ts'), `import { z } from 'zod';
export default async function(bb) {
  const settings = bb.settings.define({ note: {type:'string',label:'Synthetic setting',default:''}, credential: {type:'string',label:'Synthetic secret',secret:true} });
  // Only the original fixture seeds state. A/B must not hide a lost database by reseeding it.
  if (${JSON.stringify(marker)} === 'original' && await bb.storage.kv.get('sentinel') == null) await bb.storage.kv.set('sentinel', 'SYNTHETIC_STATE');
  bb.rpc.register({identity:{input:z.null(),output:z.object({marker:z.string(),state:z.boolean(),setting:z.boolean(),secret:z.boolean()})}}, {
    identity:async()=>{const values=await settings.get();return {marker:${JSON.stringify(marker)},state:await bb.storage.kv.get('sentinel')==='SYNTHETIC_STATE',setting:values.note==='SYNTHETIC_SETTING',secret:values.credential==='SYNTHETIC_SECRET'};}
  });
}
`);
};
await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid');
for (const id of ids) await fixture(id, 'original', '1.0.0');
await git('add', '.'); await git('commit', '-qm', 'original');
const original = await git('rev-parse', 'HEAD');
await git('tag', 'v1.0.0');
const log = openSync(join(root, 'server.log'), 'w', 0o600);
const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { cwd: root, env, stdio: ['ignore', log, log] }); closeSync(log);
let completed = false;
try {
  let ready = false;
  for (let n = 0; n < 200; n++) {
    assert.equal(server.exitCode, null, 'disposable BB exited');
    try { ready = (await fetch(env.BB_SERVER_URL, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'disposable BB must start');
  for (const id of ids) {
    const ref = id === pinnedId ? 'v1.0.0' : id === rangedId ? 'semver:^1.0.0' : 'main';
    const source = `git:${repo}@${ref}`;
    const installed = JSON.parse(await cli('plugin', 'install', source, '--subdirectory', `plugins/${id}`, '--yes', '--json'));
    assert.equal(installed.plugin.status, 'running', 'managed fixture must run');
    await cli('plugin', 'config', id, 'set', 'note', 'SYNTHETIC_SETTING');
    await cli('plugin', 'config', id, 'set', 'credential', 'SYNTHETIC_SECRET');
  }
  const before = await rpc(calendarId);
  assert.equal(before.marker, 'original'); assert.equal(before.state, true); assert.equal(before.setting, true); assert.equal(before.secret, true);
  assert.deepEqual(await rpc(pinnedId), before, 'tag-pinned first install runs original code with state');
  assert.deepEqual(await rpc(rangedId), before);
  const sourceIntent = async id => {
    const response = await request(`plugins/${id}/source`);
    assert.equal(response.status, 200);
    const { requested, resolved, subdirectory } = response.body;
    assert.equal(typeof requested, 'string'); assert.equal(typeof resolved, 'string');
    return { requested, resolved, subdirectory }; // Never interpret candidate history as activation.
  };
  const pinnedSourceBefore = await sourceIntent(pinnedId);
  assert.ok(pinnedSourceBefore.requested.endsWith('@v1.0.0'), 'first install records pinned tag');
  const inventory = JSON.parse(await cli('plugin', 'list', '--json')).plugins;
  const unrelated = inventory.filter(p => !ids.includes(p.id)).map(p => ({ id: p.id, version: p.version, enabled: p.enabled, status: p.status }));
  // Public inventory supplies active roots; do not infer activation from history.
  const calendar = inventory.find(p => p.id === ids[0]);
  const drive = inventory.find(p => p.id === ids[1]);
  assert.ok(calendar.rootDir && drive.rootDir, 'public inventory exposes active roots');
  for (const item of [calendar, drive]) assert.ok(item.rootDir.startsWith(join(root, 'data') + '/'), 'only touch disposable installed code');
  assert.equal(resolve(calendar.rootDir, '../..'), resolve(drive.rootDir, '../..'), 'fixtures share one managed checkout');
  const keptSource = join(drive.rootDir, 'server.ts');
  await writeFile(keptSource, (await readFile(keptSource, 'utf8')).replaceAll('"original"', '"kept-custom"'));
  // Managed reload prefers dist/server.js: build the deliberately edited fixture
  // through the public CLI before checking its actual running identity.
  await cli('plugin', 'build', drive.rootDir);
  await cli('plugin', 'reload', ids[1]);
  const keptBefore = await rpc(ids[1]); assert.equal(keptBefore.marker, 'kept-custom');
  const treeDigest = async dir => {
    const hash = createHash('sha256');
    const visit = async (path, relative = '') => {
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const name = relative + '/' + entry.name;
        hash.update(name + '\0');
        if (entry.isDirectory()) await visit(join(path, entry.name), name);
        else if (entry.isFile()) hash.update(await readFile(join(path, entry.name)));
        else throw new Error('unsupported fixture entry');
      }
    };
    await visit(dir); return hash.digest('hex');
  };
  const keptDigest = await treeDigest(drive.rootDir);
  for (const id of changedIds) await fixture(id, 'reviewed-A', '1.0.1');
  await git('add', '.'); await git('commit', '-qm', 'review A'); const targetA = await git('rev-parse', 'HEAD');
  await git('tag', 'v1.0.1');
  for (const id of [calendarId, rangedId]) {
    const reviewed = await request('plugins/updates/check', { id });
    assert.equal(reviewed.status, 200, 'public update check must succeed');
    assert.ok(JSON.stringify(reviewed.body).includes(targetA), 'branch and semver reviews must identify A');
  }
  for (const id of changedIds) await fixture(id, 'unreviewed-B', '1.0.2');
  await git('add', '.'); await git('commit', '-qm', 'advance B'); const targetB = await git('rev-parse', 'HEAD');
  await git('tag', 'v1.0.2');
  const pinned = await request(`plugins/${ids[0]}/update`, { targetCommit: targetA });
  assert.equal(pinned.status, 400, 'current API rejects an exact target');
  assert.equal((await rpc(ids[0])).marker, 'original');
  const expectReinstallRefused = async (id, ref) => {
    const identity = await rpc(id);
    let refused = false;
    try { await cli('plugin', 'install', `git:${repo}@${ref}`, '--subdirectory', `plugins/${id}`, '--yes', '--json'); }
    catch (error) { refused = /already installed/.test(String(error.stderr) + String(error.stdout)); }
    assert.ok(refused, 'existing managed plugin cannot be retargeted by reinstall');
    assert.deepEqual(await rpc(id), identity, 'refused retarget must leave runtime and state intact');
  };
  await expectReinstallRefused(calendarId, targetA);
  await expectReinstallRefused(calendarId, 'v1.0.1'); // main → immutable tag A
  await expectReinstallRefused(pinnedId, 'v1.0.1'); // immutable tag 0 → immutable tag A
  const pinnedUpdate = await request(`plugins/${pinnedId}/update`, {});
  assert.equal(pinnedUpdate.status, 422);
  assert.match(pinnedUpdate.body.error, /pinned/);
  assert.deepEqual(await rpc(pinnedId), before);
  assert.deepEqual(await sourceIntent(pinnedId), pinnedSourceBefore, 'refusal preserves tag source intent');
  const applied = await request(`plugins/${ids[0]}/update`, {});
  assert.equal(applied.status, 200, 'ordinary update must succeed for the counterexample');
  assert.equal(applied.body.outcome, 'updated');
  const after = await rpc(ids[0]);
  assert.equal(after.marker, 'unreviewed-B', 'characterization: ordinary update installs B, NOT reviewed A');
  assert.equal(after.state, true); assert.equal(after.setting, true); assert.equal(after.secret, true);
  const rangedUpdate = await request(`plugins/${rangedId}/update`, {});
  assert.equal(rangedUpdate.status, 200); assert.equal(rangedUpdate.body.outcome, 'updated');
  const rangedAfter = await rpc(rangedId);
  assert.deepEqual(rangedAfter, after, 'semver tag tracking also installs unreviewed B, preserving state');
  assert.deepEqual(await rpc(driveId), keptBefore);
  assert.equal(await treeDigest(drive.rootDir), keptDigest);
  const finalInventory = JSON.parse(await cli('plugin', 'list', '--json')).plugins;
  assert.deepEqual(finalInventory.filter(p => !ids.includes(p.id)).map(p => ({ id: p.id, version: p.version, enabled: p.enabled, status: p.status })), unrelated);
  const result = { gate: 'BLOCKED', evidence: 'Generated four-plugin Git repository; real managed installer and original HTTP handlers; no production integrations or provider data',
    bb: pkg.version, sdk, node: process.version, platform: process.platform,
    original, reviewed: targetA, remoteAtApply: targetB, runtimeAfterApply: after.marker,
    exactTargetBodyRejected: true, pinnedReinstallRefused: true,
    tagPinnedFirstInstallVerified: true, branchToTagReinstallRefused: true, tagToTagReinstallRefused: true,
    pinnedOrdinaryUpdateRefused: true, pinnedSourcePreserved: true, semverTrackingRuntimeAfterApply: rangedAfter.marker,
    settingSecretAndStatePreserved: true,
    sharedCheckoutKeptSiblingUnchanged: true, unrelatedPluginsUnchanged: true,
    missingContract: 'State-preserving exact-target replacement of an existing managed plugin',
    notProven: ['exact-target application', 'trustworthy complete installed-code baseline', 'concurrent edit reservation', 'sync quiescence', 'rendered UI'] };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); completed = true; process.exitCode = 2;
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
    await new Promise(resolve => server.once('exit', resolve)); clearTimeout(timer);
  }
  // Keep failures for local diagnosis, never print arbitrary host error output.
  if (completed) await rm(root, { recursive: true, force: true });
  else console.error('Gate harness failed; isolated evidence directory:', root);
}
