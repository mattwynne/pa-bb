// Opt-in native review: isolated HOME/data + loopback host, no credentials.
// BB_REVIEW_ROOT selects an already-built BB package/checkout. SIGTERM cleans up.
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
if (!process.env.BB_REVIEW_ROOT) throw new Error('Set BB_REVIEW_ROOT to an existing built BB package or checkout for this isolated fixture.');
const bbRoot = process.env.BB_REVIEW_ROOT;
let apps = join(bbRoot, 'apps'); try { await access(apps); } catch { apps = bbRoot; }
const cli = join(apps, 'host-daemon/dist/bb');
const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const port = await freePort(), daemonPort = await freePort();
const root = await mkdtemp(join(tmpdir(), 'sheets-edit-review-')), fixture = join(root, 'sheets-edit-review');
await mkdir(join(root, 'home'));
for (const file of ['sheets-edit-approval.tsx', 'sheets-edit-approval.css', 'connection-ui.tsx', 'connection-ui.css', 'core/sheets-edit.mjs', 'core/sheets.mjs', 'core/sheets-cells.mjs', 'core/native-create.mjs', 'core/docs-edit.mjs', 'core/docs-approval.mjs', 'test/sheets-edit-preview/app.tsx', 'test/sheets-edit-preview/server.ts']) {
  await mkdir(dirname(join(fixture, file)), { recursive: true }); await cp(join(source, file), join(fixture, file));
}
await cp(join(source, 'test/sheets-edit-preview/package.json'), join(fixture, 'package.json'));
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
  const enrollment = await api('hosts/join-codes', {});
  const fd = openSync(join(root, 'daemon.log'), 'a', 0o600);
  daemon = spawn(process.execPath, [join(apps, 'host-daemon/dist/index.js')], { cwd: root, env: { ...env, BB_DATA_DIR: join(root, 'daemon-data'), BB_HOST_DAEMON_PORT: String(daemonPort), BB_HOST_ID: enrollment.hostId, BB_HOST_ENROLL_KEY: enrollment.joinCode, BB_CLI_DIR: join(apps, 'host-daemon/dist'), BB_HOST_DAEMON_AUTO_UPDATE: 'false' }, stdio: ['ignore', fd, fd] }); closeSync(fd);
  let connected = false;
  for (let i = 0; i < 150; i++) { assert.equal(daemon.exitCode, null); const hosts = await (await fetch(`${env.BB_SERVER_URL}/api/v1/hosts`)).json(); connected = hosts.some(h => h.id === enrollment.hostId && h.status === 'connected'); if (connected) break; await new Promise(r => setTimeout(r, 100)); }
  assert.ok(connected, 'Disposable daemon must connect');
  const installed = JSON.parse(await command('plugin', 'install', fixture, '--yes', '--json')); assert.equal(installed.plugin.status, 'running');
  const threads = {};
  for (const state of ['values', 'long', 'clear', 'invalid', 'error', 'busy']) {
    const result = await api('threads', { projectId: 'proj_personal', origin: 'sdk', providerId: 'codex', model: 'synthetic-inert-never-dispatch', title: `Synthetic Sheets review: ${state}`, input: [{ type: 'text', text: 'Inert native approval fixture; never dispatch.' }], environment: { type: 'host', hostId: enrollment.hostId, workspace: { type: 'personal' } }, sendAt: 4102444800000 });
    const t = result.thread ?? result; assert.equal(t.status, 'pending'); threads[state] = t.id;
    await api('plugins/sheets-edit-review/rpc/stage', { threadId: t.id, state });
  }
  console.log(JSON.stringify({ root, url: `${env.BB_SERVER_URL}/threads/${threads.values}`, controllerPid: process.pid, threads, googleWrites: 0, providerTurns: 0 }));
} catch (error) { console.error('Isolated review setup failed; temporary data will be removed.'); console.error(error); stop(); process.exitCode = 1; }
