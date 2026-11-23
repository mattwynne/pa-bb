import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createLinkCandidates, isShortWikiPath, linkPathForms, noteNameKey, pathKey, suffixForms } from './link-candidates.ts';
import { projectFolders, type ProjectMove } from './project-move.ts';
import { MAX_NOTE_BYTES, VaultError, type NoteParser } from './ports.ts';
export const projectMoveSchema = z.enum(['standalone', 'paired', 'folder']);
export const moveRecordSchema = z.object({ operationId: z.string().uuid(), finished: z.boolean().optional(), refused: z.boolean().optional(), expectedHash: z.string().optional(), root: z.string().max(1024).optional(),
  verification: z.object({ state: z.enum(['verified', 'inventory_changed', 'note_changed', 'unavailable']), paths: z.array(z.string().max(1024)).max(8) }).strict().optional(),
  project: projectMoveSchema.optional(), vaultId: z.string(), path: z.string().max(1024), destination: z.string().max(1024), repairs: z.array(z.object({ path: z.string().max(1024), expectedHash: z.string(), hash: z.string(), operationId: z.string().uuid(), outcome: z.enum(['unstarted', 'submitted', 'saved', 'not_saved', 'uncertain']) }).strict()).max(64) }).strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export const MOVE_SCAN_LIMITS = { notes: 10000, bytes: 128 * 1024 * 1024, milliseconds: 20000, batch: 8 } as const;
const REPAIR_BYTES = 8 * 1024 * 1024;
const encodePath = (path: string) => path.split('/').map(part => encodeURIComponent(part)
  .replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())).join('/');
