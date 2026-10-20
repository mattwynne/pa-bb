// Disposable test host, never production. BB's shipped entry points and public
// APIs only. Excludes the caller's credentials/configuration from the environment.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
const exec = promisify(execFile);
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
export async function createGateHost(bbPath) {
  const bb = resolve(bbPath ?? 'node_modules/bb-app');
  const pkg = JSON.parse(await readFile(join(bb, 'package.json'), 'utf8'));
  const npm = join(createRequire(join(bb, 'package.json')).resolve('npm/package.json'), '../bin/npm-cli.js');
  const root = await mkdtemp(join(tmpdir(), 'pa-ordinary-gate-'));
  const home = join(root, 'home'), repo = join(root, 'remote'), baseline = join(root, 'baseline');
  await mkdir(home); await mkdir(repo); await mkdir(baseline);
  const port = await freePort(); let daemonPort = await freePort();
  while (daemonPort === port) daemonPort = await freePort();
  // Match public launcher's actual package version. Without this the server
  // reports 0.0.0-dev and production-version compatibility checks are skipped.
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, NODE_ENV: 'production', BB_APP_VERSION: pkg.version,
    BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1',
    BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_MARKETPLACE_URL: `http://127.0.0.1:${port}/synthetic-no-marketplace` };
  const children = new Set();
  const command = async (file, args, cwd = root) => {
    const task = exec(file, args, { cwd, env, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    children.add(task.child);
    try { return (await task).stdout; }
    catch { throw new Error('gate_command_failed'); } // Never expose args, stdout, stderr or cause.
    finally { children.delete(task.child); }
  };
  const git = async (...args) => (await command('git', args, repo)).trim();
  const cli = (...args) => command(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args]);
  const request = async (path, body) => {
    const response = await fetch(env.BB_SERVER_URL + '/api/v1/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
    });
    return { status: response.status, body: await response.json() };
  };
  let server, finishing;
  const onInterrupt = () => { void finish(false).finally(() => process.exit(130)); };
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
  function finish(completed) {
    return finishing ??= (async () => {
      for (const child of children) child.kill('SIGTERM');
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
        await exited; clearTimeout(timer);
      }
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
      if (completed) await rm(root, { recursive: true, force: true });
      else console.error('Proof failed; isolated evidence directory:', root);
    })();
  }
  return { bb, pkg, npm, root, home, repo, baseline, env, command, git, cli, request,
    async start() {
      assert.equal(server, undefined, 'start a test host once');
      const log = openSync(join(root, 'server.log'), 'w', 0o600);
      server = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { cwd: root, env, stdio: ['ignore', log, log] }); closeSync(log);
      let ready = false;
      for (let n = 0; n < 200; n++) {
        assert.equal(server.exitCode, null, 'disposable BB exited');
        try { ready = (await fetch(env.BB_SERVER_URL, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
        if (ready) break; await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'disposable BB must start');
      const runtime = await request('system/version');
      assert.equal(runtime.body.currentVersion, pkg.version, 'runtime must not use dev fallback');
    },
    finish,
  };
}
