import { z } from 'zod';

// Adapted from mattwynne/pa integrations/fastmail-email/email-labels.py and
// jmap_common.py. Only membership updates are exposed here; MCP retains its
// archive/trash tools. No message bodies are requested.
const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const MAX_RESPONSE = 4 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const label = z.string().min(1).max(512).refine(value => !/[\x00-\x1f]/.test(value));
export const labelUpdateSchema = z.object({
  emailIds: z.array(id).min(1).max(50),
  addLabels: z.array(label).max(25).optional(),
  removeLabels: z.array(label).max(25).optional(),
  apply: z.boolean().optional(),
}).strict();
type Request = z.infer<typeof labelUpdateSchema>;
type Json = Record<string, unknown>;
type Diagnose = (stage: string, category: string) => void;
type Mailbox = { id: string; name: string; parentId: string | null; role: string | null; path: string; rights: Json };
type Email = { id: string; blobId: string; threadId: string; mailboxIds: string[]; keywords: string[] };
type Proposal = { emailId: string; before: string[]; after: string[]; willChange: boolean; patchKeys: string[] };
type Plan = { patches: Record<string, Record<string, true | null>>; proposals: Proposal[]; expected: Map<string, Email> };
type Verification = { status: 'verified' | 'noop' | 'diverged' };
type ItemResult = { status: string; verification?: Verification };

export class JmapLabelError extends Error {
  stage: string;
  category: string;
  definitive: boolean;
  constructor(stage: string, category: string, message: string, definitive = false) {
    super(message); this.stage = stage; this.category = category; this.definitive = definitive;
  }
}
const object = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function fail(message: string, stage = 'jmap_plan'): never { throw new JmapLabelError(stage, 'invalid_state', message, true); }
function sorted(values: Iterable<string>) { return [...values].sort(); }
function same(a: string[], b: string[]) { return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b)); }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function safeEndpoint(value: unknown): string {
  try {
    if (typeof value !== 'string' || /[\x00-\x20]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?api\.fastmail\.com$/.test(url.hostname) ||
      url.username || url.password || url.port || url.hash || url.search || !url.pathname.startsWith('/jmap/')) throw new Error();
    return url.href;
  } catch { throw new JmapLabelError('jmap_session', 'invalid_endpoint', 'Fastmail returned an unsupported JMAP endpoint. No changes made.', true); }
}

