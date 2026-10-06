import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { SCOPES } from '../core/service.mjs';
import { createBbStore } from '../adapters/bb-store.mjs';

async function setup(settings = { clientId: 'web-id', clientSecret: 'private-client-secret' }) {
  const host = createFakePluginHost({ pluginId: 'google-drive', appUrl: 'https://bb.example', settings });
  await plugin(host.bb);
  return host;
}
test('registers five read-only tools, an independent callback, and no connected accounts on first run', async () => {
  const { harness } = await setup();
  try {
    const selected = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.deepEqual(selected.tools.map(t => t.name).sort(), ['gdocs_read','gdrive_auth_status','gdrive_get_file','gdrive_list_folder','gdrive_search_files']);
    const status = await harness.behavior.callRpc('status', null);
    assert.equal(status.redirectUri, 'https://bb.example/api/v1/plugins/google-drive/http/callback');
    assert.deepEqual(status.accounts, []);
    const { url } = await harness.behavior.callRpc('beginConnect', null);
    assert.equal(new URL(url).searchParams.get('code_challenge_method'), 'S256');
    assert.equal(new URL(url).searchParams.get('scope'), SCOPES.join(' '));
    const failed = await harness.behavior.fetchHttp('GET', '/callback?state=bogus&code=private-code');
    assert.equal(failed.status, 400);
    assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-code|private-client-secret|bogus/);
    assert.deepEqual(JSON.parse((await harness.behavior.callAgentTool('gdrive_auth_status', {})).content[0].text).accounts, []);
  } finally { await harness.lifecycle.dispose(); }
});

test('only the verified Calendar plugin can receive Drive Web client settings', async () => {
  const { harness } = await setup({ clientId: 'web-id', clientSecret: 'private-client-secret' });
  try {
    await assert.rejects(() => harness.behavior.callRpc('exportOAuthClientForCalendar', null), /restricted/);
    await assert.rejects(() => harness.behavior.callRpc('exportOAuthClientForCalendar', null,
      { experimental_caller: { kind: 'plugin', pluginId: 'fastmail' } }), /restricted/);
    const client = await harness.behavior.callRpc('exportOAuthClientForCalendar', null,
      { experimental_caller: { kind: 'plugin', pluginId: 'google-calendar' } });
    assert.deepEqual(client, { clientId: 'web-id', clientSecret: 'private-client-secret' });
    assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-client-secret/);
  } finally { await harness.lifecycle.dispose(); }
});

test('one-time Calendar client import stays server-side and Drive keeps its own copy', async () => {
  let { harness } = await setup({});
  try {
    harness.sdk.stub('plugins.callRpc', async args => {
      assert.equal(args.pluginId, 'google-calendar');
      assert.equal(args.method, 'exportOAuthClientForDrive');
      return { clientId: 'shared-web-id', clientSecret: 'private-calendar-secret' };
    });
    assert.deepEqual(await harness.behavior.callRpc('importCalendarOAuthClient', null), { imported: true });
    const status = await harness.behavior.callRpc('status', null);
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes('private-calendar-secret'), false);
    const { url } = await harness.behavior.callRpc('beginConnect', null);
    assert.equal(new URL(url).searchParams.get('client_id'), 'shared-web-id');
    assert.doesNotMatch(url, /private-calendar-secret/);
    ({ harness } = await harness.lifecycle.reload(plugin));
    assert.equal((await harness.behavior.callRpc('status', null)).configured, true);
    assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-calendar-secret/);
  } finally { await harness.lifecycle.dispose(); }
});

test('a missing Calendar plugin leaves Drive unconfigured', async () => {
  const { harness } = await setup({});
  try {
    await assert.rejects(() => harness.behavior.callRpc('importCalendarOAuthClient', null));
    assert.equal((await harness.behavior.callRpc('status', null)).configured, false);
  } finally { await harness.lifecycle.dispose(); }
});

test('import refuses to replace the OAuth client of an already connected Drive account', async () => {
  const host = await setup({});
  try {
    const store = createBbStore(host.bb.storage.database(), () => {});
    await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'private-refresh' });
    await assert.rejects(() => host.harness.behavior.callRpc('importCalendarOAuthClient', null), /Disconnect Drive accounts/);
    assert.deepEqual(host.harness.sdk.callsTo('plugins.callRpc'), []);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('callback consumes grant once and a plugin reload retains the Drive account without touching Calendar', async () => {
  const fetchOriginal = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/token')) { exchanges++; return Response.json({ access_token: 'private-access', refresh_token: 'private-refresh', scope: SCOPES.join(' '), expires_in: 3600 }); }
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'google-sub', email: 'alice@example.test', email_verified: true });
    throw new Error('Unexpected external request');
  };
  let harness;
  try {
    ({ harness } = await setup());
    const { url } = await harness.behavior.callRpc('beginConnect', null);
    const state = new URL(url).searchParams.get('state');
    const path = `/callback?state=${encodeURIComponent(state)}&code=once`;
    assert.equal((await harness.behavior.fetchHttp('GET', path)).status, 200);
    assert.equal((await harness.behavior.fetchHttp('GET', path)).status, 400);
    assert.equal(exchanges, 1);
    assert.deepEqual((await harness.behavior.callRpc('status', null)).accounts.map(a => a.email), ['alice@example.test']);
    ({ harness } = await harness.lifecycle.reload(plugin));
    assert.deepEqual((await harness.behavior.callRpc('status', null)).accounts.map(a => a.email), ['alice@example.test']);
    const logged = JSON.stringify(harness.inspection.logEntries);
    assert.doesNotMatch(logged, /private-access|private-refresh|once/);
  } finally { if (harness) await harness.lifecycle.dispose(); globalThis.fetch = fetchOriginal; }
});

