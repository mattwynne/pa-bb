import { correspondenceLinks } from '../core/correspondence.ts';
import { posix } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { nextAction, noteSection, inventoryRevision, noteSaveReceipt, standardSaveResult, type areaStandardInput, type createProjectInput, type createProjectResult } from '../contract.ts';
import { areaSnapshotSchema, GtdError, snapshotSchema } from '../core/model.ts';
import type { Area, AreaBackend, Project, ProjectBackend, ProjectStatus, Warning } from '../core/model.ts';

export const relativeFolder = z.string().min(1).max(1024).refine(value =>
  !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..'),
  'Use a relative folder such as Projects or Life/Projects, without a trailing slash.');
export const vaultIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
export const vaultSelectionSchema = z.string().min(1).max(1100).refine(value => {
  const [id, ...parts] = value.split('/');
  return vaultIdSchema.safeParse(id).success && (!parts.length || relativeFolder.safeParse(parts.join('/')).success);
});
const inventorySchema = z.object({
  source: z.object({
    vaultId: vaultIdSchema, name: z.string().nullable(), cloudConnected: z.boolean(), enabled: z.boolean(),
    phase: z.string().max(64), lastSuccess: z.string().nullable(), failure: z.string().max(128).nullable(),
  }),
  notes: z.array(z.object({
    path: relativeFolder, properties: z.record(z.string(), z.unknown()), malformed: z.boolean(),
  })).max(100000),
  folders: z.array(relativeFolder).max(100000),
  incomplete: z.boolean(),
});
export const noteEvidence = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  properties: z.record(z.string(), z.unknown()),
  receipt: noteSaveReceipt.shape.outcome.nullable(),
});
type RpcInput = Parameters<BbPluginApi['sdk']['plugins']['callRpc']>[0]['input'];

export function vaultRpc(sdk: BbPluginApi['sdk'], method: string, input: RpcInput, signal: AbortSignal) {
  return sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method, input, outputSchema: z.unknown(), signal });
}
export async function vaultOptions(sdk: BbPluginApi['sdk'], signal: AbortSignal = AbortSignal.timeout(10000)) {
  const schema = z.object({ vaults: z.array(z.object({ id: vaultIdSchema, root: z.string().max(1024), name: z.string().max(240) })), incomplete: z.boolean() });
  const value = schema.parse(await vaultRpc(sdk, 'vaultLocations', null, signal));
  return { ...value, vaults: value.vaults.map(v => ({ ...v, selection: v.root ? `${v.id}/${v.root}` : v.id })) };
}
export async function readVaultInventory(sdk: BbPluginApi['sdk'], input: {
  vaultId: string; root: string; folders?: string[]; metadataFolders?: string[]; metadataDepth?: number; fields: string[];
}, signal: AbortSignal) {
  const result = inventorySchema.parse(await vaultRpc(sdk, 'vaultInventory', input, signal));
  const withinRoot = (path: string) => !input.root || path === input.root || path.startsWith(input.root + '/');
  if (result.source.vaultId !== input.vaultId || result.notes.some(note => !withinRoot(note.path) || !note.path.endsWith('.md')) ||
      result.folders.some(path => !withinRoot(path))) throw new GtdError('invalid_source');
  return result;
}

const aliases: Record<string, ProjectStatus> = { active: 'active', deferred: 'deferred', someday: 'someday', done: 'done', completed: 'done' };
const within = (path: string, folder: string) => path.startsWith(folder + '/');
const immediate = (path: string, folder: string) => within(path, folder) && !path.slice(folder.length + 1).includes('/');
const basenameKey = (path: string) => posix.basename(path.replace(/\/$/, ''), path.endsWith('/') ? undefined : '.md').toLocaleLowerCase('und');
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value);

function projectStatusFolder(folder: string, path: string) {
  const directory = posix.dirname(path);
  const key = posix.basename(directory).toLowerCase();
  return immediate(directory, folder) && Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}

export function projectFromNote(folder: string, path: string, properties: Record<string, unknown>): Project | 'invalid' | null {
  if (!relativeFolder.safeParse(path).success || !path.endsWith('.md') || !within(path, folder)) return 'invalid';
  const fallback = projectStatusFolder(folder, path);
  if (!immediate(path, folder) && !fallback) return null;
  const status = fallback ?? (properties.status === undefined ? 'active'
    : typeof properties.status === 'string' && Object.hasOwn(aliases, properties.status) ? aliases[properties.status] : undefined);
  const title = posix.basename(path).slice(0, -3);
  return status && text(title) ? { id: path, status, title: title.trim() } : 'invalid';
}

