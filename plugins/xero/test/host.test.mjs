import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Synthetic public SDK fixtures only. No real account, credentials or Xero calls.
const TENANT = '11111111-1111-4111-8111-111111111111', INVOICE = '33333333-3333-4333-8333-333333333333';
const scopes = 'offline_access accounting.invoices accounting.contacts.read accounting.settings.read accounting.payments accounting.attachments accounting.banktransactions.read accounting.reports.banksummary.read accounting.reports.trialbalance.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read';
async function world(settings = { clientId: 'CLIENT', clientSecret: 'SECRET_CLIENT' }, appUrl = 'https://bb.example', hostOptions = {}) {
  const host = createFakePluginHost({ pluginId: 'xero', agentSkillIds: ['xero'], appUrl, settings, ...hostOptions });
  const calls = []; let mode = 'ok', now = Date.now();
  await plugin(host.bb, { clock: () => now, fetcher: async (url, init) => {
    calls.push({ url: String(url), init });
    if (mode === 'validation' && init.method === 'POST') return Response.json({ Invoices: [{ HasErrors: true, ValidationErrors: [{ Message: 'SECRET_VALIDATION PRIVATE_ACCOUNT' }] }] });
    if (mode === 'failure') throw Object.assign(new Error('SECRET_ACCESS PRIVATE_ACCOUNT'), { code: 'SECRET_CODE', cause: 'SECRET_CAUSE' });
    if (String(url).includes('/connect/token')) return Response.json({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 1800, scope: scopes });
    if (String(url).endsWith('/connections')) return Response.json([{ tenantId: TENANT, tenantName: 'Example organisation', tenantType: 'ORGANISATION' }]);
    if (mode === 'pdf') return new Response('%PDF-1.7\nPRIVATE_ORIGINAL', { headers: { 'content-type': 'application/pdf' } });
    if (String(url).includes('/Organisation')) return Response.json({ Organisations: [{ Name: 'Example organisation' }] });
    return Response.json({ Invoices: [{ InvoiceID: INVOICE, CurrencyRate: .72, CurrencyCode: 'USD', Reference: 'r' }] });
  } });
  const rpc = (method, input = null) => host.harness.behavior.callRpc(method, input);
  return { host, calls, rpc, fail() { mode = 'failure'; }, validation() { mode = 'validation'; }, pdf() { mode = 'pdf'; }, age() { now += 1800_000; },
    selected: () => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext()),
    async connect() { const { url } = await rpc('beginConnect'); return host.harness.behavior.fetchHttp('GET', '/callback?state=' + new URL(url).searchParams.get('state') + '&code=SECRET_CODE'); },
    close: () => host.harness.lifecycle.dispose(),
  };
}

