import { posix } from 'node:path';
import type { NoteParser } from './ports.ts';

export function areaEvidence(text: string, parser: NoteParser): string[] | null {
  const metadata = parser.parse(text);
  if (metadata.warnings.length) return null;
  const values: string[] = [];
  for (const key of ['areaId', 'area']) {
    if (!Object.hasOwn(metadata.properties, key)) continue;
    const property = metadata.properties[key];
    if (property === null || property === undefined || (typeof property === 'string' && !property.trim())) continue;
    const items = Array.isArray(property) ? property : [property];
    if (!items.length) continue;
    if (items.length > 8 || items.some(v => typeof v !== 'string' || !v.trim() || v.length > 1024)) return null;
    values.push(...items as string[]);
  }
  if (values.length) return values;
  const headings = metadata.headings.filter(h => h.title.trim().toLowerCase() === 'area');
  if (!headings.length) return [];
  if (headings.length !== 1) return null;
  const heading = headings[0];
  const end = metadata.headings.find(h => h.start > heading.start && h.depth <= heading.depth)?.start ?? text.length;
  const lines = text.slice(heading.end, end).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > 8) return null;
  for (const line of lines) {
    const match = /^(?:[-*+]\s+)?\[\[([^\]\n]+)\]\]\s*$/.exec(line);
    if (!match) return null;
    values.push('[[' + match[1] + ']]');
  }
  return values;
}

/** Metadata-only counterpart of Obsidian's existing local link matching.
 * Display aliases are stripped; basename links require a unique candidate.
 */
export function areaLinkPath(link: string, source: string, root: string): string | undefined {
  let target = link.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0];
  try { target = decodeURIComponent(target); } catch { return; }
  if (!target || target.includes('#') || /[\\\x00-\x1f\x7f]/.test(target) || /^[A-Za-z][\w+.-]*:/.test(target) || target.startsWith('//')) return;
  target = target.replace(/^\//, '').replace(/\/$/, '');
  if (!target.includes('/')) return;
  const relative = target.startsWith('./') || target.startsWith('../');
  const path = posix.normalize(relative ? posix.join(posix.dirname(source), target) : root && !target.startsWith(root + '/') ? root + '/' + target : target);
  if (path === '..' || path.startsWith('../') || (root && !path.startsWith(root + '/'))) return;
  return path;
}
export function areaCandidates(link: string, source: string, root: string, candidates: string[]) {
  let target = link.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0];
  try { target = decodeURIComponent(target); } catch { return []; }
  if (!target || target.includes('#') || /[\\\x00-\x1f\x7f]/.test(target) || /^[A-Za-z][\w+.-]*:/.test(target) || target.startsWith('//')) return [];
  target = target.replace(/^\//, '').replace(/\/$/, '');
  if (target.includes('/')) {
    const path = areaLinkPath(link, source, root);
    if (!path) return [];
    const note = path.endsWith('.md') ? path : path + '.md';
    if (candidates.includes(note)) return [note];
    return candidates.includes(path + '/') ? [path + '/'] : [];
  }
  const name = target.replace(/\.md$/, '').toLocaleLowerCase('und');
  return candidates.filter(path => (!root || path.startsWith(root + '/')) && posix.basename(path.replace(/\/$/, ''), path.endsWith('/') ? undefined : '.md').toLocaleLowerCase('und') === name);
}
