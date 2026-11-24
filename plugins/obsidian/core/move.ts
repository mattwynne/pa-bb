import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { linkReference, parseLinks, VaultLinks, type ParsedLinks } from './vault-links.ts';
import { projectFolders, type ProjectMove } from './project-move.ts';
import { MAX_NOTE_BYTES, VaultError, type NoteParser } from './ports.ts';
export const projectMoveSchema = z.enum(['standalone', 'paired']);
export const moveRecordSchema = z.object({ operationId: z.string().uuid(), finished: z.boolean().optional(), verifyLinks: z.literal(true).optional(), refused: z.boolean().optional(), expectedHash: z.string().optional(), root: z.string().max(1024).optional(),
  verification: z.object({ state: z.enum(['verified', 'inventory_changed', 'note_changed', 'unavailable']), paths: z.array(z.string().max(1024)).max(8), category: z.string().max(64).optional() }).strict().optional(),
  project: projectMoveSchema.optional(), directory: z.literal(true).optional(), vaultId: z.string(), path: z.string().max(1024), destination: z.string().max(1024), repairs: z.array(z.object({ path: z.string().max(1024), expectedHash: z.string(), hash: z.string(), operationId: z.string().uuid(), outcome: z.enum(['unstarted', 'submitted', 'saved', 'not_saved', 'uncertain']) }).strict()).max(64) }).strict();
export type MoveRecord = z.infer<typeof moveRecordSchema>;
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export const MOVE_SCAN_LIMITS = { notes: 10000, bytes: 128 * 1024 * 1024, milliseconds: 20000, batch: 8 } as const;
const REPAIR_BYTES = 8 * 1024 * 1024;
const encodePath = (path: string) => path.split('/').map(part => encodeURIComponent(part)
  .replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase())).join('/');
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
  frontmatter_link: 'A YAML wikilink could be affected by the move and cannot be rewritten safely.',
  target_encoding: 'The link target uses unsupported percent encoding.',
  target_characters: 'The link target contains characters the planner cannot handle safely.',
  overlapping_links: 'The planner found overlapping link spans.',
} as const;
export class MoveLinkError extends VaultError {
  additionalLocations?: MoveLinkError['location'][];
  affectedBacklinks?: FolderBacklink[];
  previewBlockers?: { notesChecked: number; bytesChecked: number; counts: Partial<Record<MoveLinkError['location']['reason'], number>>; locationsTruncated: boolean };
  constructor(
    readonly location: { reason: keyof typeof unsupportedReasons | 'ambiguous_target'; path: string; line?: number; column?: number; start?: number; end?: number; beforeCandidates?: readonly string[]; afterCandidates?: readonly string[] },
    ambiguity?: string,
  ) {
    super(location.reason === 'ambiguous_target' ? 'ambiguous_link' : 'unsupported_links',
      `Move stopped before writing. ${location.reason === 'ambiguous_target' ? ambiguity : unsupportedReasons[location.reason]} Inspect the location in Obsidian.`);
  }
}

type FolderBacklink = { path: string; line: number; column: number; target: string; destination: string; rewrite: boolean };

