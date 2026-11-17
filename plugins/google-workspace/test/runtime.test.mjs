import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRuntime, runtimeEnvironment } from '../adapters/runtime.mjs';

function world(options = {}) {
  const launches = [], signals = [], logs = [];
  const child = new EventEmitter();
  child.kill = signal => { signals.push(signal); child.emit('exit', 0, signal); return true; };
  const runtime = createRuntime({ getPort: async () => 8765,
    launch: (...args) => { launches.push(args); options.onLaunch?.(child); return child; },
    fetchImpl: options.fetchImpl || (async () => new Response(null, { status: 401 })),
    wait: async () => {}, attempts: 2, diagnose: (...args) => logs.push(args) });
  return { runtime, child, launches, signals, logs };
}

test('starts the pinned five-service backend once on loopback and closes it', async () => {
  const w = world();
  assert.equal(w.runtime.state, 'idle');
  assert.equal((await w.runtime.start()).href, 'http://127.0.0.1:8765/mcp');
  await w.runtime.start();
  assert.equal(w.launches.length, 1);
  const [program, args, opts] = w.launches[0];
  assert.equal(program, 'uvx'); assert.ok(args.includes('workspace-mcp==2.3.0'));
  for (const service of ['drive', 'docs', 'sheets', 'calendar', 'gmail']) assert.ok(args.includes(service), service);
  assert.equal(opts.env.WORKSPACE_MCP_HOST, '127.0.0.1');
  assert.equal(opts.env.EXTERNAL_OAUTH21_PROVIDER, 'true');
  await w.runtime.close();
  assert.deepEqual(w.signals, ['SIGTERM']);
});
test('runtime receives no parent Google credentials or arbitrary upstream configuration', () => {
  const env = runtimeEnvironment(8765, { PATH: '/bin', HOME: '/synthetic-home', GOOGLE_OAUTH_CLIENT_SECRET: 'SECRET', GOOGLE_WORKSPACE_CLI_TOKEN: 'SECRET', WORKSPACE_MCP_HOST: '0.0.0.0', WORKSPACE_MCP_LOG_LEVEL: 'DEBUG' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.WORKSPACE_MCP_HOST, '127.0.0.1');
  assert.equal(env.WORKSPACE_MCP_LOG_LEVEL, 'CRITICAL');
  assert.equal(env.WORKSPACE_MCP_STATELESS_MODE, 'true');
  assert.doesNotMatch(JSON.stringify(env), /SECRET/);
});
test('missing uvx is a classified startup failure, not a raw child exception', async () => {
  const w = world({ onLaunch: child => queueMicrotask(() => child.emit('error', Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'ENOENT' }))),
    fetchImpl: async () => { throw new Error('not ready'); } });
  try { await assert.rejects(w.runtime.start(), error => error.workspaceCategory === 'runtime_missing' && !error.message.includes('PRIVATE_SENTINEL')); }
  finally { await w.runtime.close(); }
});
test('backend startup timeout stops the child; unexpected exit is observable', async () => {
  const w = world({ fetchImpl: async () => { throw new Error('not ready'); } });
  await assert.rejects(w.runtime.start(), error => error.workspaceCategory === 'runtime_timeout');
  assert.deepEqual(w.signals, ['SIGTERM']);
  await w.runtime.close();
  const next = world(); await next.runtime.start(); next.child.emit('exit', 1);
  assert.equal(next.runtime.state, 'unavailable');
  assert.deepEqual(next.logs, [['runtime_exit', { workspaceCategory: 'runtime_exit' }]]);
  await next.runtime.close();
});
