import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_NOTE_BYTES, VaultError, type NoteParser } from './ports.ts';
export const moveRecordSchema = z.object({ operationId: z.string().uuid(), finished: z.boolean().optional(), vaultId: z.string(), path: z.string().max(1024), destination: z.string().max(1024), repairs: z.array(z.object({ path: z.string().max(1024), expectedHash: z.string(), hash: z.string(), operationId: z.string().uuid(), outcome: z.enum(['unstarted', 'submitted', 'saved', 'not_saved', 'uncertain']) }).strict()).max(64) }).strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export const MOVE_SCAN_LIMITS = { notes: 10000, bytes: 128 * 1024 * 1024, milliseconds: 20000, batch: 8 } as const;
const REPAIR_BYTES = 8 * 1024 * 1024;
const basenameKey = (path: string) => posix.basename(path).toLowerCase().replace(/\.md$/, '');
const below = (path: string, folder: string) => path.startsWith(folder + '/');
const unsupportedReasons = {
  path_characters: 'The path contains characters the move planner cannot handle safely.',
  frontmatter: 'The YAML frontmatter could not be checked for links.',
  parser_warning: 'The Markdown parser reported a warning while checking this note.',
  reference_definition: 'The planner cannot check Markdown reference definitions.',
  html_link_attribute: 'The planner found an HTML link or embed attribute it cannot check safely.',
  unclosed_html: 'The Markdown parser found an HTML element without a closing tag.',
  link_syntax: 'The planner cannot check this link syntax.',
  frontmatter_link: 'A YAML wikilink could be affected by the move and cannot be rewritten safely.',
  target_encoding: 'The link target uses unsupported percent encoding.',
  target_characters: 'The link target contains characters the planner cannot handle safely.',
  overlapping_links: 'The planner found overlapping link spans.',
} as const;
export class UnsupportedMoveLink extends VaultError {
  additionalLocations?: UnsupportedMoveLink['location'][];
  constructor(readonly location: { reason: keyof typeof unsupportedReasons; path: string; line?: number; column?: number }) {
    super('unsupported_links', `Move stopped before writing. ${unsupportedReasons[location.reason]} Inspect the location in Obsidian.`);
  }
}
export function createMovePlanner(paths: ReadonlySet<string>, from: string, to: string, parser: NoteParser) {
  if (!paths.has(from) || paths.has(to)) throw new VaultError('conflict');
  const oldFolder = posix.dirname(from), newFolder = posix.dirname(to);
  const siblings = posix.dirname(oldFolder) === posix.dirname(newFolder);
  const endpoints = [from, to].map(path => path.toLowerCase());
  const endpointNames = [from, to].map(basenameKey);
  const basenames = new Map<string, string[]>();
  for (const path of paths) {
    const key = basenameKey(path);
    const matches = basenames.get(key);
    if (matches) matches.push(path);
    else basenames.set(key, [path]);
  }
  const pathForms = (name: string, folder: string, wiki: boolean) => {
    const path = posix.normalize(name.startsWith('/') ? name.slice(1) : wiki && !name.startsWith('.') ? name : posix.join(folder, name));
    return [path, path + '.md'];
  };
  // A short wikilink may name a path suffix inside a workspace. Use suffix
  // matches to rule out changes or detect uncertainty, never to pick a target.
  const suffixForms = (name: string) => pathForms(name, '', true).map(path => path.toLowerCase().replace(/^(?:\.\.\/)+/, ''));
  const matchesSuffix = (forms: string[], path: string) => forms.some(form => path === form || path.endsWith('/' + form));
  const suffixCandidates = (forms: string[]) =>
    [...new Set(forms.flatMap(form => basenames.get(basenameKey(form)) ?? []))].filter(path => matchesSuffix(forms, path.toLowerCase()));
  const existsAfter = (path: string) => path === to || (path !== from && paths.has(path));
  const ambiguous = (reason: string) => new VaultError('ambiguous_link', `Move stopped before writing. ${reason}`);
  const repairs: Array<{ path: string; text: string; expectedHash: string; hash: string }> = [];
  let repairBytes = 0;
  const visit = (note: { path: string; text: string; hash: string }, bytes: number) => {
    // All supported links and the syntax the planner refuses start with '['
    // or '<', or can be decoded from YAML frontmatter. Inspect the exact
    // bytes of every note before taking this fast path.
    if (!note.text.includes('[') && !note.text.includes('<') && !/^(?:\uFEFF)?---\r?\n/.test(note.text)) return;
    const unsupported = (reason: keyof typeof unsupportedReasons, offset?: number): never => {
      if (offset === undefined) throw new UnsupportedMoveLink({ reason, path: note.path });
      const prefix = note.text.slice(0, offset);
      throw new UnsupportedMoveLink({
        reason, path: note.path, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n'),
      });
    };
    const metadata = parser.parse(note.text, 'move');
    // The parser exposes YAML link locations as whole-property spans and does
    // not expose Markdown reference destinations. Fail closed, never regex-edit
    // code, HTML or a YAML scalar as though it were a supported inline link.
    if (metadata.warnings.includes('properties_unsupported')) unsupported('frontmatter', 0);
    if (metadata.warnings.includes('unclosed_html')) unsupported('unclosed_html', metadata.unclosedHtmlOffset);
    if (metadata.warnings.length) unsupported('parser_warning');
    const reference = /^ {0,3}\[[^\]\n]+\]:/m.exec(note.text);
    if (reference) unsupported('reference_definition', reference.index + reference[0].indexOf('['));
    if (metadata.htmlLinkOffset !== undefined) unsupported('html_link_attribute', metadata.htmlLinkOffset);
    const pieces: string[] = [];
    let offset = 0;
    for (const link of [...metadata.links].sort((a, b) => a.start - b.start)) {
      const raw = note.text.slice(link.start, link.end);
      // Use the Markdown parser's destination for external links. The inline
      // rewrite grammar need not understand their labels or parentheses.
      if (link.syntax === 'markdown' && /^(?:https?:\/\/|mailto:|file:\/\/\/[^?#]*\.pdf$)/i.test(link.target)) continue;
      const frontmatter = link.syntax === 'frontmatter';
      const wiki = frontmatter || /^!?\[\[/.test(raw);
      const match = frontmatter ? null : wiki ? raw.match(/^(!?\[\[)([^|\]#]*)([^\]]*\]\])$/) : raw.match(/^(!?\[[^\]\n]*\]\()([^\s()]+)(\s+"[^"\n]*")?\)$/);
      const spellingBefore = frontmatter ? link.target : match?.[2];
      if (spellingBefore === undefined) return unsupported('link_syntax', link.start);
      let target: string; try { target = decodeURIComponent(spellingBefore); } catch { return unsupported('target_encoding', link.start); }
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) continue;
      if (/%(?!20)/i.test(spellingBefore)) unsupported('target_encoding', link.start);
      if (target.includes('\\') || target.includes('?')) unsupported('target_characters', link.start);
      const split = target.indexOf('#'), name = split < 0 ? target : target.slice(0,split), fragment = split < 0 ? '' : target.slice(split);
      if (!name) continue; // Local heading or block references follow their note.
      const moved = note.path === from;
      const movedSource = moved ? to : note.path;
      const basename = wiki && !name.includes('/');
      const shortPath = wiki && !basename && !name.startsWith('/') && !name.startsWith('.');
      const before = basename ? [] : pathForms(name, posix.dirname(note.path), wiki);
      const after = moved && !basename ? pathForms(name, newFolder, wiki) : before;
      const suffixes = shortPath ? suffixForms(name) : [];
      const touchesEndpoint = basename
        ? endpointNames.includes(basenameKey(name))
        : [...before, ...after].some(path => endpoints.includes(path.toLowerCase())) || endpoints.some(path => matchesSuffix(suffixes, path));
      if (!touchesEndpoint) {
        if (!moved || oldFolder === newFolder) continue;
        if (basename) {
          if ((basenames.get(basenameKey(name))?.length ?? 0) <= 1) continue;
          throw ambiguous('An outgoing basename link in the moved note could change targets.');
        }
        if (shortPath) {
          const possible = suffixCandidates(suffixes);
          // Only the two sibling directories change context. A unique match
          // outside them stays in the same ancestor scopes and remains the
          // same candidate. Preserve the original spelling.
          if (possible.length === 1 && !below(possible[0].toLowerCase(), oldFolder.toLowerCase())
            && !below(possible[0].toLowerCase(), newFolder.toLowerCase())
            && (siblings || before.includes(possible[0]))) continue;
          throw ambiguous('An outgoing short-path link could change meaning in the destination folder.');
        }
        if (before[0] === after[0]) continue;
      }
      if (!match) return unsupported('frontmatter_link', link.start);
      const candidates = basename
        ? basenames.get(basenameKey(name)) ?? []
        : before.filter(path => paths.has(path));
      if (candidates.length !== 1 || (shortPath && suffixCandidates(suffixes).length !== 1)) {
        throw ambiguous('A link that could change with this move did not have a uniquely established target.');
      }
      const resolved = candidates[0];
      if (touchesEndpoint && resolved !== from && (basename || shortPath || !moved)) {
        throw ambiguous('A link could acquire a different target at the destination.');
      }
      const destination = resolved === from ? to : resolved;
      const next = wiki ? destination.replace(/\.md$/, '') : encodeURI(posix.relative(posix.dirname(movedSource), destination)).replace(/#/g, '%23');
      const spelling = wiki ? next : decodeURIComponent(next);
      const possibleAfter = wiki && !spelling.includes('/')
        ? (basenames.get(basenameKey(spelling)) ?? []).filter(existsAfter).concat(basenameKey(spelling) === basenameKey(to) ? [to] : [])
        : pathForms(spelling, posix.dirname(movedSource), wiki).filter(existsAfter);
      if (possibleAfter.length !== 1 || possibleAfter[0] !== destination) {
        throw ambiguous('A rewritten link would not uniquely identify its intended target.');
      }
      if (wiki && spelling.includes('/')) {
        const forms = suffixForms(spelling);
        if (suffixCandidates(forms).some(path => existsAfter(path) && path !== destination)
          || (to !== destination && matchesSuffix(forms, to.toLowerCase()))) {
          throw ambiguous('A rewritten wikilink would have a competing path match.');
        }
      }
      const replacement = wiki ? match[1] + next + (match[3] || '') : match[1] + next + fragment + (match[3] || '') + ')';
      if (replacement === raw) continue;
      if (link.start < offset) unsupported('overlapping_links', link.start);
      bytes += Buffer.byteLength(replacement) - Buffer.byteLength(raw);
      pieces.push(note.text.slice(offset, link.start), replacement);
      offset = link.end;
    }
    if (!pieces.length) return;
    if (bytes > MAX_NOTE_BYTES) throw new VaultError('capacity', 'A planned link repair would exceed the note store’s 1 MiB write limit.');
    if (repairs.length >= 64) throw new VaultError('capacity', 'The move would require more than 64 link repairs.');
    repairBytes += bytes;
    if (repairBytes > REPAIR_BYTES) throw new VaultError('capacity', 'The planned link repairs exceed the 8 MiB total repair limit.');
    const text = pieces.join('') + note.text.slice(offset);
    repairs.push({ path: note.path === from ? to : note.path, text, expectedHash: note.hash, hash: hashText(text) });
  };
  return { visit, repairs };
}
