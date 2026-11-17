import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleAuth, SCOPES } from '../core/auth.mjs';
import { memoryStore } from './support/memory-store.mjs';

function world() {
  let now = 1000;
  const store = memoryStore(), calls = [], client = { clientId: 'existing-web-client', clientSecret: 'SECRET_CLIENT' };
  const identity = { sub: 'alice-id', email: 'alice@example.test', email_verified: true };
  const tokens = { access_token: 'SECRET_ACCESS', refresh_token: 'SECRET_REFRESH', expires_in: 3600, scope: SCOPES.join(' ') };
  const oauth = {
    authorizationUrl(args) { calls.push(['authorize', args]); const url = new URL('https://accounts.google.com/o/oauth2/v2/auth'); for (const [k,v] of Object.entries(args)) url.searchParams.set(k, Array.isArray(v) ? v.join(' ') : String(v)); return url.toString(); },
    exchange: async args => { calls.push(['exchange', args]); return tokens; },
    refresh: async args => { calls.push(['refresh', args]); return { access_token: 'REFRESHED_ACCESS', expires_in: 3600 }; },
    identity: async token => { calls.push(['identity', token]); return identity; },
  };
  const auth = createGoogleAuth({ store, oauth, getClient: async () => client, clock: () => now,
    callbackUrl: () => 'https://bb.example/api/v1/plugins/google-workspace/http/callback' });
  return { auth, store, oauth, calls, tokens, identity, client, setNow(value) { now = value; } };
}
async function connect(w) {
  const { url } = await w.auth.beginConnect();
  const state = new URL(url).searchParams.get('state');
  return w.auth.finishConnect({ state, code: 'SECRET_CODE' });
}

test('one Web OAuth consent requests Drive, Docs/Sheets via Drive, Calendar and Gmail', async () => {
  const w = world(), { url } = await w.auth.beginConnect();
  const request = new URL(url);
  assert.equal(request.searchParams.get('client_id'), 'existing-web-client');
  assert.ok(request.searchParams.get('scope').includes('gmail.modify'));
  assert.ok(request.searchParams.get('scope').includes('gmail.settings.basic'));
  assert.ok(request.searchParams.get('scope').includes('/auth/drive'));
  assert.ok(request.searchParams.get('scope').includes('/auth/calendar'));
  assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(request.searchParams.get('redirect_uri'), 'https://bb.example/api/v1/plugins/google-workspace/http/callback');
  assert.doesNotMatch(url, /SECRET_CLIENT/);
});
test('verified connection lists only public account facts and supplies its token to MCP', async () => {
  const w = world(); await connect(w);
  assert.deepEqual(await w.auth.list(), [{ subject: 'alice-id', email: 'alice@example.test' }]);
  assert.equal(await w.auth.access('ALICE@example.test'), 'SECRET_ACCESS');
  assert.equal(w.calls.filter(([stage]) => stage === 'refresh').length, 0);
  assert.doesNotMatch(JSON.stringify(await w.auth.list()), /SECRET/);
});
test('state is one-use, expires, and never accepts an unknown callback', async () => {
  const w = world(), { url } = await w.auth.beginConnect(), state = new URL(url).searchParams.get('state');
  await assert.rejects(w.auth.finishConnect({ state: 'wrong', code: 'code' }), /authorization/i);
  await w.auth.finishConnect({ state, code: 'code' });
  await assert.rejects(w.auth.finishConnect({ state, code: 'code' }), /authorization/i);
  const next = new URL((await w.auth.beginConnect()).url).searchParams.get('state');
  w.setNow(1000 + 6 * 60 * 1000);
  await assert.rejects(w.auth.finishConnect({ state: next, code: 'code' }), /authorization/i);
});
test('cancelled Google consent stores no account', async () => {
  const w = world(), { url } = await w.auth.beginConnect();
  await assert.rejects(w.auth.finishConnect({ state: new URL(url).searchParams.get('state'), error: 'access_denied' }));
  assert.deepEqual(await w.auth.list(), []);
  assert.equal(w.calls.some(([stage]) => stage === 'exchange'), false);
});
test('declining Gmail scope does not create a falsely complete connection', async () => {
  const w = world(); w.tokens.scope = 'openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar';
  await assert.rejects(connect(w), /permission/i);
  assert.deepEqual(await w.auth.list(), []);
});
test('unverified Google identity cannot become a connection', async () => {
  const w = world(); w.identity.email_verified = false;
  await assert.rejects(connect(w), /identity/i);
  assert.deepEqual(await w.auth.list(), []);
});
test('expired access refreshes with existing app credentials; refresh token stays in BB', async () => {
  const w = world(); await connect(w); w.setNow(3_601_000);
  assert.equal(await w.auth.access('alice@example.test'), 'REFRESHED_ACCESS');
  assert.deepEqual(w.calls.find(([stage]) => stage === 'refresh'), ['refresh', { clientId: 'existing-web-client', clientSecret: 'SECRET_CLIENT', refreshToken: 'SECRET_REFRESH' }]);
  assert.equal((await w.store.bySubject('alice-id')).refreshToken, 'SECRET_REFRESH');
});
test('reconnect is bound to the selected account; changing accounts does not overwrite it', async () => {
  const w = world(); await connect(w);
  const { url } = await w.auth.beginConnect({ subject: 'alice-id' });
  assert.equal(new URL(url).searchParams.get('login_hint'), 'alice@example.test');
  w.identity.sub = 'bob-id'; w.identity.email = 'bob@example.test';
  await assert.rejects(w.auth.finishConnect({ state: new URL(url).searchParams.get('state'), code: 'code' }), /same Google account/i);
  assert.deepEqual(await w.auth.list(), [{ subject: 'alice-id', email: 'alice@example.test' }]);
});
test('removing an account prevents further tokens', async () => {
  const w = world(); await connect(w); await w.auth.removeAccount('alice-id');
  await assert.rejects(w.auth.access('alice@example.test'), /account/i);
});
