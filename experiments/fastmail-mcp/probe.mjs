// Public discovery only: no credentials, registration, consent or tool calls.
import assert from 'node:assert/strict';

const origin = 'https://api.fastmail.com';
async function get(url) {
  assert.equal(new URL(url).origin, origin, 'Unexpected discovery origin; review before following');
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

try {
  const response = await get(`${origin}/mcp`);
  assert.equal(response.status, 401, 'Expected unauthenticated MCP challenge');
  const challenge = response.headers.get('www-authenticate') ?? '';
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert.ok(metadataUrl, 'Missing protected resource discovery URL');
  const resourceResponse = await get(metadataUrl);
  assert.equal(resourceResponse.status, 200);
  const resource = await resourceResponse.json();
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.ok(resource.authorization_servers?.includes(origin));
  const authResponse = await get(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(authResponse.status, 200);
  const auth = await authResponse.json();
  assert.equal(auth.issuer, origin);
  for (const key of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint']) {
    assert.equal(new URL(auth[key]).origin, origin);
  }
  assert.ok(auth.code_challenge_methods_supported?.includes('S256'));
  assert.ok(auth.grant_types_supported?.includes('refresh_token'));
  console.log('PASS: unauthenticated challenge, resource discovery, OAuth discovery, PKCE and refresh metadata');
  console.log('NOT TESTED: consent, authenticated transport, tool discovery, reads, restart or writes');
} catch {
  // Deliberately omit remote bodies and error details from diagnostic output.
  console.error('FAIL: public discovery did not match expectations; review provider metadata or network availability');
  process.exitCode = 1;
}
