import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../../dist/server.js';
import { MemoryMcp } from '../../testing/memory-mcp.mjs';
import { SCOPES } from '../../core/auth.mjs';
import { tools, richResult } from '../support/mcp-fixture.mjs';

async function world(settings = { clientId: 'existing-web-client', clientSecret: 'SECRET_CLIENT' }, ports = {}) {
  const host = createFakePluginHost({ pluginId: 'google-workspace', appUrl: 'https://bb.example', settings });
  const mcp = new MemoryMcp({ tools, handler: () => richResult });
  const oauth = {
    authorizationUrl(fields) { const u = new URL('https://accounts.google.com/o/oauth2/v2/auth'); for (const [k,v] of Object.entries(fields)) u.searchParams.set(k, Array.isArray(v) ? v.join(' ') : v); return u.toString(); },
    exchange: async () => ({ access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 3600, scope: SCOPES.join(' ') }),
    refresh: async () => ({ access_token: 'REFRESHED_ACCESS', expires_in: 3600 }),
    identity: async () => ({ sub: 'alice-id', email: 'alice@example.test', email_verified: true }),
  };
  await plugin(host.bb, { mcp, oauth, ...ports });
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
    const response = await w.connect();
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/settings/plugins/google-workspace');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(response.headers.get('location'), /SECRET|state=|code=/);
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
    assert.equal((await w.selected()).tools.length, 4, 'only generic/account tools remain after failed discovery');
    const logs = JSON.stringify(w.host.harness.inspection.logEntries);
    assert.match(logs, /tool_call/); assert.match(logs, /catalogue_discovery/);
    assert.doesNotMatch(logs, /PRIVATE_CONTENT|SECRET|alice@example|recipient@example/);
  } finally { await w.close(); }
});
test('removing Workspace account disables its tools without calling other plugins', async () => {
  const w = await world();
  try {
    await w.connect();
    await w.rpc('removeAccount', { subject: 'alice-id' });
    assert.deepEqual((await w.rpc('status')).accounts, []);
    assert.equal((await w.selected()).tools.length, 4);
    assert.deepEqual(w.host.harness.sdk.callsTo('plugins.callRpc'), []);
  } finally { await w.close(); }
});
test('Workspace connects with its saved Web client without another plugin', async () => {
  const w = await world();
  try {
    assert.equal(new URL((await w.rpc('beginConnect')).url).searchParams.get('client_id'), 'existing-web-client');
    await w.connect();
    assert.equal((await w.rpc('status')).accounts.length, 1);
    assert.deepEqual(w.host.harness.sdk.callsTo('plugins.callRpc'), []);
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

test('cancelled reconnect offers recovery without removing the connected account', async () => {
  const w = await world();
  try {
    await w.connect();
    const before = (await w.rpc('status')).accounts;
    const { url } = await w.rpc('beginReconnect', { subject: 'alice-id' });
    const response = await w.host.harness.behavior.fetchHttp('GET', '/callback?state=' + new URL(url).searchParams.get('state') + '&error=access_denied');
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Back to Workspace/);
    assert.deepEqual((await w.rpc('status')).accounts, before);
  } finally { await w.close(); }
});

test('invalid callback is rejected and secrets are never logged', async () => {
  const w = await world();
  try {
    const response = await w.host.harness.behavior.fetchHttp('GET', '/callback?state=UNKNOWN_STATE&code=SECRET_CODE');
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    assert.match(html, /name="viewport"/);
    assert.match(html, /<main>/);
    assert.match(html, /href="\/settings\/plugins\/google-workspace"/);
    assert.doesNotMatch(html, /UNKNOWN_STATE|SECRET_CODE/);
    assert.doesNotMatch(JSON.stringify(w.host.harness.inspection.logEntries), /UNKNOWN_STATE|SECRET/);
  } finally { await w.close(); }
});

test('Email reuses the exact Gmail connection with read-only calls and safe failures', async () => {
  const requests = [];
  let rejected = false;
  const w = await world(undefined, { gmailFetch: async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Authorization: 'Bearer SECRET_ACCESS' });
    requests.push(new URL(url));
    if (rejected) return new Response('PRIVATE_GMAIL_BODY', { status: 403 });
    if (requests.at(-1).pathname.endsWith('/messages')) {
      return Response.json({ messages: [{ id: 'm1' }], nextPageToken: 'next' });
    }
    return Response.json({ id: 'm1', raw: Buffer.from('PRIVATE_GMAIL_BODY').toString('base64url') });
  } });
  const caller = { experimental_caller: { kind: 'plugin', pluginId: 'email' } };
  const call = (method, input) => w.host.harness.behavior.callRpc(method, input, caller);
  try {
    await w.connect();
    await assert.rejects(w.rpc('emailArchiveAccounts'), { code: 'forbidden' });
    let accounts = await call('emailArchiveAccounts', null);
    assert.deepEqual(accounts, [{ id: 'alice-id', email: 'alice@example.test' }]);
    assert.deepEqual(await call('emailArchivePage', { accountId: 'alice-id', cursor: null }), { ids: ['m1'], next: 'next' });
    const message = await call('emailArchiveMessage', { accountId: 'alice-id', messageId: 'm1' });
    assert.equal(Buffer.from(message.mime, 'base64').toString(), 'PRIVATE_GMAIL_BODY');
    assert.equal(requests[0].host, 'gmail.googleapis.com');
    assert.equal(requests[0].searchParams.get('includeSpamTrash'), 'true');
    assert.equal(requests[1].searchParams.get('format'), 'raw');
    rejected = true;
    await assert.rejects(call('emailArchivePage', { accountId: 'alice-id', cursor: 'next' }), /Gmail archive read failed/);
    const logs = JSON.stringify(w.host.harness.inspection.logEntries);
    assert.match(logs, /archive_page authorization/);
    assert.doesNotMatch(logs, /PRIVATE_GMAIL_BODY|SECRET|alice/);
    await w.rpc('removeAccount', { subject: 'alice-id' });
    accounts = await call('emailArchiveAccounts', null);
    assert.deepEqual(accounts, []);
    await assert.rejects(call('emailArchivePage', { accountId: 'alice-id', cursor: null }), /Gmail archive read failed/);
    assert.equal(requests.length, 3);
  } finally { await w.close(); }
});

