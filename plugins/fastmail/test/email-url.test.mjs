import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmailUrlSources, EmailUrlError, resolveEmailUrl, messageWebUrl, fastmailWebUserId } from '../email-url.ts';
const MAIL = 'urn:ietf:params:jmap:mail';
const source = { id: 'M_SYNTHETIC', threadId: 'T_SYNTHETIC', messageId: ['synthetic@example.test'], receivedAt: '2026-01-02T12:00:00Z' };
const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function fixture(change = {}) {
  const calls = [];
  const session = { username: 'login@example.test', apiUrl: 'https://synthetic.api.fastmail.com/jmap/api/', primaryAccounts: { [MAIL]: 'u1234abcd' }, accounts: { u1234abcd: { isPersonal: true, accountCapabilities: { [MAIL]: {} } } }, ...change.session };
  const options = { ensureCurrent() {}, ...change.options, fetch: async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.headers.Authorization, 'Bearer private-token-sentinel');
    assert.equal(init.redirect, 'error');
    if (change.throw) throw new Error('private-content-sentinel private-token-sentinel');
    if (change.response) return change.response();
    if (url.includes('/session')) return Response.json(session);
    const body = JSON.parse(init.body);
    const [method, input, tag] = body.methodCalls[0];
    assert.equal(method, 'Email/get');
    assert.deepEqual(body.using, ['urn:ietf:params:jmap:core', MAIL]);
    assert.deepEqual(input, { accountId: 'u1234abcd', ids: [source.id], properties: ['id', 'threadId', 'messageId', 'receivedAt'] });
    const data = { accountId: input.accountId, list: [{ ...source, ...change.email }], notFound: [], ...change.data };
    return Response.json({ methodResponses: [[change.method ?? method, data, change.tag ?? tag]], ...change.envelope });
  } };
  return { calls, run: () => resolveEmailUrl('private-token-sentinel', { emailId: source.id }, source, options) };
}
test('account/thread/message mapping uses the authenticated Fastmail account, not username or aliases; no top-level userId required', async () => {
  const f = fixture(); const result = await f.run();
  assert.equal(result.url, 'https://app.fastmail.com/mail/Archive/T_SYNTHETIC.M_SYNTHETIC?u=1234abcd');
  assert.equal(result.accountId, 'u1234abcd'); assert.equal(result.verification, 'metadata-verified-not-browser-verified');
  assert.equal(result.urlSource, 'fastmail-web-client-route'); assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /login@|private-/);
});
for (const folder of ['Inbox', 'Archive', 'Custom label/嵌套 & stuff', 'Trash']) test(`source in ${folder} uses fixed archive context without reading extra bodies`, async () => {
  const sources = new EmailUrlSources();
  sources.observe('search_email', {}, mcp({ results: [{ ...source, folder: { name: folder }, labels: [{ name: folder }], bodyText: 'private-body-sentinel' }] }), 2);
  assert.deepEqual(sources.get(source.id, 2), source);
  const result = await fixture().run();
  assert.match(result.url, /\/Archive\/T_SYNTHETIC.M_SYNTHETIC\?u=/);
  assert.doesNotMatch(JSON.stringify(sources.get(source.id, 2)), /private-|folder|labels/);
});
for (const [name, change, category] of [
  ['conflicting optional web selector', { session: { userId: '5678abcd' } }, 'account_selector_mismatch'],
  ['selector punctuation', { session: { userId: 'WEB-other' } }, 'account_selector_mismatch'],
  ['selector query injection', { session: { userId: 'WEB&u=other' } }, 'account_selector_mismatch'],
  ['unsupported opaque account ID', { session: { primaryAccounts: { [MAIL]: 'ACCOUNT_SYNTHETIC' }, accounts: { ACCOUNT_SYNTHETIC: { isPersonal: true, accountCapabilities: { [MAIL]: {} } } } } }, 'unsupported_account_format'],
  ['canonical ID is not a mail account', { session: { accounts: { u1234abcd: { isPersonal: true, accountCapabilities: {} } } } }, 'primary_mail_account_missing'],
  ['missing primary account', { session: { primaryAccounts: {} } }, 'primary_mail_account_missing'],
  ['shared account', { session: { accounts: { u1234abcd: { isPersonal: false, accountCapabilities: { [MAIL]: {} } } } } }, 'primary_mail_account_missing'],
  ['account mismatch', { data: { accountId: 'OTHER' } }, 'missing_or_mismatched_message'],
  ['missing email', { data: { list: [], notFound: [source.id] } }, 'missing_or_mismatched_message'],
  ['duplicate emails', { data: { list: [source, source] } }, 'missing_or_mismatched_message'],
  ['wrong email', { email: { id: 'M_OTHER' } }, 'source_message_mismatch'],
  ['wrong thread', { email: { threadId: 'T_OTHER' } }, 'source_message_mismatch'],
  ['wrong RFC message id', { email: { messageId: ['other@example.test'] } }, 'source_message_mismatch'],
  ['missing RFC message id', { email: { messageId: null } }, 'source_message_mismatch'],
  ['wrong received time', { email: { receivedAt: '2026-01-02T13:00:00Z' } }, 'source_message_mismatch'],
  ['wrong method', { method: 'Thread/get' }, 'missing_or_mismatched_message'],
  ['wrong tag', { tag: 'other' }, 'missing_or_mismatched_message'],
  ['provider rejection', { method: 'error' }, 'provider_rejected'],
  ['extra response', { envelope: { methodResponses: [] } }, 'invalid_response'],
  ['untrusted API origin', { session: { apiUrl: 'https://api.fastmail.com.evil.test/jmap/' } }, 'invalid_endpoint'],
  ['API userinfo', { session: { apiUrl: 'https://private-content-sentinel@api.fastmail.com/jmap/' } }, 'invalid_endpoint'],
  ['API query', { session: { apiUrl: 'https://api.fastmail.com/jmap/?token=private-content-sentinel' } }, 'invalid_endpoint'],
  ['transport', { throw: true }, 'transport_or_invalid_response'],
  ['invalid JSON', { response: () => new Response('private-content-sentinel') }, 'transport_or_invalid_response'],
  ['HTTP rejected', { response: () => new Response('private-content-sentinel', { status: 403 }) }, 'http_status=403'],
  ['oversized response', { response: () => new Response('x'.repeat(512 * 1024 + 1)) }, 'response_limit'],
]) test(`fails closed: ${name}`, async () => {
  await assert.rejects(fixture(change).run(), error => {
    assert.ok(error instanceof EmailUrlError); assert.equal(error.category, category);
    assert.doesNotMatch(error.message + error.stage + error.category, /private-|https:\/\/|login@/); return true;
  });
});
test('identifier encoding is exact for route-safe IDs; delimiters/control characters/ambiguous encodings are rejected', () => {
  const url = new URL(messageWebUrl('T_a-1', 'M_b-2', 'u1234abcd'));
  assert.equal(url.pathname, '/mail/Archive/T_a-1.M_b-2'); assert.deepEqual([...url.searchParams], [['u', '1234abcd']]);
  for (const bad of ['x/y', 'x.y', '%2f', '../x', 'x?u=z', 'x#z', 'x\ny', 'é', 'x\\y', 'x'.repeat(257), '']) {
    for (let position = 0; position < 3; position++) {
      const args = ['T1', 'M1', 'u1234abcd']; args[position] = bad;
      assert.throws(() => messageWebUrl(...args), EmailUrlError);
    }
  }
});
test('actual search/read/thread receipts only, bounded TTL/revision and explicit clear; metadata cannot be supplied by resolver callers', () => {
  let now = 0; const sources = new EmailUrlSources(() => now);
  const get = () => sources.get(source.id, 2);
  assert.throws(get, /first search or read/);
  sources.observe('read_email', { id: 'OTHER' }, mcp(source), 2); assert.throws(get);
  sources.observe('read_thread', { threadId: 'OTHER' }, mcp([source]), 2); assert.throws(get);
  sources.observe('other', {}, mcp(source), 2); assert.throws(get);
  sources.observe('search_email', {}, { ...mcp({ results: [source] }), isError: true }, 2); assert.throws(get);
  sources.observe('search_email', {}, { ...mcp({ results: [source] }), structuredContent: { results: [{ ...source, threadId: 'OTHER' }] } }, 2); assert.throws(get);
  sources.observe('read_email', { id: source.id }, mcp(source), 2); assert.deepEqual(get(), source);
  const copy = get(); copy.messageId[0] = 'tampered'; assert.deepEqual(get(), source);
  assert.throws(() => sources.get(source.id, 3)); now = 600_000; assert.throws(get);
  sources.observe('read_thread', { threadId: source.threadId }, mcp([source]), 2); assert.deepEqual(get(), source);
  sources.clear(); assert.throws(get);
  sources.observe('read_email', { id: source.id }, mcp({ ...source, messageId: null }), 2); assert.throws(get);
  for (let i = 0; i < 257; i++) sources.observe('read_email', { id: `M${i}` }, mcp({ ...source, id: `M${i}` }), 2);
  assert.throws(() => sources.get('M0', 2)); assert.equal(sources.get('M256', 2).id, 'M256');
});
test('Fastmail canonical mapping is narrow, not a general rule for JMAP IDs', () => {
  assert.equal(fastmailWebUserId('u1234abcd'), '1234abcd');
  assert.equal(fastmailWebUserId('u00000001'), '00000001');
  for (const value of ['1234abcd', 'u1234ABCD', 'c1234abcd', 'u1234567', 'u123456789', 'u1234abcd/other', 'u1234abcd?u=other', 'u1234abcd\n', 'user@example.test']) {
    assert.throws(() => fastmailWebUserId(value), error => error.category === 'unsupported_account_format');
  }
});
test('matching optional explicit web selector does not override the authenticated account mapping', async () => {
  assert.equal((await fixture({ session: { userId: '1234abcd' } }).run()).accountMapping, 'fastmail-primary-personal-u-hex-account');
});
test('lifecycle revocation while reading prevents returning a URL', async () => {
  let checks = 0;
  const f = fixture({ options: { ensureCurrent() { if (++checks >= 4) throw new EmailUrlError('email_url_source', 'connection_changed'); } } });
  await assert.rejects(f.run(), error => error.category === 'connection_changed');
});
