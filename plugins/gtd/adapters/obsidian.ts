import { experimental_PluginRpcCallError, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { renameResult } from '../contract.ts';
import { areaSnapshotSchema, GtdError, snapshotSchema } from '../core/model.ts';
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
  inventoryBatchVersion: z.number().int().optional(),
  inventoryEvidenceVersion: z.number().int().optional(),
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
const propertiesPage = z.object({ status: z.enum(['observed', 'missing', 'partial']), properties: z.record(z.string(), z.unknown()), unsupported: z.array(z.string()).max(8) }).strict();
const targetPage = z.object({ status: z.enum(['unsupported', 'incomplete', 'ambiguous', 'matched', 'missing']), matches: z.array(z.object({ path: relativeFolder, kind: z.enum(['markdown', 'directory']) }).strict()).max(3), basename: z.string().nullable(), fragment: z.boolean(), embed: z.boolean(), incomplete: z.boolean() }).strict();
const envelope = z.object({ authority: relationshipAuthority, publication: z.string().uuid().nullable() });
const batchPage = envelope.extend({ rows: z.array(z.discriminatedUnion('kind', [
  childrenPage.extend({ kind: z.literal('children') }),
  propertiesPage.extend({ kind: z.literal('properties') }),
  targetPage.extend({ kind: z.literal('target') }),
])).max(128) }).strict();
type Proof = z.infer<typeof envelope>;
type Request = { kind: 'children'; folder: string } | { kind: 'properties'; path: string; fields: string[] } | { kind: 'target'; path: string; reference: string };
type RpcInput = Parameters<BbPluginApi['sdk']['plugins']['callRpc']>[0]['input'];
const httpRefusal = z.object({
  status: z.number().int(),
  body: z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(['unknown_method', 'invalid']),
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])).optional(), message: z.string() })).optional(),
  }) }),
});
function rpcRefusal(error: unknown) {
  if (error instanceof experimental_PluginRpcCallError) return error;
  // Server-side inter-plugin calls use BB's HTTP SDK. Its structured refusal
  // is nested in the response body instead of on the error instance.
  const value = httpRefusal.safeParse(error);
  if (value.success) {
    const { status, body } = value.data;
    if (status === (body.error.code === 'invalid' ? 422 : 404)) return body.error;
  }
}
function batchRefused(error: unknown, reason: 'output_limit' | 'incompatible') {
  const refusal = rpcRefusal(error);
  return refusal?.code === 'invalid' && refusal.issues?.some(issue =>
    issue.path?.length === 1 && issue.path[0] === 'requests' && issue.message === reason);
}
type Row = z.infer<typeof batchPage>['rows'][number];
type ChildrenRow = Extract<Row, { kind: 'children' }>;
type CheckedProbe = { proof: Proof; children: Map<string, ChildrenRow> };
type Inventory = { items: (Project | Area)[]; complete: boolean; warnings: Warning[]; observedAt: string };
type Kind = 'project' | 'area';
const sameProof = (left: Proof, right: Proof) =>
  left.publication === right.publication && left.authority.route === right.authority.route &&
  left.authority.epoch === right.authority.epoch && left.authority.revision === right.authority.revision;

class IndexedEvidence {
  private children = new Map<string, Promise<ChildrenRow>>();
  private calls = 0;
  private verification?: Promise<Row[]>;
  private queue: Array<{ request: Request; resolve: (row: Row) => void; reject: (error: unknown) => void }> = [];

  constructor(private rpc: (method: string, input: object) => Promise<unknown>, readonly proof: Proof, readonly signal: AbortSignal) {}

  private async call(method: string, input: object) {
    this.signal.throwIfAborted();
    if (++this.calls > 50000) throw new GtdError('source_unavailable');
    const raw = await this.rpc(method, { ...input, expectedAuthority: this.proof.authority, publication: this.proof.publication });
    if (!sameProof(this.proof, envelope.parse(raw))) throw new GtdError('source_unavailable');
    this.signal.throwIfAborted();
    return raw;
  }

