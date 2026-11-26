import { z } from 'zod';

const key = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const cursor = z.string().min(1).max(4096);
const maxMimeBytes = 32 * 1024 * 1024;
const maxRawChars = Math.ceil(maxMimeBytes * 4 / 3) + 4;
const account = z.object({ id: key, email: z.email().max(320) });
const page = z.object({ ids: z.array(key).max(25), next: cursor.nullable(), restart: z.boolean().optional() });
const gmailMessage = z.object({ id: key, raw: z.unknown().optional() });
const invalidRawCharacter = /[^A-Za-z0-9_-]/;
const raw = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), mime: z.string().max(maxRawChars) }),
  z.object({ status: z.enum(['missing', 'too_large']) }),
]);
export const emailArchiveContract = {
  emailArchiveAccounts: { input: z.null(), output: z.array(account).max(100) },
  emailArchivePage: { input: z.object({ accountId: key, cursor: cursor.nullable() }), output: page },
  emailArchiveMessage: { input: z.object({ accountId: key, messageId: key }), output: raw },
};

export class MailReadError extends Error {
  constructor(readonly category: 'authorization' | 'rate_limited' | 'provider_rejected' | 'size_limit' | 'invalid_response'
    | 'transport' | 'body_read' | 'raw_missing' | 'raw_invalid') {
    super('Gmail archive read failed.');
  }
}

export async function readGmailJson(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new MailReadError('invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read().catch(error => {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
        throw new MailReadError('body_read');
      });
      if (result.done) break;
      size += result.value.length;
      if (size > limit) throw new MailReadError('size_limit');
      chunks.push(result.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; }
    catch { throw new MailReadError('invalid_response'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function gmailArchive(access: (subject: string) => Promise<string>, request = fetch) {
  async function get(subject: string, path: string, query: URLSearchParams, signal: AbortSignal) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    const token = await access(subject);
    signal.throwIfAborted();
    return request(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${query}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal,
    }).catch(() => {
      signal.throwIfAborted();
      throw new MailReadError('transport');
    });
  }
  function rejected(response: Response): never {
    void response.body?.cancel().catch(() => {});
    throw new MailReadError([401, 403].includes(response.status) ? 'authorization'
      : response.status === 429 ? 'rate_limited' : 'provider_rejected');
  }
  return {
    async page(accountId: string, token: string | null, signal: AbortSignal): Promise<z.infer<typeof page>> {
      const query = new URLSearchParams({ maxResults: '25', includeSpamTrash: 'true' });
      if (token) query.set('pageToken', token);
      const response = await get(accountId, 'messages', query, signal);
      if (token && response.status === 400) {
        void response.body?.cancel().catch(() => {});
        return { ids: [], next: null, restart: true };
      }
      if (!response.ok) rejected(response);
      const body = z.object({
        messages: z.array(z.object({ id: key })).max(25).default([]),
        nextPageToken: cursor.optional(),
      }).parse(await readGmailJson(response, 64 * 1024));
      return { ids: body.messages.map(message => message.id), next: body.nextPageToken ?? null };
    },
    async message(accountId: string, messageId: string, signal: AbortSignal): Promise<z.infer<typeof raw>> {
      const response = await get(accountId, 'messages/' + encodeURIComponent(messageId), new URLSearchParams({ format: 'raw' }), signal);
      if (response.status === 404) {
        void response.body?.cancel().catch(() => {});
        return { status: 'missing' };
      }
      if (!response.ok) rejected(response);
      let body: unknown;
      try { body = await readGmailJson(response, maxRawChars + 64 * 1024); }
      catch (error) {
        if (error instanceof MailReadError && error.category === 'size_limit') return { status: 'too_large' };
        throw error;
      }
      const message = gmailMessage.safeParse(body);
      if (!message.success || message.data.id !== messageId) throw new MailReadError('invalid_response');
      const encoded = message.data.raw;
      if (encoded == null || encoded === '') throw new MailReadError('raw_missing');
      if (typeof encoded !== 'string') throw new MailReadError('raw_invalid');
      // Look for an invalid character without matching the entire MIME payload.
      const unpadded = encoded.replace(/={1,2}$/, '');
      if (!unpadded || invalidRawCharacter.test(unpadded)) throw new MailReadError('raw_invalid');
      const mime = Buffer.from(unpadded, 'base64url');
      if (!mime.length) throw new MailReadError('raw_invalid');
      if (mime.length > maxMimeBytes) return { status: 'too_large' };
      return { status: 'ok', mime: mime.toString('base64') };
    },
  };
}
