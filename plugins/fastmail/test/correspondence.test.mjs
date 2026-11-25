import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { fastmailCorrespondence } from '../correspondence.ts';
import plugin from '../dist/server.js';

const MAIL = 'urn:ietf:params:jmap:mail';
const CORE = 'urn:ietf:params:jmap:core';
const url = (route = 'S_anchor', user = '1234abcd') => `https://app.fastmail.com/mail/Archive/${route}?u=${user}`;
const caller = { experimental_caller: { kind: 'plugin', pluginId: 'gtd' } };
const config = new AbortController();
const signal = new AbortController().signal;
const token = 'private-token-sentinel';

function fixture(change = {}) {
  const accountId = change.accountId ?? 'u1234abcd';
  const emailIds = ['S_anchor', 'S_reply', 'S_seen', 'S_draft', 'S_trash', 'S_junk', 'S_mixed'];
  const make = (id, memberships, keywords = {}, day = '01') => ({
    id, threadId: emailIds.includes(id) ? 'T_one' : 'T_two',
    mailboxIds: Object.fromEntries(memberships.map(box => [box, true])), keywords,
    receivedAt: `2026-01-${day}T12:00:00Z`, from: [{ name: 'Test Sender', email: 'sender@example.test' }],
  });
  const messages = [
    make('S_anchor', ['B_archive']), make('S_reply', ['B_inbox']),
    make('S_seen', ['B_inbox'], { $seen: true }, '02'),
    make('S_draft', ['B_inbox'], { $draft: true }, '03'),
    make('S_trash', ['B_trash']), make('S_junk', ['B_junk', 'B_trash']),
    make('S_mixed', ['B_archive', 'B_junk']), make('S_other', ['B_archive']),
  ];
  const calls = [];
  const logs = [];
  const fetcher = async (endpoint, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    if (!init.body) {
      calls.push(['session']);
      if (change.sessionResponse) return change.sessionResponse();
      return Response.json({
        apiUrl: 'https://synthetic.api.fastmail.com/jmap/api/',
        primaryAccounts: { [MAIL]: accountId },
        accounts: { [accountId]: { isPersonal: true, accountCapabilities: { [MAIL]: {} } } },
        capabilities: { [CORE]: { maxObjectsInGet: 3 } },
      });
    }
    const [method, args, tag] = JSON.parse(init.body).methodCalls[0];
    calls.push([method, args]);
    assert.equal(args.accountId, accountId);
    assert.ok(!JSON.stringify(args).includes('body'));
    let data;
    if (method === 'Mailbox/get') {
      assert.deepEqual(args.properties, ['id', 'role']);
      data = { list: [
        { id: 'B_archive', role: 'archive' }, { id: 'B_inbox', role: 'inbox' },
        { id: 'B_trash', role: 'trash' }, { id: 'B_junk', role: 'junk' },
      ] };
    } else if (method === 'Thread/get') {
      data = { list: args.ids.map(id => ({ id, emailIds: id === 'T_one' ? emailIds : ['S_other'] })) };
    } else {
      assert.equal(method, 'Email/get');
      assert.ok(args.ids.length <= 3);
      const list = args.ids.flatMap(id => messages.filter(item => item.id === id));
      data = { list, notFound: args.ids.filter(id => !list.some(item => item.id === id)), state: 'state' };
    }
    data = { accountId, notFound: [], ...data };
    const response = change.response?.(method, args, data, calls);
    return Response.json({ methodResponses: [[method, response ?? data, tag]] });
  };
  const read = fastmailCorrespondence(fetcher, (...args) => logs.push(args), change.now);
  return { fetcher, calls, logs, read: (address = url(), ...args) => read(address, ...(args.length ? args : [token, config.signal, signal])) };
}