const correspondenceUrl = 'https://mail.google.com/mail/?authuser=alice%40example.test#all/beef';
const threadMessage = (id, labelIds) => ({
  id: String(id), threadId: 'beef', labelIds, internalDate: String(1000 * id),
  payload: { headers: [{ name: 'From', value: 'Sender ' + id }, { name: 'Subject', value: 'Workshop' }] },
});
const threadMessages = [
  threadMessage(1, ['INBOX', 'UNREAD']), threadMessage(2, ['UNREAD', 'Label_1']), threadMessage(3, undefined),
  threadMessage(4, ['DRAFT', 'UNREAD']), threadMessage(5, ['TRASH', 'UNREAD']), threadMessage(6, ['SPAM', 'UNREAD']),
];
const asThread = messages => Response.json({ id: 'beef', messages });
const correspondenceRead = (w, url = correspondenceUrl) => w.host.harness.behavior.callRpc(
  'gmailConversationStatus', { url }, { experimental_caller: { kind: 'plugin', pluginId: 'gtd' } },
);

test('GTD reads complete metadata for an exact Gmail conversation in its connected mailbox', async () => {
  let calls = 0;
  const w = await world(undefined, { gmailFetch: async (value, options) => {
    calls++;
    const url = new URL(value);
    assert.equal(url.pathname, '/gmail/v1/users/me/threads/beef');
    assert.equal(url.searchParams.get('format'), 'metadata');
    assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'Subject']);
    assert.equal(options.method, undefined);
    return asThread(threadMessages);
  } });
  try {
    await w.connect();
    await assert.rejects(w.rpc('gmailConversationStatus', { url: correspondenceUrl }), /Only GTD/);
    assert.deepEqual(await correspondenceRead(w, 'https://mail.google.com/mail/u/0/#all/beef'), { status: 'unsupported' });
    assert.deepEqual(await correspondenceRead(w, 'https://mail.google.com/mail/?authuser=wrong%40example.test#all/beef'), { status: 'account_missing' });
    assert.equal(calls, 0);
    assert.deepEqual(await correspondenceRead(w), {
      status: 'ok', unread: 2, sender: 'Sender 3', latestAt: '1970-01-01T00:00:03.000Z',
    });
    const resolved = await w.host.harness.behavior.callAgentTool('gworkspace_resolve_gmail_thread_url', { account: 'alice@example.test', threadId: 'beef' });
    assert.deepEqual(JSON.parse(resolved.content[0].text), { url: correspondenceUrl, subject: 'Workshop' });
  } finally { await w.close(); }
});

