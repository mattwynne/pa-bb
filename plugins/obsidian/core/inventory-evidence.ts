import { posix } from 'node:path';
import type { InventoryBatchRequest } from '../contract.ts';
import type { IndexedNote, IndexView } from './vault-index.ts';
import { VaultError } from './ports.ts';

export const within = (path: string, root: string) => !root || path.startsWith(root + '/');
export const hides = (o: IndexView['omissions'][number], path: string) => o.path === path || (o.kind === 'tree' && (!o.path || within(path, o.path)));
export const INVENTORY_BATCH_MAX_REQUESTS = 128;
export const INVENTORY_BATCH_MAX_BYTES = 4 * 1024 * 1024;
export class InventoryBatchRefusal extends VaultError {
  constructor(readonly reason: 'output_limit' | 'incompatible') { super(reason); }
}
type Child = { name: string; kind: 'directory' | 'markdown' };
function childListing(view: IndexView, folder: string, exists: boolean) {
  const entries: Child[] = [];
  let incomplete = !exists || view.omissions.some(o => hides(o, folder) || posix.dirname(o.path) === folder);
  let bytes = 0;
  return {
    add(name: string, kind: Child['kind']) {
      bytes += Buffer.byteLength(name) + 40;
      if (entries.length >= 5000 || bytes > 512 * 1024) incomplete = true;
      else entries.push({ name, kind });
    },
    result() { return { entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'en')), incomplete }; },
  };
}
export function indexedChildren(view: IndexView, folder: string) {
  const listing = childListing(view, folder, view.directories.includes(folder));
  for (const path of view.directories) if (posix.dirname(path) === folder) listing.add(posix.basename(path), 'directory');
  for (const note of view.notes) if (posix.dirname(note.path) === folder) listing.add(posix.basename(note.path), 'markdown');
  return listing.result();
}
export function indexedProperties(view: IndexView, note: IndexedNote | undefined, path: string, fields: string[]) {
  const partial = view.omissions.some(o => hides(o, path)) || !!note?.propertyWarning;
  return { status: partial ? 'partial' as const : note ? 'observed' as const : 'missing' as const, ...projectFields(note?.properties ?? {}, fields) };
}
export const targetCoverageIncomplete = (view: IndexView, root: string) =>
  view.omissions.some(o => within(o.path, root) || (o.kind === 'tree' && hides(o, root)));
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
const targetNotePath = (path: string) => path.endsWith('.md') ? path : path + '.md';
function matchingNotes(notes: Iterable<string>, root: string, path: string | undefined, basename: string | undefined, limit = Infinity) {
  const matches: string[] = [];
  const exact = path && targetNotePath(path);
  for (const note of notes) {
    if (within(note, root) && (path ? note === exact : basenameKey(posix.basename(note)) === basename)) matches.push(note);
    if (matches.length === limit) break;
  }
  return matches;
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

/** The first discoverable .obsidian directory wins along each path. */
export function checkIndexedInventoryRoot(view: IndexView, root: string) {
  if (!root) return;
  const parts = root.split('/');
  if (parts.length > 32 || parts.some(part => ['.obsidian', '.git', 'node_modules'].includes(part))) throw new VaultError('source_unavailable');
  const marker = root + '/.obsidian';
  const ancestors = new Set(parts.map((_, depth) => [...parts.slice(0, depth), '.obsidian'].join('/')));
  if (!view.directories.includes(marker) || view.directories.some(path => ancestors.has(path))
      || view.omissions.some(omission => hides(omission, root) || omission.path === marker || ancestors.has(omission.path))) {
    throw new VaultError('source_unavailable');
  }
}

/** Gather only requested lookup keys. Preserve the view's candidate order and child clipping. */
export function* indexedInventoryRows(view: IndexView, root: string, requests: InventoryBatchRequest[]) {
  if (!requests.length) return;
  const folders = new Map<string, { exists: boolean; directories: string[]; notes: string[] }>();
  const notes = new Map<string, IndexedNote | undefined>();
  const basenames = new Map<string, string[]>();
  const explicitDirectories = new Set<string>();
  const queries = requests.map(request => {
    if (request.kind === 'children') {
      if (!folders.has(request.folder)) folders.set(request.folder, { exists: false, directories: [], notes: [] });
    } else if (request.kind === 'properties') {
      notes.set(request.path, undefined);
    } else {
      const query = targetQuery(request.reference, request.path, root);
      if (query.path) {
        notes.set(targetNotePath(query.path), undefined);
        explicitDirectories.add(query.path);
      }
      if (query.basename) basenames.set(query.basename, []);
      return query;
    }
  });
  const directories = new Set<string>();
  if (folders.size || explicitDirectories.size) {
    for (const path of view.directories) {
      if (explicitDirectories.has(path)) directories.add(path);
      if (folders.size) {
        const folder = folders.get(path);
        if (folder) folder.exists = true;
        folders.get(posix.dirname(path))?.directories.push(path);
      }
    }
  }
  if (folders.size || notes.size || basenames.size) {
    for (const note of view.notes) {
      const { path } = note;
      if (notes.has(path)) notes.set(path, note);
      if (folders.size) folders.get(posix.dirname(path))?.notes.push(path);
      if (basenames.size && within(path, root)) {
        const candidates = basenames.get(basenameKey(posix.basename(path)));
        if (candidates && candidates.length < 2) candidates.push(path);
      }
    }
  }
  const children = new Map<string, ReturnType<typeof indexedChildren>>();
  const incomplete = queries.some(Boolean) && targetCoverageIncomplete(view, root);
  for (const [index, request] of requests.entries()) {
    switch (request.kind) {
      case 'children': {
        const { folder } = request;
        let result = children.get(folder);
        if (!result) {
          const bucket = folders.get(folder)!;
          const listing = childListing(view, folder, bucket.exists);
          for (const path of bucket.directories) listing.add(posix.basename(path), 'directory');
          for (const path of bucket.notes) listing.add(posix.basename(path), 'markdown');
          result = listing.result();
          children.set(folder, result);
        }
        yield { kind: request.kind, ...result };
        break;
      }
      case 'properties':
        yield { kind: request.kind, ...indexedProperties(view, notes.get(request.path), request.path, request.fields) };
        break;
      case 'target': {
        const query = queries[index]!;
        const exactPath = query.path && targetNotePath(query.path);
        const candidates = exactPath && notes.get(exactPath) ? [exactPath] : basenames.get(query.basename ?? '') ?? [];
        yield { kind: request.kind, ...targetEvidence(query, root, candidates, !!query.path && directories.has(query.path), incomplete) };
        break;
      }
    }
  }
}
