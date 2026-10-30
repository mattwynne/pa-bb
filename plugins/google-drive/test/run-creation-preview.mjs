// Opt-in disposable native-BB review. Never installs/builds the registered plugin.
// BB_REVIEW_ROOT selects already-built BB; all fixture outputs/HOME/data are temporary.
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
const source = resolve(fileURLToPath(new URL('../', import.meta.url)));
const bbRoot = process.env.BB_REVIEW_ROOT || join(source, 'node_modules/bb-app');
let apps = join(bbRoot, 'apps'); try { await access(apps); } catch { apps = bbRoot; }
const cli = join(apps, 'host-daemon/dist/bb');
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), daemonPort = await freePort();
const root = await mkdtemp(join(tmpdir(), 'drive-creation-review-')), fixture = join(root, 'drive-creation-review');
await mkdir(join(root, 'home'));
for (const file of ['creation-approval.tsx', 'core/file-link.mjs', 'core/filing-presentation.mjs', 'app.css', 'connection-ui.tsx', 'connection-ui.css', 'test/creation-preview/app.tsx', 'test/creation-preview/server.ts']) {
  await mkdir(dirname(join(fixture, file)), { recursive: true }); await cp(join(source, file), join(fixture, file));
}
await cp(join(source, 'test/creation-preview/package.json'), join(fixture, 'package.json'));
await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'), 'dir');
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_CLI: cli, BB_MARKETPLACE_URL: `http://127.0.0.1:${port}/no-marketplace` };
const fd = openSync(join(root, 'server.log'), 'a', 0o600);
const server = spawn(process.execPath, [join(apps, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', fd, fd] }); closeSync(fd);
let stopping = false, daemon;
function stop() { if (stopping) return; stopping = true; daemon?.kill('SIGTERM'); server.kill('SIGTERM'); const timer = setTimeout(() => { daemon?.kill('SIGKILL'); server.kill('SIGKILL'); }, 10000); timer.unref(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
server.on('exit', async () => { if (daemon && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit'); } await rm(root, { recursive: true, force: true }); process.exit(process.exitCode || (stopping ? 0 : 1)); });
const exec = promisify(execFile);
const command = async (...args) => (await exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout;
const api = async (path, body) => {
  const response = await fetch(`${env.BB_SERVER_URL}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: env.BB_SERVER_URL }, body: JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
};
try {
  let ready = false;
  for (let i = 0; i < 150; i++) { assert.equal(server.exitCode, null); try { ready = (await fetch(env.BB_SERVER_URL, { signal: AbortSignal.timeout(1000) })).ok; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready, 'Disposable BB did not start');
  const enrollment = await api('hosts/join-codes', {}), fd = openSync(join(root, 'daemon.log'), 'a', 0o600);
  daemon = spawn(process.execPath, [join(apps, 'host-daemon/dist/index.js')], { cwd: root, env: { ...env, BB_DATA_DIR: join(root, 'daemon-data'), BB_HOST_DAEMON_PORT: String(daemonPort), BB_HOST_ID: enrollment.hostId, BB_HOST_ENROLL_KEY: enrollment.joinCode, BB_CLI_DIR: join(apps, 'host-daemon/dist'), BB_HOST_DAEMON_AUTO_UPDATE: 'false' }, stdio: ['ignore', fd, fd] }); closeSync(fd);
  let connected = false;
  for (let i = 0; i < 150; i++) { assert.equal(daemon.exitCode, null); const hosts = await (await fetch(`${env.BB_SERVER_URL}/api/v1/hosts`)).json(); connected = hosts.some(h => h.id === enrollment.hostId && h.status === 'connected'); if (connected) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(connected, 'Disposable daemon must connect');
  const installed = JSON.parse(await command('plugin', 'install', fixture, '--yes', '--json')); assert.equal(installed.plugin.status, 'running');
  const threads = {};
  for (const state of ['document', 'spreadsheet', 'invalid', 'error']) {
    const result = await api('threads', { projectId: 'proj_personal', origin: 'sdk', providerId: 'codex', model: 'synthetic-inert-never-dispatch', title: `Synthetic filing review: ${state}`, input: [{ type: 'text', text: 'Inert native filing fixture; never dispatch.' }], environment: { type: 'host', hostId: enrollment.hostId, workspace: { type: 'personal' } }, sendAt: 4102444800000 });
    const t = result.thread ?? result; assert.equal(t.status, 'pending'); threads[state] = t.id;
    await api('plugins/drive-creation-review/rpc/stage', { threadId: t.id, state });
  }
  console.log(JSON.stringify({ root, url: `${env.BB_SERVER_URL}/threads/${threads.document}`, controllerPid: process.pid, threads, googleWrites: 0, providerTurns: 0 }));
} catch (error) { console.error('Isolated filing review setup failed; temporary data will be removed.'); console.error(error); stop(); process.exitCode = 1; }
