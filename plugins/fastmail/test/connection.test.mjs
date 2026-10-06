import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FastmailConnection, FastmailProvider, callbackUrl, parseCallback, defaultSendingAddress } from '../core.mjs';
import { failureCategory, connectionFailureContext } from '../diagnostic.mjs';
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';

function fixture() {
  let value = {};
  const store = { get: () => structuredClone(value), patch: patch => { value = { ...value, ...patch }; }, remove: (...keys) => { for (const key of keys) delete value[key]; }, clear: () => { value = {}; } };
  const calls = [], registered = [], diagnostics = [];
  let tools = [
    { name: 'search_mail', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, description: 'Search mail' },
    { name: 'create_calendar_event', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, description: 'Create event' },
  ];
  const clients = [];
  const redirect = callbackUrl('http://127.0.0.1:38886', 'fastmail');
  const connection = new FastmailConnection({ store, redirect, register: tool => registered.push(tool), diagnose: message => diagnostics.push(message), connect: () => {
    const client = { connect: async () => {}, close: async () => {}, request: async () => ({ tools }), callTool: async (args) => { calls.push(args); return { content: [{ type: 'text', text: 'provider data' }] }; } };
    clients.push(client);
    return { client, transport: { finishAuth: async () => {}, close: async () => {} } };
  } });
  return { store, calls, registered, diagnostics, connection, clients, setTools: value => { tools = value; }, redirect };
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

test('only one explicitly default sending identity can label a connection', () => {
  const identities = [
    { email: 'alias@example.test', name: 'Alias', isDefault: false },
    { email: 'sender@example.test', name: 'Sender', isDefault: true },
  ];
  assert.equal(defaultSendingAddress({ content: [{ type: 'text', text: JSON.stringify(identities) }] }), 'sender@example.test');
  assert.equal(defaultSendingAddress({ structuredContent: { identities }, content: [] }), 'sender@example.test');
  assert.equal(defaultSendingAddress({ content: [{ type: 'text', text: JSON.stringify(identities) }], isError: true }), null);
  assert.equal(defaultSendingAddress({ content: [{ type: 'text', text: JSON.stringify(identities.map(item => ({ ...item, isDefault: false }))) }] }), null);
  assert.equal(defaultSendingAddress({ content: [{ type: 'text', text: JSON.stringify(identities.map(item => ({ ...item, isDefault: true }))) }] }), null);
  assert.equal(defaultSendingAddress({ content: [{ type: 'text', text: JSON.stringify([{ email: 'bad\n@example.test', isDefault: true }]) }] }), null);
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

test('diagnostic categories discard untrusted error messages and arbitrary codes', () => {
  const secret = 'token=private code=one-use';
  assert.equal(failureCategory(new ProtocolError(-32602, secret, { body: secret })), 'protocol_code=-32602');
  assert.equal(failureCategory(new SdkError(SdkErrorCode.RequestTimeout, secret)), 'REQUEST_TIMEOUT');
  assert.equal(failureCategory(new Error(secret)), 'unknown');
  assert.equal(failureCategory({ name: secret, code: secret, status: 401, message: secret }), 'unknown');
});

test('connection context only includes bounded age, session presence, protocol and validated provider trace', () => {
  const error = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'private token and callback code', {
    status: 500, text: JSON.stringify({ trace_id: `ti_${'a'.repeat(32)}`, detail: 'private email body' }),
  });
  const context = connectionFailureContext(error, { openedAt: 1000, now: 37 * 60_000, sessionIdPresent: true, protocolVersion: '2025-11-25' });
  assert.equal(context, `age=30-60m session=present protocol=2025-11-25 trace=ti_${'a'.repeat(32)}`);
  assert.doesNotMatch(context, /private|token|callback|email/);
  const hostile = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'private', {
    status: 500, text: JSON.stringify({ trace_id: 'ti_private-email-body', detail: 'private-token' }),
  });
  assert.equal(connectionFailureContext(hostile, { openedAt: -1, now: 1000, sessionIdPresent: 'private', protocolVersion: 'private-token' }),
    'age=unknown session=unknown protocol=unknown trace=none');
});

test('connection failures report only a bounded category, not provider errors', async () => {
  const f = fixture();
  f.connection.makeConnection = () => ({ client: { connect: async () => { throw new Error('code=private one-time-token'); }, close: async () => {} }, transport: {} });
  await assert.rejects(f.connection.open(), /^Error: Fastmail connection failed$/);
  assert.deepEqual(f.diagnostics, ['connection_open unknown']);
});

test('a protocol failure is not retried, including an uncertain mutation', async () => {
  const f = fixture(); let attempts = 0;
  f.connection.makeConnection = () => ({ client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: [{ name: 'send_mail', inputSchema: { type: 'object' } }] }), callTool: async () => { attempts++; throw new Error('provider response lost'); } }, transport: {} });
  await f.connection.open();
  await assert.rejects(f.connection.call(f.connection.toolNames()[0], {}), /response lost/);
  assert.equal(attempts, 1);
});

