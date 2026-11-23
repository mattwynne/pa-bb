import { posix } from 'node:path';
import type { Metadata, NoteParser } from './ports.ts';
const pathKey = (path: string) => path.toLowerCase();

export type ParsedLinks = Readonly<Pick<Metadata, 'unclosedHtmlOffset' | 'htmlLinkOffset' | 'unparsedReferenceOffset'>> & {
  readonly links: readonly IndexedLink[];
  readonly warnings: readonly string[];
};
export type IndexedLink = Readonly<Omit<Metadata['links'][number], 'destination'>> & {
  readonly destination?: Readonly<{ start: number; end: number }>;
  readonly spelling: string;
  readonly rawTarget?: string;
  readonly column: number;
};

export const externalLink = (value: string) => /^[a-z][\w+.-]*:/i.test(value) || value.startsWith('//');

export function parseLinks(text: string, parser: NoteParser): ParsedLinks {
  if (!text.includes('[') && !text.includes('<') && !/^(?:\uFEFF)?---\r?\n/.test(text)) return { links: [], warnings: [] };
  const { links, warnings, unclosedHtmlOffset, htmlLinkOffset, unparsedReferenceOffset } = parser.parse(text, 'move');
  return { warnings, unclosedHtmlOffset, htmlLinkOffset, unparsedReferenceOffset,
    links: links.filter(link => !externalLink(link.target) || (link.syntax === 'definition' && /^data:/i.test(link.target)))
      .sort((a, b) => a.start - b.start).map(link => ({
        ...link, spelling: text.slice(link.start, link.end),
        rawTarget: link.destination && text.slice(link.destination.start, link.destination.end),
        column: link.start - text.lastIndexOf('\n', link.start - 1),
      })) };
}

export function linkReference(spelling: string) {
  const fragment = spelling.indexOf('#');
  const path = fragment < 0 ? spelling : spelling.slice(0, fragment);
  if (externalLink(path)) return { status: 'external' as const };
  if (/%(?:2f|5c)/i.test(path)) return { status: 'target_encoding' as const };
  try {
    const name = decodeURIComponent(path);
    if (externalLink(name)) return { status: 'external' as const };
    if (path.includes('?') || /[\\\x00-\x1f\x7f]/.test(name)) return { status: 'target_characters' as const };
    return { status: 'internal' as const, name, path, subpath: fragment < 0 ? '' : decodeURIComponent(spelling.slice(fragment + 1)) };
  } catch {
    return { status: 'target_encoding' as const };
  }
}

export type LinkResolution = {
  status: 'resolved' | 'ambiguous' | 'missing';
  target?: string;
  candidates: readonly string[];
  competing: readonly string[];
};
const missing: LinkResolution = Object.freeze({ status: 'missing', candidates: Object.freeze([]), competing: Object.freeze([]) });
const evidence = (candidates: readonly string[], competing: readonly string[] = []): LinkResolution => candidates.length === 0 ? missing :
  { status: candidates.length === 1 ? 'resolved' : 'ambiguous', target: candidates.length === 1 ? candidates[0] : undefined, candidates, competing };

export function vaultRootFor(path: string, roots: readonly string[]) {
  if (roots.includes('')) return '';
  return roots.filter(root => path.startsWith(root + '/')).sort((a, b) => a.length - b.length)[0] ?? '';
}

export type LinkSource = { readonly path: string; readonly hash: string; readonly linkData?: ParsedLinks };
export class VaultLinks {
  private readonly names = new Map<string, string[]>();
  private readonly sources = new Map<string, LinkSource>();
  constructor(paths: Iterable<string>, readonly root = '', sources: Iterable<LinkSource> = []) {
    for (const path of paths) {
      if (root && !path.startsWith(root + '/')) continue;
      const key = pathKey(posix.basename(path));
      const group = this.names.get(key);
      if (group) group.push(path);
      else this.names.set(key, [path]);
    }
    for (const source of sources) this.sources.set(source.path, source);
  }
  private relative(path: string) { return this.root ? path.slice(this.root.length + 1) : path; }

  source(path: string, hash: string) {
    const note = this.sources.get(path);
    return note?.hash === hash ? note.linkData : undefined;
  }

  resolve(name: string, source: string): LinkResolution {
    if (!name) return evidence([source]);
    let reference = pathKey(name);
    const file = posix.basename(reference);
    let paths = file.includes('.') ? this.names.get(file) : undefined;
    if (!paths) {
      reference += '.md';
      paths = this.names.get(file + '.md');
    }
    if (!paths) return missing;
    const folder = pathKey(posix.dirname(this.relative(source)));
    const relative = reference.startsWith('./') || reference.startsWith('../');
    const absolute = reference.startsWith('/');
    if (relative) {
      let referringFolder = folder;
      while (reference.startsWith('./') || reference.startsWith('../')) {
        if (reference.startsWith('../')) { referringFolder = posix.dirname(referringFolder); reference = reference.slice(3); }
        else reference = reference.slice(2);
      }
      reference = referringFolder === '.' ? reference : referringFolder + '/' + reference;
    }
    if (absolute) reference = reference.slice(1);
    const exact = paths.filter(path => pathKey(this.relative(path)) === reference);
    if (exact.length) return evidence(exact, absolute || relative ? [] : paths.filter(path => !exact.includes(path) &&
      pathKey(this.relative(path)).endsWith(reference)));
    if (absolute) return missing;
    const suffix = paths.filter(path => pathKey(this.relative(path)).endsWith(reference));
    const nearby = folder === '.' ? [] : suffix.filter(path => pathKey(this.relative(path)).startsWith(folder));
    const preferred = nearby.length ? nearby : suffix;
    const shortest = preferred.reduce((length, path) => Math.min(length, path.length), Infinity);
    const first = preferred.filter(path => path.length === shortest);
    const firstSet = new Set(first);
    return evidence(first, suffix.filter(path => !firstSet.has(path)));
  }

  *backlinks(target: string) {
    for (const source of this.sources.values()) {
      if (this.root && !source.path.startsWith(this.root + '/')) continue;
      for (const link of source.linkData?.links ?? []) {
        const reference = linkReference(link.rawTarget ?? link.target);
        if (reference.status !== 'internal' || link.syntax === 'definition') continue;
        // A destination must have this basename before its contextual rank matters.
        const name = pathKey(posix.basename(reference.name)), targetName = pathKey(posix.basename(target));
        if (name ? name !== targetName && name + '.md' !== targetName : source.path !== target) continue;
        const resolution = this.resolve(reference.name, source.path);
        if (resolution.target === target) yield { source: source.path, hash: source.hash, link, resolution };
      }
    }
  }
}
