import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { XeroError } from './diagnostic.ts';

import { SCOPES, requestedScopes, scopeGranted } from './permissions.ts';
export { SCOPES } from './permissions.ts';
const tenantSchema = z.object({ tenantId: z.uuid(), tenantName: z.string().min(1).max(500), tenantType: z.string() });
export type Tenant = z.infer<typeof tenantSchema>;
export type Client = { clientId?: string; clientSecret?: string; additionalScopes?: string; scopeOverride?: string; enableAppStore?: boolean };
export type Session = { clientId: string; accessToken: string; refreshToken: string; expiresAt: number; scopes: string[]; tenants: Tenant[] };
export type Pending = { hash: string; expiresAt: number; clientId: string; redirectUri: string; scopes?: string[] };
export type Store = { get(): Session | null; save(session: Session): void; clear(): void; pending(value: Pending): void; consume(hash: string): Pending | null; clearPending(): void };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive().max(86400), scope: z.string().optional() });
const MAX_RESPONSE = 2_000_000;

// Read a bounded body, including when the provider omits Content-Length.
export async function responseJson(response: Response, stage: string): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new XeroError('response_invalid', stage, 'Xero returned no response data. Check the record before retrying.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE) { await reader.cancel(); throw new XeroError('response_invalid', stage, 'Xero returned too much data. Use a narrower filter or page. Check any requested change before retrying.'); }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new XeroError('response_invalid', stage, 'Xero returned an unreadable response. Check any requested change before retrying.'); }
  } catch (error) {
    if (error instanceof XeroError) throw error;
    throw new XeroError('transport', stage, 'The Xero response was interrupted. Any requested change may already be saved. Inspect the record before retrying.');
  } finally { reader.releaseLock(); }
}
export async function providerFetch(fetcher: typeof fetch, url: string | URL, init: RequestInit, stage: string, mutation = false, acceptedStatuses: readonly number[] = []) {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([init.signal ?? AbortSignal.timeout(30_000), AbortSignal.timeout(30_000)]) }); }
  catch { throw new XeroError('transport', stage, mutation ? 'Xero did not confirm the change. It may have been applied. Read the record before retrying; do not create a replacement.' : 'Could not reach Xero. Check the connection and try the read again.', mutation); }
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    const category = status === 401 || status === 403 ? 'authorization' : status === 429 ? 'rate_limit' : 'provider_rejection';
    const uncertain = mutation && status >= 500;
    throw new XeroError(category, stage, uncertain ? 'Xero did not confirm the change. It may have been applied. Read the record before retrying.'
      : category === 'authorization' ? 'Xero access was rejected. Reconnect in Xero settings and approve the requested permissions.'
      : category === 'rate_limit' ? 'Xero is limiting requests. Wait before trying again; check any requested change first.'
      : ['oauth_exchange', 'token_refresh', 'application_token'].includes(stage) ? 'Xero rejected the token request. Check client credentials, requested scopes and app eligibility; reconnect after correcting the configuration.'
      : 'Xero rejected the request. Check the record and requested fields before trying again.', uncertain, status);
  }
  return response;
}

