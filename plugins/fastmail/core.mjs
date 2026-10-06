import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Client, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { failureCategory } from './diagnostic.mjs';

export const ENDPOINT = new URL('https://api.fastmail.com/mcp');
const TTL = 10 * 60_000;
const MAX_PAGES = 32;
const MAX_TOOLS = 2048;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const equal = (a, b) => Boolean(a && b && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)));
export const callbackPath = id => `/api/v1/plugins/${encodeURIComponent(id)}/http/oauth/callback`;
export function callbackUrl(base, id) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('BB loopback URL required');
  return new URL(callbackPath(id), `http://localhost:${origin.port}`).toString();
}
export function parseCallback(value, redirect) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid callback URL'); }
  const expected = new URL(redirect);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => !['state', 'code', 'iss', 'error', 'error_description'].includes(key)) ||
      ['state', 'code', 'iss', 'error'].some(key => url.searchParams.getAll(key).length > 1)) throw new Error('Wrong callback route');
  return url.searchParams;
}
export class FastmailProvider {
  constructor(store, redirect) { this.store = store; this.redirectUrl = new URL(redirect); this.authorizationUrl = null; }
  get clientMetadata() { return { client_name: 'BB Fastmail', redirect_uris: [this.redirectUrl.toString()], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }; }
  async state() { const state = randomBytes(32).toString('base64url'); this.store.patch({ pending: { state, at: Date.now() } }); return state; }
  clientInformation(ctx) { const value = this.store.get().client; return ctx?.issuer && value?.issuer && ctx.issuer !== value.issuer ? undefined : value; }
  saveClientInformation(value) { this.store.patch({ client: value }); }
  tokens(ctx) { const value = this.store.get().tokens; return ctx?.issuer && value?.issuer && ctx.issuer !== value.issuer ? undefined : value; }
  saveTokens(value) { this.store.patch({ tokens: value }); }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString(); }
  saveCodeVerifier(verifier) { const pending = this.store.get().pending; if (!pending) throw new Error('Authorization expired'); this.store.patch({ pending: { ...pending, verifier } }); }
  codeVerifier() { const pending = this.store.get().pending; if (!pending?.verifier) throw new Error('Authorization expired'); return pending.verifier; }
  saveAuthorizationServerUrl(value) { this.store.patch({ issuerUrl: value }); }
  authorizationServerUrl() { return this.store.get().issuerUrl; }
  saveResourceUrl(value) { this.store.patch({ resourceUrl: value }); }
  resourceUrl() { return this.store.get().resourceUrl; }
  saveDiscoveryState(value) { this.store.patch({ discovery: value }); }
  discoveryState() { return this.store.get().discovery; }
  invalidateCredentials(scope) {
    if (scope === 'all') return this.store.clear();
    const keys = { client: ['client'], tokens: ['tokens'], verifier: ['pending'], discovery: ['discovery', 'issuerUrl', 'resourceUrl'] }[scope] || [];
    this.store.remove(...keys);
  }
  consume(params) {
    const pending = this.store.get().pending;
    // Consume before any network operation: even a failed exchange cannot be replayed.
    this.store.remove('pending');
    if (!pending || Date.now() - pending.at > TTL || !equal(pending.state, params.get('state')) || !pending.verifier ||
        !params.get('code') || params.has('error')) throw new Error('Invalid or expired authorization');
    this.store.patch({ pending: { verifier: pending.verifier } });
  }
  finish() { this.store.remove('pending'); this.authorizationUrl = null; }
}

