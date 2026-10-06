import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';

async function fixture(fetchImpl) {
  const store = createMemoryStore();
  const record = { subject: 'sub-a', email: 'alice@example.test', refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 };
  await store.addAccount(record);
  return { record, adapter: createGoogleAdapter({ store, fetchImpl, getClient: async () => ({ clientId: 'web', clientSecret: 'private-secret' }) }) };
}
test('Drive and Docs GETs use verified identity, encoded file IDs, paging, and tab content', async () => {
  const requests = [];
  const { record, adapter } = await fixture(async (url, options) => {
    requests.push([String(url), options]);
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'sub-a', email: 'alice@example.test', email_verified: true });
    return Response.json({ files: [] });
  });
  await adapter.drive.listFiles(record, { q: "name contains 'a'", pageSize: 20, pageToken: 'next-page' });
  const list = new URL(requests.at(-1)[0]);
  assert.equal(list.pathname, '/drive/v3/files');
  assert.equal(list.searchParams.get('pageToken'), 'next-page');
  assert.equal(list.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(list.searchParams.get('q'), "name contains 'a'");
  await adapter.drive.getFile(record, 'id/with slash');
  assert.match(requests.at(-1)[0], /files\/id%2Fwith%20slash/);
  await adapter.drive.readDoc(record, 'doc-a');
  assert.equal(new URL(requests.at(-1)[0]).searchParams.get('includeTabsContent'), 'true');
  assert.ok(requests.every(([, opts]) => opts.headers.authorization === 'Bearer private-access'));
});

test('mismatched Google subject blocks Drive reads before the API request', async () => {
  const requests = [];
  const { record, adapter } = await fixture(async url => {
    requests.push(String(url));
    return Response.json({ sub: 'another-subject', email: 'someone@example.test', email_verified: true });
  });
  await assert.rejects(() => adapter.drive.getFile(record, 'doc-a'), /identity changed/);
  assert.equal(requests.length, 1);
});

test('Google error bodies stay private and 401 on a GET refreshes once', async () => {
  const urls = [];
  const { record, adapter } = await fixture(async (url, options) => {
    urls.push([String(url), options]);
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'sub-a', email: 'alice@example.test', email_verified: true });
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'renewed-access', expires_in: 3600 });
    if (options.headers.authorization === 'Bearer private-access') return Response.json({ error: 'private diagnostic' }, { status: 401 });
    return Response.json({ id: 'doc-a' });
  });
  assert.equal((await adapter.drive.getFile(record, 'doc-a')).id, 'doc-a');
  assert.equal(urls.filter(([url]) => url.includes('/drive/v3/files/')).length, 2);
  assert.equal(urls.filter(([url]) => url.endsWith('/token')).length, 1);
  const { adapter: failed } = await fixture(async url => String(url).endsWith('/userinfo')
    ? Response.json({ sub: 'sub-a', email: 'alice@example.test', email_verified: true })
    : Response.json({ error: 'private diagnostic' }, { status: 403 }));
  await assert.rejects(() => failed.drive.getFile(record, 'doc-a'), e => {
    assert.doesNotMatch(e.message, /private diagnostic/); return true;
  });
});
