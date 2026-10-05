import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { FastmailConnection } from '../core.mjs';

// Synthetic OAuth discovery + MCP. No Fastmail network access or account data.
test('official client discovers OAuth/PKCE and forwards a granted mutation through MCP', { timeout: 20000 }, async () => {
  let base, challenge, state, tokenCalls = 0, mutationCalls = 0;
  const listCursors = [];
  const send = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, base).pathname;
    if (path.includes('oauth-protected-resource')) return send(res, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] });
    if (path.includes('oauth-authorization-server')) return send(res, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'] });
    if (path === '/auth/register') { let body = ''; for await (const chunk of req) body += chunk; return send(res, { client_id: 'mock-client', redirect_uris: JSON.parse(body).redirect_uris, token_endpoint_auth_method: 'none' }); }
    if (path === '/auth/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      assert.equal(params.get('code'), 'mock-code'); tokenCalls++;
      return send(res, { access_token: 'mock-access', refresh_token: 'mock-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    if (path === '/mcp') {
      if (req.headers.authorization !== 'Bearer mock-access') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); res.end(); return;
      }
      let body = ''; for await (const chunk of req) body += chunk;
      if (!body) { res.writeHead(202); res.end(); return; }
      const message = JSON.parse(body);
      if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } }
        : message.method === 'tools/list' ? (listCursors.push(message.params?.cursor), message.params?.cursor === 'second'
          ? { tools: [{ name: 'read_mail', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'send_mail', description: 'Mock mutation', inputSchema: { type: 'object', properties: { subject: { type: 'string' } } } }], nextCursor: 'second' })
        : message.method === 'tools/call' ? (mutationCalls++, { content: [{ type: 'text', text: 'mock-result' }] }) : {};
      return send(res, { jsonrpc: '2.0', id: message.id, result }, 200, { 'mcp-session-id': 'mock-session' });
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
  let value = {};
  const store = { get: () => structuredClone(value), patch: p => { value = { ...value, ...p }; }, remove: (...keys) => { keys.forEach(key => delete value[key]); }, clear: () => { value = {}; } };
  const registered = [];
  const connection = new FastmailConnection({ store, redirect: 'http://localhost:38886/api/v1/plugins/fastmail/http/oauth/callback', endpoint: new URL(`${base}/mcp`), register: x => registered.push(x) });
  try {
    const url = new URL(await connection.begin());
    challenge = url.searchParams.get('code_challenge'); state = url.searchParams.get('state');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.ok(state && challenge);
    await assert.rejects(connection.finish(new URLSearchParams({ state, code: 'mock-code', iss: `${base}/impostor` })), /authorization/);
    assert.equal(tokenCalls, 0, 'wrong issuer must be rejected before token exchange');
    await assert.rejects(connection.finish(new URLSearchParams({ state, code: 'mock-code' })), /authorization/);
    assert.equal(tokenCalls, 0);
    const second = new URL(await connection.begin());
    challenge = second.searchParams.get('code_challenge'); state = second.searchParams.get('state');
    await connection.finish(new URLSearchParams({ state, code: 'mock-code', iss: `${base}/auth` }));
    assert.equal(tokenCalls, 1); assert.equal(registered.length, 2);
    assert.deepEqual(connection.list().map(tool => tool.name), ['send_mail', 'read_mail']);
    assert.deepEqual(listCursors, [undefined, 'second']);
    const result = await connection.call(connection.toolNames()[0], { subject: 'mock' });
    assert.equal(result.content[0].text, 'mock-result'); assert.equal(mutationCalls, 1);
    await connection.disconnect();
    assert.equal(connection.toolNames().length, 0); assert.deepEqual(store.get(), {});
  } finally { await connection.disable(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
