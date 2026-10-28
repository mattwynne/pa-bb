import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
async function fixture(scope, respond) {
  const store = createMemoryStore();
  const record = { subject: 'subject', email: 'test@example.org', accessToken: 'secret', refreshToken: 'secret', expiresAt: Date.now() + 600000 };
  await store.addAccount(record);
  const requests = [];
  const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl: async (url, options) => {
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'subject', email: record.email, email_verified: true });
    if (String(url).endsWith('/tokeninfo')) return Response.json({ scope });
    requests.push([String(url), options]);
    return respond();
  } });
  return { requests, copy: () => adapter.drive.copyFile(record, 'source', 'destination', 'Copy') };
}
test('read-only grant blocks copy without POST', async () => {
  const { requests, copy } = await fixture('https://www.googleapis.com/auth/drive.readonly', () => { throw Error('unexpected'); });
  await assert.rejects(copy(), { code: 'copy_scope_required' });
  assert.equal(requests.length, 0);
});
for (const mode of ['transport', 'server', 'malformed', 'success']) {
  test(`copy ${mode}: one request, explicit parent, no permissions payload`, async () => {
    const { requests, copy } = await fixture('https://www.googleapis.com/auth/drive.file', () => {
      if (mode === 'transport') throw Error('private sentinel');
      if (mode === 'server') return new Response('private sentinel', { status: 503 });
      if (mode === 'malformed') return new Response('private sentinel');
      return Response.json({ id: 'new' });
    });
    const result = await copy();
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1].method, 'POST');
    assert.deepEqual(JSON.parse(requests[0][1].body), { parents: ['destination'], name: 'Copy' });
    if (mode === 'success') assert.equal(result.id, 'new');
    else assert.deepEqual(result, { outcome: 'uncertain', retrySafe: false });
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  });
}
