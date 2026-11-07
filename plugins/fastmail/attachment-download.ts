import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { saveOriginal, safeAttachmentName } from './attachment-file.ts';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024; // Existing Drive upload ceiling.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const account = z.string().min(1).max(320).regex(/^[^\s\x00-\x1f\x7f]+$/);
const mime = z.string().max(255).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/);
export const attachmentDownloadSchema = z.object({
  account, emailId: id, blobId: id,
  expectedName: z.string().min(1).max(255), expectedMimeType: mime,
  expectedSize: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
}).strict();
type Request = z.infer<typeof attachmentDownloadSchema>;
type Json = Record<string, any>;
type Options = {
  fetch?: typeof fetch; signal?: AbortSignal;
  mcp: (name: string, args: Json, signal: AbortSignal) => Promise<unknown>;
  location: () => Promise<string>;
  ensureCurrent: () => void;
};
export class AttachmentError extends Error {
  stage: string; category: string;
  constructor(stage: string, category: string) {
    super(category === 'account_mismatch'
      ? 'Original download is blocked because the requested JMAP account does not match the authenticated session. Select the account reported by preflight; do not guess. No attachment was downloaded or uploaded.'
      : category === 'cleanup_failed'
      ? 'Local download cleanup could not be confirmed. A partial or complete file may remain in this thread storage. Inspect it before another download. No upload was attempted.'
      : 'Original attachment download did not complete. No upload was attempted. Check Fastmail attachment download setup and the exact attachment metadata; do not bypass a refusal.');
    this.stage = stage; this.category = category;
  }
}
export function attachmentFail(stage: string, category: string): never { throw new AttachmentError(stage, category); }
const object = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && id.safeParse(v).success;
function endpoint(value: unknown, download = false): string {
  try {
    if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw new Error();
    const u = new URL(value);
    // Fastmail advertises sharded API hosts and a separate dedicated content
    // domain. Only the authenticated session's download template may select a
    // fastmailusercontent.com host; agent/sender URLs never reach this function.
    // Metadata stays on the API family used by our JMAP label adapter.
    const allowedHost = /^(?:[a-z0-9-]+\.)?api\.fastmail\.com$/.test(u.hostname) || download &&
      /^(?:[a-z0-9-]+\.)*fastmailusercontent\.com$/.test(u.hostname);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
      return attachmentFail('attachment_session', download ? 'download_endpoint_origin' : 'api_endpoint_origin');
    if (!allowedHost) {
      const family = /(?:^|\.)fastmailusercontent\.com$/.test(u.hostname) ? 'content_family' : /(?:^|\.)fastmail\.com$/.test(u.hostname) ? 'fastmail_family' : 'origin';
      return attachmentFail('attachment_session', download ? `download_endpoint_${family}` : 'api_endpoint_origin');
    }
    if (download ? ([...u.searchParams.keys()].length !== 1 || !u.searchParams.get('type')) : Boolean(u.search))
      return attachmentFail('attachment_session', download ? 'download_endpoint_query' : 'api_endpoint_query');
    if (!(download ? u.pathname.startsWith('/jmap/download/') : u.pathname.startsWith('/jmap/')))
      return attachmentFail('attachment_session', download ? 'download_endpoint_path' : 'api_endpoint_path');
    return u.href;
  } catch (error) { if (error instanceof AttachmentError) throw error; return attachmentFail('attachment_session', 'invalid_endpoint'); }
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal, stage: string): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AttachmentError(stage, 'cancelled'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
async function bounded(response: Response, limit: number, signal: AbortSignal, stage: string): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return attachmentFail(stage, 'invalid_response');
  const bytes = Buffer.alloc(limit); let size = 0;
  // Explicitly cancel pending reads too; this also bounds synthetic/stalled streams.
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > limit - size) return attachmentFail(stage, 'size_limit');
      bytes.set(value, size); size += value.byteLength;
    }
    return bytes.subarray(0, size);
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    return attachmentFail(stage, signal.aborted ? 'cancelled' : 'transport');
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function mcpJson(result: unknown): unknown {
  if (!object(result) || result.isError) return attachmentFail('attachment_mcp', 'provider_error_result');
  const values: unknown[] = [];
  if (result.structuredContent !== undefined) values.push(result.structuredContent);
  if (Array.isArray(result.content)) for (const p of result.content) {
    if (p?.type === 'text' && typeof p.text === 'string' && p.text.length <= 512 * 1024) {
      try { values.push(JSON.parse(p.text)); } catch { /* Non-JSON is not metadata proof. */ }
    }
  }
  if (!values.length || values.some(v => JSON.stringify(v).length > 512 * 1024)) return attachmentFail('attachment_mcp', 'invalid_response');
  if (values.some(v => !isDeepStrictEqual(v, values[0]))) return attachmentFail('attachment_mcp', 'invalid_response');
  return values[0];
}
function messageIds(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.length || value.length > 16 || value.some(v => typeof v !== 'string' || !v || v.length > 998 || /[\x00-\x20\x7f]/.test(v)))
    return attachmentFail('attachment_ownership', 'invalid_message_identity');
  return value;
}
function receivedAt(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    return attachmentFail('attachment_ownership', 'invalid_message_identity');
  return Date.parse(value);
}
class DownloadClient {
  token: string; options: Options; signal: AbortSignal; api = ''; accountId = ''; username = ''; template = '';
  constructor(token: string | undefined, options: Options) {
    if (!token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) attachmentFail('attachment_config', 'token_missing_or_invalid');
    this.token = token; this.options = options;
    this.signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
  }
  async request(url: string, stage: string, payload?: Json) {
    try {
      this.signal.throwIfAborted(); this.options.ensureCurrent();
      const response = await abortable((this.options.fetch ?? fetch)(url, {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: this.signal,
        headers: { Authorization: `Bearer ${this.token}`, ...(payload ? { 'Content-Type': 'application/json' } : { 'Accept-Encoding': 'identity' }) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      }), this.signal, stage);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return attachmentFail(stage, [401, 403, 404, 429].includes(response.status) ? `http_status=${response.status}` : 'http_rejected');
      }
      return response;
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      return attachmentFail(stage, this.signal.aborted ? 'cancelled' : 'transport');
    }
  }
  async mcp(name: string, args: Json) {
    try { this.signal.throwIfAborted(); return mcpJson(await abortable(this.options.mcp(name, args, this.signal), this.signal, 'attachment_mcp')); }
    catch (error) { if (error instanceof AttachmentError) throw error; return attachmentFail('attachment_mcp', this.signal.aborted ? 'cancelled' : 'transport'); }
  }
  async json(url: string, stage: string, payload?: Json): Promise<Json> {
    const response = await this.request(endpoint(url), stage, payload);
    const bytes = await bounded(response, 512 * 1024, this.signal, stage);
    try { const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (object(v)) return v; } catch { /* fixed diagnostic below */ }
    return attachmentFail(stage, 'invalid_response');
  }
  async call(method: string, properties: Json, using: string[]) {
    const data = await this.json(this.api, 'attachment_metadata', { using: [CORE, ...using], methodCalls: [[method, { accountId: this.accountId, ...properties }, 'attachment']] });
    const responses = data.methodResponses;
    if (!Array.isArray(responses) || responses.length !== 1 || !Array.isArray(responses[0]) || responses[0].length !== 3) return attachmentFail('attachment_metadata', 'invalid_response');
    const [name, result, callId] = responses[0];
    if (name === 'error') return attachmentFail('attachment_metadata', 'provider_rejected');
    if (name !== method || callId !== 'attachment' || !object(result) || result.accountId !== this.accountId ||
        !Array.isArray(result.list) || !Array.isArray(result.notFound) || result.notFound.length) return attachmentFail('attachment_metadata', 'invalid_response');
    return result;
  }
  async open() {
    const session = await this.json('https://api.fastmail.com/jmap/session', 'attachment_session');
    const aid = session.primaryAccounts?.[MAIL];
    if (!validId(aid) || !object(session.accounts?.[aid])) return attachmentFail('attachment_session', 'primary_account_missing');
    if (!account.safeParse(session.username).success) return attachmentFail('attachment_session', 'session_username_missing');
    if (session.accounts[aid].isPersonal !== true) return attachmentFail('attachment_session', 'personal_account_required');
    if (!object(session.accounts[aid].accountCapabilities?.[MAIL])) return attachmentFail('attachment_session', 'mail_access_missing');
    this.accountId = aid; this.username = session.username; this.api = endpoint(session.apiUrl);
    if (typeof session.downloadUrl !== 'string' || session.downloadUrl.length > 2048) return attachmentFail('attachment_session', 'invalid_download_template');
    // Only the documented Fastmail JMAP template; no signed URLs or redirects.
    this.template = session.downloadUrl;
    const skeleton = this.template.replace(/\{(?:accountId|blobId|name|type)\}/g, 'placeholder');
    if (/[{}]/.test(skeleton) || ['accountId', 'blobId', 'name', 'type'].some(key => this.template.split(`{${key}}`).length !== 2)) return attachmentFail('attachment_session', 'invalid_download_template');
    endpoint(skeleton, true);
    // JMAP's authenticated session is authoritative for its own account. MCP
    // sending aliases are not login identities, and may omit the actual login.
    // Never assert account equivalence: the caller selects this explicit JMAP
    // account, and download independently verifies the exact source message and
    // attachment membership against MCP evidence before reading any blob bytes.
    this.options.ensureCurrent();
    return { account: this.username, accountId: this.accountId, identityBinding: 'authenticated-jmap-session' as const };
  }
  async download(r: Request, threadId: string) {
    const identity = await this.open();
    if (r.account !== this.username) return attachmentFail('attachment_identity', 'account_mismatch');
    const mcp = await this.mcp('read_email', { id: r.emailId });
    if (!object(mcp) || mcp.id !== r.emailId || !validId(mcp.threadId) || !Array.isArray(mcp.attachments) || mcp.attachments.length > 256)
      return attachmentFail('attachment_ownership', 'invalid_response');
    const matches = mcp.attachments.filter((a: Json) => object(a) && a.blobId === r.blobId);
    if (matches.length !== 1 || !matchesMetadata(matches[0], r)) return attachmentFail('attachment_ownership', 'metadata_mismatch');
    const data = await this.call('Email/get', { ids: [r.emailId], properties: ['id', 'threadId', 'messageId', 'receivedAt', 'attachments'] }, [MAIL]);
    if (data.list.length !== 1) return attachmentFail('attachment_ownership', 'email_missing');
    const email = data.list[0];
    if (!object(email) || email.id !== r.emailId || email.threadId !== mcp.threadId || !Array.isArray(email.attachments) || email.attachments.length > 256)
      return attachmentFail('attachment_ownership', 'metadata_mismatch');
    if (!isDeepStrictEqual(messageIds(email.messageId), messageIds(mcp.messageId)) || receivedAt(email.receivedAt) !== receivedAt(mcp.receivedAt))
      return attachmentFail('attachment_ownership', 'message_identity_mismatch');
    const parts = email.attachments.filter((a: Json) => object(a) && a.blobId === r.blobId);
    if (parts.length !== 1 || !matchesMetadata(parts[0], r)) return attachmentFail('attachment_ownership', 'metadata_mismatch');
    // Never interpolate untrusted names into paths before validation, even URLs.
    safeAttachmentName(r.expectedName);
    const url = endpoint(this.template.replace(/\{(accountId|blobId|name|type)\}/g, (_, key: string) => encodeURIComponent(
      ({ accountId: this.accountId, blobId: r.blobId, name: r.expectedName, type: r.expectedMimeType } as Json)[key])), true);
    const response = await this.request(url, 'attachment_bytes');
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if ((length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== r.expectedSize)) ||
        (encoding && encoding.toLowerCase() !== 'identity') || !contentType || contentType !== r.expectedMimeType.toLowerCase()) {
      void response.body?.cancel().catch(() => {}); return attachmentFail('attachment_bytes', 'metadata_mismatch');
    }
    const bytes = await bounded(response, r.expectedSize, this.signal, 'attachment_bytes');
    if (bytes.length !== r.expectedSize) return attachmentFail('attachment_bytes', 'size_mismatch');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.signal.throwIfAborted(); this.options.ensureCurrent();
    const provenance = { provider: 'Fastmail', ...identity, emailId: r.emailId, threadId: mcp.threadId, blobId: r.blobId,
      name: r.expectedName, mimeType: r.expectedMimeType, sizeBytes: bytes.length, sha256, downloadedAt: new Date().toISOString(),
      sourceMessage: { messageId: messageIds(email.messageId), receivedAt: email.receivedAt },
      ownershipBinding: 'exact-email-thread-message-attachment-metadata-in-both-apis' };
    const path = await saveOriginal(await abortable(this.options.location(), this.signal, 'attachment_file'), r.expectedName, bytes, provenance, () => { this.signal.throwIfAborted(); this.options.ensureCurrent(); });
    return { status: 'downloaded', source: { host: 'bb-server', threadId, path }, name: r.expectedName,
      mimeType: r.expectedMimeType, sizeBytes: bytes.length, sha256, provenance,
      note: 'Exact downloaded bytes; not opened, extracted, converted or uploaded. A Drive upload requires a separate user request and approval.' };
  }
}
function matchesMetadata(a: Json, r: Request) {
  return a.name === r.expectedName && a.type === r.expectedMimeType && a.size === r.expectedSize;
}
export async function attachmentStatus(token: string | undefined, options: Options) {
  return new DownloadClient(token, options).open();
}
export async function downloadAttachment(token: string | undefined, input: unknown, threadId: string, options: Options) {
  const parsed = attachmentDownloadSchema.safeParse(input);
  if (!parsed.success || !/^thr_[a-z0-9]+$/.test(threadId)) return attachmentFail('attachment_arguments', 'invalid_arguments');
  return new DownloadClient(token, options).download(parsed.data, threadId);
}
