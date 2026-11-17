import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleOAuth } from '../adapters/google-oauth.mjs';

test('OAuth adapter uses existing Web client, PKCE, offline consent and supplied callback', () => {
  const oauth = createGoogleOAuth();
  const url = new URL(oauth.authorizationUrl({ client_id: 'client', redirect_uri: 'https://bb.example/callback', state: 'state', code_challenge: 'challenge', code_challenge_method: 'S256', scope: ['openid', 'email'] }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});
test('OAuth HTTP translations keep credentials out of URLs and preserve token payloads', async () => {
  const requests = [];
  const oauth = createGoogleOAuth({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return Response.json(url.includes('userinfo') ? { sub: 'subject', email: 'alice@example.test', email_verified: true } : { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  } });
  await oauth.exchange({ code: 'code', verifier: 'verifier', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://bb.example/callback' });
  await oauth.refresh({ refreshToken: 'refresh', clientId: 'client', clientSecret: 'secret' });
  await oauth.identity('access');
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].init.body.get('code_verifier'), 'verifier');
  assert.equal(requests[1].init.body.get('grant_type'), 'refresh_token');
  assert.equal(requests[2].init.headers.authorization, 'Bearer access');
  assert.ok(requests.every(r => !r.url.includes('secret') && !r.url.includes('refresh') && !r.url.includes('access')));
});
test('provider failures are classified without exposing their bodies, tokens or exceptions', async () => {
  for (const failure of [() => Response.json({ error: 'invalid_grant', private: 'PRIVATE_CONTENT' }, { status: 400 }), () => { throw new Error('SECRET_TOKEN PRIVATE_CONTENT'); }]) {
    const oauth = createGoogleOAuth({ fetchImpl: async () => failure() });
    await assert.rejects(oauth.refresh({ clientId: 'client', clientSecret: 'SECRET_TOKEN', refreshToken: 'refresh' }), error => {
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_CONTENT|SECRET_TOKEN/);
      return true;
    });
  }
});
