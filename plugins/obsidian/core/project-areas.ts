import { posix } from 'node:path';

// The YAML input is not the resolved areaId returned by the projection.
export const projectAreasDeclarationKey = 'area';
export function areaEvidence(properties: Readonly<Record<string, unknown>>): string[] | null {
  if (!Object.hasOwn(properties, projectAreasDeclarationKey)) return [];
  const property = properties[projectAreasDeclarationKey];
  if (property === null || property === undefined || (typeof property === 'string' && !property.trim())) return [];
  const items = Array.isArray(property) ? property : [property];
  if (items.length > 8 || items.some(v => typeof v !== 'string' || !v.trim() || v.length > 1024)) return null;
  return [...items] as string[];
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
const basenameKey = (path: string) => posix.basename(path.replace(/\/$/, ''), path.endsWith('/') ? undefined : '.md').toLocaleLowerCase('und');

export function areaLookup(root: string, areaFolder: string, notePaths: Iterable<string>, directories: Iterable<string>) {
  const paths = new Set<string>();
  const basenames = new Map<string, string[]>();
  const add = (path: string, byName: boolean) => {
    if (paths.has(path)) return;
    paths.add(path);
    if (!byName) return;
    const name = basenameKey(path), matches = basenames.get(name);
    // Only uniqueness matters; never retain an unbounded collision list.
    if (!matches) basenames.set(name, [path]);
    else if (matches.length < 2) matches.push(path);
  };
  for (const path of notePaths) if (!root || path.startsWith(root + '/')) add(path, true);
  for (const path of directories) if (path.startsWith(areaFolder + '/')) {
    // As on the legacy route, unqualified folder names are Area entries;
    // nested folders require explicit paths. A sibling note wins a pair.
    add(path + '/', posix.dirname(path) === areaFolder && !paths.has(path + '.md'));
  }
  return (link: string, source: string) => areaCandidates(link, source, root, paths, basenames);
}

function areaCandidates(link: string, source: string, root: string, paths: Set<string>, basenames: Map<string, string[]>) {
  let target = link.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0];
  try { target = decodeURIComponent(target); } catch { return []; }
  if (!target || target.includes('#') || /[\\\x00-\x1f\x7f]/.test(target) || /^[A-Za-z][\w+.-]*:/.test(target) || target.startsWith('//')) return [];
  target = target.replace(/^\//, '').replace(/\/$/, '');
  if (target.includes('/')) {
    const path = areaLinkPath(link, source, root);
    if (!path) return [];
    const note = path.endsWith('.md') ? path : path + '.md';
    if (paths.has(note)) return [note];
    return paths.has(path + '/') ? [path + '/'] : [];
  }
  return basenames.get(target.replace(/\.md$/, '').toLocaleLowerCase('und')) ?? [];
}

export type AreaRow = { path: string; status: 'none' | 'resolved' | 'unresolved'; areaId?: string };
export function areaRow(path: string, areaFolder: string, evidence: string[] | null, lookup: (link: string, path: string) => string[], incomplete: boolean): AreaRow {
  if (!evidence) return { path, status: 'unresolved' };
  if (!evidence.length) return { path, status: 'none' };
  if (!incomplete) {
    const targets = evidence.map(link => lookup(link, path));
    const target = targets[0][0];
    if (target?.startsWith(areaFolder + '/') && targets.every(matches => matches.length === 1 && matches[0] === target))
      return { path, status: 'resolved', areaId: target };
  }
  return { path, status: 'unresolved' };
}
