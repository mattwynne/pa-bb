import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '../diagnostic.mjs';

export const UPSTREAM_VERSION = '2.3.0';
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export function runtimeEnvironment(port, parent = process.env) {
  // Do not inherit account credentials, arbitrary upstream settings or proxy logs.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter(k => parent[k]).map(k => [k, parent[k]]));
  return { ...env, WORKSPACE_MCP_HOST: '127.0.0.1', WORKSPACE_MCP_PORT: String(port),
    MCP_ENABLE_OAUTH21: 'true', EXTERNAL_OAUTH21_PROVIDER: 'true',
    GOOGLE_OAUTH_CLIENT_ID: 'bb-google-workspace', WORKSPACE_MCP_STATELESS_MODE: 'true',
    // Upstream initializes its proxy base class even in external-token mode.
    // A throwaway local key satisfies that bootstrap without sharing our Google client secret.
    FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY: randomBytes(32).toString('base64url'),
    WORKSPACE_MCP_DISABLE_LOCAL_FILES: 'true', WORKSPACE_MCP_LOG_LEVEL: 'CRITICAL',
  };
}
export function createRuntime({ launch = spawn, getPort = unusedPort, fetchImpl = fetch, wait = delay, attempts = 120, diagnose = /** @type {(stage: string, error: unknown) => void} */ (() => {}) } = {}) {
  let child, starting, state = 'idle', stopped = false;
  const lifetime = new AbortController();
  const runtime = {
    get state() { return state; },
    async start() {
      if (stopped) fail('disabled');
      if (state === 'ready') return runtime.url;
      if (starting) return starting;
      state = 'starting';
      starting = (async () => {
        const port = await getPort();
        if (stopped) fail('disabled');
        const url = new URL(`http://127.0.0.1:${port}/mcp`);
        let launchFailure;
        child = launch('uvx', ['--python', '3.12', '--from', `workspace-mcp==${UPSTREAM_VERSION}`, 'workspace-mcp', '--transport', 'streamable-http', '--tools', 'drive', 'docs', 'sheets', 'calendar', 'gmail', '--tool-tier', 'complete'], {
          env: runtimeEnvironment(port), stdio: ['ignore', 'ignore', 'ignore'],
        });
        const process = child;
        child.once('error', error => { launchFailure = error.code === 'ENOENT' ? 'runtime_missing' : 'runtime_exit'; });
        child.once('exit', () => {
          launchFailure ||= 'runtime_exit';
          if (child === process) { child = null; if (!stopped) { state = 'unavailable'; diagnose('runtime_exit', { workspaceCategory: 'runtime_exit' }); } }
        });
        for (let i = 0; i < attempts; i++) {
          if (stopped) fail('disabled');
          if (launchFailure) fail(launchFailure);
          try {
            // An auth challenge proves HTTP is up, not that a Google call works.
            const response = await fetchImpl(url, { headers: { accept: 'application/json, text/event-stream' }, redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(500)]) });
            await response.body?.cancel();
            if ([200, 400, 401, 405, 406].includes(response.status)) { state = 'ready'; runtime.url = url; return url; }
          } catch { /* Startup includes the first pinned-package download. */ }
          await wait(500, undefined, { signal: lifetime.signal });
        }
        fail('runtime_timeout');
      })().catch(error => { state = 'unavailable'; child?.kill('SIGTERM'); throw error; }).finally(() => { starting = null; });
      return starting;
    },
    async close() {
      stopped = true; state = 'idle'; lifetime.abort();
      const process = child; child = null;
      if (process) {
        await new Promise(resolve => {
          const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 5000); timer.unref();
          process.once('exit', () => { clearTimeout(timer); resolve(); });
          process.kill('SIGTERM');
        });
      }
      await starting?.catch(() => {});
    },
  };
  return runtime;
}
