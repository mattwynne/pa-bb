import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { renameResult } from '../contract.ts';
import { GtdError } from '../core/model.ts';
import type { Area, AreaBackend, AreaSnapshot, Project, ProjectBackend, ProjectSnapshot, ProjectStatus, Warning } from '../core/model.ts';

export const relativeFolder = z.string().min(1).max(1024).refine(value =>
  !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'),
  'Use a relative folder such as Projects or Life/Projects, without a trailing slash.');
export const vaultSelectionSchema = z.string().min(1).max(1100).refine(value => {
  const [id, ...parts] = value.split('/');
  return vaultIdSchema.safeParse(id).success && (!parts.length || relativeFolder.safeParse(parts.join('/')).success);
});
export async function vaultOptions(sdk: BbPluginApi['sdk'], signal: AbortSignal = AbortSignal.timeout(10000)) {
  const schema = z.object({ vaults: z.array(z.object({ id: vaultIdSchema, root: z.string().max(1024), name: z.string().max(240) })), incomplete: z.boolean() });
  const value = schema.parse(await sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'vaultLocations', input: null, outputSchema: z.unknown(), signal }));
  return { ...value, vaults: value.vaults.map(v => ({ ...v, selection: v.root ? `${v.id}/${v.root}` : v.id })) };
}
export const vaultIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
// Wire contracts are local to this adapter. No imports from another plugin's implementation.
const projectAreasDeclarationKey = 'area';
const statusSchema = z.object({
  projectAreasVersion: z.number().int().optional(),
  projectAreasFrontmatterOnly: z.unknown().optional(),
  projectAreasDeclarationKey: z.unknown().optional(),
  propertiesAccessVersion: z.number().int().optional(),
  childrenAccessVersion: z.number().int().optional(),
  vaults: z.array(z.object({ vaultId: vaultIdSchema, name: z.string().nullable(), source: z.object({
    local: z.object({ available: z.boolean() }), cloudConnected: z.boolean(), enabled: z.boolean(),
    phase: z.string().max(64), lastSuccess: z.string().nullable(), failure: z.string().max(128).nullable(),
  }).nullable() })),
});
const propertyPage = z.object({
  notes: z.array(z.object({ path: z.string().min(1).max(1024), properties: z.record(z.string(), z.unknown()) }).strict()).max(200),
  nextCursor: z.string().uuid().nullable(), incomplete: z.boolean(), warnings: z.array(z.string()).max(32), observedAt: z.string(),
}).strict();
const relationshipAuthority = z.object({ revision: z.number().int().nonnegative(), route: z.enum(['index', 'direct', 'legacy_pending', 'legacy_conflict', 'legacy']), epoch: z.string().uuid() }).strict();
const relationshipPage = z.object({ rows: z.array(z.object({ path: relativeFolder, status: z.enum(['none', 'resolved', 'unresolved']), areaId: z.string().max(1024).optional() }).strict()).max(50), incomplete: z.boolean(), authority: relationshipAuthority }).strict();
const childrenPage = z.object({ entries: z.array(z.object({ name: z.string().min(1).max(1024).refine(value => !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..'), kind: z.enum(['directory', 'markdown']) }).strict()).max(5000), incomplete: z.boolean() }).strict();
const aliases: Record<string, ProjectStatus> = { active: 'active', deferred: 'deferred', someday: 'someday', done: 'done', completed: 'done' };
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function projectEntry(folder: string, path: string, statusGroups = true) {
  if (!relativeFolder.safeParse(path).success || !path.startsWith(folder + '/') || !path.endsWith('.md')) return null;
  const parts = path.slice(folder.length + 1).split('/');
  const grouped = statusGroups && parts.length > 1 && Object.hasOwn(aliases, parts[0].toLowerCase());
  const prefix = grouped ? parts.shift()! + '/' : '';
  const rootNote = parts.length === 1;
  return { key: `${folder}/${prefix}${rootNote ? parts[0].slice(0, -3) : parts[0]}`, rootNote, readme: parts.length === 2 && parts[1] === 'README.md' };
}
export function projectFromNote(folder: string, path: string, properties: Record<string, unknown>): Project | 'invalid' | null {
  const entry = projectEntry(folder, path);
  if (!entry) return 'invalid';
  const parts = path.slice(folder.length + 1).split('/');
  // Folder membership defines projects; a status folder overrides old frontmatter.
  const folderStatus = parts.length > 1 && Object.hasOwn(aliases, parts[0].toLowerCase()) ? parts.shift()!.toLowerCase() : undefined;
  // A project-level README supplies metadata while keeping the directory ID.
  if (!entry.rootNote && !entry.readme) return text(parts[0], 240) ? { id: entry.key + '/', title: parts[0], status: folderStatus ? aliases[folderStatus] : 'active' } : 'invalid';
  const status = folderStatus ? aliases[folderStatus] : properties.status === undefined ? 'active'
    : typeof properties.status === 'string' && Object.hasOwn(aliases, properties.status) ? aliases[properties.status] : undefined;
  if (!status) return 'invalid';
  const title = properties.title === undefined ? (entry.readme ? parts[0] : parts[0].slice(0, -3)) : properties.title;
  if (!text(title, 240)) return 'invalid';
  return {
    id: entry.readme ? entry.key + '/' : path,
    ...(entry.readme ? { notePath: path } : {}),
    title: (title as string).trim(),
    status,
  };
}

export function areaFromNote(folder: string, path: string, properties: Record<string, unknown>): Area | 'invalid' | null {
  const entry = projectEntry(folder, path, false);
  if (!entry) return 'invalid';
  if (!entry.rootNote) {
    const title = path.slice(folder.length + 1).split('/')[0];
    return text(title, 240) ? { id: entry.key + '/', title } : 'invalid';
  }
  const title = properties.title === undefined ? path.split('/').at(-1)!.slice(0, -3) : properties.title;
  if (!text(title, 240)) return 'invalid';
  return { id: path, title: (title as string).trim() };
}

export class ObsidianBackend implements ProjectBackend, AreaBackend {
  constructor(private sdk: BbPluginApi['sdk'], private config: { vaultId: string; folder: string; root?: string; areasFolder?: string }, private cleanupFailure: () => void = () => {}) {}
  async rename(id: string, title: string, signal: AbortSignal) {
    const folder = this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder;
    if (!relativeFolder.safeParse(id).success || !id.startsWith(folder + '/') || !id.endsWith('.md')) throw new GtdError('invalid_source');
    await this.checkAccess(signal);
    // Renaming the display property keeps backend path identity and all links unchanged.
    return renameResult.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'renameTitle', input: { vaultId: this.config.vaultId, path: id, title }, outputSchema: z.unknown(), signal }));
  }
  private async status(signal: AbortSignal) {
    let state: z.infer<typeof statusSchema>;
    try { state = statusSchema.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'status', input: null, outputSchema: z.unknown(), signal })); }
    catch { throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable'); }
    if (state.propertiesAccessVersion !== 1) throw new GtdError('incompatible');
    if (this.config.root) {
      let options: Awaited<ReturnType<typeof vaultOptions>>;
      try { options = await vaultOptions(this.sdk, signal); } catch { throw new GtdError('source_unavailable'); }
      if (!options.vaults.some(v => v.id === this.config.vaultId && v.root === this.config.root)) throw new GtdError('source_unavailable');
    }
    return state;
  }
  async checkAccess(signal: AbortSignal) {
    const state = await this.status(signal);
    if (!state.vaults.find(vault => vault.vaultId === this.config.vaultId)?.source?.local.available) throw new GtdError('source_unavailable');
  }
  async readProjects(signal: AbortSignal): Promise<ProjectSnapshot> {
    const { items, ...snapshot } = await this.readInventory(signal, 'project');
    return { ...snapshot, projects: items as Project[] };
  }
  async readAreas(signal: AbortSignal): Promise<AreaSnapshot> {
    const { items, ...snapshot } = await this.readInventory(signal, 'area');
    return { ...snapshot, areas: items as Area[] };
  }
  private async readInventory(signal: AbortSignal, kind: 'project' | 'area') {
    const state = await this.status(signal);
    const vault = state.vaults.find(vault => vault.vaultId === this.config.vaultId);
    if (!vault?.source?.local.available) throw new GtdError('source_unavailable');
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const items: (Project | Area)[] = [], warnings = new Set<Warning>();
    // The v1 consumer enumerates Markdown paths, not directories. Never claim
    // empty/attachment-only folders were enumerated, even after draining it.
    if (state.childrenAccessVersion !== 1) warnings.add('directory_enumeration_unavailable');
    const entries = new Map<string, Project | Area>();
    const invalidRoots = new Set<string>(), seenRoots = new Set<string>();
    const readmes = new Map<string, Project | 'invalid'>();
    let cursor: string | undefined, pages = 0, notes = 0, observedAt = new Date().toISOString();
    try {
      do {
        if (pages++ >= 128 || notes >= 5000 || readSignal.aborted) { warnings.add('scan_limit'); break; }
        let page: z.infer<typeof propertyPage>;
        try { page = propertyPage.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'listProperties', input: {
          vaultId: this.config.vaultId, folder: this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder, fields: ['type', 'status', 'title'], ...(cursor ? { cursor } : {}),
        }, outputSchema: z.unknown(), signal: readSignal })); }
        catch (error) {
          if (signal.aborted) throw new GtdError('cancelled');
          if (readSignal.aborted) { warnings.add('scan_limit'); break; }
          throw new GtdError(error instanceof z.ZodError ? 'invalid_source' : 'source_unavailable');
        }
        cursor = page.nextCursor ?? undefined;
        observedAt = page.observedAt;
        if (page.incomplete || page.warnings.length) warnings.add('source_partial');
        for (const note of page.notes) {
          if (++notes > 5000) { warnings.add('scan_limit'); break; }
          const folder = this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder;
          const entry = projectEntry(folder, note.path, kind === 'project');
          if (kind === 'project' && entry?.readme) {
            const item = projectFromNote(folder, note.path, note.properties);
            if (readmes.has(entry.key)) {
              warnings.add('duplicate_id');
              readmes.set(entry.key, 'invalid');
            } else if (item) {
              readmes.set(entry.key, item);
            }
            continue;
          }
          const item = kind === 'area' ? areaFromNote(folder, note.path, note.properties) : projectFromNote(folder, note.path, note.properties);
          if (entry?.rootNote) { if (seenRoots.has(entry.key)) warnings.add('duplicate_id'); seenRoots.add(entry.key); }
          if (!entry || item === 'invalid') { warnings.add(kind === 'project' ? 'invalid_project' : 'invalid_area'); if (entry?.rootNote) { entries.delete(entry.key); invalidRoots.add(entry.key); } }
          else if (item && !invalidRoots.has(entry.key) && (!entries.has(entry.key) || entry.rootNote)) entries.set(entry.key, item);
        }
      } while (cursor);
    } finally {
      // Explicitly release the producer on cancellation/limits; do not leave invisible scans open.
      if (cursor) {
        try { await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'closeProperties', input: { cursor }, outputSchema: z.unknown(), signal: AbortSignal.timeout(3000) }); }
        catch { this.cleanupFailure(); /* Read-only handle expires upstream; no retry. */ }
      }
    }
    if (signal.aborted) throw new GtdError('cancelled');
    if (state.childrenAccessVersion === 1) {
      const folder = this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder;
      let directories = 0, visited = 0;
      const enumerate = async (scope: string, status?: ProjectStatus) => {
        if (++directories > 128 || visited >= 5000 || readSignal.aborted) { warnings.add('scan_limit'); return; }
        let page: z.infer<typeof childrenPage>;
        try { page = childrenPage.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'listChildren', input: { vaultId: this.config.vaultId, folder: scope }, outputSchema: z.unknown(), signal: readSignal })); }
        catch { if (signal.aborted) throw new GtdError('cancelled'); warnings.add(readSignal.aborted ? 'scan_limit' : 'source_partial'); return; }
        if (page.incomplete) warnings.add('source_partial');
        for (const child of page.entries) {
          if (++visited > 5000 || readSignal.aborted) { warnings.add('scan_limit'); break; }
          const path = `${scope}/${child.name}`;
          if (!relativeFolder.safeParse(path).success) { warnings.add(kind === 'project' ? 'invalid_project' : 'invalid_area'); continue; }
          if (kind === 'project' && child.kind === 'directory' && status === undefined && Object.hasOwn(aliases, child.name.toLowerCase())) {
            await enumerate(path, aliases[child.name.toLowerCase()]);
          } else if (child.kind === 'directory') {
            if (!entries.has(path) && !invalidRoots.has(path)) {
              if (!text(child.name, 240)) warnings.add(kind === 'project' ? 'invalid_project' : 'invalid_area');
              else if (entries.size >= 5000) warnings.add('scan_limit');
              else entries.set(path, kind === 'project' ? { id: path + '/', title: child.name, status: status ?? 'active' } : { id: path + '/', title: child.name });
            }
          } else if (child.kind === 'markdown' && !seenRoots.has(path.slice(0, -3))) {
            // An enumerated root note whose metadata was omitted is not a
            // confirmed folder-only/default-metadata project.
            warnings.add('source_partial');
            const key = path.slice(0, -3); invalidRoots.add(key); entries.delete(key);
          }
        }
      };
      await enumerate(folder);
    }
    if (signal.aborted) throw new GtdError('cancelled');
    // Resolve README ownership after both scans so a legacy sibling keeps its
    // existing ID and metadata regardless of page order.
    for (const [key, item] of readmes) {
      if (seenRoots.has(key) || invalidRoots.has(key)) continue;
      if (item === 'invalid') {
        warnings.add('invalid_project');
        entries.delete(key);
      } else {
        entries.set(key, item);
      }
    }
    if (kind === 'project' && this.config.areasFolder) {
      // Older producers can consult bodies or interpret the old YAML key.
      // Do not call them or treat a raw property as a resolved Area ID.
      if (state.projectAreasVersion !== 1 || state.projectAreasFrontmatterOnly !== true || state.projectAreasDeclarationKey !== projectAreasDeclarationKey) warnings.add('source_partial');
      else {
        const areaFolder = [this.config.root, this.config.areasFolder].filter(Boolean).join('/');
        const roots = [...entries.values()].flatMap(item => {
          const notePath = 'notePath' in item ? item.notePath : undefined;
          return notePath || item.id.endsWith('.md') ? [{ item: item as Project, path: notePath ?? item.id }] : [];
        });
        const assignments = new Map<Project, string>();
        let authority: z.infer<typeof relationshipAuthority> | undefined;
        for (let start = 0; start < roots.length; start += 50) {
          if (readSignal.aborted) { warnings.add('scan_limit'); break; }
          const batch = roots.slice(start, start + 50);
          try {
            // A producer rolled back after status either lacks this method
            // or rejects declarationKey before the older resolver can run.
            const page = relationshipPage.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'projectAreasFromFrontmatter', input: {
              vaultId: this.config.vaultId, root: this.config.root ?? '', areaFolder, paths: batch.map(root => root.path), declarationKey: projectAreasDeclarationKey, ...(authority ? { expectedAuthority: authority } : {}),
            }, outputSchema: z.unknown(), signal: readSignal }));
            if (authority && (page.authority.revision !== authority.revision || page.authority.route !== authority.route || page.authority.epoch !== authority.epoch)) throw new GtdError('source_unavailable');
            authority = page.authority;
            if (page.incomplete) warnings.add('source_partial');
            for (const { item, path } of batch) {
              const matches = page.rows.filter(row => row.path === path);
              if (matches.length !== 1) { warnings.add('source_partial'); continue; }
              const row = matches[0];
              if (row.status === 'resolved') {
                if (!row.areaId?.startsWith(areaFolder + '/') || !relativeFolder.safeParse(row.areaId.replace(/\/$/, '')).success) warnings.add('source_partial');
                else assignments.set(item, row.areaId);
              }
            }
          } catch {
            if (signal.aborted) throw new GtdError('cancelled');
            warnings.add(readSignal.aborted ? 'scan_limit' : 'source_partial');
            // Isolated omissions are successful, partial pages. A failed RPC
            // cannot confirm source authority for the rows staged so far.
            assignments.clear();
            break;
          }
        }
        for (const [item, areaId] of assignments) item.areaId = areaId;
      }
    }
    if (signal.aborted) throw new GtdError('cancelled');
    items.push(...entries.values());
    const source = vault.source;
    return { items, complete: warnings.size === 0, warnings: [...warnings], source: {
      backend: 'obsidian', id: vault.vaultId, name: this.config.root?.split('/').at(-1) ?? vault.name ?? 'Obsidian vault', scope: this.config.folder, observedAt,
      lastSuccessfulSync: source.lastSuccess,
      sync: { connected: source.cloudConnected, enabled: source.enabled, phase: source.phase, failure: source.failure },
    } };
  }
}
export async function connectedVaults(sdk: BbPluginApi['sdk'], signal: AbortSignal) {
  try {
    const state = await vaultOptions(sdk, signal);
    if (state.incomplete) throw new GtdError('source_unavailable');
    return state.vaults.map(vault => ({ id: vault.selection, name: vault.name, available: true }));
  } catch { throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable'); }
}
