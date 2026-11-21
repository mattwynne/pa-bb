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
const statusSchema = z.object({
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
const childrenPage = z.object({ entries: z.array(z.object({ name: z.string().min(1).max(1024).refine(value => !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..'), kind: z.enum(['directory', 'markdown']) }).strict()).max(5000), incomplete: z.boolean() }).strict();
const aliases: Record<string, ProjectStatus> = { active: 'active', deferred: 'deferred', someday: 'someday', done: 'done', completed: 'done' };
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function projectEntry(folder: string, path: string) {
  if (!relativeFolder.safeParse(path).success || !path.startsWith(folder + '/') || !path.endsWith('.md')) return null;
  const parts = path.slice(folder.length + 1).split('/');
  const grouped = parts.length > 1 && Object.hasOwn(aliases, parts[0].toLowerCase());
  const prefix = grouped ? parts.shift()! + '/' : '';
  const rootNote = parts.length === 1;
  return { key: `${folder}/${prefix}${rootNote ? parts[0].slice(0, -3) : parts[0]}`, rootNote };
}
export function projectFromNote(folder: string, path: string, properties: Record<string, unknown>): Project | 'invalid' | null {
  const entry = projectEntry(folder, path);
  if (!entry) return 'invalid';
  const parts = path.slice(folder.length + 1).split('/');
  // Folder membership defines projects; a status folder overrides old frontmatter.
  const folderStatus = parts.length > 1 && Object.hasOwn(aliases, parts[0].toLowerCase()) ? parts.shift()!.toLowerCase() : undefined;
  // Only the explicit root note owns metadata. Descendants establish a folder
  // entry, but their title/type/status/area must never classify that project.
  if (parts.length > 1) return text(parts[0], 240) ? { id: entry.key + '/', title: parts[0], status: folderStatus ? aliases[folderStatus] : 'active' } : 'invalid';
  const status = folderStatus ? aliases[folderStatus] : properties.status === undefined ? 'active'
    : typeof properties.status === 'string' && Object.hasOwn(aliases, properties.status) ? aliases[properties.status] : undefined;
  if (!status) return 'invalid';
  const title = properties.title === undefined ? parts.at(-1)!.slice(0, -3) : properties.title;
  if (!text(title, 240)) return 'invalid';
  const areaId = properties.areaId ?? undefined;
  if (areaId !== undefined && !relativeFolder.safeParse(areaId).success) return 'invalid';
  return { id: path, title: (title as string).trim(), status, ...(typeof areaId === 'string' ? { areaId } : {}) };
}

export function areaFromNote(folder: string, path: string, properties: Record<string, unknown>): Area | 'invalid' | null {
  if (!path.startsWith(folder + '/') || !path.endsWith('.md') || /[\\\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return 'invalid';
  const title = properties.title === undefined ? path.split('/').at(-1)!.slice(0, -3) : properties.title;
  if (!text(title, 240)) return 'invalid';
  return { id: path, title: (title as string).trim() };
}

export class ObsidianBackend implements ProjectBackend, AreaBackend {
  constructor(private sdk: BbPluginApi['sdk'], private config: { vaultId: string; folder: string; root?: string }, private cleanupFailure: () => void = () => {}) {}
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
    if (kind === 'project' && state.childrenAccessVersion !== 1) warnings.add('directory_enumeration_unavailable');
    const entries = new Map<string, Project>();
    const invalidRoots = new Set<string>(), seenRoots = new Set<string>();
    let cursor: string | undefined, pages = 0, notes = 0, observedAt = new Date().toISOString();
    try {
      do {
        if (pages++ >= 128 || notes >= 5000 || readSignal.aborted) { warnings.add('scan_limit'); break; }
        let page: z.infer<typeof propertyPage>;
        try { page = propertyPage.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'listProperties', input: {
          vaultId: this.config.vaultId, folder: this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder, fields: ['type', 'status', 'title', 'areaId'], ...(cursor ? { cursor } : {}),
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
          const item = (kind === 'area' ? areaFromNote : projectFromNote)(this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder, note.path, note.properties);
          if (kind === 'area') {
            if (item === 'invalid') warnings.add('invalid_area'); else if (item) items.push(item);
          } else {
            // Pair by exact entry path, not display title; root notes win even
            // when their supporting-folder evidence arrives on a later page.
            const entry = projectEntry(this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder, note.path);
            if (entry?.rootNote) { if (seenRoots.has(entry.key)) warnings.add('duplicate_id'); seenRoots.add(entry.key); }
            if (!entry || item === 'invalid') { warnings.add('invalid_project'); if (entry?.rootNote) { entries.delete(entry.key); invalidRoots.add(entry.key); } }
            else if (item && !invalidRoots.has(entry.key) && (!entries.has(entry.key) || entry.rootNote)) entries.set(entry.key, item as Project);
          }
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
    if (kind === 'project' && state.childrenAccessVersion === 1) {
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
          if (!relativeFolder.safeParse(path).success) { warnings.add('invalid_project'); continue; }
          if (child.kind === 'directory' && status === undefined && Object.hasOwn(aliases, child.name.toLowerCase())) {
            await enumerate(path, aliases[child.name.toLowerCase()]);
          } else if (child.kind === 'directory') {
            if (!entries.has(path) && !invalidRoots.has(path)) {
              if (!text(child.name, 240)) warnings.add('invalid_project');
              else if (entries.size >= 5000) warnings.add('scan_limit');
              else entries.set(path, { id: path + '/', title: child.name, status: status ?? 'active' });
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
    if (kind === 'project') items.push(...entries.values());
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