export function areaFromNote(folder: string, path: string): Area | 'invalid' | null {
  if (!relativeFolder.safeParse(path).success || !path.endsWith('.md') || !within(path, folder)) return 'invalid';
  if (!immediate(path, folder)) return null;
  const title = posix.basename(path).slice(0, -3);
  return text(title) ? { id: path, title } : 'invalid';
}

export function areaLookup(root: string, areaFolder: string, notes: Set<string>, folders: Set<string>) {
  const names = new Map<string, string | null>();
  const add = (path: string) => {
    const key = basenameKey(path);
    names.set(key, names.has(key) ? null : path);
  };
  for (const path of notes) add(path);
  for (const path of folders) if (immediate(path, areaFolder) && !notes.has(path + '.md')) add(path + '/');
  return (raw: unknown, source: string) => {
    const refs = Array.isArray(raw) ? raw : [raw];
    if (!refs.length || refs.length > 8) return;
    let resolved: string | undefined;
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ref.trim() || ref.length > 1024 || ref.startsWith('!')) return;
      const directory = ref.slice(0, -1);
      if (within(ref, areaFolder) && (notes.has(ref) ||
          (ref.endsWith('/') && folders.has(directory) && !notes.has(directory + '.md')))) {
        if (resolved && resolved !== ref) return;
        resolved = ref;
        continue;
      }
      let target: string;
      try { target = decodeURIComponent(ref.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]); }
      catch { return; }
      if (!target || target.includes('#') || /[\\\x00-\x1f\x7f]/.test(target) || /^[A-Za-z][\w+.-]*:/.test(target) || target.startsWith('//')) return;
      target = target.replace(/^\//, '').replace(/\/$/, '');
      let match: string | null | undefined;
      if (target.includes('/')) {
        const relative = target.startsWith('./') || target.startsWith('../');
        const path = posix.normalize(relative ? posix.join(posix.dirname(source), target)
          : root && !target.startsWith(root + '/') ? root + '/' + target : target);
        const note = path.endsWith('.md') ? path : path + '.md';
        match = notes.has(note) ? note : folders.has(path) ? path + '/' : undefined;
      } else match = names.get(target.replace(/\.md$/, '').toLocaleLowerCase('und'));
      if (!match || !within(match, areaFolder) || (resolved && resolved !== match)) return;
      resolved = match;
    }
    return resolved;
  };
}

// Request-local file evidence used by explicit changes.
export type ProjectEvidence = { owners: Map<string, Record<string, unknown>>; entries: Set<string> };

export class ObsidianBackend implements ProjectBackend, AreaBackend {
  private generation = 0;

  constructor(private sdk: BbPluginApi['sdk'], private config: { vaultId: string; folder: string; root?: string; areasFolder?: string },
    private evidence?: ProjectEvidence) {}

  invalidate() { this.generation++; }

  async createProject(input: z.infer<typeof createProjectInput>, signal: AbortSignal, beforeSave: () => Promise<void>): Promise<z.infer<typeof createProjectResult>> {
    const { vaultId, root = '', areasFolder, folder } = this.config;
    if (input.source !== vaultId || !areasFolder) throw new GtdError('invalid_source');
    const areaFolder = this.scope(areasFolder);
    const projectFolder = this.scope(folder);
    const areaPath = input.id.replace(/\/$/, '');
    if (!relativeFolder.safeParse(areaPath).success || !immediate(areaPath, areaFolder)) throw new GtdError('invalid_source');
    const id = `${projectFolder}/${input.name}.md`;
    if (!relativeFolder.safeParse(id).success) throw new GtdError('invalid_source');
    const generation = this.generation;
    const inventory = await readVaultInventory(this.sdk, {
      vaultId, root, folders: [...new Set([areaFolder, projectFolder])],
      metadataFolders: [areaFolder], metadataDepth: 1, fields: ['area'],
    }, signal);
    const notes = new Set(inventory.notes.map(note => note.path));
    const folders = new Set(inventory.folders);
    if (inventory.incomplete || !folders.has(projectFolder) ||
        (input.id.endsWith('/') ? !folders.has(areaPath) || notes.has(areaPath + '.md')
          : !areaPath.endsWith('.md') || !inventory.notes.some(note => note.path === areaPath && !note.malformed)) ||
        areaLookup(root, areaFolder, notes, folders)(input.id, id) !== input.id) throw new GtdError('invalid_source');
    if (notes.has(id) || folders.has(id)) return { state: 'exists' };

    await beforeSave();
    this.checkGeneration(generation, signal);
    try {
      const result = noteSaveReceipt.extend({ reason: z.literal('conflict').optional() }).parse(await vaultRpc(this.sdk, 'createNote', {
        vaultId, path: id, operationId: input.operationId,
        text: `---\narea: ${JSON.stringify(input.id)}\n---\n`,
      }, signal));
      if (result.operationId !== input.operationId || result.outcome === 'uncertain') return { state: 'uncertain' };
      if (result.outcome === 'not_saved') return { state: result.reason === 'conflict' ? 'exists' : 'blocked' };
      return { state: 'created', id };
    } catch {
      return { state: 'uncertain' };
    }
  }