function absoluteFilePath(target: string) {
  if (!/^file:\/\/\/(?!\/)/i.test(target) || /[\\\x00-\x1f\x7f]/.test(target)) return;
  try {
    const { pathname } = new URL(target);
    if (/%(?:2f|5c)/i.test(pathname)) return;
    const path = decodeURIComponent(pathname);
    if (!/[\\\x00-\x1f\x7f]/.test(path)) return path;
  } catch {
    // A malformed file URL may still name a move endpoint.
  }
}
const below = (path: string, folder: string) => path.startsWith(folder + '/');
const unsupportedReasons = {
  path_characters: 'The path contains characters the move planner cannot handle safely.',
  frontmatter: 'The YAML frontmatter could not be checked for links.',
  parser_warning: 'The Markdown parser reported a warning while checking this note.',
  reference_definition: 'The planner cannot check this Markdown reference definition.',
  html_link_attribute: 'The planner found an HTML link or embed attribute it cannot check safely.',
  unclosed_html: 'The Markdown parser found an HTML element without a closing tag.',
  link_syntax: 'The planner cannot check this link syntax.',
  destination_markup: 'The link destination uses markup the planner cannot rewrite safely.',
  file_url: 'The planner could not verify the spelling of this absolute file link.',
  target_scheme: 'The planner cannot verify whether this link protocol can refer to the moved note.',
  frontmatter_link: 'A YAML wikilink could be affected by the move and cannot be rewritten safely.',
  target_encoding: 'The link target uses unsupported percent encoding.',
  target_characters: 'The link target contains characters the planner cannot handle safely.',
  overlapping_links: 'The planner found overlapping link spans.',
} as const;
export class MoveLinkError extends VaultError {
  additionalLocations?: MoveLinkError['location'][];
  previewBlockers?: { notesChecked: number; bytesChecked: number; counts: Partial<Record<MoveLinkError['location']['reason'], number>>; locationsTruncated: boolean };
  constructor(
    readonly location: { reason: keyof typeof unsupportedReasons | 'ambiguous_target'; path: string; line?: number; column?: number },
    ambiguity?: string,
  ) {
    super(location.reason === 'ambiguous_target' ? 'ambiguous_link' : 'unsupported_links',
      `Move stopped before writing. ${location.reason === 'ambiguous_target' ? ambiguity : unsupportedReasons[location.reason]} Inspect the location in Obsidian.`);
  }
}
export function createMovePlanner(paths: ReadonlySet<string>, from: string, to: string, parser: NoteParser,
  project?: ProjectMove, attachments: readonly string[] = [], root = '') {
  if (!paths.has(from) || paths.has(to)) throw new VaultError('conflict');
  const folders = projectFolders({ path: from, destination: to, project });
  const moves = new Map([[from, to]]);
  const targets = new Set([...paths, ...attachments]);
  if (folders && project !== 'standalone') {
    for (const path of targets) {
      if (below(path, folders.from)) moves.set(path, folders.to + path.slice(folders.from.length));
      if (below(path, folders.to)) throw new VaultError('conflict');
    }
  }
  const endpoints = new Set([...moves.keys(), ...moves.values()].map(pathKey));
  const endpointNames = new Set([...endpoints].map(noteNameKey));
  const movedFolders = folders && project !== 'standalone' ? [pathKey(folders.from), pathKey(folders.to)] : [];
  const beforeMove = createLinkCandidates(targets);
  const afterPaths = new Set([...targets].map(path => moves.get(path) ?? path));
  if (afterPaths.size !== targets.size) throw new VaultError('conflict');
  const afterMove = createLinkCandidates(afterPaths);
  const forms = (name: string, folder: string, wiki: boolean) => {
    if (root && (name.startsWith('/') || (wiki && !name.startsWith('./') && !name.startsWith('../'))))
      return linkPathForms(name, '', wiki).map(path => root + '/' + path);
    return linkPathForms(name, folder, wiki).filter(path => !root || below(path, root));
  };
  const repairs: Array<{ path: string; text: string; expectedHash: string; hash: string }> = [];
  let repairBytes = 0;
  const visit = (note: { path: string; text: string; hash: string }, bytes: number) => {
    // All supported links and the syntax the planner refuses start with '['
    // or '<', or can be decoded from YAML frontmatter. Inspect the exact
    // bytes of every note before taking this fast path.
    if (!note.text.includes('[') && !note.text.includes('<') && !/^(?:\uFEFF)?---\r?\n/.test(note.text)) return;
    const location = (offset?: number) => {
      if (offset === undefined) return { path: note.path };
      const prefix = note.text.slice(0, offset);
      return { path: note.path, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') };
    };
    const unsupported = (reason: keyof typeof unsupportedReasons, offset?: number): never => {
      throw new MoveLinkError({ reason, ...location(offset) });
    };
    const metadata = parser.parse(note.text, 'move');
    if (metadata.warnings.includes('properties_unsupported')) unsupported('frontmatter', 0);
    if (metadata.warnings.includes('unclosed_html')) unsupported('unclosed_html', metadata.unclosedHtmlOffset);
    if (metadata.warnings.length) unsupported('parser_warning');
    if (metadata.unparsedReferenceOffset !== undefined) unsupported('reference_definition', metadata.unparsedReferenceOffset);
    if (metadata.htmlLinkOffset !== undefined) unsupported('html_link_attribute', metadata.htmlLinkOffset);
    const movedSource = moves.get(note.path) ?? note.path;
    const oldFolder = posix.dirname(note.path), newFolder = posix.dirname(movedSource);
    const moved = movedSource !== note.path;
    const siblings = posix.dirname(oldFolder) === posix.dirname(newFolder);
    const pieces: string[] = [];
    let offset = 0;
    for (const link of [...metadata.links].sort((a, b) => a.start - b.start)) {
      const ambiguous = (reason: string) => new MoveLinkError({ reason: 'ambiguous_target', ...location(link.start) }, reason);
      if (link.syntax === 'definition') {
        if (/^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i.test(link.target)) continue;
        return unsupported('reference_definition', link.start);
      }
      if (link.syntax === 'markdown' && /^(?:https?:\/\/|mailto:|tel:|sandbox:\/mnt\/data(?:\/|$))/i.test(link.target)) continue;
      if (link.syntax === 'markdown' && /^file:/i.test(link.target)) {
        const filePath = absoluteFilePath(link.target);
        // An absolute file destination has no dependency on the referring
        // folder. Its mount prefix may differ across machines, so a matching
        // final name is still a possible endpoint.
        if (filePath === undefined) return unsupported('file_url', link.start);
        if (!endpointNames.has(noteNameKey(filePath))) continue;
        throw ambiguous('An absolute file link could name the source or destination.');
      }
      const frontmatter = link.syntax === 'frontmatter';
      const wiki = frontmatter || link.syntax === 'wiki';
      const span = link.destination;
      const raw = span && note.text.slice(span.start, span.end);
      if (!wiki && raw !== undefined && raw !== link.target) return unsupported('destination_markup', link.start);
      if (!wiki && raw === undefined && !link.target) continue;
      const spellingBefore = raw ?? link.target;
      const fragment = spellingBefore.indexOf('#');
      const pathSpelling = fragment < 0 ? spellingBefore : spellingBefore.slice(0, fragment);
      if (!pathSpelling) continue; // Local heading or block references follow their note.
      if (/^[a-z][\w+.-]*:/i.test(pathSpelling) || pathSpelling.startsWith('//')) return unsupported('target_scheme', link.start);
      if (/%(?:2f|5c)/i.test(pathSpelling)) return unsupported('target_encoding', link.start);
      let name: string;
      try { name = decodeURIComponent(pathSpelling); } catch { return unsupported('target_encoding', link.start); }
      if (/^[a-z][\w+.-]*:/i.test(name) || name.startsWith('//')) return unsupported('target_scheme', link.start);
      if (pathSpelling.includes('?') || /[\\\x00-\x1f\x7f]/.test(name)) return unsupported('target_characters', link.start);
      if (wiki && (pathSpelling !== pathSpelling.trim() || (raw !== undefined && raw !== link.target))) {
        return unsupported('target_characters', link.start);
      }
      const basename = wiki && !name.includes('/');
      const shortPath = wiki && isShortWikiPath(name);
      const before = basename ? [] : forms(name, oldFolder, wiki);
      const after = moved && !basename ? forms(name, newFolder, wiki) : before;
      const suffixes = shortPath ? suffixForms(name) : [];
      const touchesPath = (value: string) => {
        const path = pathKey(value);
        return endpoints.has(path) || movedFolders.some(folder => below(path, folder));
      };
      const touchesEndpoint = basename
        ? endpointNames.has(noteNameKey(name))
        : [...before, ...after].some(touchesPath) ||
          (shortPath && [...beforeMove.bySuffix(suffixes), ...afterMove.bySuffix(suffixes)].some(touchesPath));
      if (!touchesEndpoint) {
        if (!moved || oldFolder === newFolder) continue;
        if (basename) {
          if (beforeMove.byName(name).length <= 1) continue;
          throw ambiguous('An outgoing basename link in the moved note could change targets.');
        }
        if (shortPath) {
          const possible = beforeMove.bySuffix(suffixes);
          if (project && possible.length === 1 && before.includes(possible[0]) &&
            afterMove.bySuffix(suffixes).every(path => path === possible[0])) continue;
          // Only the two sibling directories change context. A unique match
          // outside them stays in the same ancestor scopes and remains the
          // same candidate. Preserve the original spelling.
          if (possible.length === 1 && !below(pathKey(possible[0]), pathKey(oldFolder))
            && !below(pathKey(possible[0]), pathKey(newFolder))
            && (siblings || before.includes(possible[0]))) continue;
          throw ambiguous('An outgoing short-path link could change meaning in the destination folder.');
        }
        if (before[0] === after[0]) continue;
      }
      // Native Obsidian can treat percent-encoded URL delimiters as literal
      // spelling. They cannot establish a target for a needed rewrite.
      if (/%(?:23|3f)/i.test(pathSpelling)) return unsupported('target_encoding', link.start);
      if (!span && !project) return unsupported(frontmatter ? 'frontmatter_link' : 'link_syntax', link.start);
      const candidates = basename
        ? beforeMove.byName(name)
        : beforeMove.byPath(before);
      if (candidates.length !== 1 || (shortPath && beforeMove.bySuffix(suffixes).length !== 1)) {
        throw ambiguous('A link that could change with this move did not have a uniquely established target.');
      }
      const resolved = candidates[0];
      if (touchesEndpoint && !moves.has(resolved) && (basename || shortPath || !moved)) {
        throw ambiguous('A link could acquire a different target at the destination.');
      }
      const destination = moves.get(resolved) ?? resolved;
      if (project) {
        const unchanged = basename ? afterMove.byName(name) : afterMove.byPath(after);
        if (unchanged.length === 1 && unchanged[0] === destination &&
          (!shortPath || afterMove.bySuffix(suffixes).every(path => path === destination))) continue;
      }
      if (!span) return unsupported(frontmatter ? 'frontmatter_link' : 'link_syntax', link.start);
      if (wiki && /[#|\[\]<>?%]/.test(destination)) return unsupported('target_characters', link.start);
      const next = wiki ? destination.slice(root ? root.length + 1 : 0).replace(/\.md$/, '') : encodePath(posix.relative(posix.dirname(movedSource), destination));
      const spelling = wiki ? next : decodeURIComponent(next);
      const possibleAfter = wiki && !spelling.includes('/')
        ? afterMove.byName(spelling)
        : afterMove.byPath(forms(spelling, newFolder, wiki));
      if (possibleAfter.length !== 1 || possibleAfter[0] !== destination) {
        throw ambiguous('A rewritten link would not uniquely identify its intended target.');
      }
      if (wiki && isShortWikiPath(spelling) && afterMove.bySuffix(suffixForms(spelling)).some(path => path !== destination)) {
        throw ambiguous('A rewritten wikilink would have a competing path match.');
      }
      if (next === pathSpelling) continue;
      if (span.start < offset) unsupported('overlapping_links', link.start);
      bytes += Buffer.byteLength(next) - Buffer.byteLength(pathSpelling);
      pieces.push(note.text.slice(offset, span.start), next);
      offset = span.start + pathSpelling.length;
    }
    if (!pieces.length) return;
    if (bytes > MAX_NOTE_BYTES) throw new VaultError('capacity', 'A planned link repair would exceed the note store’s 1 MiB write limit.');
    if (repairs.length >= 64) throw new VaultError('capacity', 'The move would require more than 64 link repairs.');
    repairBytes += bytes;
    if (repairBytes > REPAIR_BYTES) throw new VaultError('capacity', 'The planned link repairs exceed the 8 MiB total repair limit.');
    const text = pieces.join('') + note.text.slice(offset);
    repairs.push({ path: movedSource, text, expectedHash: note.hash, hash: hashText(text) });
  };
  return { visit, repairs, moves };
}
