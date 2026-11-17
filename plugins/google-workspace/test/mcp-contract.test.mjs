import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpAdapter } from '../adapters/mcp.mjs';
import { MemoryMcp } from '../testing/memory-mcp.mjs';
import { tools, richResult, googleRpc } from './support/mcp-fixture.mjs';

// Same observable port contract, exercised with the in-memory double and real SDK/HTTP adapter.
for (const kind of ['memory', 'adapter']) {
  function setup(handler = () => richResult) {
    if (kind === 'memory') return { port: new MemoryMcp({ tools, handler }), requests: [] };
    const http = googleRpc({ handler });
    return { port: createMcpAdapter({ endpoint: async () => new URL('http://127.0.0.1:8765/mcp'), fetchImpl: http.fetch }), requests: http.requests };
  }
  test(`${kind}: discovers provider schemas without rewriting them`, async () => {
    const { port } = setup();
    try { assert.deepEqual(await port.listTools('synthetic-token'), tools); }
    finally { await port.close(); }
  });
  test(`${kind}: passes exact tool arguments and rich result; no approval protocol`, async () => {
    const observed = [], { port } = setup((call, token) => { observed.push({ call, token }); return richResult; });
    const call = { name: 'send_gmail_message', arguments: { to: 'recipient@example.test', body: 'Hello 😀' } };
    try {
      assert.deepEqual(await port.callTool('synthetic-token', call), richResult);
      assert.deepEqual(observed, [{ call, token: 'Bearer synthetic-token' }]);
    } finally { await port.close(); }
  });
  test(`${kind}: preserves an upstream error result instead of claiming success`, async () => {
    const errorResult = { content: [{ type: 'text', text: 'Invalid document' }], isError: true };
    const { port } = setup(() => errorResult);
    try { assert.deepEqual(await port.callTool('synthetic-token', { name: 'modify_doc_text', arguments: {} }), errorResult); }
    finally { await port.close(); }
  });
  test(`${kind}: propagates transport failure without replaying a write`, async () => {
    let calls = 0;
    const { port } = setup(() => { calls++; throw new Error('PRIVATE_PROVIDER_SENTINEL'); });
    try {
      await assert.rejects(port.callTool('synthetic-token', { name: 'send_gmail_message', arguments: {} }));
      assert.equal(calls, 1);
    } finally { await port.close(); }
  });
  test(`${kind}: already cancelled calls never reach the provider`, async () => {
    let calls = 0;
    const { port } = setup(() => { calls++; return richResult; });
    try {
      const signal = AbortSignal.abort();
      await assert.rejects(port.callTool('synthetic-token', { name: 'modify_doc_text', arguments: {} }, { signal }));
      assert.equal(calls, 0);
    } finally { await port.close(); }
  });
}

test('real adapter uses selected bearer token only on the fixed MCP endpoint', async () => {
  const http = googleRpc();
  const port = createMcpAdapter({ endpoint: async () => new URL('http://127.0.0.1:8765/mcp'), fetchImpl: http.fetch });
  try {
    await port.listTools('private-selected-account-token');
    assert.ok(http.requests.length >= 3);
    assert.ok(http.requests.every(r => r.url === 'http://127.0.0.1:8765/mcp' && r.token === 'Bearer private-selected-account-token'));
    assert.equal(http.requests.filter(r => r.body.method === 'tools/list').length, 2, 'catalogue paging exercised through the SDK');
  } finally { await port.close(); }
});
