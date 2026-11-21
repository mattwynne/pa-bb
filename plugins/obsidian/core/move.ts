import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_NOTE_BYTES, VaultError, type NoteParser } from './ports.ts';
export const moveRecordSchema = z.object({ operationId: z.string().uuid(), finished: z.boolean().optional(), vaultId: z.string(), path: z.string().max(1024), destination: z.string().max(1024), repairs: z.array(z.object({ path: z.string().max(1024), expectedHash: z.string(), hash: z.string(), operationId: z.string().uuid(), outcome: z.enum(['unstarted', 'submitted', 'saved', 'not_saved', 'uncertain']) }).strict()).max(64) }).strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export function planMove(notes: Array<{ path: string; text: string; hash: string }>, from: string, to: string, parser: NoteParser) {
  const paths = notes.map(n => n.path);
  if (!paths.includes(from) || paths.includes(to)) throw new VaultError('conflict');
  const resolve = (name: string, source: string, wiki: boolean) => {
    if (!name) return [source];
    if (wiki && !name.includes('/')) return paths.filter(p => posix.basename(p, '.md').toLowerCase() === name.replace(/\.md$/, '').toLowerCase());
    const path = posix.normalize(name.startsWith('/') ? name.slice(1) : wiki && !name.startsWith('.') ? name : posix.join(posix.dirname(source), name));
    return paths.filter(p => p === path || p === path + '.md');
  };
  let repairs = 0;
  return notes.flatMap(note => {
    const metadata = parser.parse(note.text, 'move');
    // The parser exposes YAML link locations as whole-property spans and does
    // not expose Markdown reference destinations. Fail closed, never regex-edit
    // code, HTML or a YAML scalar as though it were a supported inline link.
    const htmlStart = note.text.search(/<\/?[A-Za-z]/);
    if (metadata.warnings.length || /^ {0,3}\[[^\]\n]+\]:/m.test(note.text) || (htmlStart !== -1 && note.text.includes('>', htmlStart + 1))) throw new VaultError('unsupported_links');
    const pieces: string[] = [];
    let offset = 0;
    let bytes = Buffer.byteLength(note.text);
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
      const candidates = resolve(name, note.path, wiki);
      if (candidates.length !== 1) throw new VaultError('ambiguous_link');
      const resolved = candidates[0], movedSource = note.path === from ? to : note.path;
      // A newly introduced basename must not silently steal unrelated links.
      if (wiki && !name.includes('/') && name && resolved !== from && posix.basename(to, '.md').toLowerCase() === name.replace(/\.md$/, '').toLowerCase()) throw new VaultError('ambiguous_link');
      if (!name || (resolved !== from && movedSource === note.path)) continue;
      const destination = resolved === from ? to : resolved;
      const next = wiki ? destination.replace(/\.md$/, '') : encodeURI(posix.relative(posix.dirname(movedSource), destination)).replace(/#/g, '%23');
      const replacement = wiki ? match[1] + next + (match[3] || '') : match[1] + next + fragment + (match[3] || '') + ')';
      if (replacement === raw) continue;
      if (link.start < offset) throw new VaultError('unsupported_links');
      bytes += Buffer.byteLength(replacement) - Buffer.byteLength(raw);
      pieces.push(note.text.slice(offset, link.start), replacement);
      offset = link.end;
    }
    if (!pieces.length) return [];
    if (bytes > MAX_NOTE_BYTES) throw new VaultError('capacity', 'A planned link repair would exceed the note store’s 1 MiB write limit.');
    if (++repairs > 64) throw new VaultError('capacity', 'The move would require more than 64 link repairs.');
    const text = pieces.join('') + note.text.slice(offset);
    return [{ path: note.path === from ? to : note.path, text, expectedHash: note.hash, hash: hashText(text) }];
  });
}
