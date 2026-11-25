import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EmailUrlError, openPrimaryMail } from './email-url.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const maxMessages = 500;
const status = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), unread: z.number().int().min(0).max(maxMessages),
    sender: z.string().max(320).nullable(), latestAt: z.iso.datetime().nullable(),
    threadKey: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ status: z.enum(['unsupported', 'account_missing', 'account_mismatch', 'not_found', 'incomplete', 'unavailable']) }).strict(),
]);
export const fastmailCorrespondenceContract = {
  fastmailConversationStatus: { input: z.object({ url: z.string().max(2048) }).strict(), output: status },
};
type Status = z.infer<typeof status>;

function target(url: string) {
  // Fastmail's web client treats a single conversation-route component as an
  // Email ID. A dotted component also supplies the expected Thread ID.
  const match = /^https:\/\/app\.fastmail\.com\/mail\/([^/?#\\\x00-\x20\x7f]+)\/([A-Za-z0-9_-]{1,256})(?:\.([A-Za-z0-9_-]{1,256}))?\?u=([0-9a-f]{8})$/.exec(url);
  if (!match || match[0] !== url) return null;
  let context: string;
  try { context = decodeURIComponent(match[1]); } catch { return null; }
  if (context === '.' || context === '..' || context === 'compose' || context.startsWith('search:') ||
      /^[uc][0-9a-f]{8}$/.test(context) || /[/\\\x00-\x1f\x7f]/.test(context)) return null;
  const [, rawContext, first, second, userId] = match;
  return { rawContext, userId, emailId: second ?? first, threadId: second ? first : undefined };
}

const anchor = z.object({ id, threadId: id });
const thread = z.object({ id, emailIds: z.array(id).min(1).max(maxMessages) });
const mailbox = z.object({ id, role: z.string().max(64).nullable() });
const message = anchor.extend({
  mailboxIds: z.record(id, z.literal(true)), keywords: z.record(z.string(), z.literal(true)),
  receivedAt: z.iso.datetime(),
  from: z.array(z.object({ name: z.string().nullable().optional(), email: z.string() })).max(64).nullable(),
});
const getResult = <T extends z.ZodType>(item: T, max: number) =>
  z.object({ list: z.array(item).max(max), notFound: z.array(id).max(max) });
const anchorResult = getResult(anchor, 1);
const threadResult = getResult(thread, 1);
const mailboxResult = getResult(mailbox, 2048);
const messageResult = getResult(message, maxMessages).extend({ state: z.string().min(1).max(256) });

const clean = (value?: string | null) => value?.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 320) || null;

export function fastmailCorrespondence(
  fetcher: typeof fetch | undefined,
  diagnose: (stage: string, category: string) => void,
  now = Date.now,
) {
  let retryAt = 0;
  let lastConfiguration: AbortSignal | undefined;
  return async (url: string, token: string | undefined, configuration: AbortSignal, signal: AbortSignal): Promise<Status> => {
    const address = target(url);
    if (!address) return { status: 'unsupported' };
    if (!token) return { status: 'account_missing' };
    if (lastConfiguration !== configuration) { lastConfiguration = configuration; retryAt = 0; }
    const ensureCurrent = () => signal.throwIfAborted();
    const defer = (header: string | null) => {
      if (signal.aborted) return;
      const time = now();
      const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - time : NaN;
      retryAt = Math.max(retryAt, time + (Number.isFinite(delay) ? Math.max(1000, delay) : 60_000));
    };
    const incomplete = (stage: string, category = 'incomplete_metadata'): Status => {
      diagnose(stage, category);
      return { status: 'incomplete' };
    };
    try {
      ensureCurrent();
      if (retryAt > now()) return { status: 'unavailable' };
      const client = await openPrimaryMail(token, { fetch: fetcher, signal, ensureCurrent, onBackoff: defer });
      if (address.userId !== client.userId) {
        diagnose('correspondence_account', 'account_selector_mismatch');
        return { status: 'account_mismatch' };
      }
      // With an explicit account segment Fastmail can select a different mail
      // account within the same login. This reader supports primary mail only.
      if (client.hasAccount(address.rawContext)) return { status: 'unsupported' };
      const emailStage = 'correspondence_anchor';
      const found = anchorResult.safeParse(await client.get('Email/get', {
        ids: [address.emailId], properties: ['id', 'threadId'],
      }, emailStage));
      if (!found.success) return incomplete(emailStage);
      const { list, notFound } = found.data;
      if (!list.length && notFound[0] === address.emailId) return { status: 'not_found' };
      const first = list[0];
      if (notFound.length || first?.id !== address.emailId) return incomplete(emailStage, 'response_mismatch');
      if (address.threadId && first.threadId !== address.threadId) return incomplete(emailStage, 'thread_mismatch');

      const threadStage = 'correspondence_thread';
      const group = threadResult.safeParse(await client.get('Thread/get', { ids: [first.threadId] }, threadStage));
      if (!group.success || group.data.notFound.length || !group.data.list.length) return incomplete(threadStage);
      const { id: threadId, emailIds } = group.data.list[0]!;
      if (threadId !== first.threadId || new Set(emailIds).size !== emailIds.length || !emailIds.includes(first.id))
        return incomplete(threadStage, 'response_mismatch');

      const mailboxStage = 'correspondence_mailboxes';
      const folders = mailboxResult.safeParse(await client.get('Mailbox/get', { properties: ['id', 'role'] }, mailboxStage));
      if (!folders.success || folders.data.notFound.length) return incomplete(mailboxStage);
      const roles = new Map(folders.data.list.map(folder => [folder.id, folder.role]));
      if (roles.size !== folders.data.list.length) return incomplete(mailboxStage, 'response_mismatch');

      let unread = 0;
      let latest: z.infer<typeof message> | undefined;
      let state: string | undefined;
      const messageStage = 'correspondence_messages';
      const batchSize = Math.min(client.maxObjectsInGet, 100);
      for (let start = 0; start < emailIds.length; start += batchSize) {
        if (retryAt > now()) return { status: 'unavailable' };
        const ids = emailIds.slice(start, start + batchSize);
        const result = messageResult.safeParse(await client.get('Email/get', {
          ids, properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt'],
        }, messageStage));
        if (!result.success || result.data.notFound.length || result.data.list.length !== ids.length ||
            (state !== undefined && state !== result.data.state)) return incomplete(messageStage);
        state = result.data.state;
        const expected = new Set(ids);
        for (const item of result.data.list) {
          if (!expected.delete(item.id) || item.threadId !== threadId) return incomplete(messageStage, 'response_mismatch');
          const memberships = Object.keys(item.mailboxIds);
          if (!memberships.length || memberships.some(id => !roles.has(id))) return incomplete(messageStage);
          if (item.keywords.$draft || memberships.every(id => roles.get(id) === 'trash' || roles.get(id) === 'junk')) continue;
          if (!item.keywords.$seen) unread++;
          if (!latest || Date.parse(item.receivedAt) > Date.parse(latest.receivedAt)) latest = item;
        }
      }
      ensureCurrent();
      const sender = latest?.from?.[0];
      const threadKey = createHash('sha256').update(JSON.stringify(['fastmail', client.accountId, threadId])).digest('hex');
      return { status: 'ok', unread, sender: clean(sender?.name) ?? clean(sender?.email), latestAt: latest?.receivedAt ?? null, threadKey };
    } catch (error) {
      const category = error instanceof EmailUrlError ? error.category : signal.aborted ? 'cancelled' : 'unknown';
      const stage = error instanceof EmailUrlError ? error.stage.replace(/^email_url_/, 'correspondence_') : 'correspondence_read';
      diagnose(stage, category);
      if (['token_missing_or_invalid', 'primary_mail_account_missing', 'unsupported_account_format', 'http_status=401', 'http_status=403'].includes(category))
        return { status: 'account_missing' };
      if (category === 'account_selector_mismatch') return { status: 'account_mismatch' };
      if (category === 'response_mismatch') return { status: 'incomplete' };
      return { status: 'unavailable' };
    }
  };
}