test('stock BB settings, protected client secret, OAuth callback and actual organisation discovery', async () => {
  const w = await world();
  try {
    assert.equal(w.calls.length, 0); assert.equal((await w.rpc('status')).connected, false);
    assert.equal((await w.rpc('status')).redirectUri, 'https://bb.example/api/v1/plugins/xero/http/callback');
    assert.deepEqual((await w.selected()).tools.map(t => t.name), ['xero_list_tenants', 'xero_list_operations', 'xero_describe_operation', 'xero_read_schema']);
    const response = await w.connect(); assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/settings/plugins/xero');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const status = await w.rpc('status'); assert.equal(status.connected, true); assert.equal(status.organisations[0].tenantName, 'Example organisation');
    assert.equal(status.organisations[0].checkedAt, null); assert.doesNotMatch(JSON.stringify(status), /SECRET/);
    assert.equal((await w.selected()).tools.length, 15); assert.deepEqual((await w.selected()).skills.map(s => s.name ?? s), ['xero']);
    await w.rpc('check', { tenantId: TENANT }); assert.ok((await w.rpc('status')).organisations[0].checkedAt);
    assert.equal(w.calls.at(-1).init.method, 'GET');
  } finally { await w.close(); }
});
test('failed callback has a safe recovery link and never reflects callback data', async () => {
  const w = await world();
  try {
    const response = await w.host.harness.behavior.fetchHttp('GET', '/callback?state=SECRET_STATE&code=SECRET_CODE&error=PRIVATE_MESSAGE');
    assert.equal(response.status, 400); const body = await response.text();
    assert.match(body, /Back to Xero settings/); assert.doesNotMatch(body, /SECRET|PRIVATE_MESSAGE/);
    assert.doesNotMatch(JSON.stringify(w.host.harness.inspection.logEntries), /SECRET|PRIVATE_MESSAGE/);
    assert.match(JSON.stringify(w.host.harness.inspection.logEntries), /oauth_callback oauth_state/);
  } finally { await w.close(); }
});
test('failed read after connection produces safe attributable diagnostics, not empty success', async () => {
  const w = await world();
  try {
    await w.connect(); w.fail();
    const result = await w.host.harness.behavior.callAgentTool('xero_read_invoice', { tenantId: TENANT, invoiceId: INVOICE });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /Could not reach Xero/);
    await assert.rejects(w.rpc('check', { tenantId: TENANT }), /Could not reach Xero/);
    const log = JSON.stringify(w.host.harness.inspection.logEntries); assert.match(log, /Xero accounting_read transport/);
    assert.doesNotMatch(log + JSON.stringify(result), /SECRET|PRIVATE_ACCOUNT|PRIVATE_MESSAGE/);
  } finally { await w.close(); }
});
test('OAuth exchange, token refresh and provider-result failures log only their bounded boundary', async () => {
  const oauth = await world();
  try {
    oauth.fail(); assert.equal((await oauth.connect()).status, 400);
    const logs = JSON.stringify(oauth.host.harness.inspection.logEntries);
    assert.match(logs, /Xero oauth_exchange transport/); assert.doesNotMatch(logs, /SECRET|PRIVATE_ACCOUNT/);
  } finally { await oauth.close(); }
  const refresh = await world();
  try {
    await refresh.connect(); refresh.age(); refresh.fail();
    await assert.rejects(refresh.rpc('refresh'));
    const logs = JSON.stringify(refresh.host.harness.inspection.logEntries);
    assert.match(logs, /Xero token_refresh transport/); assert.doesNotMatch(logs, /SECRET|PRIVATE_ACCOUNT/);
  } finally { await refresh.close(); }
  const validation = await world();
  try {
    await validation.connect(); validation.validation();
    const result = await validation.host.harness.behavior.callAgentTool('xero_update_invoice', { tenantId: TENANT, invoiceId: INVOICE, invoice: { Reference: 'Requested edit' }, idempotencyKey: '55555555-5555-4555-8555-555555555555' });
    assert.equal(result.isError, true);
    const logs = JSON.stringify(validation.host.harness.inspection.logEntries);
    assert.match(logs, /Xero accounting_result provider_result/); assert.doesNotMatch(logs + JSON.stringify(result), /SECRET|PRIVATE_ACCOUNT|Requested edit/);
  } finally { await validation.close(); }
});
test('discovery works without login, and saving requested access does not upgrade or reconnect the existing grant', async () => {
  const w = await world();
  try {
    const discover = await w.host.harness.behavior.callAgentTool('xero_list_operations', { api: 'accounting', search: 'email', page: 1, pageSize: 20 });
    assert.match(discover.content[0].text, /emailInvoice/); assert.equal(w.calls.length, 0);
    await w.connect(); const calls = w.calls.length, before = (await w.rpc('status')).scopes;
    await w.host.harness.behavior.setSettings({ additionalScopes: 'files accounting.contacts' });
    const status = await w.rpc('status'); assert.deepEqual(status.scopes, before); assert.deepEqual(status.missingScopes, ['files', 'accounting.contacts']); assert.equal(w.calls.length, calls);
    const { url } = await w.rpc('beginConnect'); assert.ok(new URL(url).searchParams.get('scope').includes('files'));
    await w.host.harness.behavior.setSettings({ enableAppStore: true }); assert.equal(w.calls.length, calls, 'billing enablement requests no token by itself');
  } finally { await w.close(); }
});
test('general API partial results expose a bounded receipt and safe diagnostics without raw provider errors', async () => {
  const w = await world();
  try {
    await w.connect(); w.validation();
    const result = await w.host.harness.behavior.callAgentTool('xero_request', { tenantId: TENANT, path: '/Invoices', method: 'POST', body: {} });
    assert.equal(result.isError, true); const message = JSON.parse(result.content[0].text); assert.ok(message.receipt.partialPossible);
    assert.match(JSON.stringify(w.host.harness.inspection.logEntries), /Xero api_result provider_result/);
    assert.doesNotMatch(result.content[0].text + JSON.stringify(w.host.harness.inspection.logEntries), /SECRET|PRIVATE_ACCOUNT/);
  } finally { await w.close(); }
});
test('generic read/write/application failures keep their boundary and uncertain write keys without private provider content', async () => {
  const w = await world();
  try {
    await w.connect(); await w.host.harness.behavior.setSettings({ enableAppStore: true }); w.fail();
    for (const input of [{ tenantId: TENANT, path: '/Invoices' }, { tenantId: TENANT, path: '/Invoices', method: 'POST', body: { Private: 'BODY_SENTINEL' } }, { api: 'app-store', operationId: 'getSubscription', parameters: { subscriptionId: INVOICE } }]) {
      const result = await w.host.harness.behavior.callAgentTool('xero_request', input); assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_ACCOUNT|BODY_SENTINEL/);
      if (input.method === 'POST') assert.ok(JSON.parse(result.content[0].text).receipt.idempotencyKey);
    }
    const logs = JSON.stringify(w.host.harness.inspection.logEntries);
    for (const stage of ['api_read', 'api_write', 'application_token']) assert.match(logs, new RegExp('Xero ' + stage + ' transport'));
    assert.doesNotMatch(logs, /SECRET|PRIVATE_ACCOUNT|BODY_SENTINEL/);
  } finally { await w.close(); }
});
test('built handlers save original downloads using the current BB-server thread storage, without binary text in the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xero-host-download-')), locations = [];
  const w = await world(undefined, undefined, { sdk: { system: { config: async () => ({ primaryHostId: 'host-fixture' }) }, threads: { storageLocation: async input => { locations.push(input); return { hostId: 'host-fixture', storageRootPath: root }; } } } });
  try {
    await w.connect(); w.pdf();
    const result = await w.host.harness.behavior.callAgentTool('xero_request', { tenantId: TENANT, operationId: 'getInvoiceAsPdf', parameters: { InvoiceID: INVOICE }, downloadName: 'invoice.pdf' });
    assert.notEqual(result.isError, true); const saved = JSON.parse(result.content[0].text).download;
    assert.equal(saved.source.threadId, locations[0].threadId); assert.equal(saved.source.host, 'bb-server');
    assert.equal(await readFile(join(root, saved.source.path), 'utf8'), '%PDF-1.7\nPRIVATE_ORIGINAL');
    assert.doesNotMatch(result.content[0].text, /PRIVATE_ORIGINAL|SECRET/);
  } finally { await w.close(); await rm(root, { recursive: true, force: true }); }
});
test('disconnect removes only plugin connection and pending authorization, not provider records', async () => {
  const w = await world();
  try {
    await w.connect(); const { url } = await w.rpc('beginConnect'); const count = w.calls.length;
    await w.rpc('disconnect'); assert.equal((await w.rpc('status')).connected, false); assert.equal(w.calls.length, count);
    const response = await w.host.harness.behavior.fetchHttp('GET', '/callback?state=' + new URL(url).searchParams.get('state') + '&code=SECRET_CODE');
    assert.equal(response.status, 400); assert.equal((await w.rpc('status')).connected, false);
    assert.deepEqual(w.host.harness.sdk.callsTo('plugins.callRpc'), []);
  } finally { await w.close(); }
});
test('missing client configuration and insecure remote callback fail before network', async () => {
  for (const [settings, url] of [[{}, 'https://bb.example'], [{ clientId: 'CLIENT', clientSecret: 'SECRET' }, 'http://remote.example']]) {
    const w = await world(settings, url);
    try { assert.equal((await w.rpc('status')).configured, false); await assert.rejects(w.rpc('beginConnect')); assert.equal(w.calls.length, 0); }
    finally { await w.close(); }
  }
});
test('general API tool forwards explicit writes without extra approval but still rejects cross-origin paths', async () => {
  const w = await world();
  try {
    await w.connect(); const n = w.calls.length;
    const write = await w.host.harness.behavior.callAgentTool('xero_request', { tenantId: TENANT, path: '/Accounts', method: 'POST', body: {} });
    assert.notEqual(write.isError, true); assert.equal(w.calls.at(-1).init.method, 'POST'); assert.equal(w.calls.at(-1).init.body, '{}');
    assert.deepEqual(w.host.harness.inspection.pendingInteractions, []);
    const result = await w.host.harness.behavior.callAgentTool('xero_request', { tenantId: TENANT, path: 'https://evil.example' });
    assert.equal(result.isError, true); assert.equal(w.calls.length, n + 1);
  } finally { await w.close(); }
});
