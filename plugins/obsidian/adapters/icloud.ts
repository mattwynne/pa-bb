import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { noteRpcContract } from './icloud-note-contract.ts';
import { VaultError } from '../core/ports.ts';
import type { MirrorCatalog, VaultFiles, Diagnose, Catalog, Configuration } from '../core/ports.ts';
const mirror = z.object({ id: z.string(), folder: z.object({ name: z.string() }), initialized: z.boolean(), enabled: z.boolean(), phase: z.enum(['paused', 'ready', 'running', 'failed', 'retained']), lastSuccess: z.string().nullable(), failure: z.string().nullable() });
const status = z.object({ noteAccessVersion: z.number().nullable().optional(), available: z.boolean(), connected: z.boolean(), challenge: z.string().nullable(), mirrors: z.array(mirror) });
const inventory = z.array(z.object({ id: z.string(), name: z.string(), localFolder: z.string(), phase: z.string(), lastSuccess: z.string().nullable() }));
export class ICloud implements MirrorCatalog, VaultFiles {
  constructor(private sdk: BbPluginApi['sdk'], private diagnose: Diagnose) {}
  async snapshot(): Promise<Catalog> {
    const unavailable = (setup: string, nextAction: string): Catalog => ({ setup, nextAction, sources: [], connected: false });
    try {
      const plugins = await this.sdk.plugins.list(); const plugin = plugins.plugins.find(p => p.id === 'icloud');
      if (!plugin) return unavailable('missing', 'Install iCloud from Plugins, then open its settings.');
      if (!plugin.enabled) return unavailable('disabled', 'Enable iCloud in Plugins.');
      if (plugin.status !== 'running') return unavailable(plugin.status === 'error' ? 'icloud_error' : 'starting', 'Open iCloud settings and check its startup status.');
      const state = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: status });
      const sources = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'inventory', input: null, outputSchema: inventory });
      // localFolder is server-only compatibility evidence, never propagated to
      // the domain, settings, tools, exceptions or diagnostic messages.
      const catalog: Catalog = { setup: 'ready', nextAction: null, connected: state.connected, sources: state.mirrors.filter(m => sources.some(s => s.id === m.id)).map(m => ({ id: m.id, name: m.folder.name, initialized: m.initialized, enabled: m.enabled, phase: m.phase, lastSuccess: m.lastSuccess, failure: m.failure })) };
      if (state.noteAccessVersion !== 1) return { ...catalog, setup: 'incompatible', nextAction: 'Update iCloud to a version with coordinated Obsidian note access. No uncoordinated fallback is available.' };
      if (!state.available) return { ...catalog, setup: 'host_prerequisite', nextAction: 'Ask the operator to check the host requirements shown in iCloud settings.' };
      if (state.challenge) return { ...catalog, setup: 'apple_verification', nextAction: 'Finish Apple verification in iCloud settings, never in chat.' };
      if (!state.connected) return { ...catalog, setup: 'apple_disconnected', nextAction: 'Connect Apple in iCloud settings. Existing successful paused copies may be stale.' };
      if (!state.mirrors.length) return { ...catalog, setup: 'no_folder', nextAction: 'Choose a vault folder in iCloud settings.' };
      if (state.mirrors.some(m => !m.initialized && m.phase === 'running')) return { ...catalog, setup: 'initial_sync_running', nextAction: 'Wait for initial sync to finish in iCloud settings.' };
      if (state.mirrors.some(m => !m.initialized && m.phase === 'failed')) return { ...catalog, setup: 'initial_sync_failed', nextAction: 'Inspect the initial-sync failure in iCloud settings. Do not rebuild merely to connect Obsidian.' };
      if (!state.mirrors.some(m => m.initialized)) return { ...catalog, setup: 'sync_disabled', nextAction: 'Enable sync for the selected folder in iCloud settings and finish initial sync.' };
      return catalog;
    } catch { this.diagnose('catalog', 'unavailable'); return unavailable('check_failed', 'Could not check iCloud. Keep your settings and choose Check again.'); }
  }
  private async call<K extends keyof typeof noteRpcContract>(method: K, input: unknown, uncertain = false): Promise<any> {
    const contract = noteRpcContract[method];
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: 'icloud', method, input: input as any, outputSchema: contract.output as z.ZodType<any> });
      if (!result.ok) { this.diagnose('rpc', result.category); throw new VaultError(result.category, result.nextAction, true); }
      return result.value;
    } catch (e) {
      if (e instanceof VaultError) throw e;
      this.diagnose('rpc', uncertain ? 'uncertain' : 'unavailable');
      throw new VaultError(uncertain ? 'uncertain' : 'unavailable', uncertain ? 'The save reply was lost. Inspect recent receipts; do not repeat the edit.' : 'Check iCloud is updated and running, then choose Check again.', true);
    }
  }
  async configure(value: Configuration) { await this.call('noteConfigure', { revision: value.revision, mirrorIds: value.vaultIds }); }
  list(mirrorId: string, revision: number) { return this.call('noteList', { mirrorId, revision }); }
  read(mirrorId: string, revision: number, path: string) { return this.call('noteRead', { mirrorId, revision, path }); }
  commit(input: Parameters<VaultFiles['commit']>[0]) { return this.call('noteCommit', input, true); }
  receipts(input: Parameters<VaultFiles['receipts']>[0]) { return this.call('noteReceipts', input); }
}
