import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../../dist/server.js';
import { MemoryMcp } from '../../testing/memory-mcp.mjs';
import { SCOPES } from '../../core/auth.mjs';
import { tools, richResult } from '../support/mcp-fixture.mjs';

async function world(settings = { clientId: 'existing-web-client', clientSecret: 'SECRET_CLIENT' }) {
  const host = createFakePluginHost({ pluginId: 'google-workspace', appUrl: 'https://bb.example', settings });
  const mcp = new MemoryMcp({ tools, handler: () => richResult });
  const oauth = {
    authorizationUrl(fields) { const u = new URL('https://accounts.google.com/o/oauth2/v2/auth'); for (const [k,v] of Object.entries(fields)) u.searchParams.set(k, Array.isArray(v) ? v.join(' ') : v); return u.toString(); },
    exchange: async () => ({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 3600, scope: SCOPES.join(' ') }),
    refresh: async () => ({ access_token: 'REFRESHED_ACCESS', expires_in: 3600 }),
    identity: async () => ({ sub: 'alice-id', email: 'alice@example.test', email_verified: true }),
  };
  await plugin(host.bb, { mcp, oauth });
  const rpc = (method, input = null) => host.harness.behavior.callRpc(method, input);
  const selected = () => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
  return { host, mcp, oauth, rpc, selected,
    async connect() {
      const { url } = await rpc('beginConnect');
      return host.harness.behavior.fetchHttp('GET', '/callback?state=' + new URL(url).searchParams.get('state') + '&code=SECRET_CODE');
    },
    close: () => host.harness.lifecycle.dispose(),
  };
}

test('BB owns the combined connection and independent callback, without an upstream login', async () => {
  const w = await world();
  try {
    const status = await w.rpc('status');
    assert.equal(status.configured, true);
    assert.equal(status.redirectUri, 'https://bb.example/api/v1/plugins/google-workspace/http/callback');
    assert.deepEqual(status.accounts, []);
    assert.deepEqual(w.mcp.calls, []);
    assert.equal((await w.connect()).status, 200);
    const connected = await w.rpc('status');
    assert.deepEqual(connected.accounts, [{ subject: 'alice-id', email: 'alice@example.test' }]);
    assert.doesNotMatch(JSON.stringify(connected), /SECRET/);
  } finally { await w.close(); }
});
test('Gmail write is forwarded once with no BB approval or custom planning step', async () => {
  const w = await world();
  try {
    await w.connect(); w.mcp.calls.length = 0;
    const send = (await w.selected()).tools.find(t => t.name.startsWith('gworkspace_send_gmail_message_'));
    assert.ok(send);
    const result = await w.host.harness.behavior.callAgentTool(send.name, { account: 'alice@example.test', to: 'recipient@example.test', body: 'Hello' });
    assert.deepEqual(result.content, richResult.content.concat([{ type: 'text', text: JSON.stringify(richResult.structuredContent) }]));
    assert.deepEqual(w.mcp.calls, [{ method: 'callTool', token: 'SECRET_ACCESS', call: { name: 'send_gmail_message', arguments: { to: 'recipient@example.test', body: 'Hello' } } }]);
    assert.deepEqual(w.host.harness.inspection.pendingInteractions, []);
  } finally { await w.close(); }
});
test('generic call path has the same account routing and result contract', async () => {
  const w = await world();
  try {
    await w.connect();
    const list = JSON.parse((await w.host.harness.behavior.callAgentTool('gworkspace_list_tools', {})).content[0].text);
    assert.ok(list.some(t => t.upstream === 'send_gmail_message'));
    const result = await w.host.harness.behavior.callAgentTool('gworkspace_call_tool', { name: 'modify_doc_text', arguments: { account: 'alice@example.test', document_id: 'doc', text: 'New text' } });
    assert.notEqual(result.isError, true);
    assert.equal(w.mcp.calls.at(-1).call.name, 'modify_doc_text');
  } finally { await w.close(); }
});
test('tool and discovery failures produce bounded diagnostics without provider or token content', async () => {
  const w = await world();
  try {
    await w.connect();
    w.mcp.handler = () => { throw new Error('PRIVATE_CONTENT SECRET_ACCESS SECRET_CODE'); };
    const result = await w.host.harness.behavior.callAgentTool('gworkspace_call_tool', { name: 'modify_doc_text', arguments: { account: 'alice@example.test' } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTENT|SECRET/);
    w.mcp.listTools = async () => { throw new Error('PRIVATE_CONTENT SECRET_REFRESH'); };
    assert.deepEqual(await w.rpc('refresh'), { ready: false });
    assert.equal((await w.selected()).tools.length, 3, 'only generic/account tools remain after failed discovery');
    const logs = JSON.stringify(w.host.harness.inspection.logEntries);
    assert.match(logs, /tool_call/); assert.match(logs, /catalogue_discovery/);
    assert.doesNotMatch(logs, /PRIVATE_CONTENT|SECRET|alice@example|recipient@example/);
  } finally { await w.close(); }
});
test('removing Workspace account disables its tools without affecting original plugins', async () => {
  const w = await world();
  try {
    await w.connect();
    await w.rpc('removeAccount', { subject: 'alice-id' });
    assert.deepEqual((await w.rpc('status')).accounts, []);
    assert.equal((await w.selected()).tools.length, 3);
    assert.deepEqual(w.host.harness.sdk.callsTo('plugins.callRpc'), []);
  } finally { await w.close(); }
});
test('original Web client can be copied server-side without importing tokens', async () => {
  const w = await world({});
  try {
    w.host.harness.sdk.stub('plugins.callRpc', async args => {
      assert.equal(args.pluginId, 'google-drive'); assert.equal(args.method, 'exportOAuthClientForWorkspace');
      return { clientId: 'imported-web-client', clientSecret: 'SECRET_IMPORTED' };
    });
    assert.deepEqual(await w.rpc('importOAuthClient', { source: 'google-drive' }), { imported: true });
    assert.equal(new URL((await w.rpc('beginConnect')).url).searchParams.get('client_id'), 'imported-web-client');
    assert.deepEqual((await w.rpc('status')).accounts, []);
    await w.connect();
    await assert.rejects(w.rpc('importOAuthClient', { source: 'google-drive' }), /Disconnect/);
    assert.doesNotMatch(JSON.stringify(w.host.harness.inspection.logEntries), /SECRET_IMPORTED/);
  } finally { await w.close(); }
});
test('unknown account gives useful feedback before any provider call', async () => {
  const w = await world();
  try {
    await w.connect(); w.mcp.calls.length = 0;
    const result = await w.host.harness.behavior.callAgentTool('gworkspace_call_tool', { name: 'send_gmail_message', arguments: { account: 'unknown@example.test' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /account is unavailable/);
    assert.deepEqual(w.mcp.calls, []);
  } finally { await w.close(); }
});

test('invalid callback is rejected and secrets are never logged', async () => {
  const w = await world();
  try {
    const response = await w.host.harness.behavior.fetchHttp('GET', '/callback?state=UNKNOWN_STATE&code=SECRET_CODE');
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /UNKNOWN_STATE|SECRET_CODE/);
    assert.doesNotMatch(JSON.stringify(w.host.harness.inspection.logEntries), /UNKNOWN_STATE|SECRET/);
  } finally { await w.close(); }
});
