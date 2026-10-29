// Opt-in native rendered review. Fresh HOME/data, loopback only, no credentials.
// BB_REVIEW_ROOT selects a built BB checkout or bb-app package. SIGTERM cleans up.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, access, cp, symlink } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const bbRoot = process.env.BB_REVIEW_ROOT || join(source, 'node_modules/bb-app');
let apps = join(bbRoot, 'apps');
try { await access(apps); } catch { apps = bbRoot; }
const cli = join(apps, 'host-daemon/dist/bb');
const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const port = await freePort();
const daemonPort = await freePort();
const root = await mkdtemp(join(tmpdir(), 'gcal-native-review-'));
await mkdir(join(root, 'home'));
// The host enforces package-local imports. Copy only the unchanged renderer,
// styles and validator needed by this tiny fixture; never rewrite source text.
const fixture = join(root, 'calendar-approval-review');
await mkdir(join(fixture, 'test/recurring-preview'), { recursive: true });
for (const file of ['approval.tsx', 'approval-model.mjs', 'app.css', 'connection-ui.tsx', 'connection-ui.css', 'core/recurrence.mjs', 'core/event-time.mjs', 'test/recurring-preview/app.tsx', 'test/recurring-preview/server.ts']) {
  await cp(join(source, file), join(fixture, file));
}
await cp(join(source, 'test/recurring-preview/package.json'), join(fixture, 'package.json'));
await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'), 'dir');
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_CLI: cli, BB_MARKETPLACE_URL: `http://127.0.0.1:${port}/no-marketplace` };
const fd = openSync(join(root, 'server.log'), 'a', 0o600);
const server = spawn(process.execPath, [join(apps, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] });
closeSync(fd);
let stopping = false;
let daemon;
const stop = () => { if (stopping) return; stopping = true; daemon?.kill('SIGTERM'); server.kill('SIGTERM'); const timer = setTimeout(() => { daemon?.kill('SIGKILL'); server.kill('SIGKILL'); }, 10000); timer.unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('exit', async () => {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM');
    await once(daemon, 'exit');
  }
  await rm(root, { recursive: true, force: true });
  process.exit(process.exitCode || (stopping ? 0 : 1));
});
const command = async (...args) => (await exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout;
const api = async (path, body) => {
  const response = await fetch(`${env.BB_SERVER_URL}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: env.BB_SERVER_URL }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
};
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(server.exitCode, null);
    try { ready = (await fetch(env.BB_SERVER_URL, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Disposable BB did not start');
  // Enroll a disposable host through the public API; bootstrap material stays
  // in child environment only. No production host or auth state is consulted.
  const enrollment = await api('hosts/join-codes', {});
  const daemonFd = openSync(join(root, 'daemon.log'), 'a', 0o600);
  daemon = spawn(process.execPath, [join(apps, 'host-daemon/dist/index.js')], { cwd: root,
    env: { ...env, BB_DATA_DIR: join(root, 'daemon-data'), BB_HOST_DAEMON_PORT: String(daemonPort), BB_HOST_ID: enrollment.hostId, BB_HOST_ENROLL_KEY: enrollment.joinCode, BB_CLI_DIR: join(apps, 'host-daemon/dist'), BB_HOST_DAEMON_AUTO_UPDATE: 'false' }, stdio: ['ignore', daemonFd, daemonFd] });
  closeSync(daemonFd);
  let connected = false;
  for (let i = 0; i < 150; i++) {
    assert.equal(daemon.exitCode, null, 'Disposable daemon exited');
    const hosts = await (await fetch(`${env.BB_SERVER_URL}/api/v1/hosts`)).json();
    connected = hosts.some(host => host.id === enrollment.hostId && host.status === 'connected');
    if (connected) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(connected, 'Disposable host must connect');
  // Also load the working-copy package without wrappers to check real
  // tool/schema registration and empty account status, without connecting.
  const production = JSON.parse(await command('plugin', 'install', source, '--yes', '--json'));
  assert.equal(production.plugin.status, 'running', JSON.stringify(production.plugin));
  assert.match(await command('plugin', 'rpc', 'call', 'google-calendar', 'status', '--json'), /"accounts":\s*\[\]/);
  const installed = JSON.parse(await command('plugin', 'install', fixture, '--yes', '--json'));
  assert.equal(installed.plugin.status, 'running', JSON.stringify(installed.plugin));
  // Public API, NOT private database seeding. A far-future scheduled first input
  // creates inert pending threads: no dispatch, environment work, or provider turn.
  // The explicit inert model avoids even provider catalogue discovery. The
  // fresh host and its queue are destroyed at shutdown, long before sendAt.
  const threads = {};
  for (const state of ['forever', 'count', 'until', 'oneoff', 'legacy', 'update-series', 'update-occurrence', 'delete-series', 'daily', 'monthly', 'yearly', 'all-day-daily', 'all-day-weekly', 'all-day-monthly', 'all-day-yearly', 'error', 'busy']) {
    const result = await api('threads', { projectId: 'proj_personal', origin: 'sdk', providerId: 'codex', model: 'synthetic-inert-never-dispatch', title: `Synthetic Calendar review: ${state}`, input: [{ type: 'text', text: 'Inert native approval fixture; never dispatch.' }], environment: { type: 'host', hostId: enrollment.hostId, workspace: { type: 'personal' } }, sendAt: 4102444800000 });
    const thread = result.thread ?? result;
    assert.equal(thread.status, 'pending');
    threads[state] = thread.id;
    await api('plugins/calendar-approval-review/rpc/stage', { threadId: thread.id, state });
  }
  console.log(JSON.stringify({ root, url: `${env.BB_SERVER_URL}/projects/proj_personal/threads/${threads.forever}`, controllerPid: process.pid, threads, googleWrites: 0, providerTurns: 0, renderer: 'native pendingInteraction' }));
} catch (error) { console.error('Native review setup failed; isolated data will be removed.'); console.error(error); stop(); process.exitCode = 1; }
