import { experimental_PluginRpcCallError, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FilesystemVault } from './filesystem-vault.ts';
import { INDEX_LIMITS } from './filesystem-index.ts';
import { untilAborted } from '../core/vault-index.ts';
import { LocalReceipts } from './local-receipts.ts';
import { noteRpcContract, searchCapabilitySchema } from './icloud-note-contract.ts';
import { projectAreaRoute, projectAreaSourceRefusal, VaultError } from '../core/ports.ts';
import type { MirrorCatalog, VaultFiles, Diagnose, Catalog, Configuration, LiveProjectAreaAccess, NoteParser, ProjectAreaRoute, ProjectAreaSelection } from '../core/ports.ts';
const local = z.object({ available: z.boolean(), reason: z.enum(['ownership', 'recovery_required', 'source_changed']).nullable(), pendingAgeMs: z.number().int().nonnegative().nullable(), applicationBlocker: z.enum(['application_uncertain', 'native_recovery']).nullable() }).strict();
const filesystemMode = z.enum(['ready', 'legacy_pending', 'legacy_conflict', 'unavailable']);
const absoluteDirectory = z.string().min(1).max(4096).refine(p => isAbsolute(p) && p !== '/' && normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p));
const directoryResult = noteRpcContract.mirrorDirectory.output.extend({ directory: absoluteDirectory });
const directoryGrantResult = noteRpcContract.mirrorDirectoryGrant.output.extend({ directory: absoluteDirectory,
  rootDev: noteRpcContract.mirrorDirectoryGrant.output.shape.rootDev.max(20), rootIno: noteRpcContract.mirrorDirectoryGrant.output.shape.rootIno.max(20) });