test('an aged connection rotates before sending a tool call, even for a mutation', async () => {
  const f = fixture(); let connections = 0; let calls = 0; let closes = 0;
  f.connection.makeConnection = () => {
    const generation = ++connections;
    return { client: {
      connect: async () => {}, close: async () => { closes++; },
      request: async () => ({ tools: [{ name: 'send_mail', inputSchema: { type: 'object' } }] }),
      callTool: async () => { calls++; return { content: [{ type: 'text', text: `connection ${generation}` }] }; },
    }, transport: {} };
  };
  await f.connection.open();
  f.connection.openedAt = Date.now() - 26 * 60_000;
  const id = f.connection.toolNames()[0];
  assert.equal((await f.connection.call(id, {})).content[0].text, 'connection 2');
  assert.equal(connections, 2);
  assert.equal(closes, 1);
  assert.equal(calls, 1, 'the mutation is sent only on the fresh connection');
});

test('concurrent calls share a proactive rotation', async () => {
  const f = fixture(); let connections = 0; let calls = 0;
  f.connection.makeConnection = () => ({ client: {
    connect: async () => { connections++; }, close: async () => {},
    request: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] }),
    callTool: async () => { calls++; return { content: [] }; },
  }, transport: {} });
  await f.connection.open();
  f.connection.openedAt = Date.now() - 26 * 60_000;
  const id = f.connection.toolNames()[0];
  await Promise.all([f.connection.call(id, {}), f.connection.call(id, {})]);
  assert.equal(connections, 2);
  assert.equal(calls, 2);
});

test('an in-flight mutation is never interrupted for proactive rotation', async () => {
  const f = fixture(); let connections = 0; let finishWrite; let started;
  const writeStarted = new Promise(resolve => { started = resolve; });
  f.connection.makeConnection = () => ({ client: {
    connect: async () => { connections++; }, close: async () => {},
    request: async () => ({ tools: [{ name: 'send_mail', inputSchema: { type: 'object' } }] }),
    callTool: async () => {
      if (!finishWrite) { started(); return new Promise(resolve => { finishWrite = resolve; }); }
      return { content: [] };
    },
  }, transport: {} });
  await f.connection.open();
  const id = f.connection.toolNames()[0];
  const pendingWrite = f.connection.call(id, {});
  await writeStarted;
  f.connection.openedAt = Date.now() - 26 * 60_000;
  await f.connection.call(id, {});
  assert.equal(connections, 1, 'an active write is never closed for maintenance');
  finishWrite({ content: [] });
  await pendingWrite;
  await f.connection.call(id, {});
  assert.equal(connections, 2, 'rotation proceeds after the write finishes');
});

test('an aged identity lookup uses the fresh connection and still returns the default address', async () => {
  const f = fixture(); let connections = 0;
  f.connection.makeConnection = () => {
    connections++;
    return { client: {
      connect: async () => {}, close: async () => {},
      request: async () => ({ tools: [{ name: 'list_identities', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify([{ email: 'private@example.test', isDefault: true }]) }] }),
    }, transport: {} };
  };
  await f.connection.open();
  f.connection.openedAt = Date.now() - 26 * 60_000;
  assert.equal(await f.connection.getDefaultSendingAddress(), 'private@example.test');
  assert.equal(connections, 2);
});