export function createConnection({ store, getClient, callbackUrl, fetcher = fetch, clock = Date.now, signal }: {
  store: Store; getClient(): Promise<Client>; callbackUrl(): string; fetcher?: typeof fetch; clock?: () => number; signal: AbortSignal;
}) {
  let revision = 0, tail: Promise<unknown> = Promise.resolve();
  let applicationToken: { token: string; expiresAt: number; revision: number } | null = null;
  // Xero rotates refresh tokens. Serialize OAuth and refresh so concurrent tools never race a rotation.
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const pending = tail.then(run, run); tail = pending.catch(() => {}); return pending;
  }
  function ensure(expected: number) { signal.throwIfAborted(); if (expected !== revision) throw new XeroError('connection_changed', 'connection', 'Xero connection changed. Check settings and the record before retrying.'); }
  async function client() {
    const value = await getClient();
    if (!value.clientId || !value.clientSecret) throw new XeroError('configuration', 'configuration', 'Save your Xero Web OAuth client ID and secret in Configuration first.');
    return { clientId: value.clientId, clientSecret: value.clientSecret, scopes: requestedScopes(value.additionalScopes, value.scopeOverride), enableAppStore: value.enableAppStore === true };
  }
  async function tokens(params: Record<string, string>, current: { clientId: string; clientSecret: string }, previousScopes?: string[], required: readonly string[] = SCOPES): Promise<Omit<Session, 'tenants'>> {
    const response = await providerFetch(fetcher, 'https://identity.xero.com/connect/token', {
      method: 'POST', signal, headers: { Authorization: `Basic ${Buffer.from(`${current.clientId}:${current.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params),
    }, params.grant_type === 'refresh_token' ? 'token_refresh' : 'oauth_exchange');
    const parsed = tokenSchema.safeParse(await responseJson(response, 'oauth_tokens'));
    if (!parsed.success) throw new XeroError('response_invalid', 'oauth_tokens', 'Xero did not return a refreshable connection. Reconnect in settings.');
    const t = parsed.data, scopes = t.scope === undefined ? previousScopes ?? [] : t.scope.split(/\s+/);
    if (required.some(scope => !scopeGranted(scope, scopes))) throw new XeroError('scope_required', 'oauth_tokens', 'Required Xero permissions are missing. Reconnect and approve all requested permissions.');
    return { clientId: current.clientId, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: clock() + t.expires_in * 1000, scopes };
  }
  async function access(): Promise<Session> {
    return exclusive(async () => {
      const expected = revision, current = await client(), saved = store.get();
      if (!saved) throw new XeroError('disconnected', 'connection', 'Connect Xero in plugin settings first.');
      if (saved.clientId !== current.clientId) throw new XeroError('configuration', 'connection', 'The Xero client changed. Restore its settings or reconnect.');
      if (saved.expiresAt > clock() + 60_000) { ensure(expected); return saved; }
      const refreshed = await tokens({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }, current, saved.scopes, saved.scopes);
      ensure(expected); const next = { ...refreshed, tenants: saved.tenants }; store.save(next); return next;
    });
  }
  async function tenants(accessToken: string): Promise<Tenant[]> {
    const response = await providerFetch(fetcher, 'https://api.xero.com/connections', { signal, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }, 'tenant_discovery');
    const parsed = z.array(tenantSchema).safeParse(await responseJson(response, 'tenant_discovery'));
    if (!parsed.success) throw new XeroError('response_invalid', 'tenant_discovery', 'Xero connections could not be verified. Refresh or reconnect.');
    return parsed.data.filter(t => ['ORGANISATION', 'PRACTICE'].includes(t.tenantType));
  }
  return {
    connected: () => Boolean(store.get()),
    list: () => store.get()?.tenants ?? [],
    scopes: () => store.get()?.scopes ?? [],
    changed() { revision++; applicationToken = null; store.clearPending(); },
    disconnect() { revision++; applicationToken = null; store.clear(); store.clearPending(); },
    async begin() {
      const expected = revision, current = await client(), redirectUri = callbackUrl(); ensure(expected);
      revision++;
      const state = randomBytes(32).toString('base64url');
      store.clearPending(); store.pending({ hash: digest(state), clientId: current.clientId, redirectUri, expiresAt: clock() + 300_000, scopes: current.scopes });
      const url = new URL('https://login.xero.com/identity/connect/authorize');
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: current.clientId, redirect_uri: redirectUri, scope: current.scopes.join(' '), state })) url.searchParams.set(key, value);
      return { url: url.toString() };
    },
    async finish({ state, code, error }: { state?: string; code?: string; error?: string }) {
      // Consume synchronously before awaiting anything: callbacks cannot reuse state.
      const expected = revision, pending = state ? store.consume(digest(state)) : null;
      return exclusive(async () => {
        ensure(expected);
        const current = await client(); ensure(expected);
        if (error || !code || !pending || pending.expiresAt <= clock() || pending.clientId !== current.clientId || pending.redirectUri !== callbackUrl())
          throw new XeroError('oauth_state', 'oauth_callback', 'Xero sign-in was cancelled, expired or already used. Start again in settings.');
        const next = await tokens({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri }, current, undefined, pending.scopes ?? SCOPES);
        ensure(expected);
        // Persist rotation before discovery. If discovery fails, Refresh can recover without replaying a code.
        const accepted = ++revision;
        store.save({ ...next, tenants: [] });
        const found = await tenants(next.accessToken); ensure(accepted); store.save({ ...next, tenants: found });
      });
    },
    async refresh() {
      const expected = revision, saved = await access(), found = await tenants(saved.accessToken); ensure(expected);
      // A parallel refresh may have rotated tokens: never overwrite those with this read's old snapshot.
      const latest = store.get(); if (latest) store.save({ ...latest, tenants: found });
      return found;
    },
    async application() {
      return exclusive(async () => {
        const expected = revision, current = await client(); ensure(expected);
        if (!current.enableAppStore) throw new XeroError('configuration', 'application_authorization', 'Enable App Store partner billing in Xero Configuration before requesting this separate client-credentials grant. Xero partner approval is required.');
        if (applicationToken?.revision === revision && applicationToken.expiresAt > clock() + 60_000) return { token: applicationToken.token, ensure: () => ensure(expected) };
        const response = await providerFetch(fetcher, 'https://identity.xero.com/connect/token', { method: 'POST', signal,
          headers: { Authorization: `Basic ${Buffer.from(`${current.clientId}:${current.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'marketplace.billing' }),
        }, 'application_token');
        const parsed = z.object({ access_token: z.string().min(1), expires_in: z.number().positive().max(86400), scope: z.string().optional() }).safeParse(await responseJson(response, 'application_token'));
        if (!parsed.success || (parsed.data.scope !== undefined && !parsed.data.scope.split(/\s+/).includes('marketplace.billing'))) throw new XeroError('authorization', 'application_token', 'Xero did not grant App Store partner billing access. Check the app eligibility and credentials.');
        ensure(expected); applicationToken = { token: parsed.data.access_token, expiresAt: clock() + parsed.data.expires_in * 1000, revision };
        return { token: applicationToken.token, ensure: () => ensure(expected) };
      });
    },
    async authorize(tenantId?: string) {
      const expected = revision, saved = await access(); ensure(expected);
      if (tenantId !== undefined && !saved.tenants.some(t => t.tenantId === tenantId)) throw new XeroError('tenant_required', 'tenant_selection', 'Choose an explicitly connected Xero organisation or practice using xero_list_tenants. No default tenant is assumed.');
      return { token: saved.accessToken, ensure: () => ensure(expected) };
    },
  };
}
export type Connection = ReturnType<typeof createConnection>;