const mirror = z.object({ id: z.string(), folder: z.object({ name: z.string() }), initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable(), local: local.optional(), filesystem: filesystemMode.optional() });
const status = z.object({ search: z.unknown().optional(), mirrorAccessVersion: z.number().int().nullish(), noteAccessVersion: z.number().int().nullable(), available: z.boolean(), connected: z.boolean(), challenge: z.string().nullable(), mirrors: z.array(mirror) });
const unavailable = (setup: string, nextAction: string): Catalog => ({ setup, nextAction, sources: [], connected: false, compatible: false });
export class ICloud implements MirrorCatalog, VaultFiles {
  private filesystem?: FilesystemVault;
  private indexState?: Configuration;
  private indexConfirmed?: number;
  private indexTimer?: ReturnType<typeof setInterval>;
  private indexJob?: Promise<void>;
  private indexAbort = new AbortController();
  // One record per configured vault, no per-inventory or per-generation state.
  private areaEpochs = new Map<string, { route?: ProjectAreaRoute; epoch: string }>();
  private revokeAreaEpoch = (id: string) => {
    const current = this.areaEpochs.get(id);
    if (current) current.epoch = randomUUID();
  };
  constructor(private sdk: BbPluginApi['sdk'], private diagnose: Diagnose, kv?: BbPluginApi['storage']['kv'], parser?: NoteParser) {
    if (kv) this.filesystem = new FilesystemVault(this.directory.bind(this), this.directoryGrant.bind(this), new LocalReceipts(kv), diagnose, parser, this.revokeAreaEpoch);
  }
  async stopIndexing() {
    this.indexAbort.abort(); clearInterval(this.indexTimer);
    await Promise.all([this.filesystem?.index.stop(), this.indexJob]);
  }
  async stop() { await Promise.all([this.stopIndexing(), this.filesystem?.searcher.stop()]); }
  indexConfiguration(configuration: Configuration) {
    if (!this.filesystem || this.indexAbort.signal.aborted || this.indexState?.revision === configuration.revision) return;
    this.indexState = { revision: configuration.revision, vaultIds: [...configuration.vaultIds] };
    this.areaEpochs = new Map(this.indexState.vaultIds.map(id => [id, { epoch: randomUUID() }]));
    if (this.lastCatalog) this.observeAreaRoutes(this.lastCatalog);
    this.filesystem.index.setEligible(configuration.revision, []);
    clearInterval(this.indexTimer);
    if (!configuration.vaultIds.length) return;
    this.indexTimer = setInterval(() => this.refreshIndexes(true), INDEX_LIMITS.reconcileMs);
    this.indexTimer.unref();
    this.refreshIndexes(false);
  }
  private refreshIndexes(reconcile: boolean) {
    const state = this.indexState, signal = this.indexAbort.signal;
    if (!state || signal.aborted || this.indexJob) return;
    this.indexJob = (async () => {
      // Do not lend a background catalog observation to foreground reads.
      const catalog = await untilAborted(this.observeCatalog(signal), signal);
      if (this.indexState !== state || !this.eligibleIndexes(state, catalog).length) return;
      if (this.indexConfirmed !== state.revision) await this.confirmConfiguration(state, signal);
      else if (this.lastCatalog) this.syncIndexAccess(this.lastCatalog, reconcile);
    })().catch(error => {
      if (!signal.aborted && !(error instanceof VaultError && error.diagnosticReported)) this.diagnose('index_refresh', error instanceof VaultError ? error.category : 'unavailable');
    }).finally(() => { this.indexJob = undefined; if (this.indexState !== state && this.indexState?.vaultIds.length) this.refreshIndexes(false); });
  }
  private eligibleIndexes(state: Configuration, catalog: Catalog) {
    return catalog.compatible && catalog.mirrorDirectoryGrantVersion === 1 ? state.vaultIds.filter(id => catalog.filesystem?.[id] === 'ready' && catalog.sources.some(s => s.id === id && s.local.available)) : [];
  }
  private syncIndexAccess(catalog: Catalog, reconcile = false) {
    const state = this.indexState;
    if (state && this.indexConfirmed === state.revision && !this.indexAbort.signal.aborted)
      this.filesystem?.index.setEligible(state.revision, this.eligibleIndexes(state, catalog), reconcile);
  }
  private checking?: Promise<Catalog>;
  private observationSequence = 0;
  private observedSequence = 0;
  private lastCatalog?: Catalog;
  private async observeCatalog(signal?: AbortSignal) {
    // Order observations at the provider reply, not at call start or after
    // local ripgrep capability probing finishes.
    let sequence = 0;
    const observed = () => { if (!sequence) sequence = ++this.observationSequence; };
    const catalog = await this.checkCatalog(observed, signal);
    if (sequence > this.observedSequence && !this.indexAbort.signal.aborted && !signal?.aborted) {
      this.observedSequence = sequence; this.lastCatalog = catalog;
      this.observeAreaRoutes(catalog);
      this.syncIndexAccess(catalog);
    }
    return catalog;
  }
  private observeAreaRoutes(catalog: Catalog) {
    for (const [id, current] of this.areaEpochs) {
      let route: ProjectAreaRoute | undefined;
      try { route = projectAreaRoute(catalog, id); } catch { /* No authorized route. */ }
      if (current.route !== route) { this.revokeAreaEpoch(id); current.route = route; }
    }
  }
  projectAreaEpoch(id: string, revision: number, route: ProjectAreaRoute) {
    const current = this.areaEpochs.get(id);
    if (this.indexAbort.signal.aborted || this.indexState?.revision !== revision || current?.route !== route) throw new VaultError('source_unavailable');
    return current.epoch;
  }
  snapshot(options?: { fresh: true; signal?: AbortSignal }): Promise<Catalog> {
    if (options?.fresh) return this.observeCatalog(options.signal);
    return this.checking ??= this.observeCatalog().finally(() => { this.checking = undefined; });
  }

