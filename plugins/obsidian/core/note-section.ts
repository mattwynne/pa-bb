import { VaultError, type NoteParser } from './ports.ts';

const withoutBlankEdges = (text: string) => text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');
const lineStart = (text: string, offset: number) => offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;

export function noteSection(parser: NoteParser, note: string, heading: string) {
  const { headings, warnings } = parser.parse(note, 'section');
  if (warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported');
  const matches = headings.filter(item => item.title.toLocaleLowerCase('und') === heading.toLocaleLowerCase('und'));
  if (matches.length > 1) throw new VaultError('ambiguous_link', 'Keep one matching heading in the Obsidian note.');
  const match = matches[0];
  if (!match) return { text: '', range: null };
  const newline = note.indexOf('\n', match.end);
  const start = newline < 0 ? note.length : newline + 1;
  const next = headings.find(item => item.start > match.start && item.depth <= match.depth);
  const end = next ? lineStart(note, next.start) : note.length;
  return { text: withoutBlankEdges(note.slice(start, end)), range: { start, end } };
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
