import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { isAbsolute, normalize } from 'node:path';
import { FilesystemVault } from './filesystem-vault.ts';
import { LocalReceipts } from './local-receipts.ts';
import { noteRpcContract, searchCapabilitySchema } from './icloud-note-contract.ts';
import { VaultError } from '../core/ports.ts';
import type { MirrorCatalog, VaultFiles, Diagnose, Catalog, Configuration } from '../core/ports.ts';
const local = z.object({ available: z.boolean(), reason: z.enum(['ownership', 'recovery_required', 'source_changed']).nullable(), pendingAgeMs: z.number().int().nonnegative().nullable(), applicationBlocker: z.enum(['application_uncertain', 'native_recovery']).nullable() }).strict();
const filesystemMode = z.enum(['ready', 'legacy_pending', 'legacy_conflict', 'unavailable']);
const directoryResult = z.object({ directory: z.string().min(1).max(4096).refine(p => isAbsolute(p) && p !== '/' && normalize(p) === p && !/[\x00-\x1f\x7f]/.test(p)) }).strict();
const mirror = z.object({ id: z.string(), folder: z.object({ name: z.string() }), initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable(), local: local.optional(), filesystem: filesystemMode.optional() });
const status = z.object({ search: z.unknown().optional(), mirrorAccessVersion: z.number().int().nullish(), noteAccessVersion: z.number().int().nullable(), available: z.boolean(), connected: z.boolean(), challenge: z.string().nullable(), mirrors: z.array(mirror) });
const unavailable = (setup: string, nextAction: string): Catalog => ({ setup, nextAction, sources: [], connected: false, compatible: false });
export class ICloud implements MirrorCatalog, VaultFiles {
  private filesystem?: FilesystemVault;
  constructor(private sdk: BbPluginApi['sdk'], private diagnose: Diagnose, kv?: BbPluginApi['storage']['kv']) {
    if (kv) this.filesystem = new FilesystemVault(this.directory.bind(this), new LocalReceipts(kv), diagnose);
  }
  stop() { return this.filesystem?.searcher.stop(); }
  private checking?: Promise<Catalog>;
  snapshot(): Promise<Catalog> {
    return this.checking ??= this.checkCatalog().finally(() => { this.checking = undefined; });
  }

  private async checkCatalog(): Promise<Catalog> {
    try {
      const plugins = await this.sdk.plugins.list(); const plugin = plugins.plugins.find(p => p.id === 'icloud');
      if (!plugin) return unavailable('missing', 'Install iCloud from Plugins, then open its settings.');
      if (!plugin.enabled) return unavailable('disabled', 'Enable iCloud in Plugins.');
      if (plugin.status !== 'running') return unavailable(plugin.status === 'error' ? 'icloud_error' : 'starting', 'Open iCloud settings and check its startup status.');
      const state = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: status });
      const search = searchCapabilitySchema.safeParse(state.search);
      const filesystem = state.mirrorAccessVersion === 3 ? Object.fromEntries(state.mirrors.map(m => [m.id, m.filesystem ?? 'unavailable'])) : undefined;
      const nativeSearch = this.filesystem && state.mirrors.some(m => m.local?.available && filesystem?.[m.id] === 'ready')
        ? await this.filesystem.searcher.capability() : undefined;
      const legacySearch = search.success ? search.data :
        { version: 1 as const, available: false, reason: state.search === undefined ? 'unavailable' as const : 'unsupported_version' as const };
      const catalog: Catalog = { filesystem, search: nativeSearch?.available || !legacySearch.available ? nativeSearch ?? legacySearch : legacySearch, setup: 'ready', nextAction: null, connected: state.connected, compatible: state.noteAccessVersion === 2,
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
    } catch { this.diagnose('catalog', 'unavailable'); return unavailable('check_failed', 'Could not check iCloud. Keep your settings and choose Check again.'); }
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
      this.diagnose('rpc', 'source_unavailable');
      throw new VaultError('source_unavailable', 'iCloud could not authorize direct local access. Check the mirror in iCloud settings.', true);
    }
  }

  private async route<T>(mirrorId: string, local: (filesystem: FilesystemVault) => Promise<T>, legacy: () => Promise<T>) {
    const catalog = await this.snapshot();
    if (!catalog.compatible) throw new VaultError(catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable', catalog.nextAction ?? 'Check iCloud status.');
    if (!catalog.sources.find(s => s.id === mirrorId)?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    if (catalog.filesystem?.[mirrorId] === 'ready') {
      if (!this.filesystem) throw new VaultError('source_unavailable');
      return local(this.filesystem);
    }
    return legacy();
  }

  private async request<K extends keyof typeof noteRpcContract>(method: K, input: unknown, uncertain: boolean, signal?: AbortSignal): Promise<any> {
    const contract = noteRpcContract[method];
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method, input: { version: 2, ...(input as object) }, outputSchema: contract.output as z.ZodType<any>, signal });
      if (!result.ok) { this.diagnose('rpc', result.category); throw new VaultError(result.category, result.nextAction, true); }
      return result.value;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      if (signal?.aborted) throw new VaultError('cancelled');
      this.diagnose('rpc', uncertain ? 'uncertain' : 'unavailable');
      throw new VaultError(uncertain ? 'uncertain' : 'unavailable', uncertain ? 'The mutation reply was lost. Inspect its scoped operation receipt; do not repeat the change.' : 'Check iCloud is updated and running, then choose Check again.', true);
    }
  }
  async configure(value: Configuration) { await this.call('noteConfigure', { revision: value.revision, mirrorIds: value.vaultIds }); }
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
  children(mirrorId: string, revision: number, folder: string) {
    return this.route(mirrorId, files => files.children(mirrorId, revision, folder), () => this.request('noteChildren', { mirrorId, revision, folder }, false));
  }
  list(mirrorId: string, revision: number) {
    return this.route(mirrorId, files => files.list(mirrorId, revision), () => this.request('noteList', { mirrorId, revision }, false));
  }
  read(mirrorId: string, revision: number, path: string) {
    return this.route(mirrorId, files => files.read(mirrorId, revision, path), () => this.request('noteRead', { mirrorId, revision, path }, false));
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
  move(input: Parameters<NonNullable<VaultFiles['move']>>[0]) {
    return this.route(input.mirrorId, files => files.move(input), () => this.request('noteMove', input, true));
  }
  async moveReceipts(input: Parameters<NonNullable<VaultFiles['moveReceipts']>>[0]) {
    const local = await this.filesystem?.moveReceipts(input);
    return local?.length ? local : this.call('noteMoveReceipts', input);
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