  private async batch(requests: Request[]): Promise<Row[]> {
    let raw: unknown;
    try { raw = await this.call('inventoryBatch', { requests }); }
    catch (error) {
      if (!batchRefused(error, 'output_limit')) throw error;
      if (requests.length > 1) {
        const middle = Math.floor(requests.length / 2);
        return [...await this.batch(requests.slice(0, middle)), ...await this.batch(requests.slice(middle))];
      }
      if (!requests.length) throw error;
      const [request] = requests;
      const { kind, ...input } = request;
      const method = { children: 'inventoryChildren', properties: 'inventoryProperties', target: 'inventoryTarget' }[kind];
      const row = await this.call(method, input);
      const schema = { children: childrenPage, properties: propertiesPage, target: targetPage }[kind];
      const { authority, publication, ...fields } = envelope.extend(schema.shape).strict().parse(row);
      return [{ kind, ...fields } as Row];
    }
    const { rows } = batchPage.parse(raw);
    if (rows.length !== requests.length || rows.some((row, i) => row.kind !== requests[i].kind)) throw new GtdError('invalid_source');
    return rows;
  }

  async verify() {
    // Readers assembling the same publication can share a proof check if all
    // their evidence has settled by the time the check is dispatched.
    this.verification ??= new Promise((resolve, reject) => {
      setImmediate(() => {
        this.verification = undefined;
        void this.batch([]).then(resolve, reject);
      });
    });
    await this.verification;
  }

  read<K extends Request['kind']>(request: Extract<Request, { kind: K }>): Promise<Extract<Row, { kind: K }>> {
    return new Promise<Row>((resolve, reject) => {
      if (!this.queue.length) setImmediate(() => void this.flush());
      this.queue.push({ request, resolve, reject });
    }) as Promise<Extract<Row, { kind: K }>>;
  }

  seedChildren(rows: ReadonlyMap<string, ChildrenRow>) {
    for (const [folder, row] of rows) if (!this.children.has(folder)) this.children.set(folder, Promise.resolve(row));
  }

  readChildren(folder: string) {
    let page = this.children.get(folder);
    if (!page) {
      page = this.read<'children'>({ kind: 'children', folder });
      this.children.set(folder, page);
    }
    return page;
  }

  private async flush() {
    const queued = this.queue;
    this.queue = [];
    try {
      for (let start = 0; start < queued.length; start += 128) {
        const chunk = queued.slice(start, start + 128);
        const rows = await this.batch(chunk.map(entry => entry.request));
        chunk.forEach((entry, i) => entry.resolve(rows[i]));
      }
    } catch (error) {
      for (const entry of queued) entry.reject(error);
    }
  }
}

type Assembly = {
  proof: Proof;
  controller: AbortController;
  evidence: IndexedEvidence;
  waiters: number;
  parts: Map<Kind, Promise<Inventory>>;
};
type Cached = { proof: Proof; parts: Map<Kind, Inventory> };

