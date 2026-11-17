function failure(category) { return Object.assign(new Error('Google authorization unavailable'), { workspaceCategory: category }); }
export function createGoogleOAuth({ fetchImpl = fetch } = {}) {
  async function json(url, init) {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw failure('authorization_transport'); }
    if (!response.ok) throw failure([400, 401, 403].includes(response.status) ? 'authorization' : 'authorization_transport');
    try { return await response.json(); } catch { throw failure('authorization_transport'); }
  }
  const token = fields => json('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  return {
    authorizationUrl(fields) {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries({ response_type: 'code', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', ...fields }))
        url.searchParams.set(key, Array.isArray(value) ? value.join(' ') : String(value));
      return url.toString();
    },
    exchange({ code, verifier, clientId, clientSecret, redirectUri }) {
      return token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
    },
    refresh({ refreshToken, clientId, clientSecret }) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
    },
    identity(accessToken) {
      return json('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
    },
  };
}
