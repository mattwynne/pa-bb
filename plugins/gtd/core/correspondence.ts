import { z } from 'zod';

export const correspondenceLink = z.object({ title: z.string().min(1).max(1024), url: z.string().min(1).max(2048) }).strict();
export const correspondenceLinks = z.object({ links: z.array(correspondenceLink).max(40), incomplete: z.boolean() }).strict();
export const mailStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), unread: z.number().int().min(0).max(500),
    sender: z.string().max(320).nullable(), latestAt: z.iso.datetime().nullable() }).strict(),
  z.object({ status: z.enum(['unsupported', 'account_missing', 'not_found', 'unavailable']) }).strict(),
]);
export const correspondenceStatus = z.array(z.object({ url: correspondenceLink.shape.url, mail: mailStatus }).strict()).max(40);
export type MailStatus = z.infer<typeof mailStatus>;

export function mailProvider(value: string) {
  if (/[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.origin === 'https://mail.google.com' && url.pathname.startsWith('/mail/')) return 'gmail';
    if (url.origin === 'https://app.fastmail.com' && url.pathname.startsWith('/mail/')) return 'fastmail';
    return null;
  } catch { return null; }
}

export function uniqueCorrespondence(links: z.infer<typeof correspondenceLinks>) {
  const seen = new Set<string>();
  return { ...links, links: links.links.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  }) };
}

export async function lookupCorrespondence(
  links: z.infer<typeof correspondenceLinks>['links'],
  lookup: (url: string) => Promise<MailStatus>,
  signal: AbortSignal,
) {
  const rows: z.infer<typeof correspondenceStatus> = new Array(links.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, links.length) }, async () => {
    while (next < links.length) {
      signal.throwIfAborted();
      const index = next++;
      const { url } = links[index]!;
      rows[index] = { url, mail: mailProvider(url) === 'gmail' ? await lookup(url) : { status: 'unsupported' } };
    }
  }));
  return rows;
}
