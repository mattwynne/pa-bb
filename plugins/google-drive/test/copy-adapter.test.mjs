import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
const key = '12345678-1234-4123-8123-123456789abc';
async function fixture(scope, respond) {
  const store = createMemoryStore(); const record = { subject: 'sub', email: 'a@example.org', accessToken: 'secret', refreshToken: 'secret', expiresAt: Date.now() + 600000 };
  await store.addAccount(record); const requests = [];
  const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl: async (url, options) => {
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'sub', email: record.email, email_verified: true });
    if (String(url).endsWith('/tokeninfo')) return Response.json({ scope });
    requests.push([String(url), options]); return respond();
  } });
  return { requests, record, drive: adapter.drive };
}
test('read-only grant blocks submission', async () => {
  const f = await fixture('https://www.googleapis.com/auth/drive.readonly', () => { throw Error('unexpected'); });
  await assert.rejects(f.drive.prepareCopy(f.record), { code: 'copy_scope_required' }); assert.equal(f.requests.length, 0);
});
for (const mode of ['transport', 'server', 'rate_limit', 'malformed', 'success', 'rejected']) test(`copy ${mode} submits once with private marker`, async () => {
  const f = await fixture('https://www.googleapis.com/auth/drive.file', () => {
    if (mode === 'transport') throw Error('private sentinel');
    if (mode === 'rate_limit') return new Response('private sentinel', { status: 429 });
    if (mode === 'server') return new Response('private sentinel', { status: 503 });
    if (mode === 'rejected') return new Response('private sentinel', { status: 403 });
    if (mode === 'malformed') return new Response('private sentinel');
    return Response.json({ id: 'new' });
  });
  const writer = await f.drive.prepareCopy(f.record); const result = await writer('source', 'dest', 'Copy', key);
  assert.equal(f.requests.length, 1); assert.deepEqual(JSON.parse(f.requests[0][1].body), { parents: ['dest'], name: 'Copy', appProperties: { paCopyCreation: key } });
  assert.deepEqual(result, mode === 'success' ? { id: 'new' } : mode === 'rejected' ? { failure: 'http', status: 403, notCreated: true } : mode === 'transport' ? { failure: 'transport' } : mode === 'malformed' ? { failure: 'invalid_response' } : { failure: 'http', status: mode === 'rate_limit' ? 429 : 503, notCreated: false });
  assert.ok(!JSON.stringify(result).includes('sentinel'));
});
test('shared drive recovery uses bounded drive corpus', async () => {
  const f = await fixture('https://www.googleapis.com/auth/drive', () => Response.json({ files: [] }));
  await f.drive.findCopy(f.record, key, 'shared');
  const url = new URL(f.requests[0][0]); assert.equal(url.searchParams.get('corpora'), 'drive'); assert.equal(url.searchParams.get('driveId'), 'shared');
  assert.equal(url.searchParams.get('pageSize'), '2'); assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
});

test('My Drive recovery includes shared-drive items and bounded fields', async () => {
  const f = await fixture('https://www.googleapis.com/auth/drive', () => Response.json({ files: [] }));
  await f.drive.findCopy(f.record, key, null);
  const url = new URL(f.requests[0][0]);
  assert.equal(url.searchParams.get('corpora'), 'user'); assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
  assert.equal(url.searchParams.get('fields'), 'files(id),nextPageToken,incompleteSearch');
});

test('real adapter and core log handled failures with bounded attribution and no private data', async () => {
  const { createCopyService } = await import('../core/copy.mjs');
  const { failureCategory } = await import('../diagnostic.mjs');
  const cases = [
    ['transport', 'copy_submission_transport unknown', 'uncertain'],
    ['malformed', 'copy_submission_invalid_response unknown', 'uncertain'],
    ['oversized', 'copy_submission_oversized response_too_large', 'uncertain'],
    ['rejected', 'copy_submission_http http_status=403', 'not_created'],
    ['mismatch', 'copy_verification_mismatch unknown', 'mismatch'],
    ['invalid_id', 'copy_submission_invalid_id unknown', 'uncertain'],
  ];
  for (const [mode, expected, outcome] of cases) {
    const store = createMemoryStore();
    const record = { subject: 'subject-private', email: 'private@example.org', accessToken: 'token-private', refreshToken: 'refresh-private', expiresAt: Date.now() + 600000 };
    await store.addAccount(record); const logs = []; let writes = 0;
    const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl: async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: record.subject, email: record.email, email_verified: true });
      if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: 'https://www.googleapis.com/auth/drive' });
      if (u.pathname.endsWith('/copy')) {
        writes++;
        if (mode === 'transport') throw Object.assign(Error('SENTINEL secret'), { cause: 'SENTINEL cause' });
        if (mode === 'rejected') return new Response('SENTINEL body', { status: 403 });
        if (mode === 'malformed') return new Response('SENTINEL malformed');
        if (mode === 'oversized') return new Response('SENTINEL body', { headers: { 'content-length': '1048577' } });
        if (mode === 'invalid_id') return Response.json({ id: 'SENTINEL bad id!' });
        return Response.json({ id: 'new' });
      }
      const id = u.pathname.split('/').at(-1);
      if (id === 'source') return Response.json({ id, name: 'Private title', mimeType: 'application/pdf', trashed: false, capabilities: { canCopy: true } });
      if (id === 'dest') return Response.json({ id, mimeType: 'application/vnd.google-apps.folder', trashed: false, capabilities: { canAddChildren: true } });
      if (id === 'new') return Response.json({ id, name: 'SENTINEL altered', mimeType: 'application/pdf', trashed: false, parents: ['dest'], appProperties: { paCopyCreation: key } });
      throw Error('SENTINEL unexpected');
    } });
    const service = createCopyService({ store, drive: adapter.drive, fileInfo: file => ({ id: file.id }), diagnose: (stage, error) => logs.push(`${stage} ${failureCategory(error)}`) });
    const result = await service.copy({ account: record.email, sourceId: 'source', folderId: 'dest', operationId: key });
    assert.equal(result.outcome, outcome, mode); assert.equal(writes, 1); assert.deepEqual(logs, [expected]);
    assert.doesNotMatch(JSON.stringify(logs) + JSON.stringify(result), /SENTINEL|token-private|refresh-private|subject-private|Private title/);
  }
});
