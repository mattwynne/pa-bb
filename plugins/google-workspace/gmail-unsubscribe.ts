import { z } from 'zod';
import { readGmailJson } from './email-archive.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const address = z.email().max(320);
const target = z.object({ account: address, emailId: id }).strict();
const maxMime = 3 * 1024 * 1024;
const message = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), mailbox: address, mime: z.string().max(maxMime) }),
  z.object({ status: z.enum(['account_missing', 'missing', 'ineligible', 'too_large']) }),
]);
export const gmailUnsubscribeContract = {
  unsubscribeMessage: { input: target, output: message },
  sendUnsubscribeMail: {
    input: z.object({
      account: address, from: address, to: address,
      subject: z.string().max(256).regex(/^[\x20-\x7e]*$/),
      body: z.string().max(2048).regex(/^[\x20-\x7e\r\n]*$/),
    }).strict(),
    output: z.object({ status: z.enum(['request_sent', 'needs_user', 'unverified']) }),
  },
};

export function gmailUnsubscribe(auth: {
  list(): Promise<{ subject: string; email: string }[]>;
  accessSubject(subject: string): Promise<string>;
}, request = fetch) {
  async function mailbox(account: string) {
    const matches = (await auth.list()).filter(entry => entry.email.toLowerCase() === account.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  }

  async function headers(subject: string, signal: AbortSignal) {
    const token = await auth.accessSubject(subject);
    signal.throwIfAborted();
    return { Authorization: `Bearer ${token}` };
  }

  return {
    async read(input: z.infer<typeof target>, signal: AbortSignal): Promise<z.infer<typeof message>> {
      const selected = await mailbox(input.account);
      if (!selected) return { status: 'account_missing' };
      const query = new URLSearchParams({ format: 'raw', fields: 'id,labelIds,sizeEstimate,raw' });
      const response = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${input.emailId}?${query}`, {
        headers: await headers(selected.subject, signal), redirect: 'error', signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 404) return { status: 'missing' };
        throw Object.assign(new Error('Gmail message read failed.'), { status: response.status });
      }
      let value: unknown;
      try { value = await readGmailJson(response, maxMime + 8192); }
      catch (error) {
        if (error instanceof Error && 'category' in error && error.category === 'size_limit') return { status: 'too_large' };
        throw error;
      }
      const item = z.object({
        id, labelIds: z.array(z.string()).max(500),
        raw: z.string().min(1).max(maxMime).regex(/^[A-Za-z0-9_-]+={0,2}$/),
      }).parse(value);
      if (item.id !== input.emailId) throw new Error('Mismatched Gmail message.');
      if (item.labelIds.some(label => ['DRAFT', 'SENT', 'SPAM', 'TRASH'].includes(label))) return { status: 'ineligible' };
      if ((await mailbox(input.account))?.subject !== selected.subject) return { status: 'account_missing' };
      return { status: 'ok', mailbox: selected.email, mime: Buffer.from(item.raw, 'base64url').toString('base64') };
    },

    async send(input: z.infer<typeof gmailUnsubscribeContract.sendUnsubscribeMail.input>, signal: AbortSignal) {
      const selected = await mailbox(input.account);
      if (!selected || selected.email.toLowerCase() !== input.from.toLowerCase()) return { status: 'needs_user' } as const;
      const authorization = await headers(selected.subject, signal);
      if ((await mailbox(input.account))?.subject !== selected.subject) return { status: 'needs_user' } as const;
      signal.throwIfAborted();
      const body = input.body.replace(/\r\n|\r|\n/g, '\r\n');
      const message = [`From: ${selected.email}`, `To: ${input.to}`, `Subject: ${input.subject}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=us-ascii', '', body].join('\r\n');
      const response = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(message).toString('base64url') }), redirect: 'error', signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if ([400, 401, 403, 429].includes(response.status)) return { status: 'needs_user' } as const;
        return { status: 'unverified' } as const;
      }
      const sent = z.object({ id }).parse(await readGmailJson(response, 8192));
      return { status: sent.id ? 'request_sent' : 'unverified' } as const;
    },
  };
}