test('single and dotted routes bind exact emails, use the whole thread, and produce an account-scoped key', async () => {
  const f = fixture();
  const first = await f.read();
  assert.deepEqual(f.calls.slice(0, 3).map(([method, args]) => [method, args?.ids]), [
    ['session', undefined], ['Email/get', ['S_anchor']], ['Thread/get', ['T_one']],
  ]);
  assert.deepEqual(first, {
    status: 'ok', unread: 3, sender: 'Test Sender', latestAt: '2026-01-02T12:00:00Z', threadKey: first.threadKey,
  });
  assert.match(first.threadKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(await f.read(url('T_one.S_reply')), first);
  assert.notEqual((await f.read(url('S_other'))).threadKey, first.threadKey);
  assert.notEqual((await fixture({ accountId: 'u2234abcd' }).read(url('S_anchor', '2234abcd'))).threadKey, first.threadKey);
  assert.deepEqual(f.logs, []);
});

test('unsupported forms, the wrong web account and an absent exact message fail closed', async () => {
  const f = fixture();
  for (const address of [url().split('?')[0], url() + '&u=1234abcd', url() + '#anchor', url() + '\n',
    url().replace('Archive', '%2e'), url().replace('Archive', 'u1234abcd'), url().replace('Archive', 'compose'),
    url().replace('Archive', 'Inbox/search:any'), url().replace('app.fastmail.com', 'app.fastmail.com.example'),
    url('S%5fanchor')]) assert.deepEqual(await f.read(address), { status: 'unsupported' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.read(url('S_anchor', '00000000')), { status: 'account_mismatch' });
  assert.deepEqual(f.calls, [['session']]);
  assert.deepEqual(await f.read(url('S_absent')), { status: 'not_found' });
  assert.deepEqual(await f.read(url('T_two.S_anchor')), { status: 'incomplete' });
  assert.deepEqual(await f.read(url(), undefined, config.signal, signal), { status: 'account_missing' });
});

for (const [name, modify] of [
  ['wrong account', (method, _args, data) => method === 'Thread/get' && { ...data, accountId: 'private-account-sentinel' }],
  ['duplicate members', (method, _args, data) => method === 'Thread/get' && { ...data, list: [{ id: 'T_one', emailIds: ['S_anchor', 'S_anchor'] }] }],
  ['anchor absent from thread', (method, _args, data) => method === 'Thread/get' && { ...data, list: [{ id: 'T_one', emailIds: ['S_reply'] }] }],
  ['partial batch', (_method, args, data) => args.properties?.includes('keywords') && { ...data, list: data.list.slice(1), notFound: [args.ids[0]] }],
  ['mailbox unknown', (_method, args, data) => args.properties?.includes('keywords') && {
    ...data, list: data.list.map(item => ({ ...item, mailboxIds: { 'private-mailbox-sentinel': true } })),
  }],
  ['Email state changed between batches', (_method, args, data) => args.ids?.includes('S_trash') && { ...data, state: 'different' }],
]) test(`incomplete Fastmail read safely diagnoses ${name}`, async () => {
  const f = fixture({ response: (...args) => modify(...args) || undefined });
  assert.deepEqual(await f.read(), { status: 'incomplete' });
  assert.match(JSON.stringify(f.logs), /correspondence_(thread|messages)/);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-|https:|S_anchor|T_one|1234abcd|example.test/);
});

test('provider backoff is shared across saved links and resets on configuration change', async () => {
  let now = 1000;
  let limited = true;
  const f = fixture({ now: () => now, sessionResponse: () => limited
    ? new Response('private-response-sentinel', { status: 429, headers: { 'retry-after': '120' } })
    : new Response('private-response-sentinel', { status: 403 }) });
  assert.deepEqual(await f.read(), { status: 'unavailable' });
  now += 60_000;
  assert.deepEqual(await f.read(url('S_other')), { status: 'unavailable' });
  assert.equal(f.calls.length, 1);
  limited = false;
  assert.deepEqual(await f.read(url(), token, new AbortController().signal, signal), { status: 'account_missing' });
  assert.deepEqual(f.logs.map(([, category]) => category), ['http_status=429', 'http_status=403']);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-/);
});

test('built RPC admits only GTD and discards reads after settings change', async () => {
  const h = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: token } });
  const f = fixture();
  let replace = false;
  await plugin(h.bb, undefined, async (...args) => {
    if (replace) await h.harness.behavior.setSettings({ jmapApiToken: 'replacement-private-token' });
    return f.fetcher(...args);
  });
  try {
    const call = h.harness.behavior.callRpc;
    await assert.rejects(call('fastmailConversationStatus', { url: url() }), /Only GTD/);
    await assert.rejects(call('fastmailConversationStatus', { url: url() }, {
      experimental_caller: { ...caller.experimental_caller, pluginId: 'email' },
    }), /Only GTD/);
    assert.deepEqual(f.calls, []);
    assert.equal((await call('fastmailConversationStatus', { url: url() }, caller)).unread, 3);
    replace = true;
    assert.deepEqual(await call('fastmailConversationStatus', { url: url() }, caller), { status: 'unavailable' });
    const logs = JSON.stringify(h.harness.inspection.logEntries);
    assert.match(logs, /Fastmail .* cancelled/);
    assert.doesNotMatch(logs, /private-|https:|S_anchor|T_one|1234abcd|example.test/);
  } finally { await h.harness.lifecycle.dispose(); }
});