class Jmap {
  token: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
  apiUrl = '';
  accountId = '';
  constructor(token: string, fetcher: typeof fetch, signal: AbortSignal) { this.token = token; this.fetcher = fetcher; this.signal = signal; }
  async json(url: string, stage: string, payload?: Json): Promise<Json> {
    try {
      this.signal.throwIfAborted();
      const response = await this.fetcher(safeEndpoint(url), {
        method: payload ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${this.token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new JmapLabelError(stage, `http_status=${response.status}`, 'Fastmail rejected the JMAP request. Check the token and its mail access. A write may have completed; inspect before retrying.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new JmapLabelError(stage, 'invalid_response', 'Fastmail returned an incomplete JMAP response.');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE) { await reader.cancel(); throw new JmapLabelError(stage, 'response_limit', 'Fastmail JMAP response exceeds the safe size limit.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let result: unknown;
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new JmapLabelError(stage, 'invalid_response', 'Fastmail returned an invalid JMAP response.'); }
      if (!object(result)) throw new JmapLabelError(stage, 'invalid_response', 'Fastmail returned an invalid JMAP response.');
      return result;
    } catch (error) {
      if (error instanceof JmapLabelError) throw error;
      throw new JmapLabelError(stage, this.signal.aborted ? 'cancelled' : 'transport', 'Fastmail JMAP request did not complete. A write may have completed; inspect before retrying.');
    }
  }
  async open() {
    const session = await this.json('https://api.fastmail.com/jmap/session', 'jmap_session');
    const accountId = object(session.primaryAccounts) ? session.primaryAccounts[MAIL] : undefined;
    const account = typeof accountId === 'string' && object(session.accounts) ? session.accounts[accountId] : undefined;
    if (typeof accountId !== 'string' || !accountId || !object(account) || !object(account.accountCapabilities) || !object(account.accountCapabilities[MAIL]))
      throw new JmapLabelError('jmap_session', 'mail_access_missing', 'The JMAP token does not expose a primary mail account. Enable mail access in Fastmail.', true);
    this.accountId = accountId; this.apiUrl = safeEndpoint(session.apiUrl);
  }
  async call(method: string, args: Json, stage: string): Promise<Json> {
    const response = await this.json(this.apiUrl, stage, { using: [CORE, MAIL], methodCalls: [[method, { accountId: this.accountId, ...args }, 'call']] });
    const results = response.methodResponses;
    if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(results[0]) || results[0].length !== 3)
      throw new JmapLabelError(stage, 'invalid_response', 'Fastmail returned an incomplete JMAP method response.');
    const [name, data, callId] = results[0];
    if (callId !== 'call' || !object(data)) throw new JmapLabelError(stage, 'invalid_response', 'Fastmail returned a mismatched JMAP response.');
    if (name === 'error') {
      const rejected = new Set(['stateMismatch', 'invalidArguments', 'accountNotFound', 'accountNotSupportedByMethod', 'accountReadOnly', 'forbidden', 'unknownMethod', 'requestTooLarge']);
      const kind = typeof data.type === 'string' && rejected.has(data.type) ? data.type : 'provider_error';
      throw new JmapLabelError(stage, kind, kind === 'stateMismatch' ? 'Mailbox state changed. Preview again before retrying.' : 'Fastmail rejected the JMAP operation. Check mail access and current mailbox state.', kind !== 'provider_error');
    }
    if (name !== method || data.accountId !== this.accountId) throw new JmapLabelError(stage, 'invalid_response', 'Fastmail returned a mismatched JMAP account or method.');
    return data;
  }
  async mailboxes(): Promise<{ boxes: Map<string, Mailbox>; inbox: string }> {
    const data = await this.call('Mailbox/get', { properties: ['id', 'name', 'parentId', 'role', 'myRights'] }, 'jmap_mailboxes');
    if (!Array.isArray(data.list) || data.list.length > 2048 || (data.notFound !== undefined && (!Array.isArray(data.notFound) || data.notFound.length))) fail('Incomplete Fastmail mailbox list. No changes made.', 'jmap_mailboxes');
    const boxes = new Map<string, Mailbox>(); const roles = new Set<string>();
    for (const raw of data.list) {
      if (!object(raw) || !validId(raw.id) || boxes.has(raw.id) || typeof raw.name !== 'string' || !raw.name || raw.name.length > 512 ||
        (raw.parentId !== null && !validId(raw.parentId)) || (raw.role !== null && typeof raw.role !== 'string') || !object(raw.myRights)) fail('Malformed Fastmail mailbox metadata. No changes made.', 'jmap_mailboxes');
      if (raw.role !== null) { if (roles.has(raw.role)) fail('Ambiguous Fastmail system mailbox role. No changes made.', 'jmap_mailboxes'); roles.add(raw.role); }
      boxes.set(raw.id, { id: raw.id, name: raw.name, role: raw.role, parentId: raw.parentId, path: '', rights: raw.myRights });
    }
    for (const box of boxes.values()) {
      const names = []; const seen = new Set<string>(); let current: Mailbox | undefined = box;
      while (current) {
        if (seen.has(current.id)) fail('Fastmail mailbox hierarchy has a cycle. No changes made.', 'jmap_mailboxes');
        seen.add(current.id); names.unshift(current.name);
        if (current.parentId === null) break;
        current = boxes.get(current.parentId);
        if (!current) fail('Fastmail mailbox hierarchy is incomplete. No changes made.', 'jmap_mailboxes');
      }
      box.path = names.join('/');
      if (box.path.length > 512) fail('Fastmail mailbox path exceeds the safe size limit. No changes made.', 'jmap_mailboxes');
    }
    const inbox = [...boxes.values()].find(box => box.role === 'inbox')?.id;
    if (!inbox) fail('A unique Fastmail Inbox role is required. No changes made.', 'jmap_mailboxes');
    return { boxes, inbox };
  }
  async snapshot(ids: string[], boxes: Map<string, Mailbox>, stage = 'jmap_snapshot'): Promise<{ state: string; emails: Map<string, Email> }> {
    const data = await this.call('Email/get', { ids, properties: ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords'] }, stage);
    if (typeof data.state !== 'string' || !data.state || !Array.isArray(data.list) || !Array.isArray(data.notFound) || data.notFound.length) fail('One or more emails are missing or their state is incomplete. No safe update is possible.', stage);
    const emails = new Map<string, Email>();
    for (const raw of data.list) {
      if (!object(raw) || !validId(raw.id) || !ids.includes(raw.id) || emails.has(raw.id) ||
        typeof raw.blobId !== 'string' || !raw.blobId || typeof raw.threadId !== 'string' || !raw.threadId ||
        !object(raw.mailboxIds) || !Object.keys(raw.mailboxIds).length || !object(raw.keywords) ||
        Object.entries(raw.mailboxIds).some(([mid, v]) => !boxes.has(mid) || v !== true) || Object.values(raw.keywords).some(v => v !== true)) fail('Malformed Fastmail email state. No safe update is possible.', stage);
      emails.set(raw.id, { id: raw.id, blobId: raw.blobId, threadId: raw.threadId, mailboxIds: sorted(Object.keys(raw.mailboxIds)), keywords: sorted(Object.keys(raw.keywords)) });
    }
    if (emails.size !== ids.length) fail('Incomplete Fastmail email snapshot. No safe update is possible.', stage);
    return { state: data.state, emails };
  }
}

function plan(request: Request, boxes: Map<string, Mailbox>, inbox: string, emails: Map<string, Email>): Plan {
  function resolve(value: string) {
    if (value.toLowerCase() === 'inbox') return inbox;
    const matches = [...boxes.values()].filter(box => box.path === value || (!value.includes('/') && box.name === value));
    if (matches.length !== 1) fail('Label not found exactly or ambiguous. Use an exact full label path. No changes made.');
    if (matches[0].role !== null && matches[0].role !== 'inbox') fail('Only Inbox and user labels are supported. Use the dedicated MCP tools for archive or trash.');
    return matches[0].id;
  }
  function right(mid: string, name: string) { if (boxes.get(mid)?.rights[name] !== true) fail('Mailbox rights do not permit this membership change. No changes made.'); }
  const add = new Set((request.addLabels ?? []).map(resolve)); const remove = new Set((request.removeLabels ?? []).map(resolve));
  if ([...add].some(mid => remove.has(mid))) fail('Cannot add and remove the same label in one request.');
  for (const mid of add) right(mid, 'mayAddItems');
  const patches: Plan['patches'] = {}; const proposals: Proposal[] = []; const expected = new Map<string, Email>();
  for (const email of emails.values()) {
    const before = new Set(email.mailboxIds); const after = new Set([...before, ...add]);
    const entries: [string, true | null][] = [];
    for (const mid of add) if (!before.has(mid)) entries.push([`mailboxIds/${mid}`, true]);
    for (const mid of remove) {
      after.delete(mid);
      if (before.has(mid)) { right(mid, 'mayRemoveItems'); entries.push([`mailboxIds/${mid}`, null]); }
    }
    if (!after.size) fail('Refusing to leave an email with no mailbox membership. No changes made.');
    const patch = Object.fromEntries(entries);
    if (entries.length) Object.defineProperty(patches, email.id, { value: patch, enumerable: true });
    expected.set(email.id, { ...email, mailboxIds: sorted(after) });
    proposals.push({ emailId: email.id, before: sorted([...before].map(mid => boxes.get(mid)!.path)), after: sorted([...after].map(mid => boxes.get(mid)!.path)), willChange: entries.length > 0, patchKeys: sorted(Object.keys(patch)) });
  }
  if (new TextEncoder().encode(JSON.stringify(proposals)).byteLength > 64 * 1024) fail('Membership proposal exceeds the safe output limit. Preview a smaller batch; no changes made.');
  return { patches, proposals, expected };
}
function verify(plan: Plan, emails: Map<string, Email>): Record<string, Verification> {
  return Object.fromEntries(plan.proposals.map(p => {
    const expected = plan.expected.get(p.emailId)!; const actual = emails.get(p.emailId);
    const matches = actual && same(actual.mailboxIds, expected.mailboxIds) && same(actual.keywords, expected.keywords) && actual.blobId === expected.blobId && actual.threadId === expected.threadId;
    return [p.emailId, { status: matches ? (p.willChange ? 'verified' : 'noop') : 'diverged' }];
  }));
}

export async function updateEmailLabels(token: string | undefined, input: unknown, options: { fetch?: typeof fetch; signal?: AbortSignal; diagnose?: Diagnose } = {}) {
  if (!token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)) throw new JmapLabelError('jmap_config', 'token_missing_or_invalid', 'Set a valid JMAP API token with mail access in Fastmail plugin Configuration.', true);
  const parsed = labelUpdateSchema.safeParse(input);
  if (!parsed.success) throw new JmapLabelError('jmap_plan', 'invalid_arguments', 'Supply 1–50 exact email IDs, up to 25 exact label paths per list, and an optional boolean apply.', true);
  const request = parsed.data;
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 64 * 1024 || new Set(request.emailIds).size !== request.emailIds.length ||
    [request.addLabels ?? [], request.removeLabels ?? []].some(values => new Set(values).size !== values.length) || !(request.addLabels?.length || request.removeLabels?.length))
    throw new JmapLabelError('jmap_plan', 'invalid_arguments', 'Supply at least one label change; duplicate IDs or labels and oversized requests are rejected.', true);
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(options.signal ? [options.signal] : [])]);
  const client = new Jmap(token, options.fetch ?? fetch, signal);
  await client.open();
  let { boxes, inbox } = await client.mailboxes();
  let snapshot = await client.snapshot(request.emailIds, boxes);
  let proposed = plan(request, boxes, inbox, snapshot.emails);
  const base = () => ({ operation: 'update', apply: Boolean(request.apply), proposals: proposed.proposals, batchAtomicity: 'Atomic per Email, not across this batch.' });
  if (!request.apply) return { ...base(), status: 'preview', summary: 'Preview only; no write performed.' };
  if (!Object.keys(proposed.patches).length) return { ...base(), status: 'noop', summary: 'Memberships already match; no write performed.', results: Object.fromEntries(request.emailIds.map(id => [id, { status: 'noop' }])) };
  let uncertain = false; let response: Json | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await client.call('Email/set', { ifInState: snapshot.state, update: proposed.patches }, 'jmap_update');
      if ((response.updated !== undefined && !object(response.updated)) || (response.notUpdated !== undefined && !object(response.notUpdated))) throw new JmapLabelError('jmap_update', 'invalid_response', 'Malformed JMAP update result.');
      break;
    } catch (error) {
      if (error instanceof JmapLabelError && error.definitive) {
        if (error.category !== 'stateMismatch' || attempt !== 0) throw error;
        options.diagnose?.('jmap_update', 'stateMismatch');
        ({ boxes, inbox } = await client.mailboxes());
        snapshot = await client.snapshot(request.emailIds, boxes);
        proposed = plan(request, boxes, inbox, snapshot.emails);
        if (!Object.keys(proposed.patches).length) return { ...base(), status: 'noop', summary: 'Memberships already match after rereading; no write needed.', results: Object.fromEntries(request.emailIds.map(id => [id, { status: 'noop' }])) };
        continue;
      }
      options.diagnose?.('jmap_update', error instanceof JmapLabelError ? error.category : 'unknown');
      uncertain = true; break;
    }
  }
  let after: Map<string, Email>;
  try { after = (await client.snapshot(request.emailIds, boxes, 'jmap_verify')).emails; }
  catch (error) {
    throw new JmapLabelError('jmap_verify', error instanceof JmapLabelError ? error.category : 'unknown', 'The membership write may have completed, but read-back verification failed. Inspect Fastmail before retrying; no automatic resend.');
  }
  const checks = verify(proposed, after);
  const results: Record<string, ItemResult> = Object.fromEntries(proposed.proposals.map(p => {
    let status = p.willChange ? 'uncertain' : 'noop';
    if (!uncertain && p.willChange) {
      const updated = object(response?.updated) && Object.hasOwn(response.updated, p.emailId);
      const rejected = object(response?.notUpdated) && Object.hasOwn(response.notUpdated, p.emailId);
      status = updated && !rejected ? 'updated' : rejected && !updated ? 'notUpdated' : 'uncertain';
    }
    return [p.emailId, { status, verification: checks[p.emailId] }];
  }));
  const verified = Object.values(checks).every(check => check.status !== 'diverged');
  const partial = !verified || Object.values(results).some(r => r.status === 'notUpdated' || r.status === 'uncertain');
  const status = uncertain ? (verified ? 'verified_after_uncertain' : 'uncertain_diverged') : partial ? 'partial' : 'applied';
  if (!uncertain && partial) options.diagnose?.('jmap_update', 'partial_result');
  return { ...base(), status, results, summary: uncertain ? 'Write outcome was uncertain; reread once. Do not blindly retry.' : partial ? 'Partial result; inspect per-email verification before any retry.' : 'Label membership update verified; other memberships and keywords preserved.' };
}
