import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPES } from '../connection.ts';
import { diagnostic, feedback, XeroError } from '../diagnostic.ts';
import { TENANT, OTHER, tenant, tokens, world } from './support.ts';

test('OAuth owns its connection, uses one-use hashed expiring state and discovers actual organisations', async () => {
  const w = world(), { url } = await w.connection.begin(), u = new URL(url), state = u.searchParams.get('state')!;
  assert.equal(u.origin, 'https://login.xero.com'); assert.ok(state.length >= 40);
  assert.equal(u.searchParams.get('scope'), SCOPES.join(' ')); assert.ok(!SCOPES.includes('accounting.settings'));
  assert.equal(w.calls.length, 0, 'registration and sign-in begin do not call Xero');
  await assert.rejects(w.connection.finish({ state: 'UNKNOWN_SECRET', code: 'SECRET_CODE' }), /cancelled, expired or already used/);
  await w.connection.finish({ state, code: 'SECRET_CODE' });
  assert.deepEqual(w.connection.list(), [tenant]); assert.equal(w.calls.length, 2);
  assert.equal(new URLSearchParams(w.calls[0]!.init.body as URLSearchParams).get('code'), 'SECRET_CODE');
  await assert.rejects(w.connection.finish({ state, code: 'SECRET_CODE' }), /cancelled, expired or already used/);
  assert.equal(w.calls.length, 2); assert.doesNotMatch(JSON.stringify(w.connection.list()), /SECRET/);
  for (const call of w.calls) assert.equal(call.init.redirect, 'error');
});
test('expired, denied and client-changed callbacks leave the old connection intact', async () => {
  for (const mode of ['expired', 'denied', 'client']) {
    const w = world(); w.seed(); const before = w.store.get();
    const { url } = await w.connection.begin(), state = new URL(url).searchParams.get('state')!;
    if (mode === 'expired') w.advance(300_001);
    if (mode === 'client') w.client.clientId = 'CHANGED';
    await assert.rejects(w.connection.finish({ state, code: 'SECRET_CODE', ...(mode === 'denied' ? { error: 'SECRET_PROVIDER_MESSAGE' } : {}) }));
    assert.equal(w.store.get(), before); assert.equal(w.calls.length, 0);
  }
});
test('missing scopes reject authentication without accepting partial permissions', async () => {
  const w = world(); w.setHandler(() => Response.json({ ...tokens, scope: 'offline_access accounting.invoices' }));
  await assert.rejects(w.connect(), /permissions are missing/); assert.equal(w.store.get(), null);
});
test('concurrent reads serialize rotating refresh tokens and persist rotation exactly once', async () => {
  const w = world(); w.seed(); w.advance(1800_000); let refreshes = 0;
  w.setHandler(async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json({ ...tokens, access_token: 'ROTATED_ACCESS', refresh_token: 'ROTATED_REFRESH' }); });
  const auth = await Promise.all(Array.from({ length: 8 }, () => w.connection.authorize(TENANT)));
  assert.equal(refreshes, 1); assert.ok(auth.every(a => a.token === 'ROTATED_ACCESS')); assert.equal(w.store.get()!.refreshToken, 'ROTATED_REFRESH');
});
test('disconnect during token refresh cannot resurrect credentials or authorize stale calls', async () => {
  const w = world(); w.seed(); const auth = await w.connection.authorize(TENANT); w.advance(1800_000);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const startedGate = new Promise<void>(resolve => { started = resolve; });
  w.setHandler(async () => { started(); await gate; return Response.json(tokens); });
  const pending = w.connection.authorize(TENANT); await startedGate; w.connection.disconnect(); release();
  await assert.rejects(pending, /connection changed/); assert.equal(w.store.get(), null); assert.throws(auth.ensure, /connection changed/);
});
test('disconnect before a queued callback starts cannot resurrect a connection', async () => {
  const w = world(), { url } = await w.connection.begin();
  const pending = w.connection.finish({ state: new URL(url).searchParams.get('state')!, code: 'SECRET_CODE' });
  w.connection.disconnect();
  await assert.rejects(pending, /connection changed/); assert.equal(w.store.get(), null); assert.equal(w.calls.length, 0);
});
test('reconnecting invalidates old authorization snapshots, including a later completed callback', async () => {
  const w = world(); w.seed();
  const old = await w.connection.authorize(TENANT); await w.connect();
  assert.throws(old.ensure, /connection changed/);
  const { url } = await w.connection.begin();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
  w.setHandler(async () => { started(); await gate; return Response.json(tokens); });
  const pending = w.connection.finish({ state: new URL(url).searchParams.get('state')!, code: 'SECRET_CODE' });
  await entered; await w.connection.begin(); release();
  await assert.rejects(pending, /connection changed/);
});
test('tenant routing is explicit and never uses an unknown or default organisation', async () => {
  const w = world(); w.seed(); await assert.rejects(w.connection.authorize(OTHER), /explicitly connected/);
  assert.equal(w.calls.length, 0); assert.ok((await w.connection.authorize(TENANT)).token);
});
test('provider failures never expose response bodies, arbitrary errors, codes or causes', async () => {
  const w = world(); w.seed();
  for (const status of [401, 403, 429, 500]) {
    w.setHandler(() => new Response('SECRET_BODY PRIVATE_ACCOUNT', { status }));
    try { await w.connection.refresh(); assert.fail('must reject'); } catch (e) {
      assert.match(diagnostic(e, 'fallback'), new RegExp(`Xero tenant_discovery .*http_${status}`));
      assert.doesNotMatch(feedback(e), /SECRET|PRIVATE_ACCOUNT/);
    }
  }
  const raw = Object.assign(new Error('SECRET_ERROR'), { code: 'SECRET_CODE', cause: { body: 'PRIVATE_ACCOUNT' } });
  assert.equal(diagnostic(raw, 'tool_call'), 'Xero tool_call unknown'); assert.doesNotMatch(feedback(raw), /SECRET|PRIVATE_ACCOUNT/);
});
test('discovery failure after code exchange preserves rotated tokens for refresh recovery', async () => {
  const w = world(); let failed = true;
  w.setHandler(url => url.hostname === 'identity.xero.com' ? Response.json(tokens) : failed ? new Response('SECRET', { status: 503 }) : Response.json([tenant]));
  await assert.rejects(w.connect()); assert.ok(w.store.get()?.refreshToken); assert.deepEqual(w.connection.list(), []);
  failed = false; assert.deepEqual(await w.connection.refresh(), [tenant]);
});
test('an interrupted response body keeps the failed boundary and drops the provider exception', async () => {
  const w = world(); w.seed();
  w.setHandler(() => new Response(new ReadableStream({ start(controller) { controller.error(new Error('SECRET_STREAM PRIVATE_ACCOUNT')); } })));
  await assert.rejects(w.connection.refresh(), e => { assert.equal(diagnostic(e, 'tool_call'), 'Xero tenant_discovery transport'); assert.doesNotMatch(feedback(e), /SECRET|PRIVATE_ACCOUNT/); return true; });
});
test('empty, malformed and oversized provider results fail honestly', async () => {
  const w = world(); w.seed();
  for (const body of ['', '{bad SECRET_JSON', JSON.stringify({ private: 'SECRET_DATA' }), JSON.stringify(['x'.repeat(2_000_001)])]) {
    w.setHandler(() => new Response(body));
    await assert.rejects(w.connection.refresh(), e => e instanceof XeroError && e.category === 'response_invalid' && !/SECRET/.test(e.message));
  }
});
