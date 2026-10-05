import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FastmailConnection, FastmailProvider, callbackUrl, parseCallback } from '../core.mjs';

function fixture() {
  let value = {};
  const store = { get: () => structuredClone(value), patch: patch => { value = { ...value, ...patch }; }, remove: (...keys) => { for (const key of keys) delete value[key]; }, clear: () => { value = {}; } };
  const calls = [], registered = [];
  let tools = [
    { name: 'search_mail', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, description: 'Search mail' },
    { name: 'create_calendar_event', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, description: 'Create event' },
  ];
  const clients = [];
  const redirect = callbackUrl('http://127.0.0.1:38886', 'fastmail');
  const connection = new FastmailConnection({ store, redirect, register: tool => registered.push(tool), connect: () => {
    const client = { connect: async () => {}, close: async () => {}, request: async () => ({ tools }), callTool: async (args) => { calls.push(args); return { content: [{ type: 'text', text: 'provider data' }] }; } };
    clients.push(client);
    return { client, transport: { finishAuth: async () => {}, close: async () => {} } };
  } });
  return { store, calls, registered, connection, clients, setTools: value => { tools = value; }, redirect };
}

test('connection exposes dynamic read and mutation schemas, then revokes both', async () => {
  const f = fixture(); await f.connection.open();
  assert.equal(f.registered.length, 2);
  const ids = f.connection.toolNames();
  assert.deepEqual(f.registered[1].parameters, { type: 'object', properties: { title: { type: 'string' } } });
  assert.equal((await f.connection.call(ids[1], { title: 'mock' })).content[0].text, 'provider data');
  assert.deepEqual(f.calls, [{ name: 'create_calendar_event', arguments: { title: 'mock' } }]);
  await f.connection.disconnect(); assert.deepEqual(f.connection.toolNames(), []);
  await assert.rejects(f.connection.call(ids[1], {}), /unavailable/);
  await f.connection.open(); f.setTools([f.registered[0] && { name: 'search_mail', inputSchema: f.registered[0].parameters }]);
  await f.connection.refresh(); assert.equal(f.connection.toolNames().length, 1);
  f.store.patch({ tokens: { access_token: 'mock-token' } });
  await f.connection.disable(); assert.deepEqual(f.connection.toolNames(), []);
  assert.equal(f.store.get().tokens.access_token, 'mock-token'); // BB disable/reload retains local grant but cannot call
  await assert.rejects(f.connection.open(), /disabled/);
});

test('paginated catalog discovers all tools and refuses cursor cycles or oversized catalogs', async () => {
  const f = fixture();
  const pages = [];
  f.connection.makeConnection = () => ({ client: {
    connect: async () => {}, close: async () => {},
    request: async message => { const cursor = message.params?.cursor; pages.push(cursor); return cursor === 'next'
      ? { tools: [{ name: 'write', inputSchema: { type: 'object' } }] }
      : { tools: [{ name: 'read', inputSchema: { type: 'object' } }], nextCursor: 'next' }; },
    callTool: async () => ({ content: [] }),
  }, transport: {} });
  await f.connection.open();
  assert.deepEqual(pages, [undefined, 'next']);
  assert.deepEqual(f.connection.list().map(x => x.name), ['read', 'write']);
  f.connection.client.request = async () => ({ tools: [], nextCursor: 'next' });
  await assert.rejects(f.connection.refresh(), /cycle/);
  assert.deepEqual(f.connection.toolNames(), [], 'incomplete catalog revokes stale tools');
  f.connection.client.request = async () => ({ tools: Array(2049).fill({ name: 'x' }) });
  await assert.rejects(f.connection.refresh(), /limit/);
  f.connection.client.request = async () => ({ tools: [{ name: 'big', inputSchema: { description: 'x'.repeat(4 * 1024 * 1024) } }] });
  await assert.rejects(f.connection.refresh(), /limit/);
  f.connection.client.request = async () => ({ tools: [], nextCursor: randomUUID() });
  await assert.rejects(f.connection.refresh(), /page limit/);
});

test('a late catalog page cannot restore tools after disconnect', async () => {
  const f = fixture(); await f.connection.open();
  let resolvePage;
  f.connection.client.request = () => new Promise(resolve => { resolvePage = resolve; });
  const refresh = f.connection.refresh();
  await f.connection.disconnect();
  resolvePage({ tools: [{ name: 'late', inputSchema: { type: 'object' } }] });
  await refresh;
  assert.deepEqual(f.connection.toolNames(), []);
  assert.deepEqual(f.connection.list(), []);
});

test('callback paste-back checks exact route, one-use state and PKCE verifier without returning a code', async () => {
  const f = fixture(); const provider = new FastmailProvider(f.store, f.redirect);
  const state = await provider.state(); provider.saveCodeVerifier('synthetic-verifier');
  const url = `${f.redirect}?state=${state}&code=synthetic-code`;
  assert.throws(() => parseCallback(url.replace('/fastmail/', '/google-calendar/'), f.redirect), /route/);
  assert.throws(() => parseCallback(url.replace('localhost', 'evil.example'), f.redirect), /route/);
  assert.throws(() => parseCallback(`${url}&code=extra`, f.redirect), /route/);
  assert.throws(() => provider.consume(new URLSearchParams('state=wrong&code=synthetic-code')), /Invalid/);
  assert.throws(() => provider.consume(parseCallback(url, f.redirect)), /Invalid/);
  const state2 = await provider.state(); provider.saveCodeVerifier('synthetic-verifier');
  provider.consume(parseCallback(`${f.redirect}?state=${state2}&code=synthetic-code`, f.redirect));
  assert.equal(provider.codeVerifier(), 'synthetic-verifier');
  assert.throws(() => provider.consume(parseCallback(`${f.redirect}?state=${state2}&code=synthetic-code`, f.redirect)), /Invalid/);
});

test('expired or cancelled callbacks never reach exchange', async () => {
  const f = fixture(); const provider = f.connection.provider;
  let state = await provider.state(); provider.saveCodeVerifier('verifier');
  f.store.patch({ pending: { ...f.store.get().pending, at: Date.now() - 11 * 60_000 } });
  assert.throws(() => provider.consume(new URLSearchParams({ state, code: 'mock-code' })), /expired/);
  state = await provider.state(); provider.saveCodeVerifier('verifier');
  assert.throws(() => provider.consume(new URLSearchParams({ state, error: 'access_denied' })), /Invalid/);
  assert.equal(f.store.get().pending, undefined);
});

test('a protocol failure is not retried, including an uncertain mutation', async () => {
  const f = fixture(); let attempts = 0;
  f.connection.makeConnection = () => ({ client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: [{ name: 'send_mail', inputSchema: { type: 'object' } }] }), callTool: async () => { attempts++; throw new Error('provider response lost'); } }, transport: {} });
  await f.connection.open();
  await assert.rejects(f.connection.call(f.connection.toolNames()[0], {}), /response lost/);
  assert.equal(attempts, 1);
});

test('failed SDK exchange fails closed and consumes pending callback', async () => {
  const f = fixture(); const state = await f.connection.provider.state(); f.connection.provider.saveCodeVerifier('verifier');
  f.connection.makeConnection = () => ({ client: {}, transport: { finishAuth: async () => { throw new Error('token=sensitive'); }, close: async () => {} } });
  await assert.rejects(f.connection.finish(new URLSearchParams(`state=${state}&code=synthetic`)), /^Error: Fastmail authorization failed$/);
  assert.equal(f.store.get().pending, undefined);
});