  private standardTarget(source: string, id: string) {
    if (source !== this.config.vaultId || !relativeFolder.safeParse(id).success ||
        !immediate(id, this.scope(this.config.areasFolder ?? this.config.folder)) || !id.endsWith('.md')) throw new GtdError('invalid_source');
    return { vaultId: source, path: id, heading: 'Standard' };
  }

  private projectSection(source: string, id: string, heading: string) {
    if (source !== this.config.vaultId) throw new GtdError('invalid_source');
    const project = projectFromNote(this.scope(this.config.folder), id, {});
    if (!project || project === 'invalid') throw new GtdError('invalid_source');
    return { vaultId: source, path: id, heading };
  }

  async readNextAction({ source, id }: { source: string; id: string }, signal: AbortSignal) {
    return nextAction.parse(await vaultRpc(this.sdk, 'readSectionTask', this.projectSection(source, id, 'TODO'), signal));
  }

  async readCorrespondence({ source, id }: { source: string; id: string }, signal: AbortSignal) {
    const result = correspondenceLinks.extend({ hash: noteEvidence.shape.hash }).parse(
      await vaultRpc(this.sdk, 'readSectionLinks', this.projectSection(source, id, 'Correspondence'), signal),
    );
    return { links: result.links, incomplete: result.incomplete };
  }

  async readAreaStandard({ source, id }: { source: string; id: string }, signal: AbortSignal) {
    return noteSection.parse(await vaultRpc(this.sdk, 'readNoteSection', this.standardTarget(source, id), signal));
  }

  async saveAreaStandard({ source, id, ...change }: z.infer<typeof areaStandardInput>, signal: AbortSignal) {
    const result = standardSaveResult.parse(await vaultRpc(this.sdk, 'writeNoteSection', { ...this.standardTarget(source, id), ...change }, signal));
    if (result.operationId !== change.operationId) throw new Error('Obsidian returned a different operation receipt.');
    return result;
  }

  private scope(folder: string) { return [this.config.root, folder].filter(Boolean).join('/'); }

  async inventoryRevision(signal: AbortSignal) {
    const folders = [...new Set([this.scope(this.config.folder), this.scope(this.config.areasFolder ?? this.config.folder)])];
    return inventoryRevision.parse(await vaultRpc(this.sdk, 'inventoryRevision', { vaultId: this.config.vaultId, folders }, signal));
  }

  async checkAccess(signal: AbortSignal) {
    const generation = this.generation;
    const result = await readVaultInventory(this.sdk, {
      vaultId: this.config.vaultId, root: this.config.root ?? '', folders: [], fields: [],
    }, signal);
    if (result.incomplete || result.notes.length || result.folders.length) throw new GtdError('source_unavailable');
    this.checkGeneration(generation, signal);
  }

  private checkGeneration(generation: number, signal: AbortSignal) {
    if (signal.aborted) throw new GtdError('cancelled');
    if (generation !== this.generation) throw new GtdError('source_unavailable');
  }

  async readProjects(signal: AbortSignal) {
    return (await this.load(signal, true, false)).projects!;
  }

  async readAreas(signal: AbortSignal) {
    return (await this.load(signal, false, true)).areas!;
  }

  async readBoth(signal: AbortSignal) {
    const { projects, areas } = await this.load(signal, true, true);
    return { projects: projects!, areas: areas! };
  }

