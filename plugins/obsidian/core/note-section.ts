import { VaultError, type Metadata, type NoteParser } from './ports.ts';
import { sectionLinkEntries } from './section-links.ts';

const withoutBlankEdges = (text: string) => text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');
const lineStart = (text: string, offset: number) => offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;

function sectionRange(note: string, heading: string, { headings, warnings }: Metadata, depth?: number) {
  if (warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported');
  const normalized = heading.toLocaleLowerCase('und');
  const matches = headings.filter(item => (depth === undefined || item.depth === depth) && item.title.toLocaleLowerCase('und') === normalized);
  if (matches.length > 1) throw new VaultError('ambiguous_link', 'Keep one matching heading in the Obsidian note.');
  const match = matches[0];
  if (!match) return null;
  const newline = note.indexOf('\n', match.end);
  const start = newline < 0 ? note.length : newline + 1;
  const next = headings.find(item => item.start > match.start && item.depth <= match.depth);
  const end = next ? lineStart(note, next.start) : note.length;
  return { start, end };
}

export function noteSection(parser: NoteParser, note: string, heading: string) {
  const range = sectionRange(note, heading, parser.parse(note, 'section'));
  return { text: range ? withoutBlankEdges(note.slice(range.start, range.end)) : '', range };
}

export function firstSectionTask(parser: NoteParser, note: string, heading: string) {
  const parsed = parser.parse(note, 'section');
  const range = sectionRange(note, heading, parsed, 2);
  if (!range) return null;
  const task = parsed.tasks.find(task => !task.complete && !!task.text.trim() && task.start >= range.start && task.end <= range.end &&
    /^(?:[-+*]|\d{1,9}[.)])[ \t]+$/.test(note.slice(lineStart(note, task.start), task.start)));
  return task?.text.trim() ?? null;
}

export function replaceNoteSection(parser: NoteParser, note: string, heading: string, draft: string) {
  const section = noteSection(parser, note, heading);
  const newline = note.match(/\r?\n/)?.[0] ?? '\n';
  const text = withoutBlankEdges(draft.replace(/\r\n?/g, '\n')).replace(/\n/g, newline);
  if (section.text === text) return note;
  const leadingBreak = note && !note.endsWith('\n') ? newline : '';
  let next: string;
  if (section.range) {
    const { start, end } = section.range;
    const separator = start === note.length ? leadingBreak : '';
    next = note.slice(0, start) + separator + newline + (text ? text + newline + newline : '') + note.slice(end);
  } else {
    next = note + leadingBreak + (note ? newline : '') + '## ' + heading + newline + newline + text + newline;
  }
  // Reject drafts that escape the section or absorb the following section.
  if (noteSection(parser, next, heading).text !== text)
    throw new VaultError('invalid_section', 'Use lower-level headings for content inside the section and close any code blocks.');
  return next;
}

function appendLinkBullet(parser: NoteParser, note: string, heading: string, text: string, bullet: string, url: string) {
  const newline = note.match(/\r?\n/)?.[0] ?? '\n';
  const added = [text, bullet].filter(Boolean).join(newline);
  const parsed = sectionLinkEntries(added);
  if (added.length > 16000 || parsed.incomplete || parsed.links.at(-1)?.url !== url)
    throw new VaultError('invalid_section', 'Check the format and size of the correspondence section in Obsidian.');
  return replaceNoteSection(parser, note, heading, added);
}

export function addNoteSectionLink(parser: NoteParser, note: string, input: { heading: string; title: string; url: string }) {
  const { text } = noteSection(parser, note, input.heading);
  const { links, incomplete } = sectionLinkEntries(text);
  if (incomplete || links.some(link => link.url === input.url))
    throw new VaultError('invalid_section', 'Check the existing links in Obsidian.');
  return appendLinkBullet(parser, note, input.heading, text, linkBullet(input), input.url);
}

function linkBullet({ title, url, returnDate }: { title: string; url: string; returnDate?: string }) {
  const label = title.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&');
  return '- [' + label + '](<' + url.replaceAll('&', '\\&') + '>' + (returnDate ? ' "' + returnDate + '"' : '') + ')';
}

export type DatedLinkEdit = { from: string[]; to: string; urls: string[]; fromDated: boolean; returnDate?: string };

export function editDatedNoteSectionLinks(parser: NoteParser, note: string, input: DatedLinkEdit) {
  const newline = note.match(/\r?\n/)?.[0] ?? '\n';
  const wanted = new Set(input.urls);
  const found = new Map<string, { title: string; url: string }>();
  const read = (heading: string, dated: boolean) => {
    const { text } = noteSection(parser, note, heading);
    const { links, incomplete } = sectionLinkEntries(text, dated);
    if (text.length > 16000 || incomplete) throw new VaultError('invalid_section');
    return { text, links };
  };
  let next = note;
  let destination = read(input.to, !!input.returnDate);
  for (const heading of input.from) {
    const { text, links } = read(heading, input.fromDated);
    const matches = links.filter(link => wanted.has(link.url));
    if (!matches.length) continue;
    for (const link of matches) if (!found.has(link.url)) found.set(link.url, link);
    let remaining = text;
    for (const { start, end } of matches.reverse()) remaining = remaining.slice(0, start) + remaining.slice(end);
    if (heading === input.to) destination = { text: withoutBlankEdges(remaining), links: links.filter(link => !wanted.has(link.url)) };
    else next = replaceNoteSection(parser, next, heading, remaining);
  }
  if (found.size !== wanted.size) throw new VaultError('invalid_section');
  const destinationUrls = new Set(destination.links.map(link => link.url));
  const added = [...found.values()].filter(link => !destinationUrls.has(link.url));
  const text = [destination.text, ...added.map(link => linkBullet({ ...link, returnDate: input.returnDate }))].filter(Boolean).join(newline);
  const parsed = sectionLinkEntries(text, !!input.returnDate);
  if (text.length > 16000 || parsed.incomplete ||
      input.urls.some(url => !parsed.links.some(link => link.url === url && link.returnDate === input.returnDate)))
    throw new VaultError('invalid_section');
  return replaceNoteSection(parser, next, input.to, text);
}

export function moveNoteSectionLink(parser: NoteParser, note: string, input: { from: string[]; to: string; url: string }) {
  const parsed = parser.parse(note, 'section');
  const read = (heading: string) => {
    const range = sectionRange(note, heading, parsed);
    const text = range ? withoutBlankEdges(note.slice(range.start, range.end)) : '';
    const { links, incomplete } = sectionLinkEntries(text);
    if (text.length > 16000 || incomplete)
      throw new VaultError('invalid_section', 'Check the correspondence sections in Obsidian before moving a link.');
    return { text, links };
  };
  const destination = read(input.to);
  let next = note;
  let moved: string | undefined;
  for (const heading of input.from) {
    const { text, links } = read(heading);
    const matches = links.filter(link => link.url === input.url);
    if (!matches.length) continue;
    moved ??= withoutBlankEdges(text.slice(matches[0]!.start, matches[0]!.end));
    let remaining = text;
    for (const { start, end } of matches.reverse()) remaining = remaining.slice(0, start) + remaining.slice(end);
    next = replaceNoteSection(parser, next, heading, remaining);
  }
  if (!moved) throw new VaultError('invalid_section', 'The link is no longer in the source sections.');
  if (destination.links.some(link => link.url === input.url)) return next;
  return appendLinkBullet(parser, next, input.to, destination.text, moved, input.url);
}
