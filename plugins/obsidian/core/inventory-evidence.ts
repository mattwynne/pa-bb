import { posix } from 'node:path';
import type { IndexView } from './vault-index.ts';
import { createLinkCandidates, isShortWikiPath, linkPathForms, suffixForms } from './link-candidates.ts';
import { VaultError } from './ports.ts';

export const within = (path: string, root: string) => !root || path.startsWith(root + '/');
export const hides = (o: IndexView['omissions'][number], path: string) => o.path === path || (o.kind === 'tree' && (!o.path || within(path, o.path)));
export function indexedChildren(view: IndexView, folder: string) {
  const entries: Array<{ name: string; kind: 'directory' | 'markdown' }> = [];
  let incomplete = !view.directories.includes(folder) || view.omissions.some(o => hides(o, folder) || posix.dirname(o.path) === folder);
  let bytes = 0;
  const add = (path: string, kind: 'directory' | 'markdown') => {
    if (posix.dirname(path) !== folder) return;
    const name = posix.basename(path); bytes += Buffer.byteLength(name) + 40;
    if (entries.length >= 5000 || bytes > 512 * 1024) incomplete = true;
    else entries.push({ name, kind });
  };
  for (const path of view.directories) add(path, 'directory');
  for (const note of view.notes) add(note.path, 'markdown');
  return { entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'en')), incomplete };
}
export function projectFields(values: Readonly<Record<string, unknown>>, fields: string[]) {
  const properties: Record<string, unknown> = Object.create(null), unsupported: string[] = [];
  for (const key of fields) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    const scalar = (v: unknown) => v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 4096);
    if (scalar(value) || (Array.isArray(value) && value.length <= 8 && value.every(scalar))) properties[key] = value;
    else unsupported.push(key);
  }
  return { properties, unsupported };
}
export const basenameKey = (name: string) => name.replace(/\.md$/, '').toLocaleLowerCase('und');
export function decodeReference(link: string) {
  const embed = link.startsWith('![[');
  const reference = decodeURIComponent(link.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0]);
  const separator = reference.indexOf('#');
  return { embed, reference, fragment: separator >= 0, target: reference.split('#')[0], subpath: separator < 0 ? '' : reference.slice(separator + 1) };
}
export function targetQuery(link: string, source: string, root: string): { fragment: boolean; embed: boolean; path?: string; basename?: string } {
  let parsed;
  try { parsed = decodeReference(link.trim()); } catch { return { fragment: false, embed: false }; }
  const { fragment, embed, reference } = parsed, flags = { fragment, embed };
  if (/[\\\x00-\x1f\x7f]/.test(reference) || /^[A-Za-z][\w+.-]*:/.test(reference) || reference.startsWith('//')) return flags;
  const target = parsed.target.replace(/^\//, '').replace(/\/$/, '');
  if (!target) return flags;
  if (!target.includes('/') && target !== '.' && target !== '..') return { ...flags, basename: basenameKey(target) };
  const relative = target.startsWith('./') || target.startsWith('../');
  const path = posix.normalize(relative ? posix.join(posix.dirname(source), target) : root && !within(target, root) ? root + '/' + target : target);
  if (!within(path, root) || path.split('/').some(p => !p || p === '.' || p === '..') || path.length > 1024) return flags;
  return { ...flags, path };
}
function matchingNotes(notes: Iterable<string>, root: string, path: string | undefined, basename: string | undefined, limit = Infinity) {
  const matches: string[] = [];
  const exact = path?.endsWith('.md') ? path : path + '.md';
  for (const note of notes) {
    if (within(note, root) && (path ? note === exact : basenameKey(posix.basename(note)) === basename)) matches.push(note);
    if (matches.length === limit) break;
  }
  return matches;
}
export function genericNoteCandidates(target: string, source: string, paths: Iterable<string>) {
  if (!target) return { matches: [source], possible: [] };
  const index = createLinkCandidates(new Set(paths));
  if (!target.includes('/')) return { matches: index.byName(target), possible: [] };
  const forms = linkPathForms(target, posix.dirname(source), true);
  const path = forms.find(path => path.endsWith('.md'))!;
  if (path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new VaultError('invalid_path');
  const matches = index.byPath(forms);
  const possible = isShortWikiPath(target) ? index.bySuffix(suffixForms(target)).filter(path => !matches.includes(path)) : [];
  return { matches, possible };
}
export function targetEvidence(query: ReturnType<typeof targetQuery>, root: string, notes: Iterable<string>, directory: boolean, incomplete: boolean) {
  const matches: Array<{ path: string; kind: 'markdown' | 'directory' }> = [];
  if (query.basename || query.path) {
    for (const path of matchingNotes(notes, root, query.path, query.basename, 2)) matches.push({ path, kind: 'markdown' });
    if (directory && query.path) matches.push({ path: query.path, kind: 'directory' });
  }
  const status = !query.path && !query.basename ? 'unsupported' : incomplete ? 'incomplete' : query.basename && matches.length > 1 ? 'ambiguous' : matches.length ? 'matched' : 'missing';
  return { status, matches, basename: query.basename ?? null, fragment: query.fragment, embed: query.embed, incomplete } as const;
}
