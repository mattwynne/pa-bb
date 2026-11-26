import { z } from 'zod';
import { inspectPage, mailtoRequest, renderMessage, verifyOneClick } from './message.ts';
import { httpsTarget, WebFailure, type WebRequest, type WebResponse } from './web.ts';

export const targetSchema = z.object({
  provider: z.enum(['gmail', 'fastmail']),
  account: z.string().min(1).max(320).regex(/^[^\s\x00-\x1f\x7f]+$/),
  emailId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
}).strict().refine(target => target.provider === 'fastmail' || z.email().safeParse(target.account).success,
  { path: ['account'], message: 'Use the connected Gmail account email address.' });
export type Target = z.infer<typeof targetSchema>;

export const messageSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), mailbox: z.email().max(320), mime: z.base64().max(3 * 1024 * 1024) }),
  z.object({ status: z.enum(['account_missing', 'missing', 'ineligible', 'too_large']) }),
]);
export const mailResultSchema = z.object({ status: z.enum(['request_sent', 'needs_user', 'unverified']), draftMayRemain: z.boolean().optional() });
export type Method = 'one_click' | 'web_link' | 'web_form' | 'browser' | 'mailto';
export type Status = 'confirmed' | 'request_sent' | 'needs_user' | 'unavailable' | 'unverified' | 'in_progress';
export type Result = { status: Status; method?: Method; reason: string; draftMayRemain?: boolean; childThreadId?: string };
type Sender = (mail: NonNullable<ReturnType<typeof mailtoRequest>>, signal: AbortSignal) => Promise<z.infer<typeof mailResultSchema>>;
export type Browser = (url: URL, recipient: string, signal: AbortSignal) => Promise<Result>;
type Ports = {
  web: WebRequest;
  browser: Browser;
  send?: Sender;
  verify?: typeof verifyOneClick;
  failure(stage: string, category: string): void;
};

export async function unsubscribeMessage(message: NonNullable<Awaited<ReturnType<typeof renderMessage>>>,
  ports: Ports, signal: AbortSignal): Promise<Result> {
  async function sendMail(): Promise<Result> {
    if (!message.mail) return { status: 'unavailable', reason: 'no_unsubscribe_method' };
    const method = 'mailto';
    if (!message.recipient) return { status: 'needs_user', method, reason: 'recipient_not_verified' };
    const mail = mailtoRequest(message.mail, message.recipient);
    if (!mail || !ports.send) return { status: 'needs_user', method, reason: mail ? 'send_unavailable' : 'unsupported_mailto' };
    try {
      const { status, draftMayRemain } = await ports.send(mail, signal);
      return { status, method, reason: status === 'request_sent' ? 'email_sent' : status === 'needs_user' ? 'send_unavailable' : 'send_unverified', ...(draftMayRemain ? { draftMayRemain } : {}) };
    } catch {
      ports.failure(method, 'send_unverified');
      return { status: 'unverified', method, reason: 'send_unverified' };
    }
  }

  if (message.ambiguous) return { status: 'needs_user', reason: 'ambiguous_unsubscribe_links' };
  const url = message.web && httpsTarget(message.web);
  if (!url) return sendMail();

  let method: Method = 'one_click';
  try {
    if (message.oneClick) {
      const verified = await (ports.verify ?? verifyOneClick)(message.raw, signal);
      if (!verified) return { status: 'needs_user', method, reason: 'one_click_signature_unverified' };
      const response = await ports.web(url, signal, new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }));
      if (ok(response)) {
        return inspectPage(response.html, url).kind === 'confirmed'
          ? { status: 'confirmed', method, reason: 'sender_confirmed' }
          : { status: 'request_sent', method, reason: 'one_click_accepted' };
      }
      if (![404, 405, 410, 415].includes(response.status))
        return { status: 'unverified', method, reason: 'unexpected_post_response' };
    }

    method = 'web_link';
    const page = await ports.web(url, signal);
    if ([404, 410].includes(page.status)) {
      if (message.mail) return sendMail();
      return { status: 'unavailable', method, reason: 'unsubscribe_page_missing' };
    }
    const inspected = ok(page) ? inspectPage(page.html, url, message.recipient) : { kind: 'browser' as const };
    if (inspected.kind === 'confirmed') return { status: 'confirmed', method, reason: 'sender_confirmed' };
    if (inspected.kind === 'blocked') return { status: 'needs_user', method, reason: 'login_or_challenge' };
    if (inspected.kind === 'form') {
      method = 'web_form';
      const submitted = await ports.web(inspected.target, signal, inspected.fields);
      if (ok(submitted) && inspectPage(submitted.html, inspected.target).kind === 'confirmed')
        return { status: 'confirmed', method, reason: 'sender_confirmed' };
      if (submitted.status === 303 && submitted.location) {
        const receipt = httpsTarget(submitted.location, inspected.target);
        if (receipt?.origin === inspected.target.origin && receipt.href !== inspected.target.href) {
          const confirmation = await ports.web(receipt, signal);
          if (ok(confirmation) && inspectPage(confirmation.html, receipt).kind === 'confirmed')
            return { status: 'confirmed', method, reason: 'sender_confirmed' };
        }
      }
      return { status: 'unverified', method, reason: 'form_confirmation_missing' };
    }
    if (!message.recipient) return { status: 'needs_user', method, reason: 'recipient_not_verified' };
    method = 'browser';
    return await ports.browser(url, message.recipient, signal);
  } catch (error) {
    const reason = error instanceof WebFailure ? error.reason : signal.aborted ? 'cancelled' : 'request_unverified';
    ports.failure(method, reason);
    return { status: error instanceof WebFailure && !error.sent && method !== 'web_form' ? 'needs_user' : 'unverified', method, reason };
  }
}

function ok(response: WebResponse) {
  return response.status >= 200 && response.status < 300;
}
