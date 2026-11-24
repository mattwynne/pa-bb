import { posix } from 'node:path';
import { checkIndexedInventoryRoot, indexedChildren, indexedInventoryRows, indexedProperties, projectFields, targetQuery, targetEvidence, targetCoverageIncomplete, within, InventoryBatchRefusal, INVENTORY_BATCH_MAX_BYTES } from './inventory-evidence.ts';
import type { InventoryBatchRequest, InventoryBatchRow } from '../contract.ts';
import type { IndexLease, IndexView, MoveIndexLease } from './vault-index.ts';
import { linkReference, parseLinks, VaultLinks, vaultRootFor, type IndexedLink, type LinkResolution, type LinkSource } from './vault-links.ts';
import { createHash } from 'node:crypto';
import { provenance } from './provenance.js';
import { MAX_NOTE_BYTES, projectAreaRoute, projectAreaSourceRefusal, VaultError } from './ports.ts';
import { areaEvidence, areaLookup, areaLinkPath, areaRow, projectAreasDeclarationKey, type AreaRow } from './project-areas.ts';
import { VaultSearch } from './search.ts';
import { moveFolders, projectFolders, type MoveEndpoints, type PhysicalMove } from './project-move.ts';
import { createMovePlanner, MOVE_SCAN_LIMITS, MoveLinkError, type MoveRecord } from './move.ts';
import type { Catalog, Configuration, MirrorCatalog, VaultFiles, NoteParser, StateRepository, Diagnose, Source, Metadata, Receipt, Resolution, LiveProjectAreaAccess, ProjectAreaAuthority, ProjectAreaSelection } from './ports.ts';
export const LIMITS = { output: 48000, scanNotes: 500, scanBytes: 16 * 1024 * 1024, scanMs: 3000, rows: 500, page: 50, cursors: 10, cursorMs: 60000, proofs: 256 } as const;
export const READ_LIMITS = { sessions: 4, idleMs: 5 * 60000, lifetimeMs: 30 * 60000, bytes: MAX_NOTE_BYTES, serialized: 60000 } as const;
type SourceContext = { source: Source; revision: number; catalog: Catalog };
type ProjectAreaRequest = { signal?: AbortSignal; expected?: ProjectAreaAuthority; inventoryBatch?: boolean };
const inventoryCapabilities = { inventoryEvidenceVersion: 1, inventoryBatchVersion: 1, propertiesAccessVersion: 1 } as const;
type InventoryInput = { vaultId: string; root: string; expectedAuthority?: ProjectAreaAuthority; publication?: string };
type InventoryStamp = { authority: ProjectAreaAuthority; publication: string | null };
const projectAreaCapabilities = { projectAreasVersion: 1, projectAreasFrontmatterOnly: true, projectAreasDeclarationKey } as const;
type ReadInput = { vaultId: string; path: string; heading?: string; blockId?: string; selector?: { version: 'incoming'; token: string }; cursor?: string };
type ReadSession = { vaultId: string; path: string; selector?: ReadInput['selector']; reader: string; hash: string; revision: number; source: string; offset: number; warnings: string[]; started: number; touched: number };
type FolderRequest = { vaultId: string; path: string; destination: string };
const FOLDER_PREVIEW_MS = 5 * 60_000;
const validPath = (path: string, directory?: true) => { if (!path || (!directory && !path.endsWith('.md')) || path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new VaultError('invalid_path'); return path; };
const lines = (text: string) => Math.max(1, text.replace(/\r?\n$/, '').split('\n').length);
export class Obsidian {
  private state: Configuration = { revision: 0, vaultIds: [], pending: [] };
  private enteredMoves = new Set<string>();
  private folderPreviews = new Map<string, { request: string; evidence: string; expires: number }>();
  private proofs = new Map<string, { hash: string; revision: number; reader: string }>();
  private reads = new Map<string, ReadSession>();
  private readReservations = 0;
  private cursors = new Map<string, { rows: any[]; offset: number; at: number; revision: number; source: string; incomplete: boolean; failures: any[]; warnings: string[] }>();
  private stopped = false;
  private publications = new WeakMap<IndexView, string>();
  private readonly searcher: VaultSearch;
  private stateQueue: Promise<void> = Promise.resolve();
  private configurationQueue: Promise<void> = Promise.resolve();
  constructor(private catalog: MirrorCatalog, private files: VaultFiles, private parser: NoteParser, private repository: StateRepository, private id: () => string, private clock: () => number, private diagnose: Diagnose) {
    this.searcher = new VaultSearch(files, parser, id, clock, diagnose, async vaultId => {
      const revision = this.state.revision, catalog = await this.catalog.snapshot(); this.checkRevision(revision);
      if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
      const ids = vaultId ? [vaultId] : [...this.state.vaultIds];
      if (ids.some(id => !this.state.vaultIds.includes(id))) throw new VaultError('not_connected');
      await this.confirm(this.state); this.checkRevision(revision); await this.remember(catalog); this.checkRevision(revision);
      return { revision, ids, catalog };
    }, revision => this.checkRevision(revision));
  }
  async start() {
    this.state = await this.repository.load() ?? this.state;
    this.files.indexConfiguration?.(this.state);
  }
  stop() { this.stopped = true; this.folderPreviews.clear(); this.proofs.clear(); this.reads.clear(); this.cursors.clear(); return this.searcher.stop(); }
  private key(vaultId: string, path: string) { return `${vaultId}/${path}`; }
  private invalidate() { this.folderPreviews.clear(); this.proofs.clear(); this.reads.clear(); this.cursors.clear(); this.searcher.invalidate(); this.files.indexConfiguration?.(this.state); }
  // Only durable state transitions enter this queue. Never await a note RPC in it.
  private update<T>(action: () => Promise<T>): Promise<T> {
    const task = this.stateQueue.then(async () => { if (this.stopped) throw new VaultError('unavailable'); return action(); });
    this.stateQueue = task.then(() => {}, () => {}); return task;
  }
  private async save(state: Configuration) { await this.repository.save(structuredClone(state)); this.state = state; }
  private configure<T>(action: () => Promise<T>): Promise<T> {
    const task = this.configurationQueue.then(action);
    this.configurationQueue = task.then(() => {}, () => {}); return task;
  }
  private async confirm(state: Configuration, projectAreas?: ProjectAreaSelection, observedCatalog?: Catalog) {
    await this.files.configure(state, projectAreas, observedCatalog);
    await this.update(async () => { if (this.state.revision === state.revision && this.state.unconfirmedRevision === state.revision) await this.save({ ...this.state, unconfirmedRevision: undefined }); });
  }
  private async remember(catalog: Catalog) {
    await this.update(async () => {
      const names = { ...this.state.names }; let changed = false;
      for (const source of catalog.sources) if (this.state.vaultIds.includes(source.id) && names[source.id] !== source.name) { names[source.id] = source.name; changed = true; }
      if (changed) await this.save({ ...this.state, names });
    });
  }
  async connect(vaultId: string) {
    return this.configure(async () => {
      const catalog = await this.catalog.snapshot();
      if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
      const source = catalog.sources.find(s => s.id === vaultId);
      if (!source?.local.available) throw new VaultError('source_unavailable', catalog.nextAction ?? 'Check the local source in iCloud settings.');
      const next = await this.update(async () => {
        if (this.state.vaultIds.includes(vaultId)) return this.state;
        if (this.state.vaultIds.length >= 20) throw new VaultError('capacity');
        const next = { ...this.state, revision: this.state.revision + 1, vaultIds: [...this.state.vaultIds, vaultId], names: { ...this.state.names, [vaultId]: source.name }, unconfirmedRevision: this.state.revision + 1 };
        await this.save(next); this.invalidate(); return next;
      });
      await this.confirm(next);
    });
  }
  async remove(vaultId: string) {
    return this.configure(async () => {
      const catalog = await this.catalog.snapshot();
      if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
      const next = await this.update(async () => {
        if (!this.state.vaultIds.includes(vaultId)) return this.state;
        const names = { ...this.state.names }; delete names[vaultId];
        const next = { ...this.state, revision: this.state.revision + 1, vaultIds: this.state.vaultIds.filter(id => id !== vaultId), names, pending: this.state.pending?.filter(p => p.vaultId !== vaultId) ?? [], unconfirmedRevision: this.state.revision + 1 };
        await this.save(next); this.invalidate(); return next;
      });
      await this.confirm(next);
    });
  }
  private fingerprint(catalog: Catalog) { return JSON.stringify({ compatible: catalog.compatible, sources: catalog.sources.map(s => [s.id, s.local.available, s.local.reason, catalog.filesystem?.[s.id]]) }); }
  private source(vaultId: string): Promise<SourceContext>;
  private source(vaultId: string, projectAreas: ProjectAreaRequest): Promise<SourceContext & { authority: ProjectAreaAuthority }>;
  private async source(vaultId: string, projectAreas?: ProjectAreaRequest) {
    if (this.stopped || !this.state.vaultIds.includes(vaultId)) throw new VaultError('not_connected', 'Connect this vault in Obsidian settings.');
    const revision = this.state.revision;
    const catalog = await this.catalog.snapshot(projectAreas?.inventoryBatch ? { fresh: true, signal: projectAreas.signal } : undefined);
    if (projectAreas?.inventoryBatch && projectAreas.signal?.aborted) throw new VaultError('cancelled');
    if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
    const source = catalog.sources.find(s => s.id === vaultId);
    if (!source?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    this.check(vaultId, revision);
    let authority: ProjectAreaAuthority | undefined;
    if (projectAreas) {
      const route = projectAreaRoute(catalog, vaultId);
      authority = { revision, route, epoch: this.files.projectAreaEpoch(vaultId, revision, route) };
      if (projectAreas.expected && (projectAreas.expected.revision !== revision || projectAreas.expected.route !== route || projectAreas.expected.epoch !== authority.epoch))
        throw new VaultError('source_unavailable');
    }
    const observedCatalog = projectAreas?.inventoryBatch && authority?.route === 'index' ? catalog : undefined;
    await this.confirm(this.state, authority && { ...authority, vaultId, signal: projectAreas?.signal }, observedCatalog); this.check(vaultId, revision);
    await this.remember(catalog); this.check(vaultId, revision);
    return { source, revision, catalog, authority };
  }
  private check(vaultId: string, revision: number) { if (this.stopped || this.state.revision !== revision || !this.state.vaultIds.includes(vaultId)) throw new VaultError('not_connected', 'The connected vaults changed. Check Obsidian settings.'); }
  private provenance = provenance;
  private async note(vaultId: string, path: string) {
    validPath(path); const context = await this.source(vaultId); const note = await this.files.read(vaultId, context.revision, path); this.check(vaultId, context.revision);
    return { ...context, note };
  }
  async status(input: { vaultId?: string; operationId?: string; path?: string; since?: string; limit?: number } = {}) {
    if (input.path) { validPath(input.path); if (!input.vaultId) throw new VaultError('invalid_query', 'Select an exact vault ID for path inspection.'); }
    if (input.vaultId && !this.state.vaultIds.includes(input.vaultId)) throw new VaultError('not_connected');
    const matchesPending = (pending: NonNullable<Configuration['pending']>[number]) => this.state.vaultIds.includes(pending.vaultId)
      && (!input.vaultId || pending.vaultId === input.vaultId) && (!input.path || pending.path === input.path)
      && (!input.operationId || pending.operationId === input.operationId);
    const catalog = await this.catalog.snapshot(); const revision = this.state.revision;
    if (catalog.compatible) await this.remember(catalog);
    const vaults = this.inventoryVaults(catalog);
    let conflict: { vaultId: string; path: string; inspection: Awaited<ReturnType<VaultFiles['inspect']>> } | null = null;
    let conflictFailure: string | null = null;
    const receipts: Receipt[] = []; const receiptFailures: Array<{ vaultId?: string; category: string }> = [];
    if (catalog.compatible) {
      try {
        await this.confirm(this.state); this.checkRevision(revision);
        if (input.vaultId && input.path) {
          try { conflict = { vaultId: input.vaultId, path: input.path, inspection: await this.files.inspect(input.vaultId, revision, input.path) }; this.checkRevision(revision); }
          catch (e) { this.checkRevision(revision); conflictFailure = e instanceof VaultError ? e.category : 'unavailable'; if (!(e instanceof VaultError && e.diagnosticReported)) this.diagnose('rpc', conflictFailure); }
        }
        for (const id of (input.vaultId ? [input.vaultId] : this.state.vaultIds)) {
          try {
            receipts.push(...await this.files.receipts({ mirrorId: id, revision, operationId: input.operationId, path: input.path, since: input.since, limit: Math.min(input.limit ?? 20, 100) }));
            // Recent pages are not a recovery index. Inspect each persisted ID in its own scope.
            for (const pending of (this.state.pending ?? []).filter(p => p.vaultId === id && matchesPending(p))) {
              if (receipts.some(r => r.operationId === pending.operationId)) continue;
              receipts.push(...await this.files.receipts({ mirrorId: id, revision, path: pending.path, operationId: pending.operationId, limit: 1 }));
            }
          } catch (e) { receiptFailures.push({ vaultId: id, category: e instanceof VaultError ? e.category : 'unavailable' }); }
        }
      } catch (e) { receiptFailures.push({ category: e instanceof VaultError ? e.category : 'unavailable' }); }
    } else { const category = catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable'; receiptFailures.push({ category }); if (input.path) conflictFailure = category; }
    this.checkRevision(revision);
    const resolved = new Set(receipts.filter(r => r.outcome !== 'uncertain').map(r => r.operationId));
    if (resolved.size) await this.update(async () => { if (this.state.revision === revision) await this.save({ ...this.state, pending: this.state.pending?.filter(p => !resolved.has(p.operationId)) }); });
    this.checkRevision(revision);
    const uncertain = (this.state.pending ?? []).filter(matchesPending);
    const uncertainOperations = uncertain.slice(0, Math.min(input.limit ?? 20, 100));
    return { ...inventoryCapabilities, ...projectAreaCapabilities, ...(this.files.children ? { childrenAccessVersion: 1 as const } : {}), search: catalog.search ?? { version: 1 as const, available: false, reason: 'unavailable' as const }, revision, conflict, conflictFailure, setup: catalog.setup, nextAction: catalog.nextAction, vaults, eligible: catalog.compatible ? catalog.sources.filter(s => s.local.available && !this.state.vaultIds.includes(s.id)) : [], receipts: receipts.sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit ?? 20), receiptFailures, uncertainOperations, uncertainOperationCount: uncertain.length, uncertainOperationsIncomplete: uncertainOperations.length < uncertain.length, configurationUnconfirmed: this.state.unconfirmedRevision === revision, evidenceOnly: true as const };
  }
  private inventoryVaults(catalog: Catalog) {
    return this.state.vaultIds.map(vaultId => {
      const source = catalog.sources.find(s => s.id === vaultId) ?? null;
      return { vaultId, name: (catalog.compatible ? source?.name : undefined) ?? this.state.names?.[vaultId] ?? null, source };
    });
  }
  async inventoryStatus() {
    const revision = this.state.revision;
    const catalog = await this.catalog.snapshot();
    this.checkRevision(revision);
    return { ...inventoryCapabilities, vaults: this.inventoryVaults(catalog) };
  }
  async vaultLocations() {
    const vaults: Array<{ id: string; root: string; name: string }> = []; let incomplete = false;
    for (const id of this.state.vaultIds) {
      try {
        const { source, revision } = await this.source(id);
        const result = await this.files.vaultRoots(id, revision); this.check(id, revision);
        incomplete ||= result.incomplete;
        for (const root of result.roots) {
          if (root && (/[\\\\\x00-\x1f\x7f]/.test(root) || root.split('/').some(p => !p || p === '.' || p === '..'))) throw new VaultError('invalid_path');
          vaults.push({ id, root, name: root ? root.split('/').at(-1)! : source.name });
        }
      } catch { this.diagnose('rpc', 'unavailable'); incomplete = true; }
    }
    return { vaults, incomplete };
  }
  async projectAreas(input: { vaultId: string; root: string; areaFolder: string; paths: string[]; expectedAuthority?: ProjectAreaAuthority }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    const { vaultId, root, areaFolder, paths } = input;
    if (root && !areaFolder.startsWith(root + '/')) throw new VaultError('invalid_path');
    for (const path of paths) {
      validPath(path);
      if (root && !path.startsWith(root + '/')) throw new VaultError('invalid_path');
    }
    const { authority } = await this.source(vaultId, { signal, expected: input.expectedAuthority });
    const { revision, route, epoch } = authority;
    const check = () => {
      this.check(vaultId, revision);
      if (signal?.aborted) throw new VaultError('cancelled');
      if (this.files.projectAreaEpoch(vaultId, revision, route) !== epoch) throw new VaultError('source_unavailable');
    };
    check();
    if (route === 'index') {
      if (!this.files.index) throw new VaultError('source_unavailable');
      const lease = await this.files.index(vaultId, revision, signal);
      try {
        check();
        const view = lease.view;
        const requested = new Set(paths);
        const projects = new Map(view.notes.filter(note => requested.has(note.path)).map(note => [note.path, note]));
        // Basenames can collide anywhere inside the selected vault. An
        // omitted path there (or an omitted ancestor tree) makes negative
        // and uniqueness evidence unsafe; never resolve from a live mix.
        const incompleteCatalog = !view.directories.includes(areaFolder) || view.omissions.some(({ path, kind }) =>
          !root || path.startsWith(root + '/') || (kind === 'tree' && (!path || path === root || root.startsWith(path + '/'))));
        let incomplete = incompleteCatalog;
        let lookup: ReturnType<typeof areaLookup> | undefined;
        const resolve = (link: string, source: string) => {
          lookup ??= areaLookup(root, areaFolder, view.notes.map(note => note.path), view.directories);
          return lookup(link, source);
        };
        const rows = paths.map((path): AreaRow => {
          const project = projects.get(path);
          if (!project || project.propertyWarning) {
            incomplete = true;
            return { path, status: 'unresolved' };
          }
          return areaRow(path, areaFolder, areaEvidence(project.properties), resolve, incompleteCatalog);
        });
        const latest = await this.catalog.snapshot(); check();
        if (projectAreaRoute(latest, vaultId) !== route) throw new VaultError('source_unavailable');
        await lease.check(signal); check(); lease.assertValid();
        return { rows, incomplete, authority };
      } finally { lease.close(); }
    }
    const access = { route, epoch, signal };
    const result = await this.liveProjectAreas(input, revision, access, check);
    // Do not release any buffered row until the original revision and route
    // have been accepted again. This includes the direct producer's handoff.
    await this.source(vaultId, { signal, expected: authority }); check();
    await this.files.checkLiveProjectAreaAccess?.(vaultId, revision, access); check();
    return { ...result, authority };
  }
  private async liveProjectAreas(input: { vaultId: string; root: string; areaFolder: string; paths: string[] }, revision: number, access: LiveProjectAreaAccess, check: () => void) {
    const listed = await this.files.list(input.vaultId, revision, access); check();
    const children = this.files.children ? await this.files.children(input.vaultId, revision, input.areaFolder, access) : { entries: [], incomplete: true };
    check();
    let incompleteCatalog = listed.incomplete || children.incomplete, incomplete = false, bytes = 0;
    const started = this.clock();
    const lookup = areaLookup(input.root, input.areaFolder, listed.paths,
      children.entries.filter(e => e.kind === 'directory').map(e => `${input.areaFolder}/${e.name}`));
    const rows: AreaRow[] = [];
    const directoryCache = new Map([[input.areaFolder, children]]);
    for (const path of input.paths) {
      check();
      if (bytes >= 2 * 1024 * 1024 || this.clock() - started > 10000) { incomplete = true; break; }
      try {
        const note = await this.files.read(input.vaultId, revision, path, access); check();
        bytes += Buffer.byteLength(note.text);
        if (bytes > 2 * 1024 * 1024) { incomplete = true; break; }
        const parsed = this.parser.frontmatter(note.text);
        if (parsed.warnings.length) {
          incomplete = true;
          this.diagnose('parse', 'unsupported');
          rows.push({ path, status: 'unresolved' });
          continue;
        }
        const evidence = areaEvidence(parsed.properties);
        const nested = new Map<string, string[]>();
        for (const link of evidence ?? []) {
          if (incompleteCatalog || lookup(link, path).length) continue;
          const target = areaLinkPath(link, path, input.root);
          if (!target || !target.startsWith(input.areaFolder + '/') || !this.files.children) continue;
          const parent = posix.dirname(target);
          if (!directoryCache.has(parent)) {
            check();
            if (directoryCache.size >= 50 || this.clock() - started > 10000) { incompleteCatalog = true; break; }
            directoryCache.set(parent, await this.files.children(input.vaultId, revision, parent, access)); check();
          }
          const directory = directoryCache.get(parent)!;
          incompleteCatalog ||= directory.incomplete;
          if (directory.entries.some(entry => entry.kind === 'directory' && entry.name === posix.basename(target))) nested.set(link, [target + '/']);
        }
        rows.push(areaRow(path, input.areaFolder, evidence, link => nested.get(link) ?? lookup(link, path), incompleteCatalog));
      } catch (error) {
        check();
        const category = error instanceof VaultError ? error.category : 'unavailable';
        // These refusals apply to the source/revision, not just this note.
        if (category === 'cancelled' || projectAreaSourceRefusal(category)) throw error;
        incomplete = true;
        if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('rpc', category);
        rows.push({ path, status: 'unresolved' });
      }
    }
    check();
    incomplete ||= incompleteCatalog;
    return { rows, incomplete };
  }
  private checkInventoryAuthority(vaultId: string, authority: ProjectAreaAuthority, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    this.check(vaultId, authority.revision);
    if (this.files.projectAreaEpoch(vaultId, authority.revision, authority.route) !== authority.epoch) throw new VaultError('source_unavailable');
  }
  private async inventoryRead<T>(input: InventoryInput, signal: AbortSignal | undefined, read: (view: IndexView | undefined, revision: number, access: LiveProjectAreaAccess | undefined, stamp: InventoryStamp) => Promise<T>, policy: 'single' | 'batch' = 'single') {
    const { vaultId } = input;
    const { authority } = await this.source(vaultId, { signal, expected: input.expectedAuthority, inventoryBatch: policy === 'batch' });
    const lease = authority.route === 'index' ? await this.files.index?.(input.vaultId, authority.revision, signal) : undefined;
    try {
      if (authority.route === 'index' && !lease) throw new VaultError('source_unavailable');
      if (policy === 'batch' && lease) this.checkInventoryAuthority(vaultId, authority, signal);
      let publication: string | null = null;
      const view = lease?.view;
      if (view) {
        publication = this.publications.get(view) ?? this.id();
        this.publications.set(view, publication);
      }
      if (input.publication && input.publication !== publication) throw new VaultError('source_unavailable');
      if (signal?.aborted) throw new VaultError('cancelled');
      const access = authority.route === 'index' ? undefined : { route: authority.route, epoch: authority.epoch, signal };
      const stamp = { authority, publication };
      const result = await read(view, authority.revision, access, stamp);
      if (policy === 'batch' && lease) {
        // The grant checks iCloud's current admission revision and pinned root.
        // Drain both checks before closing the lease, even when one fails.
        const [catalog, grant] = await Promise.allSettled([
          Promise.resolve().then(() => this.catalog.snapshot({ fresh: true, signal })),
          Promise.resolve().then(() => lease.check(signal)),
        ]);
        if (signal?.aborted) throw new VaultError('cancelled');
        if (grant.status === 'rejected') throw grant.reason;
        if (catalog.status === 'rejected') throw catalog.reason;
        if (projectAreaRoute(catalog.value, vaultId) !== authority.route) throw new VaultError('source_unavailable');
        this.checkInventoryAuthority(vaultId, authority, signal);
        lease.assertValid();
      } else {
        await this.source(vaultId, { signal, expected: authority });
        if (lease) { await lease.check(signal); lease.assertValid(); }
        else if (access) await this.files.checkLiveProjectAreaAccess?.(vaultId, authority.revision, access);
        if (signal?.aborted) throw new VaultError('cancelled');
        this.check(vaultId, authority.revision);
      }
      return { ...result, ...stamp };
    } finally { lease?.close(); }
  }
  async inventoryBatch(input: InventoryInput & { requests: InventoryBatchRequest[] }, signal?: AbortSignal) {
    for (const request of input.requests) {
      const path = request.kind === 'children' ? request.folder : validPath(request.path);
      if (!within(path, input.root)) throw new VaultError('invalid_path');
    }
    const { rows, authority, publication } = await this.inventoryRead(input, signal, async (view, _revision, _access, stamp) => {
      const rows: InventoryBatchRow[] = [];
      if (!view) return { rows };
      checkIndexedInventoryRoot(view, input.root);
      if (!input.requests.length) return { rows };
      let bytes = Buffer.byteLength(JSON.stringify({ ...stamp, rows }));
      for (const row of indexedInventoryRows(view, input.root, input.requests)) {
        if (signal?.aborted) throw new VaultError('cancelled');
        bytes += Buffer.byteLength(JSON.stringify(row)) + (rows.length ? 1 : 0);
        if (bytes > INVENTORY_BATCH_MAX_BYTES) return { rows: null };
        rows.push(row);
      }
      return { rows };
    }, 'batch');
    if (!rows) throw new InventoryBatchRefusal('output_limit');
    if (authority.route !== 'index' && input.requests.length) throw new InventoryBatchRefusal('incompatible');
    return { rows, authority, publication };
  }
  async inventoryChildren(input: { vaultId: string; root: string; folder: string; expectedAuthority?: ProjectAreaAuthority; publication?: string }, signal?: AbortSignal) {
    if (!within(input.folder, input.root)) throw new VaultError('invalid_path');
    return this.inventoryRead(input, signal, async (view, revision, access) => {
      if (view) return indexedChildren(view, input.folder);
      if (!this.files.children) throw new VaultError('incompatible');
      return this.files.children(input.vaultId, revision, input.folder, access);
    });
  }
  async inventoryProperties(input: { vaultId: string; root: string; path: string; fields: string[]; expectedAuthority?: ProjectAreaAuthority; publication?: string }, signal?: AbortSignal) {
    validPath(input.path);
    if (!within(input.path, input.root)) throw new VaultError('invalid_path');
    return this.inventoryRead(input, signal, async (view, revision, access) => {
      if (view) return indexedProperties(view, view.notes.find(n => n.path === input.path), input.path, input.fields);
      if (this.files.children) {
        const parent = posix.dirname(input.path);
        const children = await this.files.children(input.vaultId, revision, parent === '.' ? '' : parent, access);
        if (!children.entries.some(e => e.kind === 'markdown' && e.name === posix.basename(input.path))) return { status: children.incomplete ? 'partial' as const : 'missing' as const, properties: {}, unsupported: [] };
      }
      try {
        const note = await this.files.read(input.vaultId, revision, input.path, access);
        const parsed = this.parser.frontmatter(note.text);
        return { status: parsed.warnings.length ? 'partial' as const : 'observed' as const, ...projectFields(parsed.properties, input.fields) };
      } catch (e) {
        const category = e instanceof VaultError ? e.category : 'unavailable';
        if (projectAreaSourceRefusal(category) || category === 'cancelled') throw e;
        if (!(e instanceof VaultError && e.diagnosticReported)) this.diagnose('rpc', category);
        return { status: 'partial' as const, properties: {}, unsupported: [] };
      }
    });
  }
  async inventoryTarget(input: { vaultId: string; root: string; path: string; reference: string; expectedAuthority?: ProjectAreaAuthority; publication?: string }, signal?: AbortSignal) {
    validPath(input.path);
    if (!within(input.path, input.root)) throw new VaultError('invalid_path');
    return this.inventoryRead(input, signal, async (view, revision, access) => {
      const query = targetQuery(input.reference, input.path, input.root);
      if (view) return targetEvidence(query, input.root, view.notes.map(n => n.path), !!query.path && view.directories.includes(query.path), targetCoverageIncomplete(view, input.root));
      const listed = await this.files.list(input.vaultId, revision, access);
      let directory = false, incomplete = listed.incomplete;
      if (query.path) {
        if (!this.files.children) incomplete = true;
        else {
          const parent = posix.dirname(query.path);
          const children = await this.files.children(input.vaultId, revision, parent === '.' ? '' : parent, access);
          incomplete ||= children.incomplete;
          directory = children.entries.some(e => e.kind === 'directory' && e.name === posix.basename(query.path!));
        }
      }
      return targetEvidence(query, input.root, listed.paths, directory, incomplete);
    });
  }
  async listChildren(input: { vaultId: string; folder: string }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    if (!this.files.children) throw new VaultError('incompatible');
    const { entries, incomplete } = await this.inventoryChildren({ ...input, root: '' }, signal);
    return { entries, incomplete };
  }
  /** Read-only consumer projection: no bodies, snippets, edit proofs, or GTD policy. */
  async listProperties(input: { vaultId: string; folder: string; fields: string[]; cursor?: string }, signal?: AbortSignal) {
    const page = await this.searcher.listProperties({ vaultId: input.vaultId, folders: [input.folder], selectProperties: input.fields, cursor: input.cursor, limit: 200 }, signal);
    return { notes: page.results, nextCursor: page.nextCursor, incomplete: page.coverage.state === 'partial', warnings: [...page.warnings, ...page.failures.map(() => 'source_unavailable')], observedAt: page.coverage.observedAt };
  }
  closeProperties(cursor: string) { return this.searcher.cancel(cursor, true); }
  private checkRevision(revision: number) { if (this.stopped || this.state.revision !== revision) throw new VaultError('not_connected'); }
  async read(input: ReadInput, signal?: AbortSignal, reader = '') {
    if ((input.selector || input.cursor) && (input.heading || input.blockId)) throw new VaultError('invalid_query', 'Read a section separately from incoming versions or continuations.');
    if (input.heading && input.blockId) throw new VaultError('invalid_query', 'Choose a heading or a block, not both.');
    validPath(input.path);
    const now = this.clock();
    for (const [cursor, session] of this.reads) if (now - session.touched > READ_LIMITS.idleMs || now - session.started > READ_LIMITS.lifetimeMs) this.reads.delete(cursor);
    let session = input.cursor ? this.reads.get(input.cursor) : undefined;
    if (input.cursor) {
      if (!session || session.reader !== reader || session.vaultId !== input.vaultId || session.path !== input.path || session.selector?.token !== input.selector?.token || session.revision !== this.state.revision) throw new VaultError('cursor_expired', 'Start a fresh whole-note read; this continuation is unavailable or belongs to another read.');
      // Claim before any await: overlapping/replayed calls cannot skip a page.
      this.reads.delete(input.cursor);
      this.readReservations++;
    }
    try {
    const cancelled = () => { if (signal?.aborted) throw new VaultError('cancelled'); };
    cancelled();
    const context = await this.source(input.vaultId);
    const incoming = input.selector ? await this.files.readIncoming(input.vaultId, context.revision, input.path, input.selector.token) : null;
    this.check(input.vaultId, context.revision); cancelled();
    if (incoming?.absent) {
      if (session) throw new VaultError('conflict', 'The incoming version changed. Inspect the conflict again.');
      return { ...this.provenance(context.source, new Date(this.clock()).toISOString()), path: input.path, selector: 'incoming', absent: true as const, complete: false as const, editReady: false, hash: null, text: undefined, nextCursor: null, warnings: [] as string[], evidenceOnly: true as const };
    }
    const note = input.selector ? incoming as import('./ports.ts').CompleteNote : await this.files.read(input.vaultId, context.revision, input.path);
    const { source, revision } = context;
    this.check(input.vaultId, revision); cancelled();
    const totalBytes = Buffer.byteLength(note.text);
    if (!note.complete || totalBytes > READ_LIMITS.bytes || createHash('sha256').update(note.text).digest('hex') !== note.hash) throw new VaultError('unsupported', 'The source did not return a bounded, complete, hash-verified note.');
    // Recheck local safety after the async read; cloud progress alone is not a revocation.
    const catalog = await this.catalog.snapshot(); this.check(input.vaultId, revision); cancelled();
    const fingerprint = this.fingerprint(catalog);
    if (fingerprint !== this.fingerprint(context.catalog) || (session && (session.hash !== note.hash || session.source !== fingerprint))) throw new VaultError('conflict', 'The note or local source changed. Start a fresh whole-note read.');
    let start = session?.offset ?? 0, end = note.text.length;
    let warnings = session ? [...session.warnings] : [];
    let metadata: Metadata | undefined;
    if (!session) {
      try { metadata = this.parser.parse(note.text); warnings = [...metadata.warnings]; }
      catch (error) { if (input.heading || input.blockId || !(error instanceof VaultError && error.category === 'parser_limit')) throw error; warnings.push('parser_limit'); this.diagnose('parse', 'limit'); }
    }
    const section = !!(input.heading || input.blockId);
    if (section) {
      const meta = metadata!;
      const candidates = input.blockId ? meta.blocks.filter(b => b.id === input.blockId) : meta.headings.filter(h => h.title.toLocaleLowerCase('und') === input.heading!.toLocaleLowerCase('und'));
      if (candidates.length !== 1) throw new VaultError(candidates.length ? 'ambiguous_link' : 'missing_link');
      start = candidates[0].start; end = candidates[0].end;
      if (input.heading) { const heading = candidates[0] as Metadata['headings'][0]; end = meta.headings.find(h => h.start > start && h.depth <= heading.depth)?.start ?? note.text.length; }
    }
    let stop = Math.min(end, start + LIMITS.output);
    // Never split a surrogate pair. Exact original text/line endings are retained.
    const boundary = (at: number) => at > start && /[\uD800-\uDBFF]/.test(note.text[at - 1]) && /[\uDC00-\uDFFF]/.test(note.text[at] ?? '') ? at - 1 : at;
    stop = boundary(stop);
    const resultAt = (at: number, nextCursor: string | null) => {
      // Paged reads require one final empty acknowledgement after all content.
      const complete = !section && (session ? start === note.text.length : at === note.text.length && nextCursor === null);
      return { ...this.provenance(source, note.readAt), path: input.path, ...(input.selector ? { selector: 'incoming', absent: false } : {}), lineStart: note.text.slice(0, start).split('\n').length, lineEnd: Math.max(note.text.slice(0, start).split('\n').length, note.text.slice(0, at).replace(/\r?\n$/, '').split('\n').length), offset: start, nextOffset: at, totalChars: note.text.length, totalBytes, text: note.text.slice(start, at), hash: note.hash, complete, editReady: complete && !input.selector && !warnings.includes('parser_limit'), warnings: at < end ? [...warnings, 'output_limit'] : warnings, evidenceOnly: true, nextCursor };
    };
    // Budget the actual JSON escaping AND provenance before issuing a cursor/proof.
    // Reserve cursor space even when a candidate might fit in a single response.
    const token = this.id();
    while (JSON.stringify(resultAt(stop, token)).length > READ_LIMITS.serialized && stop > start) stop = boundary(start + Math.floor((stop - start) / 2));
    const continued = !section && (!!session ? start < end : stop < end);
    const nextCursor = continued ? token : null;
    const result = resultAt(stop, nextCursor);
    if (JSON.stringify(result).length > READ_LIMITS.serialized || (stop === start && start < end)) throw new VaultError('output_limit', 'This read could not fit a bounded response. No edit proof was issued.');
    this.check(input.vaultId, revision); cancelled();
    if (session && (this.clock() - session.touched > READ_LIMITS.idleMs || this.clock() - session.started > READ_LIMITS.lifetimeMs)) throw new VaultError('cursor_expired', 'This read expired while checking the source. Start a fresh whole-note read.');
    if (continued) {
      if (!session) {
        if (this.reads.size + this.readReservations >= READ_LIMITS.sessions) {
          if (!this.reads.size) throw new VaultError('capacity', 'All whole-note read slots are in use. Finish an active read, then start again.');
          this.reads.delete(this.reads.keys().next().value!);
        }
        session = { vaultId: input.vaultId, path: input.path, selector: input.selector, reader, hash: note.hash, revision, source: fingerprint, offset: 0, warnings, started: now, touched: now };
      }
      this.reads.set(token, { ...session, offset: stop, touched: this.clock() });
    }
    if (result.editReady) {
      if (this.proofs.size >= LIMITS.proofs) this.proofs.delete(this.proofs.keys().next().value!);
      this.proofs.set(this.key(input.vaultId, input.path), { hash: note.hash, revision, reader });
    }
    return result;
    } finally {
      if (input.cursor) this.readReservations--;
    }
  }
  private async linkInventory(vaultId: string, revision: number, root: string) {
    if (this.files.listLinkTargets) return this.files.listLinkTargets(vaultId, revision, root);
    const listed = await this.files.list(vaultId, revision);
    return { ...listed, paths: listed.paths.filter(path => within(path, root)), attachments: [] };
  }

  private async withLinks<T>(input: { vaultId: string; path: string }, context: SourceContext, hash: string,
    signal: AbortSignal | undefined, backlinks: boolean,
    use: (links: VaultLinks, incomplete: boolean, backlinksIncomplete: boolean) => T): Promise<T> {
    const { vaultId, path } = input;
    const { revision, catalog } = context;
    if (this.files.index && projectAreaRoute(catalog, vaultId) === 'index') {
      const lease = await this.files.index(vaultId, revision, signal);
      try {
        const view = lease.view;
        const roots = view.directories.filter(path => posix.basename(path) === '.obsidian').map(path => posix.dirname(path)).map(path => path === '.' ? '' : path);
        const root = vaultRootFor(path, roots);
        const incomplete = targetCoverageIncomplete(view, root) || !view.notes.some(note => note.path === path && note.hash === hash);
        const index = view.links?.(root) ?? new VaultLinks(view.notes.map(note => note.path), root, view.notes);
        const result = use(index, incomplete, incomplete || (backlinks && view.notes.some(note => within(note.path, root) && !this.completeLinkData(note))));
        await lease.check(signal);
        this.check(vaultId, revision);
        return result;
      } finally { lease.close(); }
    }
    const roots = await this.files.vaultRoots(vaultId, revision);
    const root = vaultRootFor(path, roots.roots);
    const listed = await this.linkInventory(vaultId, revision, root);
    const incomplete = roots.incomplete || listed.incomplete || !listed.paths.includes(path);
    const sources: LinkSource[] = [];
    let backlinksIncomplete = incomplete;
    if (backlinks) {
      let bytes = 0, visited = 0;
      const started = this.clock();
      for (const candidate of listed.paths) {
        if (++visited > LIMITS.scanNotes || bytes >= LIMITS.scanBytes || this.clock() - started >= LIMITS.scanMs) {
          backlinksIncomplete = true;
          break;
        }
        if (signal?.aborted) throw new VaultError('cancelled');
        try {
          const note = await this.files.read(vaultId, revision, candidate);
          bytes += Buffer.byteLength(note.text);
          const source = { path: candidate, hash: note.hash, linkData: parseLinks(note.text, this.parser) };
          sources.push(source);
          backlinksIncomplete ||= !this.completeLinkData(source) || (candidate === path && hash !== note.hash);
        } catch (error) {
          backlinksIncomplete = true;
          if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('parse', error instanceof VaultError ? error.category : 'unavailable');
        }
      }
    }
    this.check(vaultId, revision);
    if (signal?.aborted) throw new VaultError('cancelled');
    return use(new VaultLinks([...listed.paths, ...listed.attachments], root, sources), incomplete, backlinksIncomplete);
  }

  private completeLinkData(note: LinkSource) {
    const data = note.linkData;
    return !!data && data.warnings.length === 0 && data.htmlLinkOffset === undefined && data.unparsedReferenceOffset === undefined &&
      data.links.every(link => link.syntax !== 'definition' && linkReference(link.rawTarget ?? link.target).status === 'internal');
  }

  async metadata(input: { vaultId: string; path: string; backlinks?: boolean }, signal?: AbortSignal) {
    const context = await this.note(input.vaultId, input.path);
    const { source, note } = context;
    const meta = this.parser.parse(note.text);
    const compact = { ...meta, tags: meta.tags.slice(0, 100), headings: meta.headings.slice(0, 100), blocks: meta.blocks.slice(0, 100), tasks: meta.tasks.slice(0, 100) };
    if (meta.tags.length > 100 || meta.headings.length > 100 || meta.blocks.length > 100 || meta.tasks.length > 100) compact.warnings.push('metadata_limit');
    return this.withLinks(input, context, note.hash, signal, !!input.backlinks, (index, incomplete, backlinksIncomplete) => {
      const parsed = index.source(input.path, note.hash) ?? parseLinks(note.text, this.parser);
      const linkRows = (target: string, link: IndexedLink, resolution?: LinkResolution) => ({
        ...link, spelling: link.spelling.slice(0, 1024), ...(link.spelling.length > 1024 ? { spellingTruncated: true } : {}),
        source: target, resolution: resolution ? this.linkEvidence(resolution, incomplete) : { status: 'unsupported' },
      });
      const links = [], backlinks = [];
      let budget = 24_000, linksTruncated = false;
      for (const link of parsed.links) {
        const ref = linkReference(link.rawTarget ?? link.target);
        if (ref.status === 'external') continue;
        const row = linkRows(input.path, link, ref.status === 'internal' && link.syntax !== 'definition' ? index.resolve(ref.name, input.path) : undefined);
        budget -= JSON.stringify(row).length;
        if (budget < 0 || links.length >= 100) { compact.warnings.push('metadata_limit'); linksTruncated = true; break; }
        links.push(row);
      }
      if (input.backlinks) for (const hit of index.backlinks(input.path)) {
        const row = { ...linkRows(hit.source, hit.link, hit.resolution), hash: hit.hash };
        budget -= JSON.stringify(row).length;
        if (budget < 0 || backlinks.length >= 100) { backlinksIncomplete = true; break; }
        backlinks.push(row);
      }
      return { ...this.provenance(source, note.readAt), path: input.path, hash: note.hash, lineStart: 1, lineEnd: lines(note.text),
        ...compact, links, linksIncomplete: linksTruncated || incomplete || !this.completeLinkData({ path: input.path, hash: note.hash, linkData: parsed }),
        ...(input.backlinks ? { backlinks, backlinksIncomplete } : {}), evidenceOnly: true };
    });
  }

  private linkEvidence(result: LinkResolution, incomplete: boolean, limit = 8) {
    return { status: incomplete ? 'incomplete' : result.status, ...(!incomplete && result.target ? { target: result.target } : {}),
      candidates: result.candidates.slice(0, limit), competing: result.competing.slice(0, limit),
      candidatesTruncated: result.candidates.length > limit || result.competing.length > limit };
  }
  private async scan(vaultId: string | undefined, visitor: (source: Source, path: string, text: string, hash: string, at: string) => any[]) {
    const ids = vaultId ? [vaultId] : [...this.state.vaultIds]; const revision = this.state.revision; const rows: any[] = []; const failures: any[] = []; const warnings = new Set<string>(); let incomplete = false; let count = 0; let bytes = 0; const started = this.clock();
    for (const id of ids) {
      try {
        const { source, revision: rev } = await this.source(id); const listed = await this.files.list(id, rev); incomplete ||= listed.incomplete; listed.warnings.forEach(w => warnings.add(w));
        for (const path of listed.paths) {
          if (++count > LIMITS.scanNotes || bytes > LIMITS.scanBytes || this.clock() - started > LIMITS.scanMs || rows.length >= LIMITS.rows) { incomplete = true; warnings.add('scan_limit'); break; }
          try { const note = await this.files.read(id, rev, path); bytes += Buffer.byteLength(note.text); this.check(id, rev); rows.push(...visitor(source, path, note.text, note.hash, note.readAt)); }
          catch (e) { if (this.state.revision !== revision) throw e; incomplete = true; warnings.add(e instanceof VaultError && e.category === 'parser_limit' ? 'parser_limit' : 'note_unavailable'); this.diagnose('parse', e instanceof VaultError && e.category === 'parser_limit' ? 'limit' : 'unavailable'); }
        }
      } catch (e) { failures.push({ vaultId: id, category: e instanceof VaultError ? e.category : 'unavailable' }); incomplete = true; }
    }
    if (revision !== this.state.revision) throw new VaultError('not_connected');
    return { rows: rows.slice(0, LIMITS.rows), failures, warnings: [...warnings], incomplete };
  }
  private async page(input: { cursor?: string; limit?: number }, create: () => Promise<{ rows: any[]; failures: any[]; warnings: string[]; incomplete: boolean }>) {
    const revision = this.state.revision; const catalog = await this.catalog.snapshot();
    if (revision !== this.state.revision || this.stopped) throw new VaultError('not_connected');
    if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
    const source = this.fingerprint(catalog); const limit = Math.max(1, Math.min(input.limit ?? 20, LIMITS.page));
    let cursor = input.cursor; let state = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!state || state.revision !== this.state.revision || state.source !== source || this.clock() - state.at > LIMITS.cursorMs)) throw new VaultError('cursor_expired', 'Start a fresh search; sources or connected vaults changed.');
    if (!state) { const result = await create(); if (revision !== this.state.revision || this.stopped) throw new VaultError('not_connected'); state = { ...result, offset: 0, at: this.clock(), revision, source }; cursor = this.id(); if (this.cursors.size >= LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!); this.cursors.set(cursor, state); }
    const results: any[] = []; let size = 0;
    while (results.length < limit && state.offset < state.rows.length) { const row = state.rows[state.offset]; const length = JSON.stringify(row).length; if (size + length > LIMITS.output) break; results.push(row); size += length; state.offset++; }
    const nextCursor = state.offset < state.rows.length ? cursor : null;
    if (!nextCursor) this.cursors.delete(cursor!);
    return { results, nextCursor, incomplete: state.incomplete, failures: state.failures, warnings: state.warnings, evidenceOnly: true };
  }
  search(input: import('./ports.ts').SearchQuery, signal?: AbortSignal) { return this.searcher.search(input, signal); }
  tasks(input: { vaultId?: string; path?: string; folder?: string; complete?: boolean; cursor?: string; limit?: number }) {
    if (input.path) validPath(input.path); if (input.folder && (input.folder.startsWith('/') || input.folder.split('/').some(p => p === '..' || p === '.') || /[\\\x00-\x1f]/.test(input.folder))) throw new VaultError('invalid_path');
    return this.page(input, () => this.scan(input.vaultId, (source, path, text, hash, at) => {
      if ((input.path && path !== input.path) || (input.folder && !path.startsWith(input.folder.replace(/\/$/, '') + '/'))) return [];
      return this.parser.parse(text).tasks.filter(t => input.complete === undefined || input.complete === t.complete).map(t => ({ ...this.provenance(source, at), path, lineStart: t.line, lineEnd: t.endLine, text: t.text.slice(0, 240), marker: t.marker, complete: t.complete, hash }));
    }));
  }
  async resolve(input: { vaultId: string; path: string; link: string }, signal?: AbortSignal, reader = '') {
    let spelling = input.link;
    if (/^!?\[\[/.test(spelling)) spelling = spelling.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0];
    else if (/^!?\[/.test(spelling)) {
      const parsed = this.parser.parse(spelling, 'move').links.find(link =>
        link.syntax === 'markdown' && link.start === 0 && link.end === input.link.length);
      if (!parsed) throw new VaultError('invalid_link');
      spelling = parsed.target;
    }
    const ref = linkReference(spelling);
    if (ref.status === 'external') throw new VaultError('external_link', 'External URLs and cross-vault references are not fetched.');
    if (ref.status !== 'internal') throw new VaultError('invalid_link');
    const context = await this.note(input.vaultId, input.path);
    const observed = await this.withLinks(input, context, context.note.hash, signal, false, (index, incomplete) =>
      this.linkEvidence(index.resolve(ref.name, input.path), incomplete, 20));
    if (!observed.target || !observed.target.endsWith('.md')) {
      return { ...observed, vaultId: input.vaultId, incomplete: observed.status === 'incomplete', evidenceOnly: true };
    }
    const subpath = ref.subpath;
    const resolved = await this.read({ vaultId: input.vaultId, path: observed.target, ...(subpath.startsWith('^') ? { blockId: subpath.slice(1) } : subpath ? { heading: subpath } : {}) }, signal, reader);
    return { ...resolved, ...observed, status: 'resolved' as const };
  }
  async completeRead(input: { vaultId: string; path: string }, signal: AbortSignal, reader: string) {
    let page = await this.read(input, signal, reader);
    for (let pages = 0; page.nextCursor; pages++) {
      if (pages >= 128) throw new VaultError('output_limit');
      page = await this.read({ ...input, cursor: page.nextCursor }, signal, reader);
    }
    if (!page.complete || !page.editReady || !page.hash) throw new VaultError('complete_read_required');
    return page.hash;
  }

  async projectDeferEvidence(input: { vaultId: string; path: string; deferUntil: string; operationId?: string }, signal: AbortSignal) {
    const { note, properties, receipt } = await this.projectDateEvidence(input, signal);
    const value = properties['defer-until'];
    const matches = value === input.deferUntil;
    if (!matches) this.parser.properties(note.text, { set: { 'defer-until': input.deferUntil }, remove: [] });
    return { hash: note.hash, fieldHash: createHash('sha256').update(JSON.stringify({ value })).digest('hex'),
      matches, receipt };
  }

  async projectDateEvidence(input: { vaultId: string; path: string; operationId?: string }, signal: AbortSignal) {
    let receipt = null;
    if (input.operationId) {
      const status = await this.status({ vaultId: input.vaultId, path: input.path, operationId: input.operationId, limit: 1 });
      if (status.receiptFailures.length) throw new VaultError('unavailable');
      const save = status.receipts.find(r => r.kind === 'save' && r.operationId === input.operationId && r.path === input.path);
      receipt = save?.kind === 'save' ? save.outcome : null;
    }
    const { note } = await this.note(input.vaultId, input.path);
    signal.throwIfAborted();
    if (!note.complete || Buffer.byteLength(note.text) > MAX_NOTE_BYTES ||
      createHash('sha256').update(note.text).digest('hex') !== note.hash) throw new VaultError('unsupported');
    const { properties, warnings } = this.parser.frontmatter(note.text);
    if (warnings.length) throw new VaultError('properties_unsupported');
    return { note, properties, receipt };
  }

  async projectMoveReceipt(input: { vaultId: string; operationId: string }) {
    if (this.enteredMoves.has(input.operationId) || !this.state.moves?.some(r => !r.directory && r.vaultId === input.vaultId && r.operationId === input.operationId)) return null;
    const { operationId, vaultId, path, destination, project, root, expectedHash, physical, outcome } = await this.moveStatus(input);
    return { operationId, vaultId, path, destination, physical, outcome,
      ...(project ? { project } : {}), ...(root ? { root } : {}), ...(expectedHash ? { expectedHash } : {}) };
  }

  async moveStatus(input: { vaultId: string; operationId: string }) {
    const { revision } = await this.source(input.vaultId);
    const record = this.state.moves?.find(r => r.vaultId === input.vaultId && r.operationId === input.operationId);
    if (!record || !this.files.moveReceipts) throw new VaultError('unavailable');
    const receipts = record.refused ? [] : await this.files.moveReceipts({
      mirrorId: input.vaultId, revision, operationId: input.operationId, ...(record.project ? { project: record.project } : {}), ...(record.directory ? { directory: record.directory } : {}),
    });
    const repairs = await Promise.all(record.repairs.map(repair => this.inspectRepair(input.vaultId, revision, repair)));
    const physical: PhysicalMove = receipts[0]?.outcome ?? (record.refused ? 'not_moved' : 'uncertain');
    const outcome: 'project_move_partial' | 'uncertain' | 'not_moved' | 'moved_supported_links_updated' | 'moved_links_partial' = physical === 'partial' ? 'project_move_partial' : physical === 'uncertain' ? 'uncertain' :
      physical === 'not_moved' ? 'not_moved' : repairs.some(r => r.outcome === 'uncertain') ? 'uncertain' :
      repairs.every(r => r.outcome === 'saved') && (record.verification ? record.verification.state === 'verified' : !record.verifyLinks && !record.project) ? 'moved_supported_links_updated' : 'moved_links_partial';
    // Receipt inspection can settle the metadata fence after a restart or a
    // manually completed physical move. This never executes unapplied repairs.
    const settled = outcome !== 'uncertain' && outcome !== 'project_move_partial';
    if ((record.project || record.directory) && !record.finished && settled && !this.enteredMoves.has(input.operationId)) {
      await this.update(() => this.save({ ...this.state, moves: this.state.moves?.map(r =>
        r.operationId === input.operationId ? { ...r, finished: true } : r) }));
    }
    const folder = record.directory || record.project === 'paired' ? moveFolders(record) : undefined;
    return { ...record, ...(folder ? { folder } : {}), repairs, physical, outcome, ...(receipts[0]?.components ? { components: receipts[0].components } : {}),
      message: physical === 'partial'
        ? 'Inspect the reported landing note and folder locations before reconciling the project. Never retry the move or delete a copy based only on its name.'
        : 'Local evidence only; cloud delivery and concurrent or unsupported links are unverified. Inspect uncertain operations before another write.' };
  }

  private async inspectRepair(vaultId: string, revision: number, repair: MoveRecord['repairs'][number]) {
    if (repair.outcome !== 'submitted' && repair.outcome !== 'uncertain') return repair;
    const matches = await this.files.receipts({ mirrorId: vaultId, revision, operationId: repair.operationId, path: repair.path, limit: 1 });
    const receipt = matches.find(row => row.kind === 'save' && row.hash === repair.hash);
    return { ...repair, outcome: receipt?.outcome === 'saved_locally_pending_sync' ? 'saved' as const :
      receipt?.outcome === 'not_saved' ? 'not_saved' as const : 'uncertain' as const };
  }

  previewFolderMove(input: FolderRequest, signal?: AbortSignal, reader = '') {
    return this.move({ ...input, directory: true, dryRun: true, expectedHash: '' }, signal, reader);
  }

  applyFolderMove({ previewId, ...input }: FolderRequest & { previewId: string }, signal?: AbortSignal, reader = '') {
    return this.move({ ...input, directory: true, operationId: previewId, expectedHash: '' }, signal, reader);
  }

  async move(input: MoveEndpoints & { vaultId: string; expectedHash: string; dryRun?: boolean; operationId?: string }, signal?: AbortSignal, reader = '', beforePhysicalMove?: () => void) {
    const { directory } = input;
    const usesFolderInventory = directory || !!input.project;
    for (const path of [input.path, input.destination]) {
      validPath(path, directory);
      if (directory && path.split('/').includes('.obsidian'))
        throw new VaultError('invalid_path', 'Folder moves cannot change an Obsidian vault boundary.');
    }
    const folders = moveFolders(input);
    if (input.root) {
      validPath(input.root + '/placeholder.md');
      if (!input.project || ![input.path, input.destination].every(path => path.startsWith(input.root + '/')))
        throw new VaultError('invalid_path');
    }
    const unsupportedPath = [input.path, input.destination].find(path => /[#|\[\]<>?%]/.test(path));
    if (unsupportedPath) throw new MoveLinkError({ reason: 'path_characters', path: unsupportedPath });
    const { revision, catalog } = await this.source(input.vaultId);
    const useMoveIndex = directory && projectAreaRoute(catalog, input.vaultId) === 'index';
    const previewRequest = directory ? JSON.stringify([reader, input.vaultId, revision, input.path, input.destination, !!useMoveIndex]) : '';
    const preview = directory && input.operationId ? this.folderPreviews.get(input.operationId) : undefined;
    if (directory) {
      if (!input.dryRun) {
        if (this.state.moves?.some(record => record.operationId === input.operationId))
          throw new VaultError('operation_reused', 'Inspect obsidian_move_status with the preview ID. This operation cannot be repeated.');
        if (preview?.request !== previewRequest || preview.expires <= this.clock())
          throw new VaultError('conflict', 'Use a fresh preview for these exact endpoints in this thread.');
      }
    } else {
      const proof = this.proofs.get(this.key(input.vaultId, input.path));
      if (!proof || proof.hash !== input.expectedHash || proof.reader !== reader || proof.revision !== revision) throw new VaultError('complete_read_required');
    }
    if (!this.files.move || !this.files.moveReceipts || (usesFolderInventory && !this.files.listProjectMove)) throw new VaultError('unsupported');
    const refuse = (category: 'capacity' | 'unavailable', reason: string): never => {
      this.diagnose('move_preflight', category);
      throw new VaultError(category, `Move stopped before writing. ${reason}`, true);
    };
    const started = this.clock();
    const deadline = AbortSignal.timeout(MOVE_SCAN_LIMITS.milliseconds);
    const scanSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const check = () => {
      this.check(input.vaultId, revision);
      if (signal?.aborted) throw new VaultError('cancelled', 'Move stopped before writing. Link discovery was cancelled.');
      if (preview && preview.expires <= this.clock()) throw new VaultError('conflict', 'The folder move preview expired. Prepare a fresh preview.');
      if (deadline.aborted || this.clock() - started >= MOVE_SCAN_LIMITS.milliseconds) {
        if (!directory) refuse('capacity', 'Link discovery reached its 20-second time limit before checking the entire vault.');
        this.diagnose('move_preflight', 'scan_timeout');
        throw new VaultError('scan_timeout', 'Move stopped before writing. Link discovery reached its 20-second time limit.', true);
      }
    };
    let moveIndex: MoveIndexLease | undefined;
    let lease: IndexLease | undefined;
    try {
      if (useMoveIndex) {
        if (!this.files.indexForFolderMove) throw new VaultError('unsupported');
        moveIndex = await this.files.indexForFolderMove(input.vaultId, revision, scanSignal);
      }
      const roots = async () => {
        if (moveIndex) return moveIndex.roots;
        const result = await this.files.vaultRoots(input.vaultId, revision);
        check();
        if (directory && result.warnings?.includes('entry_cap'))
          throw new VaultError('entry_cap', 'The vault boundary scan reached its entry cap.', true);
        if (directory && result.warnings?.includes('scan_timeout'))
          throw new VaultError('scan_timeout', 'The vault boundary scan timed out.', true);
        if (result.incomplete) refuse('unavailable', 'The selected vault boundary could not be verified.');
        return result.roots;
      };
      const observedRoots = await roots();
      const sourceRoot = vaultRootFor(input.path, observedRoots);
      if (input.root && observedRoots.length && input.root !== sourceRoot)
        throw new VaultError('conflict', 'Move stopped before writing. The requested root does not match the source Obsidian vault.');
      const root = input.root ?? sourceRoot;
      const checkRoot = (current: readonly string[]) => {
        if (directory && current.some(entry => entry &&
          [input.path, input.destination].some(path => path === entry || entry.startsWith(path + '/'))))
          throw new VaultError('conflict', 'A folder endpoint is or contains an Obsidian vault boundary.');
        if (vaultRootFor(input.path, current) !== vaultRootFor(input.path, observedRoots) ||
          vaultRootFor(input.destination, current) !== vaultRootFor(input.destination, observedRoots) ||
          vaultRootFor(input.path, current) !== vaultRootFor(input.destination, current)) {
          throw new VaultError('conflict', 'Move stopped before writing. The endpoints must remain in the same Obsidian vault.');
        }
      };
      checkRoot(observedRoots);
      const projectInput = { mirrorId: input.vaultId, revision, path: input.path, destination: input.destination,
        project: input.project, root: root || undefined, ...(directory ? { directory, operationId: input.operationId } : {}) };
      const readForMove = (path: string) => this.files.readForMove
        ? this.files.readForMove(input.vaultId, revision, path, scanSignal)
        : this.files.read(input.vaultId, revision, path);
      const list = async () => {
        check();
        const listed = usesFolderInventory
          ? await this.files.listProjectMove!(projectInput, moveIndex && { lease: moveIndex, signal: scanSignal })
          : { ...await this.linkInventory(input.vaultId, revision, root), folderEvidence: undefined };
        check();
        if (listed.warnings.includes('entry_cap')) throw new VaultError('entry_cap', 'The vault listing reached its entry cap.');
        if (listed.warnings.includes('scan_timeout')) throw new VaultError('scan_timeout', 'The vault listing timed out.');
        if (listed.warnings.includes('scan_limit')) refuse('capacity', 'The vault listing reached its scan limit before link discovery could finish.');
        if (listed.incomplete || listed.warnings.length) refuse('unavailable', 'The vault listing was incomplete or contained unsupported entries. Check vault access before attempting the move again.');
        if (listed.paths.length > MOVE_SCAN_LIMITS.notes) refuse('capacity', `Link discovery is limited to ${MOVE_SCAN_LIMITS.notes} notes in the vault.`);
        if (new Set(listed.paths).size !== listed.paths.length) refuse('unavailable', 'The vault listing contained duplicate paths.');
        return listed;
      };
      const { paths: listed, attachments, folderEvidence } = await list();
      if (directory && !folderEvidence) refuse('unavailable', 'The backend could not verify the folder tree.');
      const inventory = new Set(listed);
      const planner = createMovePlanner(inventory, input.path, input.destination, this.parser, input.project, attachments, root, directory);
      if (!directory && this.files.index && projectAreaRoute(catalog, input.vaultId) === 'index') {
        lease = await this.files.index(input.vaultId, revision, scanSignal);
      }
      const indexed = (moveIndex ?? lease)?.view.links?.(root);
      const originalHashes = new Map<string, string>();
      const blockerSamples: MoveLinkError[] = [];
      const firstByReason = new Map<MoveLinkError['location']['reason'], MoveLinkError>();
      const counts: NonNullable<MoveLinkError['previewBlockers']>['counts'] = {};
      let blockedNotes = 0;
      let bytes = 0;
      for (let offset = 0; offset < listed.length; offset += MOVE_SCAN_LIMITS.batch) {
        check();
        const paths = listed.slice(offset, offset + MOVE_SCAN_LIMITS.batch);
        const batch = await Promise.allSettled(paths.map(readForMove));
        check();
        for (const [index, result] of batch.entries()) {
          check();
          if (result.status === 'rejected') {
            const error = result.reason;
            if (error instanceof VaultError && error.category === 'unsupported') {
              if (!error.diagnosticReported) this.diagnose('move_preflight', 'unsupported');
              throw new VaultError('unsupported', 'Move stopped before writing. A vault note could not be fully read for link discovery. The store requires supported UTF-8 notes up to 1 MiB.', true);
            }
            throw error;
          }
          const { text, hash } = result.value;
          const path = paths[index];
          if (!directory && path === input.path && hash !== input.expectedHash) throw new VaultError('conflict');
          originalHashes.set(path, hash);
          const noteBytes = Buffer.byteLength(text);
          if (noteBytes > MAX_NOTE_BYTES) refuse('capacity', 'Link discovery found a note over the 1 MiB whole-note limit.');
          bytes += noteBytes;
          if (bytes > MOVE_SCAN_LIMITS.bytes) refuse('capacity', 'Link discovery reached its 128 MiB total text limit.');
          try { planner.visit({ path, text, hash }, noteBytes, indexed?.source(path, hash)); }
          catch (error) {
            if (input.dryRun && error instanceof MoveLinkError) {
              const { reason } = error.location;
              if (!firstByReason.has(reason)) firstByReason.set(reason, error);
              if (blockerSamples.length < 12) blockerSamples.push(error);
              counts[reason] = (counts[reason] ?? 0) + 1;
              blockedNotes++;
              continue;
            }
            if (error instanceof VaultError && error.category === 'parser_limit') {
              refuse('capacity', 'A vault note exceeded the Markdown parser’s complexity limit during link discovery.');
            }
            if (error instanceof VaultError && error.category === 'capacity') refuse('capacity', error.nextAction);
            throw error;
          }
        }
      }
      if (blockedNotes) {
        // Keep response size fixed while surfacing later refusal reasons.
        let sampleBytes = 0;
        const samples = [...new Set([...firstByReason.values(), ...blockerSamples])].slice(0, 12).filter(error => {
          sampleBytes += JSON.stringify(error.location).length;
          return sampleBytes <= 40_000;
        });
        const [first, ...additional] = samples;
        first.additionalLocations = additional.map(error => error.location);
        if (directory) first.affectedBacklinks = planner.backlinks;
        first.previewBlockers = { notesChecked: listed.length, bytesChecked: bytes, counts, locationsTruncated: blockedNotes > samples.length };
        throw first;
      }
      const attachmentPaths = new Set(attachments);
      const checkMembership = async () => {
        checkRoot(await roots());
        const final = await list();
        if (final.folderEvidence !== folderEvidence || final.paths.length !== inventory.size || final.paths.some(path => !inventory.has(path)) ||
          final.attachments.length !== attachmentPaths.size || final.attachments.some(path => !attachmentPaths.has(path))) {
          this.diagnose('move_preflight', 'conflict');
          throw new VaultError('conflict', 'Move stopped before writing. Vault paths changed during link discovery. Check the source and destination before preparing another move.', true);
        }
      };
      const checkLinkPlan = async () => {
        await checkMembership();
        for (let offset = 0; offset < listed.length; offset += MOVE_SCAN_LIMITS.batch) {
          check();
          const paths = listed.slice(offset, offset + MOVE_SCAN_LIMITS.batch);
          const checks = await Promise.allSettled(paths.map(readForMove));
          check();
          for (const [i, observed] of checks.entries()) {
            if (observed.status === 'rejected' || observed.value.hash !== originalHashes.get(paths[i])) {
              this.diagnose('move_preflight', 'conflict');
              const note = directory ? ` (${paths[i]})` : '';
              throw new VaultError('conflict', `Move stopped before writing. A note changed or could no longer be read during link discovery${note}. Prepare a fresh plan.`, true);
            }
          }
        }
        await checkMembership();
        await lease?.check(scanSignal);
        const assertPlan = () => { (moveIndex ?? lease)?.assertUnchanged?.(); check(); };
        assertPlan();
        return assertPlan;
      };
      await checkMembership();
      const plan = planner.repairs;
      const operationId = input.operationId ?? this.operationId();
      const previewEvidence = directory ? createHash('sha256').update(JSON.stringify([root, folderEvidence, [...originalHashes], attachments])).digest('hex') : '';
      if (preview && preview.evidence !== previewEvidence)
        throw new VaultError('conflict', 'The folder, vault membership, or note versions changed after preview. Prepare a fresh preview.');
      const expectedHash = folderEvidence ?? input.expectedHash;
      const record: MoveRecord = { vaultId: input.vaultId, path: input.path, destination: input.destination, operationId,
        expectedHash, verifyLinks: true, ...(directory ? { directory, root } : {}), ...(input.project ? { project: input.project } : {}), ...(input.root ? { root: input.root } : {}), repairs: plan.map(r => ({ path: r.path, expectedHash: r.expectedHash, hash: r.hash, operationId: this.operationId(), outcome: 'unstarted' })) };
      if (JSON.stringify(record).length > 32000) refuse('capacity', 'The link repair plan exceeds the move record size limit.');
      // Keep only bounded metadata; original/recovery bytes live with the producer.
      const checkLedger = () => {
        if ((this.state.moves?.length ?? 0) >= 20) refuse('capacity', 'The move ledger has reached its 20-record limit. Ask the operator to inspect move recovery records.');
        if (this.state.moves?.some(r => r.operationId === operationId)) throw new VaultError('operation_reused',
          'Inspect the existing move operation. It cannot be repeated.');
        const endpoints = [input.path, input.destination, ...(folders ? [folders.from, folders.to] : [])];
        if (this.state.moves?.some(r => {
          if (r.finished || r.vaultId !== input.vaultId) return false;
          const previous = moveFolders(r);
          return [r.path, r.destination, ...(previous ? [previous.from, previous.to] : [])].some(p =>
            endpoints.some(endpoint => p === endpoint || p.startsWith(endpoint + '/') || endpoint.startsWith(p + '/')));
        })) throw new VaultError('busy', 'Inspect the overlapping move receipt before continuing.');
      };
      if (input.dryRun) {
        let movedNotes = 0;
        if (directory || input.project) {
          for (const path of planner.moves.keys()) if (originalHashes.has(path)) movedNotes++;
        }
        await checkLinkPlan();
        checkLedger();
        if (directory) {
          if (this.folderPreviews.size >= 32) this.folderPreviews.delete(this.folderPreviews.keys().next().value!);
          this.folderPreviews.set(operationId, { request: previewRequest, evidence: previewEvidence, expires: this.clock() + FOLDER_PREVIEW_MS });
          return { outcome: 'link_plan_ready' as const, vaultId: input.vaultId, path: input.path, destination: input.destination,
            previewId: operationId, affectedBacklinks: planner.backlinks, notesChecked: listed.length, bytesChecked: bytes,
            movedNotes, movedAttachments: planner.moves.size - movedNotes,
            plannedRepairs: plan.length, repairPaths: plan.map(repair => repair.path) };
        }
        return { outcome: 'link_plan_ready' as const, notesChecked: listed.length, bytesChecked: bytes, plannedRepairs: plan.length, ...(input.project ? {
          project: input.project, movedNotes, movedAttachments: planner.moves.size - movedNotes, operationId,
          ...(folders && input.project !== 'standalone' ? { folder: folders } : {}),
        } : {}), repairPaths: plan.map(repair => repair.path),
          message: 'Read-only link discovery completed. Moving reruns preflight and checks destination, conflicts and recovery state at write time.' };
      }
      await this.update(async () => {
        check();
        checkLedger();
        await this.save({ ...this.state, moves: [...(this.state.moves ?? []), structuredClone(record)] });
        this.enteredMoves.add(operationId);
      });
      const updateRecord = () => this.update(async () => {
        await this.save({ ...this.state, moves: this.state.moves!.map(r => r.operationId === operationId ? structuredClone(record) : r) });
      });
      let physicalVerified = false;
      let dispatched = false, planRefused = false;
      let refusal: { category: string; nextAction: string } | undefined;
      try {
        this.check(input.vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
        for (const [path, destination] of planner.moves) {
          this.proofs.delete(this.key(input.vaultId, path));
          this.proofs.delete(this.key(input.vaultId, destination));
        }
        const movedNotes = input.project ? new Map<string, string>() : undefined;
        if (movedNotes) {
          for (const [path, hash] of originalHashes) if (planner.moves.has(path)) movedNotes.set(path, hash);
        }
        if (!this.files.checksLinkPlanAtWrite) await checkLinkPlan();
        beforePhysicalMove?.();
        dispatched = true;
        const receipt = await this.files.move({ mirrorId: input.vaultId, revision, path: input.path, destination: input.destination, expectedHash, operationId,
          // The direct writer checks again under its write lock. Legacy writes
          // recheck immediately before dispatching the existing producer RPC.
          checkLinkPlan: async () => {
            try { return await checkLinkPlan(); }
            catch (error) { planRefused = true; throw error; }
          }, ...(input.project ? { project: input.project, root: projectInput.root, movedNotes } : {}), ...(directory ? { directory, root } : {}) });
        this.proofs.delete(this.key(input.vaultId, input.path));
        physicalVerified = receipt.outcome === 'moved_locally_pending_sync';
        if (physicalVerified) for (let i = 0; i < plan.length; i++) {
          this.check(input.vaultId, revision); if (signal?.aborted) break;
          record.repairs[i].outcome = 'submitted';
          await updateRecord();
          try {
            const r = record.repairs[i];
            const result = await this.files.commit({ mirrorId: input.vaultId, revision, path: r.path, operationId: r.operationId, kind: 'replace', expectedHash: r.expectedHash, text: plan[i].text });
            record.repairs[i].outcome = result.outcome === 'saved_locally_pending_sync' ? 'saved' : result.outcome === 'not_saved' ? 'not_saved' : 'uncertain';
          } catch (e) {
            record.repairs[i].outcome = e instanceof VaultError && ['conflict', 'busy', 'cancelled', 'capacity'].includes(e.category) ? 'not_saved' : 'uncertain';
            if (!(e instanceof VaultError && e.diagnosticReported)) this.diagnose('tool', e instanceof VaultError ? e.category : 'unavailable');
          }
          await updateRecord();
          if (record.repairs[i].outcome === 'uncertain') break;
        }
      } catch (e) {
        if (!(e instanceof VaultError && e.diagnosticReported)) this.diagnose('tool', e instanceof VaultError ? e.category : 'unavailable');
        const folderRefusal = usesFolderInventory && e instanceof VaultError &&
          ['conflict', 'unsupported', 'invalid_path', 'operation_expired', 'cancelled', 'entry_cap', 'scan_timeout'].includes(e.category);
        if (!dispatched || (planRefused && e instanceof VaultError && e.category !== 'uncertain') || (!physicalVerified && folderRefusal)) {
          record.refused = true;
          if (directory && e instanceof VaultError) refusal = { category: e.category, nextAction: e.nextAction };
        }
      }
      try {
        if (physicalVerified) {
          record.repairs = await Promise.all(record.repairs.map(repair => this.inspectRepair(input.vaultId, revision, repair)));
        }
        if (physicalVerified && record.repairs.every(repair => repair.outcome === 'saved')) {
          const destinationHashes = new Map<string, string>();
          for (const [path, hash] of originalHashes) destinationHashes.set(planner.moves.get(path) ?? path, hash);
          for (const repair of plan) destinationHashes.set(repair.path, repair.hash);
          moveIndex?.close();
          moveIndex = undefined;
          record.verification = await this.verifyMovedLinks(projectInput, destinationHashes,
            new Set(attachments.map(path => planner.moves.get(path) ?? path)), vaultRootFor(input.destination, observedRoots), signal, !!useMoveIndex);
        }
        if (record.refused || record.verification) await updateRecord();
        const status = await this.moveStatus({ vaultId: input.vaultId, operationId });
        if (status.outcome === 'moved_supported_links_updated' || status.outcome === 'moved_links_partial' || status.outcome === 'not_moved') {
          record.finished = true;
          await updateRecord();
        }
        return refusal ? { ...status, refusal } : status;
      } catch (error) {
        if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('tool', 'uncertain');
        return { operationId, outcome: 'uncertain' as const, nextAction: 'Inspect obsidian_move_status with this operation ID. Do not repeat the move or repairs.' };
      } finally {
        this.enteredMoves.delete(operationId);
      }
    } catch (error) {
      if (scanSignal.aborted && !(error instanceof VaultError && error.diagnosticReported)) check();
      throw error;
    } finally { lease?.close(); moveIndex?.close(); }
  }

  private async verifyMovedLinks(input: Parameters<NonNullable<VaultFiles['listProjectMove']>>[0],
    expected: ReadonlyMap<string, string>, attachments: ReadonlySet<string>, observedRoot: string, signal?: AbortSignal, useMoveIndex = false): Promise<NonNullable<MoveRecord['verification']>> {
    const deadline = AbortSignal.timeout(MOVE_SCAN_LIMITS.milliseconds);
    const check = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let lease: MoveIndexLease | undefined;
    try {
      if (useMoveIndex) lease = await this.files.indexForFolderMove!(input.mirrorId, input.revision, check);
      const inventory = async () => {
        const roots = lease ? { roots: lease.roots, incomplete: false, warnings: [] } : await this.files.vaultRoots(input.mirrorId, input.revision);
        if (roots.incomplete || vaultRootFor(input.destination, roots.roots) !== observedRoot)
          throw new VaultError(roots.warnings?.[0] ?? 'unavailable', undefined, !!roots.warnings?.length);
        const listed = input.project || input.directory ? await this.files.listProjectMove!({ ...input, afterMove: true }, lease && { lease, signal: check }) :
          await this.linkInventory(input.mirrorId, input.revision, input.root ?? '');
        check.throwIfAborted();
        this.check(input.mirrorId, input.revision);
        if (listed.incomplete || listed.warnings.length)
          throw new VaultError(listed.warnings.find(warning => warning === 'entry_cap' || warning === 'scan_timeout') ?? 'unavailable');
        const differences = (paths: string[], prior: ReadonlySet<string> | ReadonlyMap<string, string>) => {
          const now = new Set(paths);
          return paths.filter(path => !prior.has(path)).concat([...prior.keys()].filter(path => !now.has(path)));
        };
        return { paths: listed.paths, changes: differences(listed.paths, expected).concat(differences(listed.attachments, attachments)) };
      };
      const inventoryChanged = (paths: string[]): NonNullable<MoveRecord['verification']> => {
        this.diagnose('move_verification', 'conflict');
        return { state: 'inventory_changed', paths: paths.slice(0, 8) };
      };
      const listed = await inventory();
      if (listed.changes.length) return inventoryChanged(listed.changes);
      const changes: string[] = [];
      for (let offset = 0; offset < listed.paths.length; offset += MOVE_SCAN_LIMITS.batch) {
        check.throwIfAborted();
        const paths = listed.paths.slice(offset, offset + MOVE_SCAN_LIMITS.batch);
        const reads = await Promise.allSettled(paths.map(path => this.files.readForMove
          ? this.files.readForMove(input.mirrorId, input.revision, path, check)
          : this.files.read(input.mirrorId, input.revision, path)));
        this.check(input.mirrorId, input.revision);
        for (const [i, observation] of reads.entries()) {
          if (observation.status !== 'fulfilled' || observation.value.hash !== expected.get(paths[i])) changes.push(paths[i]);
        }
        if (changes.length >= 8) break;
      }
      check.throwIfAborted();
      if (changes.length) {
        this.diagnose('move_verification', 'conflict');
        return { state: 'note_changed', paths: changes.slice(0, 8) };
      }
      const final = await inventory();
      lease?.assertUnchanged?.();
      return final.changes.length ? inventoryChanged(final.changes) : { state: 'verified', paths: [] };
    } catch (error) {
      const category = signal?.aborted ? 'cancelled' : deadline.aborted ? 'scan_timeout' : error instanceof VaultError ? error.category : 'unavailable';
      if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('move_verification', category);
      return { state: 'unavailable', paths: [], ...(input.directory ? { category } : {}) };
    } finally { lease?.close(); }
  }

  private async pending(vaultId: string, path: string, operationId: string, revision: number, kind: 'save' | 'resolution') {
    await this.update(async () => {
      this.check(vaultId, revision);
      if (this.state.pending?.some(p => p.vaultId === vaultId && p.path === path)) throw new VaultError('uncertain', 'Inspect this note’s operation receipt before another change.');
      if ((this.state.pending?.length ?? 0) >= 100) throw new VaultError('capacity', 'Inspect unresolved operations before preparing more writes.');
      await this.save({ ...this.state, pending: [...(this.state.pending ?? []), { operationId, vaultId, path, kind, at: new Date(this.clock()).toISOString() }] });
    });
  }
  private async clearPending(operationId: string) { await this.update(async () => {
    if (this.state.pending?.some(p => p.operationId === operationId)) await this.save({ ...this.state, pending: this.state.pending?.filter(p => p.operationId !== operationId) });
  }); }
  private operationId() { const time = Math.floor(this.clock()).toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${this.id().slice(15)}`; }
  private async write(vaultId: string, path: string, expectedHash: string | null, prepare: (text: string) => string, create = false, signal?: AbortSignal, reader = '', requestedOperationId?: string) {
    if (signal?.aborted) throw new VaultError('cancelled');
    validPath(path); const { revision, source } = await this.source(vaultId);
    let text = '';
    if (!create) {
      const proof = this.proofs.get(this.key(vaultId, path)); if (!proof || proof.hash !== expectedHash || proof.revision !== revision || proof.reader !== reader) throw new VaultError('complete_read_required', 'Read the complete note, then prepare a change against its whole-note hash.');
      const current = await this.files.read(vaultId, revision, path); this.check(vaultId, revision);
      if (current.hash !== expectedHash) { this.proofs.delete(this.key(vaultId, path)); throw new VaultError('conflict', 'The note changed. Reread it and prepare a fresh change.'); } text = current.text;
    }
    const next = prepare(text); const metadata = this.parser.parse(next);
    if (metadata.warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported', 'The proposed note has malformed or unsupported properties. Correct the explicit change before saving.');
    const oldTags = this.parser.frontmatter(text).properties.tags as string[] | undefined;
    const newTags = metadata.properties.tags as string[] | undefined;
    const removedPropertyTags = (oldTags ?? []).filter(tag => !newTags?.includes(tag));
    this.check(vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
    const operationId = requestedOperationId ?? this.operationId();
    await this.pending(vaultId, path, operationId, revision, 'save');
    try {
      this.check(vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
      // The file adapter rechecks authorization immediately before local publication.
      const receipt = await this.files.commit({ mirrorId: vaultId, revision, path, operationId, expectedHash, text: next, kind: create ? 'create' : 'replace' });
      if (receipt.outcome !== 'uncertain') await this.clearPending(operationId);
      this.proofs.delete(this.key(vaultId, path)); this.check(vaultId, revision);
      return { ...this.provenance(source, receipt.at), path, lineStart: 1, lineEnd: lines(next), operationId, receipt: { ...receipt, kind: 'save' as const }, change: { previousHash: expectedHash, hash: receipt.hash, beforeBytes: Buffer.byteLength(text), afterBytes: Buffer.byteLength(next), removedPropertyTags }, message: receipt.outcome === 'saved_locally_pending_sync' ? 'Saved locally, pending iCloud sync. This does not verify delivery to iCloud or a phone.' : 'The outcome is not a confirmed save. Inspect receipts; do not repeat the edit.' };
    } catch (e) {
      if (e instanceof VaultError && ['busy', 'conflict', 'capacity', 'cancelled', 'invalid_path', 'unsupported', 'not_connected', 'source_unavailable', 'operation_reused', 'incompatible'].includes(e.category)) await this.clearPending(operationId);
      throw e;
    }
  }
  async recover(input: { vaultId: string; path: string; token: string; expectedLogicalHash: string; expectedIncomingHash: string | null; choice: Resolution['choice']; text?: string }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    validPath(input.path); const { revision, source } = await this.source(input.vaultId);
    if ((input.choice === 'replace') !== (input.text !== undefined)) throw new VaultError('ambiguous_edit');
    if (input.text !== undefined && this.parser.parse(input.text).warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported');
    const operationId = this.operationId(); await this.pending(input.vaultId, input.path, operationId, revision, 'resolution');
    let resolved = false;
    try {
      this.check(input.vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
      const result = await this.files.resolve({ mirrorId: input.vaultId, revision, path: input.path, operationId, token: input.token, expectedLogicalHash: input.expectedLogicalHash, expectedIncomingHash: input.expectedIncomingHash, choice: input.choice, ...(input.text === undefined ? {} : { text: input.text }) });
      resolved = true;
      const matches = await this.files.receipts({ mirrorId: input.vaultId, revision, path: input.path, operationId, limit: 1 });
      const receipt = matches.find((r): r is Extract<Receipt, { kind: 'resolution' }> => r.kind === 'resolution' && r.operationId === operationId && r.path === input.path);
      if (!receipt || receipt.outcome !== result.outcome || receipt.hash !== result.hash) throw new VaultError('uncertain', 'Inspect the exact resolution receipt; do not repeat the choice.');
      await this.clearPending(operationId); this.proofs.delete(this.key(input.vaultId, input.path)); this.check(input.vaultId, revision);
      return { ...this.provenance(source, receipt.at), path: input.path, operationId, receipt, message: result.outcome === 'adopted_absence' ? 'Adopted incoming absence locally; no cloud deletion was requested.' : 'Resolution recorded locally; cloud delivery is not verified.' };
    } catch (e) {
      if (!resolved && e instanceof VaultError && ['conflict', 'capacity', 'cancelled', 'invalid_path', 'unsupported', 'not_connected', 'source_unavailable', 'operation_reused', 'incompatible'].includes(e.category)) await this.clearPending(operationId);
      if (resolved && !(e instanceof VaultError && e.category === 'uncertain')) throw new VaultError('uncertain', 'The resolution was recorded but its receipt could not be confirmed. Inspect the exact operation ID; do not repeat it.');
      throw e;
    }
  }
  create(input: { vaultId: string; path: string; text: string }, signal?: AbortSignal) { return this.write(input.vaultId, input.path, null, () => input.text, true, signal); }
  edit(input: { vaultId: string; path: string; expectedHash?: string; resolution?: { token: string; expectedLogicalHash: string; expectedIncomingHash: string | null; choice: Resolution['choice']; text?: string }; append?: string; replacements?: Array<{ oldText: string; newText: string }>; task?: { line: number; marker: string } }, signal?: AbortSignal, reader = '') {
    if (input.resolution) { if (input.expectedHash !== undefined || input.append !== undefined || input.replacements !== undefined || input.task !== undefined) throw new VaultError('ambiguous_edit'); return this.recover({ vaultId: input.vaultId, path: input.path, ...input.resolution }, signal); }
    if (!input.expectedHash) throw new VaultError('complete_read_required');
    return this.write(input.vaultId, input.path, input.expectedHash, text => {
      if ([input.append !== undefined, !!input.replacements?.length, !!input.task].filter(Boolean).length !== 1) throw new VaultError('ambiguous_edit');
      if (input.task) { const task = this.parser.parse(text).tasks.filter(t => t.line === input.task!.line); if (task.length !== 1 || [...input.task.marker].length !== 1 || /[\]\r\n]/.test(input.task.marker)) throw new VaultError('ambiguous_edit'); return this.parser.edit(text, [{ oldText: text.slice(task[0].start, task[0].end), newText: text.slice(task[0].start, task[0].markerOffset) + input.task.marker + text.slice(task[0].markerOffset + task[0].marker.length, task[0].end) }]); }
      return input.append !== undefined ? this.parser.edit(text, []) + input.append : this.parser.edit(text, input.replacements!);
    }, false, signal, reader);
  }
  properties(input: { vaultId: string; path: string; expectedHash: string; set?: Record<string, unknown>; remove?: string[]; addAliases?: string[] }, signal?: AbortSignal, reader = '', operationId?: string) {
    return this.write(input.vaultId, input.path, input.expectedHash, text => { const set = { ...input.set }; if (input.addAliases?.length) { if ('aliases' in set || input.remove?.includes('aliases')) throw new VaultError('ambiguous_edit'); set.aliases = [...new Set([...this.parser.parse(text).aliases, ...input.addAliases])]; } return this.parser.properties(text, { set, remove: input.remove ?? [] }); }, false, signal, reader, operationId);
  }
}