function awaitInventory<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new GtdError('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}

const aliases: Record<string, ProjectStatus> = { active: 'active', deferred: 'deferred', someday: 'someday', done: 'done', completed: 'done' };
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function projectEntry(folder: string, path: string, statusGroups = true) {
  if (!relativeFolder.safeParse(path).success || !path.startsWith(folder + '/') || !path.endsWith('.md')) return null;
  const parts = path.slice(folder.length + 1).split('/');
  const grouped = statusGroups && parts.length > 1 && Object.hasOwn(aliases, parts[0].toLowerCase());
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
  if (!entry.rootNote) return text(parts[0], 240) ? { id: entry.key + '/', title: parts[0], status: folderStatus ? aliases[folderStatus] : 'active' } : 'invalid';
  const status = folderStatus ? aliases[folderStatus] : properties.status === undefined ? 'active'
    : typeof properties.status === 'string' && Object.hasOwn(aliases, properties.status) ? aliases[properties.status] : undefined;
  if (!status) return 'invalid';
  const title = properties.title === undefined ? parts[0].slice(0, -3) : properties.title;
  if (!text(title, 240)) return 'invalid';
  return {
    id: path,
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

function areaReferences(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values.length <= 8 && values.every(value => typeof value === 'string' && value.trim() && value.length <= 1024) ? values as string[] : [];
}

function areaTarget(page: z.infer<typeof targetPage>, areaFolder: string, directories: Array<{ name: string }>) {
  if (page.incomplete || page.fragment || page.embed || page.status === 'unsupported' || page.status === 'ambiguous') return;
  const candidates = page.matches.filter(match => match.kind === 'markdown');
  let target: string | undefined;
  if (page.basename) {
    const folders = directories.filter(entry => entry.name.toLocaleLowerCase('und') === page.basename);
    if (candidates.length + folders.length === 1) target = candidates[0]?.path ?? `${areaFolder}/${folders[0].name}/`;
  } else target = candidates[0]?.path ?? page.matches.find(match => match.kind === 'directory')?.path.concat('/');
  if (target?.startsWith(areaFolder + '/')) return target;
}

// Optional observations for the explicitly requested migration preview only.
export type PreviewEvidence = { owners: Map<string, Record<string, unknown>>; entries: Set<string>; proof?: { expectedAuthority: z.infer<typeof relationshipAuthority>; publication?: string } };
export class ObsidianBackend implements ProjectBackend, AreaBackend {
  constructor(private sdk: BbPluginApi['sdk'], private config: { vaultId: string; folder: string; root?: string; areasFolder?: string }, private cleanupFailure: () => void = () => {}, private preview?: PreviewEvidence) {}
  async rename(id: string, title: string, signal: AbortSignal) {
    const folder = this.config.root ? `${this.config.root}/${this.config.folder}` : this.config.folder;
    if (!relativeFolder.safeParse(id).success || !id.startsWith(folder + '/') || !id.endsWith('.md')) throw new GtdError('invalid_source');
    await this.checkAccess(signal);
    // Renaming the display property keeps backend path identity and all links unchanged.
    return renameResult.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'renameTitle', input: { vaultId: this.config.vaultId, path: id, title }, outputSchema: z.unknown(), signal }));
  }
  private hasBatch = false;
  private current?: Assembly;
  private active = new Set<Assembly>();
  private generation = 0;
  private cached?: Cached;

  invalidate() {
    this.generation++;
    for (const assembly of this.active) assembly.controller.abort();
    this.active.clear();
    this.current = undefined;
    this.cached = undefined;
  }

  private rpc(method: string, input: RpcInput, signal: AbortSignal) {
    return this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method, input, outputSchema: z.unknown(), signal });
  }

  private async status(signal: AbortSignal, preferInventoryStatus: boolean) {
    if (!this.preview && (this.hasBatch || preferInventoryStatus)) {
      try { return statusSchema.parse(await this.rpc('inventoryStatus', null, signal)); }
      catch (error) {
        if (rpcRefusal(error)?.code !== 'unknown_method') throw error;
      }
    }
    return statusSchema.parse(await this.rpc('status', null, signal));
  }

  private async access(signal: AbortSignal, preferInventoryStatus = false, primeFolders: string[] = []) {
    try {
      const stateRead = this.status(signal, preferInventoryStatus);
      // Check the route and read source metadata in parallel. The combined
      // reader can try both on first use; an older producer will use status
      // and the existing single-read inventory path.
      const [stateResult, early] = await Promise.allSettled([
        stateRead, !this.preview && (this.hasBatch || preferInventoryStatus) ? this.probe(signal, primeFolders) : undefined,
      ]);
      if (stateResult.status === 'rejected') throw stateResult.reason;
      const state = stateResult.value;
      this.hasBatch = state.inventoryBatchVersion === 1;
      if (state.propertiesAccessVersion !== 1) throw new GtdError('incompatible');
      const vault = this.selectedVault(state);
      let probe: CheckedProbe | undefined;
      if (!this.preview && this.hasBatch) {
        if (early.status === 'rejected') {
          if (!primeFolders.length || (!batchRefused(early.reason, 'incompatible') && !batchRefused(early.reason, 'output_limit'))) throw early.reason;
          probe = await this.probe(signal);
        } else probe = early.value ?? await this.probe(signal);
      }
      if (!probe?.proof.publication && this.config.root) {
        const options = await vaultOptions(this.sdk, signal);
        if (!options.vaults.some(option => option.id === this.config.vaultId && option.root === this.config.root)) throw new GtdError('source_unavailable');
      }
      if (signal.aborted) throw new GtdError('cancelled');
      return { state, vault, probe };
    } catch (error) {
      // Permission loss or a failed proof invalidates assembled evidence.
      // Cancellation belongs only to the caller and need not evict another read.
      if (signal.aborted) throw new GtdError('cancelled');
      this.invalidate();
      throw error instanceof GtdError ? error : new GtdError('source_unavailable');
    }
  }

  private selectedVault(state: z.infer<typeof statusSchema>) {
    const vault = state.vaults.find(candidate => candidate.vaultId === this.config.vaultId);
    if (!vault?.source?.local.available) throw new GtdError('source_unavailable');
    return vault;
  }

  private async probe(signal: AbortSignal, folders: string[] = []): Promise<CheckedProbe> {
    const { authority, publication, rows } = batchPage.parse(await this.rpc('inventoryBatch', {
      vaultId: this.config.vaultId, root: this.config.root ?? '', requests: folders.map(folder => ({ kind: 'children', folder })),
    }, signal));
    if (rows.length !== folders.length || (authority.route === 'index') !== (publication !== null) || (rows.length && !publication)) {
      throw new GtdError('invalid_source');
    }
    const children = new Map<string, ChildrenRow>();
    rows.forEach((row, index) => {
      if (row.kind !== 'children') throw new GtdError('invalid_source');
      children.set(folders[index], row);
    });
    signal.throwIfAborted();
    return { proof: { authority, publication }, children };
  }

  async checkAccess(signal: AbortSignal) { await this.access(signal); }

  async readProjects(signal: AbortSignal, fresh = false): Promise<ProjectSnapshot> {
    return snapshotSchema.parse((await this.load(['project'], signal, fresh))[0]);
  }

  async readAreas(signal: AbortSignal): Promise<AreaSnapshot> {
    return areaSnapshotSchema.parse((await this.load(['area'], signal))[0]);
  }

  async readBoth(signal: AbortSignal, fresh = false) {
    const [projects, areas] = await this.load(['project', 'area'], signal, fresh);
    return { projects: snapshotSchema.parse(projects), areas: areaSnapshotSchema.parse(areas) };
  }

  private folder(kind: Kind) {
    return kind === 'area' ? this.config.areasFolder ?? this.config.folder : this.config.folder;
  }

  private async load(kinds: Kind[], signal: AbortSignal, fresh = false) {
    let generation = this.generation;
    const combined = kinds.length > 1;
    // A cold combined request can get both root catalogs in the same call
    // that establishes the publication. Warm callers only need the proof.
    const prime = combined && (fresh || (!this.cached && !this.current));
    const folders = prime ? [...new Set(kinds.map(kind => [this.config.root, this.folder(kind)].filter(Boolean).join('/')))] : [];
    const { state, vault, probe } = await this.access(signal, combined, folders);
    const proof = probe?.proof;
    if (generation !== this.generation) throw new GtdError('source_unavailable');
    if (fresh) {
      // Start a new assembly while previously validated readers finish.
      this.current = undefined;
      this.cached = undefined;
    }
    if (!proof?.publication && (this.cached || this.active.size)) {
      this.invalidate();
      generation = this.generation;
    }
    const snapshots = [];
    if (probe && proof?.publication) snapshots.push(...await this.assemble(probe, kinds, signal));
    else for (const kind of kinds) snapshots.push(await this.readInventory(signal, kind, state, vault));
    if (generation !== this.generation) throw new GtdError('source_unavailable');
    if (signal.aborted) throw new GtdError('cancelled');
    return snapshots.map(({ items, ...snapshot }, i) => {
      const kind = kinds[i];
      if ('source' in snapshot) return { ...snapshot, [kind === 'project' ? 'projects' : 'areas']: items };
      const source = vault.source!;
      const { observedAt, ...coverage } = snapshot;
      return { ...coverage, [kind === 'project' ? 'projects' : 'areas']: items, source: {
        backend: 'obsidian', id: vault.vaultId, name: this.config.root?.split('/').at(-1) || vault.name || 'Obsidian vault',
        scope: this.folder(kind), observedAt, lastSuccessfulSync: source.lastSuccess,
        sync: { connected: source.cloudConnected, enabled: source.enabled, phase: source.phase, failure: source.failure },
      } };
    });
  }

  private async assemble({ proof, children }: CheckedProbe, kinds: Kind[], signal: AbortSignal): Promise<Inventory[]> {
    if (this.cached && !sameProof(this.cached.proof, proof)) this.cached = undefined;
    const cache: Cached = this.cached ??= { proof, parts: new Map() };
    if (kinds.every(kind => cache.parts.has(kind))) return kinds.map(kind => cache.parts.get(kind)!);

    let assembly = this.current;
    if (!assembly || !sameProof(assembly.proof, proof)) {
      if (this.active.size >= 4) throw new GtdError('capacity');
      const controller = new AbortController();
      const readSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      const evidence = new IndexedEvidence((method, input) => this.rpc(method, {
        vaultId: this.config.vaultId, root: this.config.root ?? '', ...input,
      }, readSignal), proof, readSignal);
      assembly = this.current = { proof, controller, evidence, waiters: 0, parts: new Map() };
      this.active.add(assembly);
    }
    const shared = assembly;
    shared.evidence.seedChildren(children);
    shared.waiters++;
    try {
      return await awaitInventory((async () => {
        const missing: Kind[] = [];
        const results = await Promise.all(kinds.map(kind => {
          const warm = cache.parts.get(kind);
          if (warm) return warm;
          missing.push(kind);
          let loading = shared.parts.get(kind);
          if (!loading) {
            loading = this.readIndexedInventory(kind, shared.evidence);
            shared.parts.set(kind, loading);
          }
          return loading;
        }));
        // One barrier after the last part a caller needs. Cached parts were
        // already checked by this caller's initial publication probe.
        await shared.evidence.verify();
        if (!signal.aborted && this.cached === cache) {
          results.forEach((result, i) => {
            if (missing.includes(kinds[i]) && result.complete &&
              Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024 &&
              result.items.every(item => item.id.length <= 1024)) {
              cache.parts.set(kinds[i], result);
            }
          });
        }
        return results;
      })(), signal);
    } catch {
      if (!signal.aborted && this.cached === cache) this.cached = undefined;
      throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable');
    } finally {
      if (--shared.waiters === 0) {
        shared.controller.abort();
        this.active.delete(shared);
        if (this.current === shared) this.current = undefined;
      }
    }
  }

  private async readIndexedInventory(kind: Kind, evidence: IndexedEvidence): Promise<Inventory> {
    const root = this.config.root ?? '';
    const folder = [root, this.folder(kind)].filter(Boolean).join('/');
    const warnings = new Set<Warning>();
    const items: (Project | Area)[] = [];
    const candidates: Array<{ name: string; path: string; owner?: string; status?: ProjectStatus }> = [];
    let visited = 0, directoriesRead = 0;
    const children = async (scope: string) => {
      if (++directoriesRead > 128) {
        warnings.add('scan_limit');
        return { entries: [], incomplete: true };
      }
      const page = await evidence.readChildren(scope);
      if (page.incomplete) warnings.add('source_partial');
      return page;
    };
    const enumerate = async (scope: string, status?: ProjectStatus) => {
      const page = await children(scope);
      const notes = new Set(page.entries.filter(entry => entry.kind === 'markdown').map(entry => entry.name));
      for (const entry of page.entries) {
        if (++visited > 5000) { warnings.add('scan_limit'); break; }
        const path = `${scope}/${entry.name}`;
        if (!relativeFolder.safeParse(path).success) { warnings.add('source_partial'); continue; }
        const directory = entry.kind === 'directory';
        if (kind === 'project' && directory && status === undefined && Object.hasOwn(aliases, entry.name.toLowerCase())) {
          await enumerate(path, aliases[entry.name.toLowerCase()]);
          continue;
        }
        if (directory && (page.incomplete || notes.has(entry.name + '.md'))) continue;
        candidates.push({ name: entry.name, path, owner: directory ? undefined : path, status });
      }
    };

    // Retain the Area listing for both relationship resolution and the sidebar
    // Area rows. The project scan still accounts for it in its own directory cap.
    await enumerate(folder);
    const fields = kind === 'project' ? ['title', 'status', 'area'] : ['title'];
    const owners = new Map<Project, { path: string; area: unknown }>();
    const properties = await Promise.all(candidates.map(candidate => candidate.owner
      ? evidence.read<'properties'>({ kind: 'properties', path: candidate.owner, fields }) : undefined));
    for (const [i, candidate] of candidates.entries()) {
      const { path, name, status, owner } = candidate;
      const page = properties[i];
      if (page && (page.status === 'partial' || page.unsupported.length)) warnings.add('source_partial');
      if (page && page.status !== 'observed') {
        warnings.add('source_partial');
        continue;
      }
      const invalid = kind === 'project' ? 'invalid_project' : 'invalid_area';
      if (page?.unsupported.some(field => field === 'title' || (field === 'status' && !status))) { warnings.add(invalid); continue; }
      const props = page?.properties ?? {};
      const item = kind === 'project'
        ? owner ? projectFromNote(folder, owner, props) : { id: path + '/', title: name, status: status ?? 'active' }
        : owner ? areaFromNote(folder, owner, props) : { id: path + '/', title: name };
      if (!item || item === 'invalid' || !text(item.title, 240)) { warnings.add(invalid); continue; }
      items.push(item);
      if (kind === 'project' && owner && !page?.unsupported.includes('area')) owners.set(item as Project, { path: owner, area: props.area });
    }
    if (kind === 'project' && this.config.areasFolder) {
      const areaFolder = [root, this.config.areasFolder].filter(Boolean).join('/');
      const page = await children(areaFolder);
      const notes = new Set(page.entries.filter(entry => entry.kind === 'markdown').map(entry => entry.name));
      const directories = page.entries.filter(entry => entry.kind === 'directory' && !notes.has(entry.name + '.md'));
      await Promise.all([...owners].map(async ([item, owner]) => {
        const values = areaReferences(owner.area);
        if (!values.length) return;
        const rows = await Promise.all(values.map(reference => evidence.read<'target'>({ kind: 'target', path: owner.path, reference })));
        if (rows.some(row => row.incomplete)) warnings.add('source_partial');
        const targets = new Set(rows.map(row => areaTarget(row, areaFolder, directories)));
        if (targets.size === 1 && !targets.has(undefined) && !warnings.has('scan_limit') && !page.incomplete) item.areaId = [...targets][0];
      }));
    }
    if (new Set(items.map(item => item.id)).size !== items.length) warnings.add('duplicate_id');
    return { items, complete: warnings.size === 0, warnings: [...warnings], observedAt: new Date().toISOString() };
  }

  private async readImmediateInventory(signal: AbortSignal, kind: 'project' | 'area', vault: z.infer<typeof statusSchema>['vaults'][number]) {
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const root = this.config.root ?? '', folder = [root, this.folder(kind)].filter(Boolean).join('/');
    const warnings = new Set<Warning>();
    const items: (Project | Area)[] = [];
    const owners = new Map<Project, { path: string; area: unknown }>();
    let authority = this.preview?.proof?.expectedAuthority, publication = this.preview?.proof?.publication, calls = 0, visited = 0, directoriesRead = 0;
    let childrenPartial = false;
    const each = async <T>(values: T[], action: (value: T) => Promise<void>) => {
      let next = 0, failed = false;
      const results = await Promise.allSettled(Array.from({ length: Math.min(4, values.length) }, async () => {
        while (!failed && next < values.length) {
          try { await action(values[next++]); } catch (error) { failed = true; throw error; }
        }
      }));
      if (results.some(result => result.status === 'rejected')) throw new GtdError('source_unavailable');
    };
    const propertyCache = new Map<string, ReturnType<typeof loadProperties>>();
    const call = async <T>(method: string, input: object, schema: z.ZodType<T>): Promise<T> => {
      if (++calls > 50000 || readSignal.aborted) throw new GtdError('source_unavailable');
      const value = await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method, input: { vaultId: this.config.vaultId, root, ...input, ...(authority ? { expectedAuthority: authority } : {}), ...(publication ? { publication } : {}) }, outputSchema: z.unknown(), signal: readSignal });
      const proof = envelope.parse(value);
      if (authority && JSON.stringify(authority) !== JSON.stringify(proof.authority)) throw new GtdError('source_unavailable');
      if (publication && publication !== proof.publication) throw new GtdError('source_unavailable');
      authority = proof.authority; publication = proof.publication ?? undefined;
      if (this.preview) this.preview.proof = { expectedAuthority: authority, ...(publication ? { publication } : {}) };
      return schema.parse(value);
    };
    const children = async (scope: string) => {
      if (++directoriesRead > 128) { warnings.add('scan_limit'); childrenPartial = true; return []; }
      const page = await call('inventoryChildren', { folder: scope }, envelope.extend(childrenPage.shape).strict());
      if (this.preview) for (const e of page.entries) this.preview.entries.add(`${scope}/${e.name}`);
      childrenPartial = page.incomplete;
      if (page.incomplete) warnings.add('source_partial');
      return page.entries;
    };
    const loadProperties = async (path: string, fields: string[]) => {
      const page = await call('inventoryProperties', { path, fields: this.preview ? [...fields, 'id'] : fields }, envelope.extend(propertiesPage.shape).strict());
      if (this.preview && page.status === 'observed') this.preview.owners.set(path, { ...page.properties, ...Object.fromEntries(page.unsupported.map(k => [k, { unsupported: true }])) });
      if (page.status === 'partial' || page.unsupported.length) warnings.add('source_partial');
      return page;
    };
    const properties = (path: string, fields: string[]) => {
      if (!propertyCache.has(path)) propertyCache.set(path, loadProperties(path, fields));
      return propertyCache.get(path)!;
    };
    const enumerate = async (scope: string, status?: ProjectStatus) => {
      const entries = await children(scope);
      const scopePartial = childrenPartial;
      await each(entries.filter(e => e.kind === 'markdown'), async entry => {
        if (visited + propertyCache.size >= 5000) return;
        await properties(`${scope}/${entry.name}`, kind === 'project' ? ['title', 'status', 'area'] : ['title']);
      });
      const notes = new Set(entries.filter(e => e.kind === 'markdown').map(e => e.name));
      for (const entry of entries) {
        if (++visited > 5000) { warnings.add('scan_limit'); break; }
        const path = `${scope}/${entry.name}`;
        if (!relativeFolder.safeParse(path).success) { warnings.add('source_partial'); continue; }
        if (kind === 'project' && entry.kind === 'directory' && status === undefined && Object.hasOwn(aliases, entry.name.toLowerCase())) { await enumerate(path, aliases[entry.name.toLowerCase()]); continue; }
        // An incomplete listing cannot confirm the absence of a sibling note.
        if (entry.kind === 'directory' && (scopePartial || notes.has(entry.name + '.md'))) continue;
        const owner = entry.kind === 'markdown' ? path : undefined;
        const page = owner ? await properties(owner, kind === 'project' ? ['title', 'status', 'area'] : ['title']) : undefined;
        if (page && page.status !== 'observed') { warnings.add('source_partial'); continue; }
        if (page?.unsupported.some(f => f === 'title' || (f === 'status' && !status))) { warnings.add(kind === 'project' ? 'invalid_project' : 'invalid_area'); continue; }
        const props = page?.properties ?? {};
        const item = kind === 'project'
          ? owner ? projectFromNote(folder, owner, props) : { id: path + '/', title: entry.name, status: status ?? 'active' }
          : entry.kind === 'markdown' ? areaFromNote(folder, path, props) : { id: path + '/', title: entry.name };
        if (!item || item === 'invalid' || !text(item.title, 240)) { warnings.add(kind === 'project' ? 'invalid_project' : 'invalid_area'); continue; }
        items.push(item);
        if (kind === 'project' && owner && !page?.unsupported.includes('area')) owners.set(item as Project, { path: owner, area: props.area });
      }
    };
    try {
      await enumerate(folder);
      if (kind === 'project' && this.config.areasFolder) {
        const areaFolder = [root, this.config.areasFolder].filter(Boolean).join('/');
        const areaChildren = await children(areaFolder);
        const areaPartial = childrenPartial;
        const areaNotes = new Set(areaChildren.filter(e => e.kind === 'markdown').map(e => e.name));
        const directories = areaChildren.filter(e => e.kind === 'directory' && !areaNotes.has(e.name + '.md'));
        await each([...owners], async ([item, owner]) => {
          const values = areaReferences(owner.area);
          if (!values.length) return;
          const targets = new Set<string>(); let unresolved = false;
          for (const reference of values) {
            const page = await call('inventoryTarget', { path: owner.path, reference }, envelope.extend(targetPage.shape).strict());
            if (page.incomplete) warnings.add('source_partial');
            const target = areaTarget(page, areaFolder, directories);
            if (!target) unresolved = true;
            else targets.add(target);
          }
          if (!unresolved && targets.size === 1 && !warnings.has('scan_limit') && !areaPartial) item.areaId = [...targets][0];
        });
      }
      // Reacquire after assembly: authority and publication drift discard all rows.
      await call('inventoryChildren', { folder }, envelope.extend(childrenPage.shape).strict());
    } catch {
      throw new GtdError(signal.aborted ? 'cancelled' : 'source_unavailable');
    }
    const source = vault.source!;
    return { items, complete: warnings.size === 0, warnings: [...warnings], source: {
      backend: 'obsidian', id: vault.vaultId, name: root.split('/').at(-1) || vault.name || 'Obsidian vault', scope: this.folder(kind), observedAt: new Date().toISOString(), lastSuccessfulSync: source.lastSuccess,
      sync: { connected: source.cloudConnected, enabled: source.enabled, phase: source.phase, failure: source.failure },
    } };
  }
  private async readInventory(signal: AbortSignal, kind: Kind, state: z.infer<typeof statusSchema>, vault: ReturnType<ObsidianBackend['selectedVault']>) {
    if (this.preview && state.inventoryEvidenceVersion !== 1) throw new GtdError('incompatible');
    if (state.inventoryEvidenceVersion === 1) return this.readImmediateInventory(signal, kind, vault);
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    const items: (Project | Area)[] = [], warnings = new Set<Warning>();
    // The v1 consumer enumerates Markdown paths, not directories. Never claim
    // empty/attachment-only folders were enumerated, even after draining it.
    if (state.childrenAccessVersion !== 1) warnings.add('directory_enumeration_unavailable');
    const entries = new Map<string, Project | Area>();
    const invalidRoots = new Set<string>(), seenRoots = new Set<string>();
    let cursor: string | undefined, pages = 0, notes = 0, observedAt = new Date().toISOString();
    try {
      do {
        if (pages++ >= 128 || notes >= 5000 || readSignal.aborted) { warnings.add('scan_limit'); break; }
        let page: z.infer<typeof propertyPage>;
        try { page = propertyPage.parse(await this.sdk.plugins.callRpc<unknown>({ pluginId: 'obsidian', method: 'listProperties', input: {
          vaultId: this.config.vaultId, folder: this.config.root ? `${this.config.root}/${this.folder(kind)}` : this.folder(kind), fields: ['type', 'status', 'title'], ...(cursor ? { cursor } : {}),
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
          const folder = this.config.root ? `${this.config.root}/${this.folder(kind)}` : this.folder(kind);
          const entry = projectEntry(folder, note.path, kind === 'project');
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
      const folder = this.config.root ? `${this.config.root}/${this.folder(kind)}` : this.folder(kind);
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
    if (kind === 'project' && this.config.areasFolder) {
      // Older producers can consult bodies or interpret the old YAML key.
      // Do not call them or treat a raw property as a resolved Area ID.
      if (state.projectAreasVersion !== 1 || state.projectAreasFrontmatterOnly !== true || state.projectAreasDeclarationKey !== projectAreasDeclarationKey) warnings.add('source_partial');
      else {
        const areaFolder = [this.config.root, this.config.areasFolder].filter(Boolean).join('/');
        const roots = [...entries.values()].filter(item => item.id.endsWith('.md'))
          .map(item => ({ item: item as Project, path: item.id }));
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
    const source = vault.source!;
    return { items, complete: warnings.size === 0, warnings: [...warnings], source: {
      backend: 'obsidian', id: vault.vaultId, name: (this.config.root ? this.config.root.split('/').at(-1) : undefined) ?? vault.name ?? 'Obsidian vault', scope: this.folder(kind), observedAt,
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
