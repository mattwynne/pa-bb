import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { noteRpcContract } from './icloud-note-contract.ts';
import { VaultError } from '../core/ports.ts';
import type { MirrorCatalog, VaultFiles, Diagnose, Catalog, Configuration } from '../core/ports.ts';
const local = z.object({ available: z.boolean(), reason: z.enum(['ownership', 'recovery_required', 'source_changed']).nullable(), pendingAgeMs: z.number().int().nonnegative().nullable(), applicationBlocker: z.enum(['application_uncertain', 'native_recovery']).nullable() }).strict();
const mirror = z.object({ id: z.string(), folder: z.object({ name: z.string() }), initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable(), local: local.optional() });
const status = z.object({ noteAccessVersion: z.number().int().nullable(), available: z.boolean(), connected: z.boolean(), challenge: z.string().nullable(), mirrors: z.array(mirror) });
const unavailable = (setup: string, nextAction: string): Catalog => ({ setup, nextAction, sources: [], connected: false, compatible: false });
export class ICloud implements MirrorCatalog, VaultFiles {
  constructor(private sdk: BbPluginApi['sdk'], private diagnose: Diagnose) {}
  async snapshot(): Promise<Catalog> {
    try {
      const plugins = await this.sdk.plugins.list(); const plugin = plugins.plugins.find(p => p.id === 'icloud');
      if (!plugin) return unavailable('missing', 'Install iCloud from Plugins, then open its settings.');
      if (!plugin.enabled) return unavailable('disabled', 'Enable iCloud in Plugins.');
      if (plugin.status !== 'running') return unavailable(plugin.status === 'error' ? 'icloud_error' : 'starting', 'Open iCloud settings and check its startup status.');
      const state = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: status });
      const catalog: Catalog = { setup: 'ready', nextAction: null, connected: state.connected, compatible: state.noteAccessVersion === 2,
        sources: state.mirrors.map(m => ({ id: m.id, name: m.folder.name, initialized: m.initialized, enabled: m.enabled, cloudConnected: state.connected, phase: m.phase, lastSuccess: m.lastSuccess, failure: m.failure, local: m.local ?? { available: false, reason: 'source_changed', pendingAgeMs: null, applicationBlocker: null } })) };
      if (catalog.compatible && state.mirrors.some(m => !m.local)) throw new Error('Invalid v2 local capability');
      if (!catalog.compatible) return { ...catalog, setup: 'incompatible', nextAction: 'Update iCloud and Obsidian together for coordinated note access v2. No filesystem fallback is available.' };
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
    if (mirrorId && method !== 'noteReceipts' && !catalog.sources.find(s => s.id === mirrorId)?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    const contract = noteRpcContract[method];
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method, input: { version: 2, ...(input as object) }, outputSchema: contract.output as z.ZodType<any> });
      if (!result.ok) { this.diagnose('rpc', result.category); throw new VaultError(result.category, result.nextAction, true); }
      return result.value;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      this.diagnose('rpc', uncertain ? 'uncertain' : 'unavailable');
      throw new VaultError(uncertain ? 'uncertain' : 'unavailable', uncertain ? 'The mutation reply was lost. Inspect its scoped operation receipt; do not repeat the change.' : 'Check iCloud is updated and running, then choose Check again.', true);
    }
  }
  async configure(value: Configuration) { await this.call('noteConfigure', { revision: value.revision, mirrorIds: value.vaultIds }); }
  list(mirrorId: string, revision: number) { return this.call('noteList', { mirrorId, revision }); }
  read(mirrorId: string, revision: number, path: string) { return this.call('noteRead', { mirrorId, revision, path }); }
  readIncoming(mirrorId: string, revision: number, path: string, token: string) { return this.call('noteRead', { mirrorId, revision, path, selector: { version: 'incoming', token } }); }
  inspect(mirrorId: string, revision: number, path: string) { return this.call('noteInspectConflict', { mirrorId, revision, path }); }
  commit(input: Parameters<VaultFiles['commit']>[0]) { return this.call('noteCommit', input, true); }
  resolve(input: Parameters<VaultFiles['resolve']>[0]) { return this.call('noteResolveConflict', input, true); }
  receipts(input: Parameters<VaultFiles['receipts']>[0]) { return this.call('noteReceipts', input); }
}