  private async checkCatalog(observed: () => void, signal?: AbortSignal): Promise<Catalog> {
    try {
      const plugins = await this.sdk.plugins.list();
      if (signal?.aborted) throw new VaultError('cancelled');
      const plugin = plugins.plugins.find(p => p.id === 'icloud');
      if (!plugin || !plugin.enabled || plugin.status !== 'running') {
        observed();
        if (!plugin) return unavailable('missing', 'Install iCloud from Plugins, then open its settings.');
        if (!plugin.enabled) return unavailable('disabled', 'Enable iCloud in Plugins.');
        return unavailable(plugin.status === 'error' ? 'icloud_error' : 'starting', 'Open iCloud settings and check its startup status.');
      }
      const state = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: status, signal });
      observed();
      if (signal?.aborted) throw new VaultError('cancelled');
      const search = searchCapabilitySchema.safeParse(state.search);
      const filesystem = state.mirrorAccessVersion === 3 ? Object.fromEntries(state.mirrors.map(m => [m.id, m.filesystem ?? 'unavailable'])) : undefined;
      const direct = state.mirrors.some(m => m.local?.available && filesystem?.[m.id] === 'ready') ? this.filesystem : undefined;
      const nativeSearch = await direct?.searcher.capability();
      const indexCapability = direct && state.noteAccessVersion === 2 ? await this.directoryCapabilities(signal) : {};
      const legacySearch = search.success ? search.data :
        { version: 1 as const, available: false, reason: state.search === undefined ? 'unavailable' as const : 'unsupported_version' as const };
      const catalog: Catalog = { filesystem, ...indexCapability, search: nativeSearch?.available || !legacySearch.available ? nativeSearch ?? legacySearch : legacySearch, setup: 'ready', nextAction: null, connected: state.connected, compatible: state.noteAccessVersion === 2,
        sources: state.mirrors.map(m => ({ id: m.id, name: m.folder.name, initialized: m.initialized, enabled: m.enabled, cloudConnected: state.connected, phase: m.phase, lastSuccess: m.lastSuccess, failure: m.failure, local: {
          available: !!m.local?.available && filesystem?.[m.id] !== 'unavailable',
          reason: m.local?.reason ?? (!m.local || filesystem?.[m.id] === 'unavailable' ? 'source_changed' : null),
          pendingAgeMs: m.local?.pendingAgeMs ?? null,
          applicationBlocker: m.local?.applicationBlocker ?? null,
        } })) };
      if (catalog.compatible && state.mirrors.some(m => !m.local)) throw new Error('Invalid v2 local capability');
      if (!catalog.compatible) return { ...catalog, setup: 'incompatible', nextAction: 'Update iCloud and Obsidian together for compatible vault access.' };
      if (!state.available) return { ...catalog, setup: 'host_prerequisite', nextAction: 'Ask the operator to check the host requirements shown in iCloud settings.' };
      if (!state.mirrors.length) return { ...catalog, setup: 'no_folder', nextAction: 'Choose a vault folder in iCloud settings.' };
      if (state.mirrors.some(m => !m.initialized && m.phase === 'running')) return { ...catalog, setup: 'initial_sync_running', nextAction: 'Wait for initial sync to finish in iCloud settings.' };
      if (state.mirrors.some(m => !m.initialized && m.phase === 'failed')) return { ...catalog, setup: 'initial_sync_failed', nextAction: 'Inspect the initial-sync failure in iCloud settings.' };
      if (!state.mirrors.some(m => m.initialized)) return { ...catalog, setup: 'sync_disabled', nextAction: 'Enable sync for the selected folder and finish initial sync.' };
      if (state.challenge) return { ...catalog, setup: 'apple_verification', nextAction: 'Finish Apple verification in iCloud settings; sound local notes remain accessible.' };
      if (!state.connected) return { ...catalog, setup: 'apple_disconnected', nextAction: 'Apple is disconnected; sound local notes remain accessible but cloud delivery is stopped.' };
      return catalog;
    } catch {
      observed();
      if (!signal?.aborted) this.diagnose('catalog', 'unavailable');
      return unavailable('check_failed', 'Could not check iCloud. Keep your settings and choose Check again.');
    }
  }
  private async call<K extends keyof typeof noteRpcContract>(method: K, input: unknown, uncertain = false): Promise<any> {
    const catalog = await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    // Configuration must remain removable and historical receipts inspectable
    // even when a source is blocked. Content access obeys current local safety.
    const mirrorId = (input as { mirrorId?: string }).mirrorId;
    if (mirrorId && method !== 'noteReceipts' && method !== 'noteMoveReceipts' && !catalog.sources.find(s => s.id === mirrorId)?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    return this.request(method, input, uncertain);
  }
  private async directory(mirrorId: string, revision: number, signal?: AbortSignal): Promise<string> {
    try {
      const value = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'mirrorDirectory',
        input: { mirrorId, revision }, outputSchema: directoryResult, signal });
      return value.directory;
    } catch {
      if (signal?.aborted) throw new VaultError('cancelled');
      if (this.indexState?.revision === revision) this.revokeAreaEpoch(mirrorId);
      this.diagnose('rpc', 'source_unavailable');
      throw new VaultError('source_unavailable', 'iCloud could not authorize direct local access. Check the mirror in iCloud settings.', true);
    }
  }

  private async directoryCapabilities(signal?: AbortSignal): Promise<Pick<Catalog, 'mirrorDirectoryGrantVersion' | 'mirrorDirectoryGrantUnconfirmed'>> {
    if (signal?.aborted) throw new VaultError('cancelled');
    try {
      return await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'mirrorDirectoryCapabilities',
        input: null, outputSchema: noteRpcContract.mirrorDirectoryCapabilities.output, signal });
    } catch (error) {
      if (signal?.aborted) throw new VaultError('cancelled');
      // Only the SDK's typed missing-method response denotes an older
      // producer. A refused or unreadable check must not enable a downgrade.
      if (error instanceof experimental_PluginRpcCallError && error.code === 'unknown_method') return {};
      this.diagnose('index_access', 'source_unavailable');
      return { mirrorDirectoryGrantUnconfirmed: true };
    }
  }
  private async directoryGrant(mirrorId: string, revision: number, signal?: AbortSignal) {
    try {
      return await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'mirrorDirectoryGrant',
        input: { mirrorId, revision }, outputSchema: directoryGrantResult, signal });
    } catch {
      if (signal?.aborted) throw new VaultError('cancelled');
      this.diagnose('index_access', 'source_unavailable');
      throw new VaultError('source_unavailable', 'iCloud could not grant the indexed root identity. Check compatible plugin versions and local source access.', true);
    }
  }

  private checkProjectAreaRoute(catalog: Catalog, mirrorId: string, revision: number, access: { route: ProjectAreaRoute; epoch: string; signal?: AbortSignal }) {
    if (access.signal?.aborted) throw new VaultError('cancelled');
    if (projectAreaRoute(catalog, mirrorId) !== access.route ||
        this.projectAreaEpoch(mirrorId, revision, access.route) !== access.epoch) throw new VaultError('source_unavailable');
  }

  private async route<T>(mirrorId: string, local: (filesystem: FilesystemVault) => Promise<T>, legacy: () => Promise<T>, selection?: { revision: number; access: LiveProjectAreaAccess }) {
    if (selection?.access.signal?.aborted) throw new VaultError('cancelled');
    const catalog = await this.snapshot();
    // Match and dispatch against the same observation. A separate service
    // precheck alone would leave route() free to switch to the live fallback.
    if (selection) this.checkProjectAreaRoute(catalog, mirrorId, selection.revision, selection.access);
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    if (!catalog.sources.find(s => s.id === mirrorId)?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    const run = () => {
      if (catalog.filesystem?.[mirrorId] !== 'ready') return legacy();
      if (!this.filesystem) throw new VaultError('source_unavailable');
      return local(this.filesystem);
    };
    if (!selection) return run();
    const result = await run();
    // A concurrent observation can revoke and restore this route while I/O runs.
    this.checkProjectAreaRoute(catalog, mirrorId, selection.revision, selection.access);
    return result;
  }

  private async request<K extends keyof typeof noteRpcContract>(method: K, input: unknown, uncertain: boolean, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) throw new VaultError('cancelled');
    const contract = noteRpcContract[method];
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method, input: { version: 2, ...(input as object) }, outputSchema: contract.output as z.ZodType<any>, signal });
      if (!result.ok) {
        if (projectAreaSourceRefusal(result.category)) {
          const { mirrorId, revision } = input as { mirrorId?: string; revision?: number };
          if (mirrorId && revision === this.indexState?.revision) this.revokeAreaEpoch(mirrorId);
        }
        this.diagnose('rpc', result.category); throw new VaultError(result.category, result.nextAction, true);
      }
      return result.value;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      if (signal?.aborted) throw new VaultError('cancelled');
      this.diagnose('rpc', uncertain ? 'uncertain' : 'unavailable');
      throw new VaultError(uncertain ? 'uncertain' : 'unavailable', uncertain ? 'The mutation reply was lost. Inspect its scoped operation receipt; do not repeat the change.' : 'Check iCloud is updated and running, then choose Check again.', true);
    }
  }
  async configure(value: Configuration, projectAreas?: ProjectAreaSelection, observedCatalog?: Catalog) {
    const catalog = observedCatalog ?? await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    if (projectAreas) this.checkProjectAreaRoute(catalog, projectAreas.vaultId, value.revision, projectAreas);
    await this.confirmConfiguration(value, projectAreas?.signal);
    if (projectAreas) this.checkProjectAreaRoute(catalog, projectAreas.vaultId, value.revision, projectAreas);
  }
  private async confirmConfiguration(value: Configuration, signal?: AbortSignal) {
    await this.request('noteConfigure', { revision: value.revision, mirrorIds: value.vaultIds }, false, signal);
    if (this.indexState?.revision === value.revision && !this.indexAbort.signal.aborted) {
      this.indexConfirmed = value.revision;
      // Eligibility only queues work. Each scan uses mirrorDirectoryGrant to check
      // and bind the current direct-access grant before opening the filesystem.
      if (this.lastCatalog) this.syncIndexAccess(this.lastCatalog);
    }
  }
  index(id: string, revision: number, signal?: AbortSignal) {
    if (!this.filesystem) throw new VaultError('source_unavailable');
    return this.filesystem.index.acquire(id, revision, signal);
  }
  async search(input: import('../core/ports.ts').SearchRequest, signal?: AbortSignal): Promise<import('../core/ports.ts').SearchBatch> {
    return this.route(input.mirrorId, files => files.search(input, signal), () => this.legacySearch(input, signal));
  }
  private async legacySearch(input: import('../core/ports.ts').SearchRequest, signal?: AbortSignal) {
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'noteSearch', signal, input: { version: 2, searchVersion: 1, ...input }, outputSchema: noteRpcContract.noteSearch.output });
      if (!result.ok) { this.diagnose('rpc', result.category); throw new VaultError(result.category, result.nextAction, true); }
      return result.value;
    } catch (error) { if (error instanceof VaultError) throw error; if (signal?.aborted) throw new VaultError('cancelled'); this.diagnose('rpc', 'unavailable'); throw new VaultError('unavailable', 'Vault search did not complete. Check the host search requirements; partial results are not a total.', true); }
  }
  async closeSearch(revision: number, cursor: string) {
    if (this.filesystem?.searcher.has(cursor)) return this.filesystem.searcher.close(revision, cursor);
    const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'noteSearchClose', input: { version: 2, revision, cursor }, outputSchema: noteRpcContract.noteSearchClose.output });
    if (!result.ok) throw new VaultError(result.category, result.nextAction);
  }
  vaultRoots(mirrorId: string, revision: number) {
    return this.route(mirrorId, files => files.vaultRoots(mirrorId, revision), () => this.request('noteVaultRoots', { mirrorId, revision }, false));
  }
  children(mirrorId: string, revision: number, folder: string, access?: LiveProjectAreaAccess) {
    return this.route(mirrorId, files => files.children(mirrorId, revision, folder, access?.signal), () => this.request('noteChildren', { mirrorId, revision, folder }, false, access?.signal), access && { revision, access });
  }
  list(mirrorId: string, revision: number, access?: LiveProjectAreaAccess) {
    return this.route(mirrorId, files => files.list(mirrorId, revision, access?.signal), () => this.request('noteList', { mirrorId, revision }, false, access?.signal), access && { revision, access });
  }
  read(mirrorId: string, revision: number, path: string, access?: LiveProjectAreaAccess) {
    return this.route(mirrorId, files => files.read(mirrorId, revision, path, access?.signal), () => this.request('noteRead', { mirrorId, revision, path }, false, access?.signal), access && { revision, access });
  }
  checkLiveProjectAreaAccess(mirrorId: string, revision: number, access: LiveProjectAreaAccess) {
    // The service has re-confirmed the legacy revision; direct sources must
    // additionally pass the producer's current root handoff and identity check.
    return this.route(mirrorId, files => files.checkAccess(mirrorId, revision, access.signal), async () => {}, { revision, access });
  }
  readForMove(mirrorId: string, revision: number, path: string, signal: AbortSignal) {
    return this.route(mirrorId, files => files.read(mirrorId, revision, path, signal), () => this.request('noteRead', { mirrorId, revision, path }, false, signal));
  }
  readIncoming(mirrorId: string, revision: number, path: string, token: string) {
    return this.route(mirrorId, files => files.readIncoming(mirrorId, revision, path, token),
      () => this.request('noteRead', { mirrorId, revision, path, selector: { version: 'incoming', token } }, false));
  }
  inspect(mirrorId: string, revision: number, path: string) {
    return this.route(mirrorId, files => files.inspect(mirrorId, revision, path), () => this.request('noteInspectConflict', { mirrorId, revision, path }, false));
  }
  listProjectMove(input: Parameters<NonNullable<VaultFiles['listProjectMove']>>[0]) {
    return this.route(input.mirrorId, files => files.listProjectMove(input), () => this.listLegacyProjectMove(input));
  }

  private async listLegacyProjectMove(input: Parameters<NonNullable<VaultFiles['listProjectMove']>>[0]) {
    if (input.project !== 'standalone') throw new VaultError('unsupported', 'Moving project folders requires direct local vault access.');
    const { mirrorId, revision } = input;
    for (const path of input.afterMove ? [] : [input.path, input.destination]) {
      const parts = path.split('/'), name = parts.pop()!;
      const folder = parts.join('/');
      const children: Awaited<ReturnType<NonNullable<VaultFiles['children']>>> = await this.request('noteChildren', { mirrorId, revision, folder }, false);
      if (children.incomplete || children.entries.some(entry => entry.kind === 'directory' && entry.name === name.slice(0, -3)))
        throw new VaultError('conflict', 'Check the project folder and destination before moving.');
    }
    const listed: Awaited<ReturnType<VaultFiles['list']>> = await this.request('noteList', { mirrorId, revision }, false);
    const paths = input.root ? listed.paths.filter(path => path.startsWith(input.root + '/')) : listed.paths;
    return { ...listed, paths, attachments: [] };
  }

  move(input: Parameters<NonNullable<VaultFiles['move']>>[0]) {
    return this.route(input.mirrorId, files => files.move(input), async () => {
      const { project, root: _root, movedNotes: _movedNotes, ...note } = input;
      if (project) await this.listLegacyProjectMove(input);
      return this.request('noteMove', note, true);
    });
  }

  async moveReceipts(input: Parameters<NonNullable<VaultFiles['moveReceipts']>>[0]) {
    const { project, ...note } = input;
    const local = await this.filesystem?.moveReceipts(note);
    if (local?.length || project === 'paired') return local ?? [];
    return this.call('noteMoveReceipts', note);
  }
  commit(input: Parameters<VaultFiles['commit']>[0]) {
    return this.route(input.mirrorId, files => files.commit(input), () => this.request('noteCommit', input, true));
  }
  resolve(input: Parameters<VaultFiles['resolve']>[0]) {
    return this.route(input.mirrorId, files => files.resolve(input), () => this.request('noteResolveConflict', input, true));
  }
  async receipts(input: Parameters<VaultFiles['receipts']>[0]): ReturnType<VaultFiles['receipts']> {
    const local = await this.filesystem?.receipts(input);
    if (input.operationId && local?.known) return local.receipts;
    const legacy: Awaited<ReturnType<VaultFiles['receipts']>> = await this.call('noteReceipts', input);
    return [...(local?.receipts ?? []), ...legacy].sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit);
  }
}