test('a Gmail metadata failure stays unknown and Retry-After suppresses repeat requests', async () => {
  let calls = 0;
  const w = await world(undefined, { gmailFetch: async () => {
    calls++;
    if (calls === 1) return asThread([{ ...threadMessages[0], internalDate: undefined, private: 'PRIVATE_SENTINEL' }]);
    return new Response('PRIVATE_SENTINEL', { status: 429, headers: { 'Retry-After': '120' } });
  } });
  try {
    await w.connect();
    for (let i = 0; i < 3; i++) assert.deepEqual(await correspondenceRead(w), { status: 'unavailable' });
    assert.equal(calls, 2);
    const logs = JSON.stringify(w.host.harness.inspection.logEntries);
    assert.match(logs, /correspondence_read/);
    assert.doesNotMatch(logs, /PRIVATE_SENTINEL|SECRET|alice@example/);
  } finally { await w.close(); }
});

test('Email Unsubscribe can read and send only through the selected Gmail connection', async () => {
  let reads = 0, sends = 0;
  const mime = Buffer.from('Subject: PRIVATE_UNSUBSCRIBE_MESSAGE\r\n\r\nTest');
  const w = await world(undefined, { gmailFetch: async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer SECRET_ACCESS');
    if (options.method === 'POST') {
      sends++;
      assert.equal(url.pathname, '/gmail/v1/users/me/messages/send');
      assert.match(Buffer.from(JSON.parse(options.body).raw, 'base64url').toString(), /From: alice@example.test\r\nTo: leave@example.test/);
      return Response.json({ id: 'sent1' });
    }
    reads++;
    assert.equal(url.pathname, '/gmail/v1/users/me/messages/target1');
    if (reads === 2) return new Response('PRIVATE_UNSUBSCRIBE_MESSAGE', { status: 403 });
    return Response.json({ id: 'target1', labelIds: ['INBOX'], raw: mime.toString('base64url') });
  } });
  const input = { account: 'alice@example.test', emailId: 'target1' };
  const caller = { experimental_caller: { kind: 'plugin', pluginId: 'email-unsubscribe' } };
  const invoke = (method, data) => w.host.harness.behavior.callRpc(method, data, caller);
  try {
    await w.connect();
    await assert.rejects(w.rpc('unsubscribeMessage', input), { code: 'forbidden' });
    assert.deepEqual(await invoke('unsubscribeMessage', { ...input, account: 'elsewhere@example.test' }), { status: 'account_missing' });
    assert.deepEqual(await invoke('unsubscribeMessage', input), { status: 'ok', mailbox: input.account, mime: mime.toString('base64') });
    await assert.rejects(invoke('unsubscribeMessage', input), /Gmail unsubscribe provider request/);
    const mail = { account: input.account, from: input.account, to: 'leave@example.test', subject: 'unsubscribe', body: '' };
    assert.deepEqual(await invoke('sendUnsubscribeMail', { ...mail, from: 'other@example.test' }), { status: 'needs_user' });
    assert.deepEqual(await invoke('sendUnsubscribeMail', mail), { status: 'request_sent' });
    assert.deepEqual([reads, sends], [2, 1]);
    assert.doesNotMatch(JSON.stringify(w.host.harness.inspection.logEntries), /PRIVATE_UNSUBSCRIBE_MESSAGE|SECRET_ACCESS|alice@example/);
  } finally { await w.close(); }
});
