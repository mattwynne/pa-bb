import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';

// The built plugin runs against BB's host contract, but never contacts Fastmail.
test('fresh provider resolutions select granted dynamic tools and hide provider metadata', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'synthetic' } }));
  let catalog = [
    { name: 'read', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'send', inputSchema: { type: 'object', properties: { subject: { type: 'string' } } } },
    { name: 'list_identities', inputSchema: { type: 'object' } },
  ];
  const calls = [];
  const fakeConnect = () => ({
    client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: catalog }),
      callTool: async args => {
        if (args.name === 'list_identities') return { content: [{ type: 'text', text: JSON.stringify([
          { email: 'alias@example.test', isDefault: false },
          { email: 'sender@example.test', isDefault: true },
        ]) }] };
        calls.push(args); return { content: [
        { type: 'text', text: 'provider body', _meta: { internal: 'private' } },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', _meta: { internal: 'private' } },
        { type: 'resource_link', uri: 'https://example.test', name: 'link', _meta: { internal: 'private' } },
      ], structuredContent: { count: 1 }, _meta: { internal: 'private' } }; } },
    transport: { close: async () => {} },
  });
  try {
    await plugin(host.bb, fakeConnect);
    const resolve = () => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const selected = await resolve();
    assert.equal(selected.tools.length, 5);
    const status = await host.harness.behavior.callRpc('status', null);
    assert.equal(status.defaultSendingAddress, 'sender@example.test');
    const send = selected.tools.find(x => x.name.startsWith('fastmail_send_'));
    assert.deepEqual(send.inputSchema.properties, { subject: { type: 'string' } });
    const result = await host.harness.behavior.callAgentTool(send.name, { subject: 'mock' });
    assert.deepEqual(calls, [{ name: 'send', arguments: { subject: 'mock' } }]);
    assert.deepEqual(result.content.slice(0, 2), [
      { type: 'text', text: 'provider body' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    assert.match(result.content[2].text, /resource_link/);
    assert.match(result.content[3].text, /structuredContent/);
    assert.doesNotMatch(JSON.stringify(result), /private|_meta/);
    catalog = [catalog[0]];
    await host.harness.behavior.callRpc('refresh', null);
    assert.equal((await resolve()).tools.length, 3);
    const withoutIdentity = await host.harness.behavior.callRpc('status', null);
    assert.equal(withoutIdentity.connected, true);
    assert.equal(withoutIdentity.defaultSendingAddress, null);
    assert.equal((await host.harness.behavior.callAgentTool(send.name, {})).isError, true);
    await host.harness.behavior.callRpc('disconnect', null);
    assert.deepEqual((await resolve()).tools, []);
    assert.equal((await host.harness.behavior.callRpc('status', null)).defaultSendingAddress, null);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('failure diagnostics distinguish call routes and status without leaking provider or OAuth content', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-access-token' } }));
  const tools = [
    { name: 'list_identities', inputSchema: { type: 'object' } },
    { name: 'read_email', inputSchema: { type: 'object' } },
  ];
  const fakeConnect = () => ({
    client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools }),
      callTool: async ({ name }) => {
        if (name === 'list_identities') throw new SdkHttpError(SdkErrorCode.ClientHttpAuthentication,
          'Bearer private-access-token; code=one-use-secret', { status: 401, body: 'private-email-body' });
        throw new Error('private-email-body https://localhost/?code=one-use-secret');
      } },
    transport: { close: async () => {} },
  });
  try {
    await plugin(host.bb, fakeConnect);
    const status = await host.harness.behavior.callRpc('status', null);
    assert.equal(status.connected, true);
    assert.equal(status.defaultSendingAddress, null);
    const selected = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const direct = selected.tools.find(tool => tool.name.startsWith('fastmail_read_email_'));
    assert.equal((await host.harness.behavior.callAgentTool(direct.name, {})).isError, true);
    assert.equal((await host.harness.behavior.callAgentTool('fastmail_call_tool', { name: 'read_email', arguments: {} })).isError, true);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /identity_lookup.*http_status=401/);
    assert.match(logs, /direct_call.*unknown/);
    assert.match(logs, /fallback_call.*unknown/);
    assert.doesNotMatch(logs, /private-access-token|private-email-body|one-use-secret|localhost|body|read_email/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('BB remains connected after an HTTP 500 without replaying the failed tool', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-token' } }));
  let connections = 0; let calls = 0;
  const fakeConnect = () => {
    const generation = ++connections;
    return { client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: [
      { name: 'read', inputSchema: { type: 'object' } }, { name: 'list_identities', inputSchema: { type: 'object' } },
    ] }), callTool: async ({ name }) => {
      if (name === 'list_identities') return { content: [{ type: 'text', text: JSON.stringify([{ email: 'private@example.test', isDefault: true }]) }] };
      calls++;
      if (generation === 1) throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'private body', {
        status: 500, text: JSON.stringify({ trace_id: `ti_${'b'.repeat(32)}`, detail: 'private token' }),
      });
      return { content: [{ type: 'text', text: 'ok' }] };
    } }, transport: { close: async () => {} } };
  };
  try {
    await plugin(host.bb, fakeConnect);
    const selected = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const read = selected.tools.find(tool => tool.name.startsWith('fastmail_read_'));
    assert.equal((await host.harness.behavior.callAgentTool(read.name, {})).isError, true);
    assert.equal(calls, 1);
    assert.equal(connections, 2);
    assert.equal((await host.harness.behavior.callRpc('status', null)).connected, true);
    assert.equal((await host.harness.behavior.callAgentTool(read.name, {})).isError, undefined);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /connection_reset http_status=500 age=under_5m session=absent protocol=unknown trace=ti_b{32}/);
    assert.match(logs, /direct_call http_status=500/);
    assert.doesNotMatch(logs, /private body|private token|private@example/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('a successful identity response without a default sender explains the blank account label', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-access-token' } }));
  try {
    await plugin(host.bb, () => ({ client: {
      connect: async () => {}, close: async () => {},
      request: async () => ({ tools: [{ name: 'list_identities', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'private provider response' }], structuredContent: { items: [] } }),
    }, transport: { close: async () => {} } }));
    assert.equal((await host.harness.behavior.callRpc('status', null)).defaultSendingAddress, null);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /identity_lookup no_default_sender/);
    assert.doesNotMatch(logs, /private provider response|private-access-token/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('provider error results and failed catalog refresh are reported without provider text', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-access-token' } }));
  let catalogFails = false;
  const fakeConnect = () => ({
    client: { connect: async () => {}, close: async () => {},
      request: async () => { if (catalogFails) throw new SdkError(SdkErrorCode.RequestTimeout, 'token=private'); return { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }; },
      callTool: async () => ({ content: [{ type: 'text', text: 'private-provider-error' }], isError: true }) },
    transport: { close: async () => {} },
  });
  try {
    await plugin(host.bb, fakeConnect);
    const selected = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const result = await host.harness.behavior.callAgentTool(selected.tools.find(tool => tool.name.startsWith('fastmail_read_')).name, {});
    assert.equal(result.isError, true);
    catalogFails = true;
    await assert.rejects(host.harness.behavior.callRpc('refresh', null));
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /direct_call.*provider_error_result/);
    assert.match(logs, /catalog_refresh.*REQUEST_TIMEOUT/);
    assert.doesNotMatch(logs, /private-provider-error|token=private/);
  } finally { await host.harness.lifecycle.dispose(); }
});
