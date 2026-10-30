import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocsAdapter } from '../adapters/docs.mjs';
import { input, record, document } from './docs-fixtures.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
function setup({ status = 200, scope = 'drive.file', throwWrite = false, badJson = false } = {}) {
  const calls = [];
  const adapter = createDocsAdapter({ verifiedAccess: async r => { assert.equal(r.subject, record.subject); return 'private-access'; },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${scope}` });
      if (init.method !== 'POST') return Response.json(document());
      if (throwWrite) throw Object.assign(new Error('private-content-and-token'), { cause: 'private-cause' });
      if (badJson) return new Response('private-malformed-content');
      return Response.json(status === 200 ? { documentId: 'doc-a', replies: [{ replaceAllText: { occurrencesChanged: 1 } }], writeControl: { requiredRevisionId: 'rev-b' } } : { message: 'private-provider-content' }, { status });
    } });
  const proposal = { ...input, documentId: 'doc-a', account: 'private-account' };
  return { adapter, calls, proposal };
}
test('complete inspection explicitly requests every tab and inline suggestions with no field mask', async () => {
  const h = setup();
  assert.equal((await h.adapter.inspect(record, 'doc-a')).revisionId, 'rev-a');
  const url = new URL(h.calls[0].url);
  assert.equal(url.searchParams.get('includeTabsContent'), 'true');
  assert.equal(url.searchParams.get('suggestionsViewMode'), 'SUGGESTIONS_INLINE');
  assert.equal(url.searchParams.has('fields'), false);
});
test('adapter builds only literal tab-scoped CAS request; no arbitrary proxy or targetRevisionId', async () => {
  const h = setup(); const writer = await h.adapter.prepareWrite(record);
  await writer.replace({ ...h.proposal, arbitrary: { deleteDocument: true } });
  const writes = h.calls.filter(c => c.url.endsWith(':batchUpdate'));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].init.body), { writeControl: { requiredRevisionId: 'rev-a' }, requests: [{ replaceAllText: {
    containsText: { text: 'old words', matchCase: true, searchByRegex: false }, replaceText: 'new words', tabsCriteria: { tabIds: ['tab-a'] },
  } }] });
  assert.equal(h.calls.filter(c => c.url.includes('/tokeninfo')).length, 2); // recheck after approval
});
test('formatting adapter has no raw request passthrough and builds only typed tab-scoped style fields', async () => {
  const h = setup(), writer = await h.adapter.prepareWrite(record);
  await assert.rejects(async () => writer.format({ documentId: 'doc-a', requests: [{ deleteContentRange: {} }] }), error => error.docsWriteAttempted === false);
  assert.equal(h.calls.filter(c => c.url.endsWith(':batchUpdate')).length, 0);
  await writer.format({ account: 'writer@example.test', document: 'doc-a', operationId: '11111111-1111-4111-8111-111111111111', expectedRevisionId: 'rev-a',
    ranges: [{ tabId: 'tab-b', startIndex: 1, endIndex: 20, textStyle: { bold: false } }] });
  const writes = h.calls.filter(c => c.url.endsWith(':batchUpdate'));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].init.body), { writeControl: { requiredRevisionId: 'rev-a' }, requests: [{ updateTextStyle: { range: { tabId: 'tab-b', startIndex: 1, endIndex: 20 }, textStyle: { bold: false }, fields: 'bold' } }] });
});
test('read-only grants fail before any write, existing narrow grants work without new OAuth scopes', async () => {
  const h = setup({ scope: 'drive.readonly' });
  await assert.rejects(() => h.adapter.prepareWrite(record), error => error.docsCode === 'scope_required');
  assert.equal(h.calls.length, 1);
});
test('400 revision/validation rejection and permission denial never retry or leak provider bodies', async () => {
  for (const [status, code] of [[400, 'write_rejected'], [401, 'authorization_failed'], [403, 'authorization_failed'], [404, 'authorization_failed'], [503, 'remote_unavailable']]) {
    const h = setup({ status }); const writer = await h.adapter.prepareWrite(record);
    await assert.rejects(() => writer.replace(h.proposal), error => { assert.doesNotMatch(error.message, /private/); return error.docsCode === code; });
    assert.equal(h.calls.filter(c => c.url.endsWith(':batchUpdate')).length, 1);
  }
});
test('uncertain network, malformed response and cancellation never replay a mutation', async () => {
  for (const options of [{ throwWrite: true }, { badJson: true }]) {
    const h = setup(options); const writer = await h.adapter.prepareWrite(record);
    await assert.rejects(() => writer.replace(h.proposal));
    assert.equal(h.calls.filter(c => c.url.endsWith(':batchUpdate')).length, 1);
  }
  const h = setup(); const writer = await h.adapter.prepareWrite(record);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => writer.replace(h.proposal, controller.signal));
  assert.equal(h.calls.filter(c => c.url.endsWith(':batchUpdate')).length, 0);
});
test('bounded responses reject streaming overrun and huge advertised length', async () => {
  for (const response of [new Response('x'.repeat(1_048_577)), new Response('{}', { headers: { 'content-length': '2000000' } })]) {
    const adapter = createDocsAdapter({ verifiedAccess: async () => 'private-access', fetchImpl: async () => response });
    await assert.rejects(() => adapter.inspect(record, 'doc-a'), error => error.docsCode === 'unsupported_document');
  }
});
test('real Google auth adapter rejects wrong-account identities before inspecting or writing Docs', async () => {
  let requests = 0;
  const adapter = createGoogleAdapter({ store: { bySubject: async () => ({ ...record, accessToken: 'private-access', expiresAt: Date.now() + 600_000 }) }, getClient: async () => ({}),
    fetchImpl: async url => {
      requests++;
      assert.match(String(url), /userinfo$/);
      return Response.json({ sub: 'wrong-account', email: 'private@example.test', email_verified: true });
    } });
  await assert.rejects(() => adapter.docs.inspect(record, 'doc-a'), error => error.code === 'reauthentication_required');
  await assert.rejects(() => adapter.docs.prepareWrite(record), error => error.code === 'reauthentication_required');
  assert.equal(requests, 2);
});
