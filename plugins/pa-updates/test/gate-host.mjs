// Disposable test host, never production. BB's shipped entry points and public
// APIs only. Excludes the caller's credentials/configuration from the environment.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
export async function createGateHost(bbPath, { nativeRuntime = false } = {}) {
  if (nativeRuntime) assert.equal(process.platform, 'linux', 'Native installers require the disposable Linux gate');
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
    BB_CLI: join(bb, 'host-daemon/dist/bb'), BB_DATA_DIR: join(root, 'data'), BB_SERVER_PORT: String(port), BB_SERVER_BIND_HOST: '127.0.0.1',
    BB_SERVER_URL: `http://127.0.0.1:${port}`, BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_MARKETPLACE_URL: `http://127.0.0.1:${port}/synthetic-no-marketplace` };
  if (nativeRuntime) {
    const bin = join(root, 'runner-bin'), prefix = join(root, 'npm-global');
    await mkdir(bin); await mkdir(join(prefix, 'bin'), { recursive: true });
    await symlink(process.execPath, join(bin, 'node')); await symlink(npm, join(bin, 'npm'));
    await symlink(join(bb, 'host-daemon/dist/bb'), join(bin, 'bb'));
    await writeFile(join(root, 'user.npmrc'), ''); await writeFile(join(root, 'global.npmrc'), '');
    Object.assign(env, { PATH: `${join(prefix, 'bin')}:${bin}:/usr/bin:/bin`,
      npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix, npm_config_cache: join(root, 'npm-cache'),
      npm_config_userconfig: join(root, 'user.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc'),
      CODEX_HOME: join(home, '.codex'), PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), XDG_CONFIG_HOME: join(home, '.config') });
    await mkdir(env.CODEX_HOME, { recursive: true }); await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
    // The daemon probes a login shell, whose system profile resets PATH. Keep
    // that supported probe inside the same owned prefix, not the image's PATH.
    const keys = ['HOME', 'PATH', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME'];
    const profile = keys.map(key => `export ${key}='${env[key].replaceAll("'", "'\\''")}'`).join('\n') + '\n';
    for (const name of ['.profile', '.bash_profile', '.bashrc']) await writeFile(join(home, name), profile, { mode: 0o600 });
  }
  const children = new Set();
  const command = async (file, args, cwd = root, timeout = nativeRuntime ? 600000 : 120000) => {
    const task = exec(file, args, { cwd, env, timeout, maxBuffer: 2 * 1024 * 1024 });
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
      if (nativeRuntime && server) {
        await command(process.execPath, [join(bb, 'dist/bb-app.js'), 'stop', '--data-dir', env.BB_DATA_DIR], root, 30000).catch(() => {});
      }
      if (nativeRuntime && server?.pid && server.exitCode === null && server.signalCode === null) {
        try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already stopped */ }
      }
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
        await exited; clearTimeout(timer);
      }
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
      // Native providers can own detached children. Preserve their evidence
      // until the enclosing disposable container is destroyed; never race rm
      // against a child's last write or hunt processes on a shared host.
      if (completed && !nativeRuntime) await rm(root, { recursive: true, force: true });
      else console.error(completed ? 'Native evidence retained for container teardown:' : 'Proof failed; isolated evidence directory:', root);
    })();
  }
  return { bb, pkg, npm, root, home, repo, baseline, env, command, git, cli, request,
    async assertNativeIsolation() {
      assert.equal(nativeRuntime, true);
      const prefix = (await command(process.execPath, [npm, 'prefix', '-g'])).trim();
      const modules = (await command(process.execPath, [npm, 'root', '-g'])).trim();
      assert.equal(prefix, join(root, 'npm-global')); assert.equal(modules, join(prefix, 'lib', 'node_modules'));
      assert.equal((await command('/bin/bash', ['-lc', 'printf "%s" "$PATH"'])).trim(), env.PATH, 'Login-shell probe must retain owned PATH');
      assert.equal((await command('/bin/bash', ['-lc', 'npm prefix -g'])).trim(), prefix, 'Login-shell installer must retain owned prefix');
      for (const name of ['pi', 'codex']) {
        let executable = null; try { executable = (await command('which', [name])).trim(); } catch { /* missing is expected before seeding */ }
        assert.ok(executable === null || executable.startsWith(join(prefix, 'bin') + '/'), 'Never use a parent/global provider executable');
      }
      const isolation = { home: env.HOME, data: env.BB_DATA_DIR, path: env.PATH, prefix, modules, credentialsInherited: false, parentProviderExecutablesExcluded: true };
      await writeFile(join(root, 'native-isolation.json'), JSON.stringify(isolation, null, 2), { mode: 0o600 });
      return isolation;
    },
    async start() {
      assert.equal(server, undefined, 'start a test host once');
      const log = openSync(join(root, 'server.log'), 'w', 0o600);
      const args = nativeRuntime ? [join(bb, 'dist/bb-app.js'), '--data-dir', env.BB_DATA_DIR, '--server-port', env.BB_SERVER_PORT, '--server-bind-host', '127.0.0.1', '--host-daemon-port', env.BB_HOST_DAEMON_PORT] : [join(bb, 'server/dist/index.js')];
      server = spawn(process.execPath, args, { cwd: root, env, detached: nativeRuntime, stdio: ['ignore', log, log] }); closeSync(log);
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
