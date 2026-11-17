import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../adapters/runtime.mjs';

// Opt-in: starts the actual pinned Python server, but uses no Google credentials.
test('real Workspace MCP starts and rejects anonymous initialization', { timeout: 120_000 }, async t => {
  const runtime = createRuntime();
  t.after(() => runtime.close());
  const endpoint = await runtime.start();
  assert.equal(endpoint.hostname, '127.0.0.1');
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'workspace-runtime-check', version: '1' },
    } }),
  });
  await response.body?.cancel();
  assert.equal(response.status, 401);
});
