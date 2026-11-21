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
    const metadata = parser.parse(note.text, 'move');
    // The parser exposes YAML link locations as whole-property spans and does
    // not expose Markdown reference destinations. Fail closed, never regex-edit
    // code, HTML or a YAML scalar as though it were a supported inline link.
    const htmlStart = note.text.search(/<\/?[A-Za-z]/);
    if (metadata.warnings.length || /^ {0,3}\[[^\]\n]+\]:/m.test(note.text) || (htmlStart !== -1 && note.text.includes('>', htmlStart + 1))) throw new VaultError('unsupported_links');
    const pieces: string[] = [];
    let offset = 0;
    for (const link of [...metadata.links].sort((a, b) => a.start - b.start)) {
      const raw = note.text.slice(link.start, link.end);
      const wiki = /^!?\[\[/.test(raw);
      const match = wiki ? raw.match(/^(!?\[\[)([^|\]#]*)([^\]]*\]\])$/) : raw.match(/^(!?\[[^\]\n]*\]\()([^\s()]+)(\s+"[^"\n]*")?\)$/);
      if (!match) throw new VaultError('unsupported_links');
      let target: string; try { target = decodeURIComponent(match[2]); } catch { throw new VaultError('unsupported_links'); }
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) continue;
      if (/%(?!20)/i.test(match[2])) throw new VaultError('unsupported_links');
      if (target.includes('\\') || target.includes('?')) throw new VaultError('unsupported_links');
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
      if (link.start < offset) throw new VaultError('unsupported_links');
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
