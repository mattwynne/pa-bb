// Disposable BB 0.45.0 host, actual installed plugin bundles and synthetic
// settings RPC views. This does not prove iCloud native access or tool calls.
// Prerequisites: built iCloud/Obsidian packages, BB 0.45.0 from the local
// devDependency, and BB_REVIEW_CHROME pointing to a local Chromium executable.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const obsidian = join(repo, 'plugins/obsidian');
const bb = join(obsidian, 'node_modules/bb-app');
const port = Number(process.env.BB_REVIEW_PORT ?? 42988);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65535);
// Never accidentally point the installer at an unrelated listener on this port.
await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
assert.ok(process.env.BB_REVIEW_CHROME, 'Set BB_REVIEW_CHROME to an installed Chromium executable');
const root = await mkdtemp(join(tmpdir(), 'obsidian-bb-rendered-'));
const artifacts = process.env.BB_REVIEW_ARTIFACTS ?? await mkdtemp(join(tmpdir(), 'obsidian-rendered-evidence-'));
assert.ok(!artifacts.startsWith(root + '/'), 'Evidence directory must remain outside disposable BB data');
await mkdir(join(root, 'home')); await mkdir(join(root, 'data')); await mkdir(artifacts, { recursive: true });
// Do not inherit provider/auth environment variables or the user's HOME.
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_HOST_DAEMON_PORT: String(port + 1) };
const serverLog = join(root, 'server.log');
const output = openSync(serverLog, 'w', 0o600);
const server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { env, cwd: root, stdio: ['ignore', output, output] });
closeSync(output);
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
let result = { bbVersion: null, hostPlatform: process.platform, installed: {}, rendered: false, screenshots: 0, nativeNoteAccess: false, providerConversation: false };
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, 'Isolated BB server exited during startup');
    try { ready = (await fetch(`${env.BB_SERVER_URL}/`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Isolated BB server did not become ready');
  result.bbVersion = (await cli('--version')).trim();
  assert.equal(result.bbVersion, '0.45.0');
  const existing = JSON.parse(await cli('plugin', 'list', '--json')).plugins;
  assert.ok(!existing.some(plugin => ['icloud', 'obsidian'].includes(plugin.id)), 'Review requires a fresh BB data root');
  for (const id of ['icloud', 'obsidian']) {
    const installation = JSON.parse(await cli('plugin', 'install', join(repo, 'plugins', id), '--yes', '--json'));
    assert.equal(installation.ok, true);
    result.installed[id] = { version: installation.plugin.version, status: installation.plugin.status };
  }
  assert.equal(result.installed.obsidian.status, 'running', 'Obsidian settings must be mounted by BB');
  const reviewEnv = { ...env, BB_REVIEW_BASE: env.BB_SERVER_URL, BB_REVIEW_ARTIFACTS: artifacts, BB_REVIEW_CHROME: process.env.BB_REVIEW_CHROME };
  const rendered = await exec(process.execPath, [join(obsidian, 'test/rendered-review.mjs')], { env: reviewEnv, cwd: root, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  await writeFile(join(artifacts, 'assertions.log'), rendered.stdout, { mode: 0o600 });
  result.rendered = true;
  result.screenshots = (await readdir(artifacts)).filter(file => file.endsWith('.png')).length;
  assert.equal(result.screenshots, 50);
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...result, artifacts }));
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10_000))]);
  }
  // Do not remove a live child's store after a failed shutdown. No child may
  // retain a reference to the data directory when it is removed.
  if (server.exitCode !== 0) console.error('Isolated server did not stop cleanly; retain disposable root for inspection:', root);
  else await rm(root, { recursive: true, force: true });
}
