import { z } from 'zod';
import { readGmailJson } from './email-archive.js';

const mailbox = z.email().max(320);
const threadId = z.string().regex(/^[0-9a-f]{1,64}$/);
export const gmailConversationInput = z.object({ account: mailbox, threadId }).strict();
export const gmailConversationStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), unread: z.number().int().min(0).max(500),
    sender: z.string().max(320).nullable(), latestAt: z.string().nullable() }).strict(),
  z.object({ status: z.enum(['unsupported', 'account_missing', 'not_found', 'unavailable']) }).strict(),
]);
export const gmailCorrespondenceContract = {
  gmailConversationStatus: { input: z.object({ url: z.string().max(2048) }).strict(), output: gmailConversationStatus },
};
const thread = z.object({
  id: threadId,
  messages: z.array(z.object({
    id: z.string(), threadId, labelIds: z.array(z.string()).default([]),
    internalDate: z.string().regex(/^\d{1,14}$/),
    payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]) }).optional(),
  })).min(1).max(500),
});

export function gmailConversationTarget(value: string) {
  if (/[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const account = url.searchParams.get('authuser');
    const match = /^#all\/([0-9a-f]{1,64})$/.exec(url.hash);
    if (url.origin !== 'https://mail.google.com' || url.username || url.password ||
        url.pathname !== '/mail/' || [...url.searchParams].length !== 1 || !match) return null;
    return gmailConversationInput.safeParse({ account, threadId: match[1] }).data ?? null;
  } catch { return null; }
}

const clean = (value: string | undefined, limit: number) =>
  value?.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) || null;

export function gmailCorrespondence(auth: {
  list(): Promise<{ subject: string; email: string }[]>;
  accessSubject(subject: string): Promise<string>;
}, request: typeof fetch = fetch, now = Date.now) {
  const retryAt = new Map<string, number>();
  return async (input: z.infer<typeof gmailConversationInput>, signal: AbortSignal) => {
    const accounts = (await auth.list()).filter(account => account.email.toLowerCase() === input.account.toLowerCase());
    if (accounts.length !== 1) return { status: 'account_missing' } as const;
    const { subject, email } = accounts[0]!;
    const retry = retryAt.get(subject);
    if (retry !== undefined && retry > now()) return { status: 'unavailable' } as const;
    retryAt.delete(subject);
    const token = await auth.accessSubject(subject);
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    const query = new URLSearchParams({
      format: 'metadata', fields: 'id,messages(id,threadId,labelIds,internalDate,payload(headers))',
    });
    for (const name of ['From', 'Subject']) query.append('metadataHeaders', name);
    const response = await request(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.threadId}?${query}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get('retry-after');
        const current = now();
        const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - current : NaN;
        if (retryAt.size >= 100) {
          for (const [id, until] of retryAt) if (until <= current) retryAt.delete(id);
        }
        retryAt.set(subject, current + (Number.isFinite(delay) ? Math.max(1000, delay) : 60_000));
      }
      if (response.status === 404) return { status: 'not_found' } as const;
      throw Object.assign(new Error('Gmail thread read failed.'), { status: response.status });
    }
    const result = thread.parse(await readGmailJson(response, 512 * 1024));
    signal.throwIfAborted();
    if (result.id !== input.threadId || result.messages.some(message => message.threadId !== result.id) ||
        new Set(result.messages.map(message => message.id)).size !== result.messages.length)
      throw new Error('Invalid Gmail thread metadata.');
    if (!(await auth.list()).some(account => account.subject === subject && account.email === email))
      return { status: 'account_missing' } as const;
    const eligible = result.messages.filter(message => !message.labelIds.some(label => ['DRAFT', 'TRASH', 'SPAM'].includes(label)));
    eligible.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    const latest = eligible.at(-1);
    const header = (message: typeof latest, name: string) =>
      message?.payload?.headers.find(header => header.name.toLowerCase() === name)?.value;
    const url = new URL('https://mail.google.com/mail/');
    url.searchParams.set('authuser', email);
    url.hash = 'all/' + result.id;
    return {
      status: 'ok', unread: eligible.filter(message => message.labelIds.includes('UNREAD')).length,
      sender: clean(header(latest, 'from'), 320),
      latestAt: latest ? new Date(Number(latest.internalDate)).toISOString() : null,
      title: clean(header(eligible[0] ?? result.messages[0], 'subject'), 1024) ?? '(no subject)',
      url: url.href,
    } as const;
  };
}
