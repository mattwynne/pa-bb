import { randomBytes, createHash } from 'node:crypto';

export const SCOPES = Object.freeze(['openid', 'email', 'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic']);
const digest = value => createHash('sha256').update(value).digest('hex');
function reject(category, message) { throw Object.assign(new Error(message), { workspaceCategory: category }); }
function identity(info) {
  if (!info?.sub || !info.email || info.email_verified !== true) reject('identity', 'Google identity could not be verified.');
  return info;
}

// OAuth and storage are ports; this core never performs HTTP or opens a database.
export function createGoogleAuth({ store, oauth, getClient, callbackUrl, clock = () => Date.now() }) {
  return {
    async list() { return (await store.accounts()).map(({ subject, email }) => ({ subject, email })); },
    async beginConnect({ subject } = {}) {
      const { clientId, clientSecret } = await getClient(), redirectUri = callbackUrl();
      if (!clientId || !clientSecret || !redirectUri?.startsWith('https://')) reject('configuration', 'Configure a Web OAuth client and an HTTPS BB address first.');
      const previous = subject ? await store.bySubject(subject) : null;
      if (subject && !previous) reject('account_missing', 'Unknown Workspace account.');
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      await store.savePending({ stateHash: digest(state), verifier, redirectUri, clientId, subject, expiresAt: clock() + 300_000 });
      return { url: oauth.authorizationUrl({ client_id: clientId, redirect_uri: redirectUri, state,
        code_challenge: challenge, code_challenge_method: 'S256', scope: SCOPES, ...(previous ? { login_hint: previous.email } : {}) }) };
    },
    async finishConnect({ state, code, error }) {
      const pending = state ? await store.consumePending(digest(state)) : null;
      const { clientId, clientSecret } = await getClient();
      if (error || !code || !pending || pending.expiresAt <= clock() || pending.clientId !== clientId || pending.redirectUri !== callbackUrl())
        reject('oauth_state', 'Google authorization was cancelled, expired or already used. Start again in Workspace settings.');
      const tokens = await oauth.exchange({ code, verifier: pending.verifier, clientId, clientSecret, redirectUri: pending.redirectUri });
      const granted = new Set(String(tokens.scope || '').split(/\s+/));
      if (SCOPES.some(scope => scope !== 'email' && !granted.has(scope))) reject('scope_required', 'Google did not grant the required Workspace permissions. Reconnect and approve the requested services.');
      const info = identity(await oauth.identity(tokens.access_token));
      if (pending.subject && pending.subject !== info.sub) reject('identity', 'Reconnect using the same Google account.');
      const previous = await store.bySubject(info.sub);
      const refreshToken = tokens.refresh_token || (previous?.clientId === clientId ? previous.refreshToken : null);
      if (!tokens.access_token || !refreshToken) reject('authorization', 'Google did not supply a refreshable connection. Connect again with consent.');
      await store.saveAccount({ subject: info.sub, email: info.email, clientId, refreshToken, accessToken: tokens.access_token, expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000 });
      return { subject: info.sub, email: info.email };
    },
    async access(email) { return accessRecord(await store.byEmail(String(email))); },
    async accessSubject(subject) { return accessRecord(await store.bySubject(subject)); },
    async removeAccount(subject) { return { removed: await store.removeAccount(subject) }; },
  };

  async function accessRecord(record) {
    if (!record) reject('account_missing', 'Unknown Workspace account. Check connected accounts.');
    if (record.accessToken && record.expiresAt > clock() + 60_000) return record.accessToken;
    const { clientId, clientSecret } = await getClient();
    if (!clientId || !clientSecret || clientId !== record.clientId) reject('configuration', 'Restore the account\'s Web OAuth client settings or reconnect the account.');
    const tokens = await oauth.refresh({ clientId, clientSecret, refreshToken: record.refreshToken });
    if (!tokens.access_token) reject('authorization', 'Google connection expired. Reconnect this account.');
    const info = identity(await oauth.identity(tokens.access_token));
    if (info.sub !== record.subject) reject('identity', 'Google returned a different account. Reconnect this account.');
    if (!await store.bySubject(record.subject)) reject('account_missing', 'Workspace account was removed.');
    await store.saveAccount({ ...record, email: info.email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || record.refreshToken,
      expiresAt: clock() + (Number(tokens.expires_in) || 3600) * 1000 });
    return tokens.access_token;
  }
}