test('agent reads use explicit account, return source identity, and reject unknown accounts', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'a', email: 'alice@example.test', email_verified: true });
    if (String(url).includes('/drive/v3/files?')) return Response.json({ files: [{ id: 'doc-a', name: 'Note', mimeType: 'application/vnd.google-apps.document' }] });
    if (String(url).includes('/drive/v3/files/doc-a')) return Response.json({ id: 'doc-a', name: 'Note', mimeType: 'application/vnd.google-apps.document' });
    if (String(url).includes('/documents/doc-a')) return Response.json({ title: 'Note', tabs: [{ documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'hello' } }] } }] } } }] });
    throw new Error('Unexpected request');
  };
  let harness;
  try {
    const host = await setup(); harness = host.harness;
    const store = createBbStore(host.bb.storage.database(), () => {});
    assert.equal(host.bb.storage.database().prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'calendar_accounts'").get().n, 0);
    await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
    const result = await harness.behavior.callAgentTool('gdrive_search_files', { query: 'Note' });
    assert.equal(JSON.parse(result.content[0].text).accounts[0].files[0].id, 'doc-a');
    const doc = await harness.behavior.callAgentTool('gdocs_read', { account: 'alice@example.test', document: 'doc-a' });
    assert.equal(JSON.parse(doc.content[0].text).text, 'hello');
    assert.equal(JSON.parse(doc.content[0].text).account, 'alice@example.test');
    assert.ok(urls.some(url => url.includes('includeTabsContent=true')));
    const unknown = await harness.behavior.callAgentTool('gdrive_get_file', { account: 'nobody@example.test', fileId: 'doc-a' });
    assert.equal(unknown.isError, true);
    assert.doesNotMatch(JSON.stringify(unknown), /private-/);
  } finally { if (harness) await harness.lifecycle.dispose(); globalThis.fetch = original; }
});

test('callback distinguishes a token endpoint rejection from other connection failures without leaking its body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'invalid_client', detail: 'private-token-and-code' }, { status: 400 });
  let harness;
  try {
    ({ harness } = await setup());
    const { url } = await harness.behavior.callRpc('beginConnect', null);
    const state = new URL(url).searchParams.get('state');
    assert.equal((await harness.behavior.fetchHttp('GET', `/callback?state=${encodeURIComponent(state)}&code=private-code`)).status, 400);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /token_endpoint_rejected http_status=400/);
    assert.doesNotMatch(logs, /invalid_client|private-token|private-code|private-client-secret/);
  } finally { if (harness) await harness.lifecycle.dispose(); globalThis.fetch = originalFetch; }
});

test('revoked Drive grant tells the agent to reconnect and logs a bounded category', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'invalid_grant', detail: 'private-token-and-code' }, { status: 400 });
  let harness;
  try {
    const host = await setup(); harness = host.harness;
    const store = createBbStore(host.bb.storage.database(), () => {});
    await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'private-refresh' });
    const result = await harness.behavior.callAgentTool('gdrive_get_file', { account: 'alice@example.test', fileId: 'doc-a' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Reconnect the Drive account/);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /agent_tool gdrive_get_file reauthentication_required/);
    assert.doesNotMatch(logs, /private-token|private-code|private-refresh|alice@example/);
  } finally { if (harness) await harness.lifecycle.dispose(); globalThis.fetch = originalFetch; }
});

test('failed identity, partial search, and tool calls log bounded diagnostics without private data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: 'private-body-and-token' }, { status: 503 });
  let harness;
  try {
    const host = await setup(); harness = host.harness;
    const store = createBbStore(host.bb.storage.database(), () => {});
    await store.addAccount({ subject: 'a', email: 'alice@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
    assert.equal((await harness.behavior.callRpc('status', null)).accounts[0].status, 'Connection unavailable');
    const search = JSON.parse((await harness.behavior.callAgentTool('gdrive_search_files', { query: 'private-query' })).content[0].text);
    assert.equal(search.accounts[0].error.code, 'drive_unavailable');
    const failed = await harness.behavior.callAgentTool('gdocs_read', { account: 'alice@example.test', document: 'doc-a' });
    assert.equal(failed.isError, true);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /identity_lookup http_status=503/);
    assert.match(logs, /search_files http_status=503/);
    assert.match(logs, /agent_tool gdocs_read http_status=503/);
    assert.doesNotMatch(logs, /private-body|private-token|private-query|private-access|private-refresh|alice@example/);
  } finally { if (harness) await harness.lifecycle.dispose(); globalThis.fetch = originalFetch; }
});

test('unconfigured OAuth cannot start even though the plugin tools are installed', async () => {
  const { harness } = await setup({});
  try {
    assert.equal((await harness.behavior.callRpc('status', null)).configured, false);
    await assert.rejects(() => harness.behavior.callRpc('beginConnect', null));
  } finally { await harness.lifecycle.dispose(); }
});