test('disconnect during proactive rotation cannot restore a revoked grant', async () => {
  const f = fixture(); let connections = 0; let finishClose; let closing;
  const closeStarted = new Promise(resolve => { closing = resolve; });
  f.connection.makeConnection = () => {
    connections++;
    return { client: {
      connect: async () => {}, close: async () => { closing(); await new Promise(resolve => { finishClose = resolve; }); },
      request: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] }),
    }, transport: {} };
  };
  f.store.patch({ tokens: { access_token: 'private-token' } });
  await f.connection.open();
  f.connection.openedAt = Date.now() - 26 * 60_000;
  const pending = f.connection.call(f.connection.toolNames()[0], {});
  await closeStarted;
  await f.connection.disconnect();
  finishClose();
  await assert.rejects(pending, /Fastmail tool unavailable/);
  assert.equal(connections, 1);
  assert.equal(f.connection.ready, false);
  assert.deepEqual(f.store.get(), {});
});

test('an HTTP 500 reopens the connection without retrying an uncertain call', async () => {
  const f = fixture();
  let connections = 0; let calls = 0; let closes = 0;
  f.connection.makeConnection = () => {
    const generation = ++connections;
    return { client: {
      connect: async () => {}, close: async () => { closes++; },
      request: async () => ({ tools: [{ name: 'send_mail', inputSchema: { type: 'object' } }] }),
      callTool: async () => {
        calls++;
        if (generation === 1) throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'private provider body', { status: 500, text: 'private token' });
        return { content: [{ type: 'text', text: 'success' }] };
      },
    }, transport: {} };
  };
  await f.connection.open();
  const id = f.connection.toolNames()[0];
  await assert.rejects(f.connection.call(id, {}), /private provider body/);
  assert.equal(calls, 1, 'an uncertain mutation is never retried');
  assert.equal(connections, 2, 'one fresh connection is opened');
  assert.equal(closes, 1);
  assert.equal(f.connection.ready, true);
  assert.deepEqual(f.diagnostics, ['connection_reset http_status=500 age=under_5m session=absent protocol=unknown trace=none']);
  assert.equal((await f.connection.call(id, {})).content[0].text, 'success');
});

test('concurrent HTTP 500s reopen the connection only once', async () => {
  const f = fixture(); let connections = 0; let calls = 0;
  f.connection.makeConnection = () => {
    const generation = ++connections;
    return { client: {
      connect: async () => {}, close: async () => {}, request: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] }),
      callTool: async () => { calls++; if (generation === 1) throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'private', { status: 500 }); return { content: [] }; },
    }, transport: {} };
  };
  await f.connection.open();
  const id = f.connection.toolNames()[0];
  const results = await Promise.allSettled([f.connection.call(id, {}), f.connection.call(id, {})]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(calls, 2);
  assert.equal(connections, 2);
  assert.equal(f.connection.ready, true);
});

test('disconnect during a failed-call recovery cannot restore the old grant', async () => {
  const f = fixture(); let connections = 0; let finishClose;
  let closing;
  const closeStarted = new Promise(resolve => { closing = resolve; });
  f.connection.makeConnection = () => {
    connections++;
    return { client: {
      connect: async () => {},
      close: async () => { closing(); await new Promise(resolve => { finishClose = resolve; }); },
      request: async () => ({ tools: [{ name: 'write', inputSchema: { type: 'object' } }] }),
      callTool: async () => { throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'private', { status: 500 }); },
    }, transport: {} };
  };
  f.store.patch({ tokens: { access_token: 'private-token' } });
  await f.connection.open();
  const failed = f.connection.call(f.connection.toolNames()[0], {});
  await closeStarted;
  await f.connection.disconnect();
  finishClose();
  await assert.rejects(failed);
  assert.equal(connections, 1);
  assert.equal(f.connection.ready, false);
  assert.deepEqual(f.store.get(), {});
});

test('failed SDK exchange fails closed and consumes pending callback', async () => {
  const f = fixture(); const state = await f.connection.provider.state(); f.connection.provider.saveCodeVerifier('verifier');
  f.connection.makeConnection = () => ({ client: {}, transport: { finishAuth: async () => { throw new Error('token=sensitive'); }, close: async () => {} } });
  await assert.rejects(f.connection.finish(new URLSearchParams(`state=${state}&code=synthetic`)), /^Error: Fastmail authorization failed$/);
  assert.equal(f.store.get().pending, undefined);
});