  private async load(signal: AbortSignal, projects: boolean, areas: boolean) {
    const generation = this.generation;
    const root = this.config.root ?? '';
    const projectFolder = this.scope(this.config.folder);
    const areaFolder = this.scope(this.config.areasFolder ?? this.config.folder);
    try {
      const inventory = await readVaultInventory(this.sdk, {
        vaultId: this.config.vaultId, root,
        ...(projects ? {} : { folders: [areaFolder] }),
        metadataFolders: projects ? [...new Set([projectFolder, areaFolder])] : [areaFolder],
        metadataDepth: projects ? 2 : 1,
        fields: projects ? ['status', 'area'] : [],
      }, signal);
      this.checkGeneration(generation, signal);
      const notes = new Set(inventory.notes.map(note => note.path));
      const folders = new Set(inventory.folders);
      const vault = inventory.source;
      const observedAt = new Date().toISOString();
      const source = (scope: string) => ({
        backend: 'obsidian', id: vault.vaultId, name: root.split('/').at(-1) || vault.name || 'Obsidian vault',
        scope, observedAt, lastSuccessfulSync: vault.lastSuccess,
        sync: { connected: vault.cloudConnected, enabled: vault.enabled, phase: vault.phase, failure: vault.failure },
      });
      for (const path of folders) this.evidence?.entries.add(path);
      for (const path of notes) this.evidence?.entries.add(path);
      const warnings = (): Set<Warning> => new Set(notes.size < inventory.notes.length ? ['duplicate_id'] : []);
      const projectWarnings = warnings();
      const areaWarnings = warnings();
      if (inventory.incomplete || !folders.has(projectFolder) || (this.config.areasFolder && !folders.has(areaFolder))) projectWarnings.add('source_partial');
      if (inventory.incomplete || !folders.has(areaFolder)) areaWarnings.add('source_partial');
      const projectRows: Project[] = [], areaRows: Area[] = [];
      const badProjects: string[] = [];
      const resolveArea = areaLookup(root, areaFolder, notes, folders);
      for (const note of inventory.notes) {
        const { path, properties, malformed } = note;
        if (projects && (immediate(path, projectFolder) || projectStatusFolder(projectFolder, path))) {
          const project = malformed ? 'invalid' : projectFromNote(projectFolder, path, properties);
          if (project === 'invalid') {
            projectWarnings.add('invalid_project');
            if (malformed && badProjects.length < 12) badProjects.push(path);
          } else if (project) {
            if (this.config.areasFolder && !projectWarnings.has('source_partial') && !projectWarnings.has('duplicate_id')) {
              const areaId = resolveArea(properties.area, path);
              if (areaId) project.areaId = areaId;
            }
            projectRows.push(project);
            this.evidence?.owners.set(path, properties);
          }
        }
        if (areas && immediate(path, areaFolder)) {
          const area = areaFromNote(areaFolder, path);
          if (area === 'invalid') areaWarnings.add('invalid_area');
          else if (area) areaRows.push(area);
        }
      }
      if (areas && !areaWarnings.has('source_partial')) for (const folder of folders) {
        if (!immediate(folder, areaFolder) || notes.has(folder + '.md')) continue;
        const title = posix.basename(folder);
        if (text(title)) areaRows.push({ id: folder + '/', title });
        else areaWarnings.add('invalid_area');
      }
      const coverage = (items: Project[] | Area[], warnings: Set<Warning>, malformed: string[]) => {
        if (items.length > 5000) warnings.add('scan_limit');
        return { complete: !warnings.size, warnings: [...warnings],
          ...(malformed.length ? { malformedFrontmatter: malformed } : {}) };
      };
      return {
        projects: projects ? snapshotSchema.parse({ source: source(this.config.folder),
          ...coverage(projectRows, projectWarnings, badProjects), projects: projectRows.slice(0, 5000) }) : undefined,
        areas: areas ? areaSnapshotSchema.parse({ source: source(this.config.areasFolder ?? this.config.folder),
          ...coverage(areaRows, areaWarnings, []), areas: areaRows.slice(0, 5000) }) : undefined,
      };
    } catch (error) {
      if (signal.aborted) throw new GtdError('cancelled');
      if (error instanceof GtdError) throw error;
      if (error instanceof z.ZodError) throw new GtdError('invalid_source');
      const refusal = z.object({ code: z.literal('unknown_method') }).safeParse(error);
      const envelope = z.object({ body: z.object({ error: z.object({ code: z.literal('unknown_method') }) }) }).safeParse(error);
      throw new GtdError(refusal.success || envelope.success ? 'incompatible' : 'source_unavailable');
    }
  }
}

export async function connectedVaults(sdk: BbPluginApi['sdk'], signal: AbortSignal) {
  try {
    const state = await vaultOptions(sdk, signal);
    if (state.incomplete) throw new GtdError('source_unavailable');
    return state.vaults.map(vault => ({ id: vault.selection, name: vault.name, available: true }));
  } catch { throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable'); }
}
