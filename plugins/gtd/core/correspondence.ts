import { z } from 'zod';

export const correspondenceLink = z.object({ title: z.string().min(1).max(1024), url: z.string().min(1).max(2048) }).strict();
export const linkLimit = 40;
export const correspondenceLinks = z.object({ links: z.array(correspondenceLink).max(linkLimit), incomplete: z.boolean() }).strict();
export const returnDate = z.iso.date().refine(date => !date.startsWith('0000-')).describe('Local calendar date in YYYY-MM-DD form. Ask the user if they did not give a date.');
export const snoozedLinks = correspondenceLinks.extend({
  links: z.array(correspondenceLink.extend({ returnDate })).max(linkLimit),
});
export const projectCorrespondence = z.object({ active: correspondenceLinks, archived: correspondenceLinks, snoozed: snoozedLinks }).strict();
export const correspondenceSections = { active: 'Active conversations', archived: 'Archived conversations',
  snoozed: 'Snoozed conversations', legacy: 'Correspondence' } as const;
type Section = z.infer<typeof correspondenceLinks>;
type SnoozedSection = z.infer<typeof snoozedLinks>;
const historicalPacific = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Vancouver',
  year: 'numeric', month: '2-digit', day: '2-digit' });
const permanentPacificFrom = Date.UTC(2026, 2, 8, 10);
export const correspondenceDate = (now: number) => now < permanentPacificFrom
  ? historicalPacific.format(now)
  : new Date(now - 7 * 60 * 60_000).toISOString().slice(0, 10);
export const mailStatus = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), unread: z.number().int().min(0).max(500),
    sender: z.string().max(320).nullable(), latestAt: z.iso.datetime().nullable(),
    threadKey: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  z.object({ status: z.enum(['unsupported', 'account_missing', 'account_mismatch', 'not_found', 'incomplete', 'unavailable']) }).strict(),
]);
export const correspondenceStatus = z.array(z.object({ url: correspondenceLink.shape.url, mail: mailStatus }).strict()).max(linkLimit);
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

const supportsMailLookup = (url: string) => mailProvider(url) !== null;

export function combineCorrespondence(active: Section, archived: Section, legacy: Section, snoozed: SnoozedSection): z.infer<typeof projectCorrespondence> {
  const seen = new Set<string>();
  const takeUnique = <T extends { url: string }>(section: { links: T[] }) => section.links.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  const snoozedLinks = takeUnique(snoozed).sort((left, right) => left.returnDate.localeCompare(right.returnDate));
  const activeLinks = takeUnique(active);
  const archivedLinks = takeUnique(archived);
  activeLinks.push(...takeUnique(legacy));
  return {
    active: { links: activeLinks.slice(0, linkLimit), incomplete: active.incomplete || legacy.incomplete || activeLinks.length > linkLimit },
    archived: { links: archivedLinks, incomplete: archived.incomplete },
    snoozed: { links: snoozedLinks, incomplete: snoozed.incomplete },
  };
}

export function uniqueConversations<T extends { url: string }>(links: T[], mail: ReadonlyMap<string, MailStatus>) {
  const seen = new Set<string>();
  return links.filter(({ url }) => {
    const result = mail.get(url);
    if (mailProvider(url) !== 'fastmail' || result?.status !== 'ok' || !result.threadKey) return true;
    if (seen.has(result.threadKey)) return false;
    seen.add(result.threadKey);
    return true;
  });
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
      rows[index] = { url, mail: supportsMailLookup(url) ? await lookup(url) : { status: 'unsupported' } };
    }
  }));
  return rows;
}

export const areaNoteBudget = 12;
export const areaMailBudget = 16;
export const areaMailStatus = z.array(z.object({
  id: z.string().min(1).max(1024),
  state: z.enum(['unread', 'incomplete', 'clear']),
}).strict()).max(areaNoteBudget);

export async function lookupAreaCorrespondence(
  projectIds: string[],
  read: (id: string) => Promise<z.infer<typeof correspondenceLinks> | undefined>,
  lookup: (url: string) => Promise<MailStatus>,
  signal: AbortSignal,
): Promise<z.infer<typeof areaMailStatus>> {
  const notes = projectIds.slice(0, areaNoteBudget).map(id => ({
    id, section: undefined as z.infer<typeof correspondenceLinks> | undefined,
  }));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, notes.length) }, async () => {
    while (next < notes.length) {
      signal.throwIfAborted();
      const note = notes[next++]!;
      note.section = await read(note.id);
    }
  }));

  const selected = new Map<string, z.infer<typeof correspondenceLink>>();
  for (const { section } of notes) {
    for (const link of section?.links ?? []) {
      if (selected.size >= areaMailBudget) break;
      if (supportsMailLookup(link.url)) selected.set(link.url, link);
    }
  }
  const status = new Map((await lookupCorrespondence([...selected.values()], lookup, signal))
    .map(row => [row.url, row.mail]));
  return notes.map(({ id, section }) => {
    const results = section?.links.map(link => status.get(link.url));
    if (results?.some(mail => mail?.status === 'ok' && mail.unread > 0)) return { id, state: 'unread' };
    if (!section || section.incomplete || results?.some(mail => mail?.status !== 'ok')) return { id, state: 'incomplete' };
    return { id, state: 'clear' };
  });
}
