import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const emailUrlSchema = z.object({ emailId: id }).strict();
type Json = Record<string, any>;
const object = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => id.safeParse(v).success;
// This is a Fastmail adapter, not a rule for opaque standard JMAP IDs.
// Fastmail's crash-course session uses u + eight lowercase hex digits; its
// web client maps user account IDs to user IDs by removing the leading u.
// Restrict this mapping to the verified primary personal mail account and the
// observed canonical format. Never fall back to username or sending aliases.
export function fastmailWebUserId(accountId: string): string {
  const match = /^u([0-9a-f]{8})$/.exec(accountId);
  if (!match) return fail('email_url_session', 'unsupported_account_format');
  return match[1];
}
export class EmailUrlError extends Error {
  stage: string; category: string;
  constructor(stage: string, category: string) {
    super(category === 'source_missing'
      ? 'Fastmail email URL unavailable: first search or read the exact email through this plugin, then resolve its returned email ID. Source evidence expires on reconnect or after ten minutes.'
      : category === 'unsupported_account_format'
      ? 'Fastmail email URL unavailable: the authenticated primary mail account ID has an unsupported Fastmail web-account format. No URL was generated; do not substitute a username or sending alias.'
      : 'Fastmail email URL unavailable: authenticated account or exact message metadata could not be verified. No URL was generated. Check Configuration and search/read the exact email again; do not construct a folder/email-ID URL.');
    this.stage = stage; this.category = category;
  }
}
function fail(stage: string, category: string): never { throw new EmailUrlError(stage, category); }
type Evidence = { id: string; threadId: string; messageId: string[]; receivedAt: string };
function evidence(v: unknown): Evidence | null {
  if (!object(v) || !validId(v.id) || !validId(v.threadId) || !Array.isArray(v.messageId) ||
    !v.messageId.length || v.messageId.length > 16 || v.messageId.some((s: unknown) => typeof s !== 'string' || !s || s.length > 998 || /[\x00-\x20\x7f]/.test(s)) ||
    typeof v.receivedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v.receivedAt) || !Number.isFinite(Date.parse(v.receivedAt))) return null;
  return { id: v.id, threadId: v.threadId, messageId: [...v.messageId], receivedAt: v.receivedAt };
}
// Receipts come only from actual successful provider calls, never agent-supplied
// metadata. Retain no bodies, subjects, addresses, mailbox names or credentials.
export class EmailUrlSources {
  private entries = new Map<string, { value: Evidence; revision: number; at: number }>();
  private now: () => number;
  constructor(now = Date.now) { this.now = now; }
  observe(name: string, args: Json, result: unknown, revision: number) {
    if (!['search_email', 'read_email', 'read_thread'].includes(name) || !object(result) || result.isError) return;
    const values: unknown[] = [];
    if (result.structuredContent !== undefined) values.push(result.structuredContent);
    if (Array.isArray(result.content)) for (const p of result.content) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.length <= 1024 * 1024) {
        try { values.push(JSON.parse(p.text)); } catch { /* Not evidence. */ }
      }
    }
    if (!values.length || values.some(v => !isDeepStrictEqual(v, values[0]))) return;
    const v = values[0];
    const list = name === 'search_email' && object(v) ? v.results : name === 'read_thread' ? v : [v];
    if (!Array.isArray(list) || list.length > 256) return;
    for (const raw of list) {
      const value = evidence(raw);
      if (!value || name === 'read_email' && value.id !== args.id || name === 'read_thread' && value.threadId !== args.threadId) continue;
      this.entries.delete(value.id);
      this.entries.set(value.id, { value, revision, at: this.now() });
      if (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value!);
    }
  }
  get(emailId: string, revision: number): Evidence {
    const entry = this.entries.get(emailId);
    if (!entry || entry.revision !== revision || this.now() - entry.at >= 600_000) return fail('email_url_source', 'source_missing');
    return structuredClone(entry.value);
  }
  clear() { this.entries.clear(); }
}
function endpoint(value: unknown): string {
  try {
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw new Error();
    const u = new URL(value);
    if (u.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?api\.fastmail\.com$/.test(u.hostname) ||
      u.username || u.password || u.port || u.hash || u.search || !u.pathname.startsWith('/jmap/')) throw new Error();
    return u.href;
  } catch { return fail('email_url_session', 'invalid_endpoint'); }
}
// Fastmail web-client routing, NOT a standard JMAP property or API guarantee.
// Use the owner-selected archive context rather than synthesizing folder paths.
// The first path segment is mandatory even for thread.email.
// Web-account mapping comes from the verified primary personal mail account,
// never an agent argument or an invented JMAP webUrl. See docs/email-urls.md.
export function messageWebUrl(threadId: string, emailId: string, accountId: string): string {
  if (!validId(threadId) || !validId(emailId)) return fail('email_url_route', 'invalid_identifier');
  const userId = fastmailWebUserId(accountId);
  const url = new URL(`https://app.fastmail.com/mail/Archive/${encodeURIComponent(threadId)}.${encodeURIComponent(emailId)}`);
  url.searchParams.set('u', userId);
  if (url.origin !== 'https://app.fastmail.com' || url.username || url.password || url.hash) return fail('email_url_route', 'invalid_origin');
  return url.href;
}
export async function resolveEmailUrl(token: string | undefined, input: unknown, source: Evidence, options: {
  fetch?: typeof fetch; signal?: AbortSignal; ensureCurrent: () => void;
}) {
  const parsed = emailUrlSchema.safeParse(input);
  if (!parsed.success || source.id !== parsed.data.emailId) return fail('email_url_arguments', 'invalid_arguments');
  if (!token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) return fail('email_url_config', 'token_missing_or_invalid');
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  async function json(url: string, stage: string, payload?: Json): Promise<Json> {
    try {
      signal.throwIfAborted(); options.ensureCurrent();
      const response = await (options.fetch ?? fetch)(endpoint(url), {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (response.status !== 200) { void response.body?.cancel(); return fail(stage, [401, 403, 404, 429].includes(response.status) ? `http_status=${response.status}` : 'http_rejected'); }
      const reader = response.body?.getReader();
      if (!reader) return fail(stage, 'invalid_response');
      const chunks: Uint8Array[] = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          const { value, done } = await reader.read(); signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > 512 * 1024) return fail(stage, 'response_limit');
          chunks.push(value);
        }
      } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!object(v)) return fail(stage, 'invalid_response');
      signal.throwIfAborted(); options.ensureCurrent(); return v;
    } catch (error) {
      if (error instanceof EmailUrlError) throw error;
      return fail(stage, signal.aborted ? 'cancelled' : 'transport_or_invalid_response');
    }
  }
  const session = await json('https://api.fastmail.com/jmap/session', 'email_url_session');
  const accountId = session.primaryAccounts?.[MAIL];
  if (!validId(accountId) || !object(session.accounts?.[accountId]) || session.accounts[accountId].isPersonal !== true ||
    !object(session.accounts[accountId].accountCapabilities?.[MAIL])) return fail('email_url_session', 'primary_mail_account_missing');
  const userId = fastmailWebUserId(accountId);
  // A future explicit selector must agree with the established account mapping.
  // It is never treated as a standard JMAP field or used to override that binding.
  if (session.userId !== undefined && session.userId !== userId) return fail('email_url_session', 'account_selector_mismatch');
  const result = await json(endpoint(session.apiUrl), 'email_url_metadata', {
    using: [CORE, MAIL], methodCalls: [['Email/get', { accountId, ids: [source.id], properties: ['id', 'threadId', 'messageId', 'receivedAt'] }, 'url']],
  });
  const responses = result.methodResponses;
  if (!Array.isArray(responses) || responses.length !== 1 || !Array.isArray(responses[0]) || responses[0].length !== 3) return fail('email_url_metadata', 'invalid_response');
  const [method, data, tag] = responses[0];
  if (method === 'error') return fail('email_url_metadata', 'provider_rejected');
  if (method !== 'Email/get' || tag !== 'url' || !object(data) || data.accountId !== accountId ||
    !Array.isArray(data.list) || data.list.length !== 1 || !Array.isArray(data.notFound) || data.notFound.length) return fail('email_url_metadata', 'missing_or_mismatched_message');
  const actual = evidence(data.list[0]);
  if (!actual || !isDeepStrictEqual(actual, source)) return fail('email_url_metadata', 'source_message_mismatch');
  signal.throwIfAborted(); options.ensureCurrent();
  return { provider: 'Fastmail', emailId: actual.id, threadId: actual.threadId, accountId,
    url: messageWebUrl(actual.threadId, actual.id, accountId),
    accountMapping: 'fastmail-primary-personal-u-hex-account',
    urlSource: 'fastmail-web-client-route', binding: 'authenticated-session-and-exact-mcp-jmap-message-metadata',
    verification: 'metadata-verified-not-browser-verified',
    note: 'Use this returned URL unchanged. Fastmail sign-in for this web account is required. Web-client routing is provider-specific, not a standard JMAP webUrl contract.' };
}
