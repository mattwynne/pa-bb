import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function fixture(fetchImpl) {
  const store = createMemoryStore();
  const record = { subject: 'subject-a', email: 'alice@example.com', refreshToken: 'refresh-private', accessToken: 'access-private', expiresAt: Date.now() + 3_600_000 };
  await store.addAccount(record);
  const google = createGoogleAdapter({ store, fetchImpl, getClient: async () => ({ clientId: 'web-id', clientSecret: 'private-secret' }) });
  return { store, record, ...google };
}

test('the Web OAuth flow uses PKCE and exchanges code server-side', async () => {
  const requests = [];
  const { oauth } = await fixture(async (url, options) => { requests.push({ url: String(url), options }); return json({ access_token: 'new-access', refresh_token: 'new-refresh', scope: 'openid email' }); });
  const url = new URL(oauth.authorizeUrl({ clientId: 'web-id', redirectUri: 'https://bb.example/callback', state: 'once', challenge: 'sha256', scopes: ['openid', 'email'] }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'once');
  assert.ok(!url.toString().includes('private-secret'));
  await oauth.exchange({ code: 'one-time', verifier: 'verifier', clientId: 'web-id', clientSecret: 'private-secret', redirectUri: 'https://bb.example/callback' });
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(requests[0].options.body).get('code_verifier'), 'verifier');
});

test('an identity mismatch blocks Google Calendar requests including writes', async () => {
  const requests = [];
  const { calendar, record } = await fixture(async (url, options) => {
    requests.push(String(url));
    if (String(url).includes('userinfo')) return json({ sub: 'someone-else', email: 'someone@example.com', email_verified: true });
    throw new Error('Calendar API must not be called');
  });
  await assert.rejects(() => calendar.insertEvent(record, 'team', { summary: 'Private' }, 'none'), /identity changed/);
  assert.equal(requests.length, 1);
});

test('Google Calendar adapter sends explicit IDs, search parameters and freebusy items', async () => {
  const requests = [];
  const { calendar, record } = await fixture(async (url, opts) => {
    requests.push({ url: String(url), opts });
    if (String(url).includes('userinfo')) return json({ sub: 'subject-a', email: 'alice@example.com', email_verified: true });
    if (String(url).endsWith('/freeBusy')) return json({ calendars: { team: { busy: [{ start: '09:00', end: '10:00' }] } } });
    return json({ items: [{ id: 'e1' }] });
  });
  const events = await calendar.listEvents(record, 'team@example.com', { timeMin: '2026-01-01T00:00:00Z', maxResults: 20, singleEvents: true, orderBy: 'startTime' });
  assert.equal(events.items[0].id, 'e1');
  const listUrl = new URL(requests.at(-1).url);
  assert.ok(listUrl.pathname.includes('team%40example.com/events'));
  assert.equal(listUrl.searchParams.get('maxResults'), '20');
  assert.equal(listUrl.searchParams.get('singleEvents'), 'true');
  const busy = await calendar.freeBusy(record, { timeMin: 'start', timeMax: 'end', calendarIds: ['team'] });
  assert.equal(busy.team.busy.length, 1);
  assert.deepEqual(JSON.parse(requests.at(-1).opts.body).items, [{ id: 'team' }]);
});

test('an uncertain failed write is never retried and provider error body is not exposed', async () => {
  let writes = 0;
  const { calendar, record } = await fixture(async (url) => {
    if (String(url).includes('userinfo')) return json({ sub: 'subject-a', email: 'alice@example.com', email_verified: true });
    writes++;
    return json({ error: 'secret-provider-diagnostic' }, 503);
  });
  await assert.rejects(() => calendar.deleteEvent(record, 'team', 'event', 'none'), error => {
    assert.ok(!error.message.includes('secret-provider-diagnostic'));
    return true;
  });
  assert.equal(writes, 1);
});

test('BB SQLite store consumes state once, retains accounts and blocks late refresh after deletion', async () => {
  const db = new Database(':memory:');
  try {
    const store = createBbStore(db, (db, statements) => { for (const sql of statements) db.exec(sql); });
    const grant = { stateHash: 'statehash', verifier: 'private', redirectUri: 'https://bb.example/callback', clientId: 'web-id', expiresAt: Date.now() + 60_000 };
    await store.savePending(grant);
    assert.deepEqual(await store.consumePending('statehash'), grant);
    assert.equal(await store.consumePending('statehash'), null);
    await store.addAccount({ subject: 'a', email: 'Alice@Example.com', refreshToken: 'original', accessToken: 'access', expiresAt: Date.now() + 60_000 });
    assert.equal((await store.byEmail('alice@example.com')).subject, 'a');
    await assert.rejects(() => store.addAccount({ subject: 'a', email: 'other@example.com', refreshToken: 'bad' }), /already connected/);
    await store.removeAccount('a');
    assert.equal(await store.mergeToken('a', 'original', { accessToken: 'late' }), false);
    assert.equal((await store.accounts()).length, 0);
  } finally { db.close(); }
});