const safeName = name => `fastmail_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);

// An identity is a send-from address, not proof of the Fastmail login username.
// Display only the one address the provider explicitly marks as default.
export function defaultSendingAddress(result) {
  if (!result || result.isError) return null;
  const candidates = [result.structuredContent];
  for (const part of result.content || []) {
    if (part.type !== 'text' || typeof part.text !== 'string' || part.text.length > 256 * 1024) continue;
    try { candidates.push(JSON.parse(part.text)); } catch { /* Ignore non-JSON messages. */ }
  }
  for (const value of candidates) {
    const identities = Array.isArray(value) ? value : value?.identities;
    if (!Array.isArray(identities)) continue;
    const defaults = identities.filter(identity => identity && identity.isDefault === true);
    if (defaults.length !== 1) return null;
    const email = defaults[0].email;
    return typeof email === 'string' && email.length <= 254 && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+$/.test(email) ? email : null;
  }
  return null;
}
/** BB lifecycle is the only authority for catalog visibility and calls. */
export class FastmailConnection {
  constructor({ store, redirect, register, changed = () => {}, diagnose = /** @type {(message: string) => void} */ (() => {}), connect = /** @type {null | (() => {client: any, transport: any})} */ (null), endpoint = ENDPOINT }) {
    this.store = store; this.provider = new FastmailProvider(store, redirect); this.register = register; this.changed = changed;
    this.diagnose = (stage, error) => diagnose(`${stage} ${typeof error === 'string' && ['provider_error_result', 'no_default_sender'].includes(error) ? error : failureCategory(error)}`);
    this.makeConnection = connect || (() => {
      const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: this.provider, onInsufficientScope: 'throw',
        fetch: async (input, init) => {
          const response = await fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(15000), ...[init?.signal].filter(Boolean)]) });
          if (response.status >= 300 && response.status < 400) throw new Error('Fastmail redirect blocked');
          return response;
        },
      });
      return { transport, client: new Client({ name: 'bb-fastmail', version: '0.1.2' }, { listChanged: { tools: { onChanged: () => {
        void this.refresh().catch(() => { /* refresh logs and revokes the failing catalog */ });
      } } } }) };
    });
    this.catalog = new Map(); this.names = new Map(); this.registered = new Set(); this.enabled = true; this.revision = 0;
    this.identityLookup = null; this.reconnecting = null;
  }
  get ready() { return this.enabled && Boolean(this.client); }
  async open() {
    if (!this.enabled) throw new Error('Fastmail disabled');
    if (this.client) return;
    const { client, transport } = this.makeConnection();
    const revision = this.revision;
    try {
      await client.connect(transport, { timeout: 15000 });
      if (!this.enabled || this.revision !== revision) throw new Error('Fastmail connection changed');
      this.client = client; this.transport = transport;
      await this.refresh();
    } catch (error) {
      if (this.client === client) { this.client = null; this.transport = null; this.catalog.clear(); this.names.clear(); this.changed(); }
      await client.close().catch(() => {});
      if (error instanceof UnauthorizedError && this.provider.authorizationUrl) return;
      this.diagnose('connection_open', error);
      throw new Error('Fastmail connection failed');
    }
  }
  async begin() {
    if (!this.enabled) throw new Error('Fastmail disabled');
    await this.close();
    this.store.remove('tokens', 'pending');
    this.provider.authorizationUrl = null;
    await this.open();
    if (!this.provider.authorizationUrl) throw new Error('Fastmail authorization unavailable');
    return this.provider.authorizationUrl;
  }
  async finish(params) {
    if (!this.enabled) throw new Error('Fastmail disabled');
    this.provider.consume(params);
    try {
      const { transport } = this.makeConnection();
      // The SDK validates issuer and exchanges the code with the saved PKCE verifier.
      await transport.finishAuth(params);
      await transport.close();
      this.provider.finish();
      await this.open();
      if (!this.ready) throw new Error('Fastmail connection failed');
    } catch (error) { this.provider.finish(); this.diagnose('authorization_finish', error); throw new Error('Fastmail authorization failed'); }
  }
  async refresh() {
    if (!this.ready) return;
    const client = this.client;
    const revision = ++this.revision;
    const seen = new Set();
    const tools = [];
    let bytes = 0;
    let cursor;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        // SDK listTools() aggregates every page internally before returning;
        // request one page at a time so our bounds apply before the next fetch.
        const response = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) });
        if (!Array.isArray(response.tools) || tools.length + response.tools.length > MAX_TOOLS) throw new Error('Fastmail catalog exceeds limit');
        bytes += Buffer.byteLength(JSON.stringify(response.tools));
        if (bytes > MAX_CATALOG_BYTES) throw new Error('Fastmail catalog exceeds limit');
        tools.push(...response.tools);
        if (response.nextCursor === undefined) { cursor = undefined; break; }
        if (typeof response.nextCursor !== 'string' || !response.nextCursor || seen.has(response.nextCursor)) throw new Error('Fastmail catalog cursor cycle');
        seen.add(response.nextCursor);
        cursor = response.nextCursor;
      }
      if (cursor !== undefined) throw new Error('Fastmail catalog exceeds page limit');
    } catch (error) {
      if (this.client === client && this.revision === revision) {
        this.catalog.clear(); this.names.clear(); this.changed();
        this.diagnose('catalog_refresh', error);
      }
      throw error;
    }
    if (!this.ready || this.client !== client || this.revision !== revision) return;
    const next = new Map();
    const names = new Map();
    for (const tool of tools) {
      if (!tool.name || !tool.inputSchema || typeof tool.inputSchema !== 'object') continue;
      const name = `${safeName(tool.name)}_${hash([tool.name, tool.inputSchema])}`;
      if (next.has(name)) continue;
      next.set(name, tool);
      names.set(tool.name, name);
      if (!this.registered.has(name) && this.registered.size < 254 && JSON.stringify(tool.inputSchema).length <= 128 * 1024) {
        try {
          this.register({ name, description: `Fastmail: ${tool.description || tool.name}`, parameters: tool.inputSchema });
          this.registered.add(name);
        } catch { /* BB rejected this schema: the generic catalog/call path remains available. */ }
      }
    }
    this.catalog = next; this.names = names; this.changed();
  }
  toolNames() { return this.ready ? [...this.catalog.keys()].filter(name => this.registered.has(name)) : []; }
  list() { return this.ready ? [...this.catalog.entries()].map(([id, tool]) => ({ id, name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations })) : []; }
  async getDefaultSendingAddress() {
    if (!this.ready || !this.names.has('list_identities')) return null;
    if (this.identityLookup) return this.identityLookup;
    const client = this.client;
    const lookup = this.callByName('list_identities', {}, AbortSignal.timeout(6000))
      .then(result => {
        if (this.client !== client) return null;
        if (result.isError) this.diagnose('identity_lookup', 'provider_error_result');
        const address = defaultSendingAddress(result);
        if (!address && !result.isError) this.diagnose('identity_lookup', 'no_default_sender');
        return address;
      })
      .catch(error => { this.diagnose('identity_lookup', error); return null; })
      .finally(() => { if (this.identityLookup === lookup) this.identityLookup = null; });
    this.identityLookup = lookup;
    return lookup;
  }
  async callByName(name, args, signal) {
    const id = this.names.get(name);
    if (!id) throw new Error('Fastmail tool unavailable');
    return this.call(id, args, signal);
  }
  async call(name, args, signal) {
    if (!this.ready || !this.catalog.has(name)) throw new Error('Fastmail tool unavailable');
    const tool = this.catalog.get(name);
    const client = this.client;
    let result;
    try { result = await client.callTool({ name: tool.name, arguments: args }, { signal }); }
    catch (error) {
      // A provider failure may follow an expired MCP connection. Reopen for
      // future calls, but never retry this call: a mutation may have completed.
      if (error instanceof SdkHttpError && error.status === 500) await this.reopenAfterFailure(client, error);
      throw error;
    }
    if (!this.ready || this.client !== client || !this.catalog.has(name)) throw new Error('Fastmail tool unavailable');
    return result;
  }
  async reopenAfterFailure(client, error) {
    if (!this.enabled || this.client !== client) return;
    if (this.reconnecting) return this.reconnecting;
    const recovery = (async () => {
      this.diagnose('connection_reset', error);
      const revision = this.revision + 1;
      await this.close();
      // A concurrent disconnect/disable must win over recovery.
      if (!this.enabled || this.revision !== revision) return;
      try { await this.open(); } catch { /* open logs its own bounded failure. */ }
    })();
    this.reconnecting = recovery;
    try { await recovery; }
    finally { if (this.reconnecting === recovery) this.reconnecting = null; }
  }
  async close() {
    const client = this.client; ++this.revision; this.client = null; this.transport = null;
    this.catalog.clear(); this.names.clear(); this.identityLookup = null; this.changed();
    if (client) await client.close().catch(() => {});
  }
  async disconnect() { await this.close(); this.store.clear(); this.provider.authorizationUrl = null; }
  async disable() { this.enabled = false; await this.close(); }
  async shutdown() { await this.disable(); }
}
