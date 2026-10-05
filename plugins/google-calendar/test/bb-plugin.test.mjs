import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { SCOPES } from '../core/service.mjs';

async function setup() {
  const host = createFakePluginHost({ pluginId: 'google-calendar', appUrl: 'https://bb.example',
    settings: { clientId: 'web-client', clientSecret: 'private-secret' } });
  await plugin(host.bb);
  return host;
}

test('registers nine native tools, BB settings, an authenticated initiation RPC, and a callback', async () => {
  const { harness } = await setup();
  try {
    const selected = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.equal(selected.tools.length, 9);
    assert.ok(selected.tools.some(tool => tool.name === 'gcal_search_events'));
    const status = await harness.behavior.callRpc('status', null);
    assert.equal(status.configured, true);
    assert.equal(status.redirectUri, 'https://bb.example/api/v1/plugins/google-calendar/http/callback');
    assert.deepEqual(status.accounts, []);
    const { url } = await harness.behavior.callRpc('beginConnect', null);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('redirect_uri'), status.redirectUri);
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(!url.includes('private-secret'));
    const tool = await harness.behavior.callAgentTool('gcal_auth_status', {});
    assert.deepEqual(JSON.parse(tool.content[0].text).accounts, []);
    const rejected = await harness.behavior.fetchHttp('GET', '/callback?state=bogus&code=bad');
    assert.equal(rejected.status, 400);
    assert.ok(!(await rejected.text()).includes('private-secret'));
    assert.match(JSON.stringify(harness.inspection.logEntries), /state_invalid_or_expired/);
    assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-secret|bogus|code=bad/);
  } finally { await harness.lifecycle.dispose(); }
});

test('a native write blocks on the owner form and a decline makes no Google request', async () => {
  const { bb, harness } = await setup();
  try {
    const store = createBbStore(bb.storage.database(), () => {});
    await store.addAccount({ subject: 'a', email: 'alice@example.com', refreshToken: 'private', accessToken: 'access', expiresAt: Date.now() + 60_000 });
    const pending = harness.behavior.callAgentTool('gcal_delete_event', { account: 'alice@example.com', calendarId: 'team', eventId: 'e1' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.inspection.pendingInteractions.length, 1);
    const form = harness.inspection.pendingInteractions[0];
    assert.equal(form.rendererId, 'calendar-approval');
    assert.ok(form.payload.details.includes('"eventId":"e1"'));
    harness.behavior.submitInteraction(form.id, { approved: false });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not approved/);
  } finally { await harness.lifecycle.dispose(); }
});

test('an approved native Calendar write reaches Google exactly once with no invitations by default', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/userinfo')) return new Response(JSON.stringify({ sub: 'a', email: 'alice@example.com', email_verified: true }), { status: 200 });
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: 'created', summary: 'Away' }), { status: 200 });
  };
  let harness;
  try {
    const host = await setup();
    harness = host.harness;
    const store = createBbStore(host.bb.storage.database(), () => {});
    await store.addAccount({ subject: 'a', email: 'alice@example.com', refreshToken: 'private', accessToken: 'access', expiresAt: Date.now() + 600_000 });
    const pending = harness.behavior.callAgentTool('gcal_create_event', { account: 'alice@example.com', calendarId: 'team', summary: 'Away', start: '2026-10-01', allDay: true });
    await new Promise(resolve => setImmediate(resolve));
    const form = harness.inspection.pendingInteractions[0];
    assert.ok(form.payload.details.includes('"start":"2026-10-01"'));
    harness.behavior.submitInteraction(form.id, { approved: true });
    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).event.id, 'created');
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).searchParams.get('sendUpdates'), 'none');
    assert.equal(JSON.parse(requests[0].options.body).end.date, '2026-10-02');
  } finally {
    if (harness) await harness.lifecycle.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('a Web callback connects an account once and retains it across a BB plugin reload', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'private-refresh', scope: SCOPES.join(' '), expires_in: 3600 }), { status: 200 });
    if (String(url).includes('/userinfo')) return new Response(JSON.stringify({ sub: 'google-sub', email: 'alice@example.com', email_verified: true }), { status: 200 });
    throw new Error('Unexpected Google request');
  };
  let harness;
  try {
    ({ harness } = await setup());
    const { url } = await harness.behavior.callRpc('beginConnect', null);
    const state = new URL(url).searchParams.get('state');
    const callbackPath = `/callback?state=${encodeURIComponent(state)}&code=once`;
    const callback = await harness.behavior.fetchHttp('GET', callbackPath);
    assert.equal(callback.status, 200);
    assert.equal(requests.filter(r => r.url.endsWith('/token')).length, 1);
    assert.deepEqual((await harness.behavior.callRpc('status', null)).accounts.map(a => a.email), ['alice@example.com']);
    assert.equal((await harness.behavior.fetchHttp('GET', callbackPath)).status, 400);
    ({ harness } = await harness.lifecycle.reload(plugin));
    assert.deepEqual((await harness.behavior.callRpc('status', null)).accounts.map(a => a.email), ['alice@example.com']);
    assert.equal(requests.filter(r => r.url.endsWith('/token')).length, 1);
  } finally {
    if (harness) await harness.lifecycle.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('rejects browser connection without Web OAuth settings', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-calendar', appUrl: 'https://bb.example' });
  await plugin(bb);
  try {
    const status = await harness.behavior.callRpc('status', null);
    assert.equal(status.configured, false);
    await assert.rejects(() => harness.behavior.callRpc('beginConnect', null));
  } finally { await harness.lifecycle.dispose(); }
});