export function createMovePlanner(paths: ReadonlySet<string>, from: string, to: string, parser: NoteParser,
  project?: ProjectMove, attachments: readonly string[] = [], root = '', directory?: true) {
  if (!directory && (!paths.has(from) || paths.has(to))) throw new VaultError('conflict');
  const folders = directory ? { from, to } : projectFolders({ path: from, destination: to, project });
  const moves = new Map(directory ? [] : [[from, to]]);
  const targets = new Set([...paths, ...attachments]);
  if (folders && project !== 'standalone') {
    for (const path of targets) {
      if (below(path, folders.from)) moves.set(path, folders.to + path.slice(folders.from.length));
      if (below(path, folders.to)) throw new VaultError('conflict');
    }
  }
  const beforeMove = new VaultLinks(targets, root);
  const afterPaths = new Set([...targets].map(path => moves.get(path) ?? path));
  if (afterPaths.size !== targets.size) throw new VaultError('conflict');
  const afterMove = new VaultLinks(afterPaths, root);
  const repairs: Array<{ path: string; text: string; expectedHash: string; hash: string }> = [];
  const backlinks: FolderBacklink[] = [];
  let backlinkBytes = 0;
  let repairBytes = 0;
  const visit = (note: { path: string; text: string; hash: string }, bytes: number, indexed?: ParsedLinks) => {
    const location = (offset?: number) => {
      if (offset === undefined) return { path: note.path };
      const prefix = note.text.slice(0, offset);
      return { path: note.path, line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') };
    };
    const unsupported = (reason: keyof typeof unsupportedReasons, offset?: number): never => {
      throw new MoveLinkError({ reason, ...location(offset) });
    };
    const metadata = indexed ?? parseLinks(note.text, parser);
    if (metadata.warnings.includes('properties_unsupported')) unsupported('frontmatter', 0);
    if (metadata.warnings.includes('unclosed_html')) unsupported('unclosed_html', metadata.unclosedHtmlOffset);
    if (metadata.warnings.length) unsupported('parser_warning');
    if (metadata.unparsedReferenceOffset !== undefined) unsupported('reference_definition', metadata.unparsedReferenceOffset);
    if (metadata.htmlLinkOffset !== undefined) unsupported('html_link_attribute', metadata.htmlLinkOffset);
    const movedSource = moves.get(note.path) ?? note.path;
    const newFolder = posix.dirname(movedSource);
    const pieces: string[] = [];
    let offset = 0;
    for (const link of metadata.links) {
      if (link.syntax === 'definition') {
        if (/^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i.test(link.target)) continue;
        return unsupported('reference_definition', link.start);
      }
      const frontmatter = link.syntax === 'frontmatter';
      const wiki = frontmatter || link.syntax === 'wiki';
      const span = link.destination;
      const raw = link.rawTarget;
      if (!wiki && raw !== undefined && raw !== link.target) return unsupported('destination_markup', link.start);
      const reference = linkReference(raw ?? link.target);
      if (reference.status === 'external') continue;
      if (reference.status !== 'internal') return unsupported(reference.status, link.start);
      const { name, path: pathSpelling } = reference;
      if (!name) continue; // Local heading or block references follow their note.
      if (wiki && (pathSpelling !== pathSpelling.trim() || (raw !== undefined && raw !== link.target))) {
        return unsupported('target_characters', link.start);
      }
      const before = beforeMove.resolve(name, note.path);
      const after = afterMove.resolve(name, movedSource);
      const ambiguous = (reason: string) => new MoveLinkError({
        reason: 'ambiguous_target', path: note.path, line: link.line, column: link.column, start: link.start, end: link.end,
        beforeCandidates: [...before.candidates, ...before.competing].slice(0, 4),
        afterCandidates: [...after.candidates, ...after.competing].slice(0, 4),
      }, reason);
      if (!before.target) {
        if (movedSource !== note.path && /^\.\.?(?:\/|$)/.test(name) && /%(?:23|3f)/i.test(pathSpelling)) {
          return unsupported('target_encoding', link.start);
        }
        const touchesFolder = directory && [note.path, movedSource].some(source => {
          const relative = /^\.\.?(?:\/|$)/.test(name);
          const explicit = posix.normalize(name.replace(/^\//, ''));
          const withinFolder = (path: string) => [from, to].some(folder => below(path.toLowerCase(), folder.toLowerCase()));
          const forms = relative ? [posix.join(posix.dirname(source), name)] :
            [root ? root + '/' + explicit : explicit, explicit];
          return (relative && movedSource !== note.path) ||
            forms.some(withinFolder) ||
            [...before.candidates, ...before.competing, ...after.candidates, ...after.competing]
              .some(withinFolder);
        });
        const unchanged = !touchesFolder && before.candidates.length === after.candidates.length &&
          before.candidates.every(path => !moves.has(path) && after.candidates.includes(path));
        if (unchanged) continue;
        if (frontmatter) return unsupported('frontmatter_link', link.start);
        throw ambiguous('A changed link did not have a uniquely established target before the move.');
      }
      const destination = moves.get(before.target) ?? before.target;
      const rewrite = after.target !== destination || (!project && !directory && moves.has(before.target));
      if (directory && moves.has(before.target)) {
        const backlink = { path: note.path, line: link.line, column: link.column, target: before.target, destination, rewrite };
        backlinkBytes += JSON.stringify(backlink).length;
        if (backlinks.length >= 256 || backlinkBytes > 16_000)
          throw new VaultError('capacity', 'The affected backlinks exceed the folder preview limit.');
        backlinks.push(backlink);
      }
      if (!rewrite) continue;
      if (/%(?:23|3f)/i.test(pathSpelling)) return unsupported('target_encoding', link.start);
      if (!span) return unsupported(frontmatter ? 'frontmatter_link' : 'link_syntax', link.start);
      if (wiki && /[#|\[\]<>?%]/.test(destination)) return unsupported('target_characters', link.start);
      const vaultPath = destination.slice(root ? root.length + 1 : 0);
      const qualified = wiki ? vaultPath.replace(/\.md$/, '') : vaultPath;
      let spelling = wiki ? qualified : posix.relative(newFolder, destination);
      if (afterMove.resolve(spelling, movedSource).target !== destination) spelling = '/' + qualified;
      if (afterMove.resolve(spelling, movedSource).target !== destination) {
        // An explicit .md may distinguish a filename with dots from an attachment.
        spelling = '/' + vaultPath;
      }
      if (afterMove.resolve(spelling, movedSource).target !== destination) {
        throw ambiguous('A rewritten link would not uniquely identify its intended target.');
      }
      const next = wiki ? spelling : encodePath(spelling);
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
  return { visit, repairs, moves, backlinks };
}
