import { z } from 'zod';
import semver from 'semver';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { Baselines } from './baseline.ts';
import { runtimePorts } from './runtime.ts';
import { ApplicationError, integrationId } from '../core/application.ts';
import type { ApplicationPorts, Assessment, IntegrationId, IntegrationInventoryRow } from '../core/application.ts';
import { SOURCE_URL } from '../core/release.ts';
const syncStatus = z.object({ updatePause: z.object({ version: z.literal(1), jobId: z.string().uuid().nullable(), manualRecovery: z.boolean().optional() }).optional(), mirrors: z.array(z.object({ id: z.string().uuid(), enabled: z.boolean(), phase: z.string(), failure: z.string().nullable() })).max(20) });
const validVersion = (value: string) => { if (value.length > 64 || !semver.valid(value)) throw new ApplicationError('unavailable'); return value; };
export function applicationPorts(bb: BbPluginApi, sourceUrl = SOURCE_URL): ApplicationPorts {
  const controller = new AbortController();
  const active = () => controller.signal.throwIfAborted();
  const signal = (timeout = 10000) => AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  const baseline = new Baselines(sourceUrl, undefined, controller.signal, {
    load: () => bb.storage.kv.get('active-baselines-v1'), save: value => bb.storage.kv.set('active-baselines-v1', value),
  });
  const list = () => bb.sdk.plugins.list({ signal: signal() });
  const available = new Map<IntegrationId, string>();
  let lastInventory: IntegrationInventoryRow[] = [];
  const trusted = (source: { requested: string; subdirectory?: string }, id: IntegrationId) =>
    [`git:${sourceUrl}@main`, `git:${sourceUrl}@ref:main`].includes(source.requested) && source.subdirectory === `plugins/${id}`;
  const source = async (id: IntegrationId) => {
    const value = await bb.sdk.plugins.getSource({ pluginId: id, signal: signal() });
    if (!trusted(value, id)) throw new ApplicationError('baseline_unknown');
    return value;
  };
  const revision = (resolved: string) => {
    const result = resolved.match(/\(([a-f0-9]{12}|[a-f0-9]{40})\)$/)?.[1];
    if (!result) throw new ApplicationError('baseline_unknown'); return result;
  };
  const sync = (method = 'status', input: null | { updateJob: string } = null) => bb.sdk.plugins.callRpc({ pluginId: 'icloud', method, input, outputSchema: syncStatus, signal: signal() });
  return {
    inventory: () => structuredClone(lastInventory),
    async inspect() {
      const rows: Assessment[] = [], inventory: IntegrationInventoryRow[] = []; available.clear();
      try {
        const listed = await list();
        await baseline.retain(listed.plugins.flatMap(plugin => { const id = integrationId.safeParse(plugin.id); return id.success ? [id.data] : []; }));
        for (const plugin of listed.plugins) {
          const id = integrationId.safeParse(plugin.id); if (!id.success) continue;
          let assessment: Awaited<ReturnType<Baselines['inspect']>> | null = null;
          const installed = plugin.version.length <= 64 && semver.valid(plugin.version) ? plugin.version : 'unknown';
          const snapshot = (state: IntegrationInventoryRow['state'], prerequisite: IntegrationInventoryRow['prerequisite'] = null) => inventory.push({ id: id.data, installed, state, local: assessment?.local ?? 'unknown', prerequisite });
          try {
            validVersion(plugin.version);
            const provenance = await bb.sdk.plugins.getSource({ pluginId: id.data, signal: signal() });
            const supported = trusted(provenance, id.data);
            try {
              // Seed independently reconstructed originals even without an
              // integration offer: later BB updates may prune this builder.
              if (supported) assessment = await baseline.inspect(id.data, plugin.rootDir, revision(provenance.resolved));
            } catch (error) {
              if (error instanceof ApplicationError && ['storage', 'interrupted'].includes(error.category)) throw error;
            }
            const checked = (await bb.sdk.plugins.checkUpdates({ pluginId: id.data, signal: signal(60000) })).find(item => item.id === id.data);
            if (!checked || checked.outcome === 'unavailable') throw new ApplicationError('unavailable');
            if (checked.outcome === 'pinned') { snapshot('pinned'); continue; }
            if (!supported) throw new ApplicationError('baseline_unknown');
            if (checked.outcome === 'current') {
              if (!assessment) throw new ApplicationError('baseline_unknown');
              snapshot('current'); continue;
            }
            if (checked.outcome === 'incompatible' || !checked.candidate) throw new ApplicationError('incompatible');
            const target = await baseline.manifest(checked.candidate.version, id.data), offered = validVersion(target.version);
            // Repository-only changes and newer installed packages are not offers.
            if (!semver.gt(offered, installed)) {
              if (!assessment) throw new ApplicationError('baseline_unknown');
              snapshot('current'); continue;
            }
            available.set(id.data, offered);
            if (!assessment) throw new ApplicationError('baseline_unknown');
            rows.push({ id: id.data, installed, available: offered, local: assessment.local, fingerprint: assessment.fingerprint, prerequisite: null });
            snapshot('offered');
          } catch (error) {
            const code = error instanceof ApplicationError ? error.category : 'unavailable';
            if (code === 'storage' || code === 'interrupted') throw error;
            bb.log.warn(`pa-updates stage=review outcome=${code}`);
            snapshot('unavailable', code);
            // Only a confirmed higher release belongs in the offer/receipt path.
            const offered = available.get(id.data);
            if (offered) rows.push({ id: id.data, installed, available: offered, local: 'unknown', fingerprint: '', prerequisite: code });
          }
        }
        lastInventory = inventory;
        return rows;
      } finally { await baseline.close(); }
    },
    async validateMix(installing) {
      if (!installing.some(id => id === 'icloud' || id === 'obsidian')) return;
      const pair = (await list()).plugins.filter(plugin => plugin.id === 'icloud' || plugin.id === 'obsidian');
      for (const plugin of pair) {
        const installed = validVersion(plugin.version);
        // 0.1/0.2 require the documented stopped paired migration. This slice
        // deliberately supports only the current 0.3.x note-v2 family.
        if (semver.lt(installed, '0.3.0')) throw new ApplicationError('paired_migration');
        const next = installing.includes(plugin.id as IntegrationId) ? available.get(plugin.id as IntegrationId) : installed;
        if (!next || !semver.satisfies(installed, '>=0.3.0 <0.4.0') || !semver.satisfies(next, '>=0.3.0 <0.4.0')) throw new ApplicationError('incompatible');
      }
    },
    async update(id, authorized) {
      try {
        const beforeSource = await source(id);
        const before = (await list()).plugins.find(item => item.id === id);
        if (!before || before.version !== authorized.installed) throw new ApplicationError('changed');
        const beforeBytes = await baseline.inspect(id, before.rootDir, revision(beforeSource.resolved));
        if (beforeBytes.fingerprint !== authorized.fingerprint) throw new ApplicationError('changed');
        if (id === 'icloud' || id === 'obsidian') {
          const cloud = (await list()).plugins.find(plugin => plugin.id === 'icloud');
          if (cloud?.enabled) {
            const held = await sync();
            if (held.updatePause?.jobId !== authorized.jobId || held.mirrors.some(mirror => mirror.enabled || mirror.phase === 'running')) throw new ApplicationError('changed');
          }
        }
        active(); // Last admission before the native non-cancellable write.
        const outcome = await bb.sdk.plugins.applyUpdate({ pluginId: id }); // Ordinary channel update, never a caller-supplied ref.
        if (outcome.outcome === 'rolled-back') throw new ApplicationError('unavailable');
        active();
        const actual = (await list()).plugins.find(item => item.id === id);
        if (!actual || actual.enabled !== before.enabled || (actual.enabled ? actual.status !== 'running' : actual.status !== 'disabled')) throw new ApplicationError('unavailable');
        const provenance = await source(id);
        const checked = await baseline.inspect(id, actual.rootDir, revision(provenance.resolved));
        if (checked.local !== 'stock') throw new ApplicationError('changed');
        if (actual.enabled) await bb.sdk.plugins.callRpc({ pluginId: id, method: 'status', input: null, outputSchema: z.unknown(), signal: signal() });
        return { actual: validVersion(actual.version), updated: outcome.applied };
      } finally { await baseline.close(); }
    },
    async quiesce(ids, jobId, remember) {
      if (!ids.some(id => id === 'icloud' || id === 'obsidian')) return;
      const cloud = (await list()).plugins.find(plugin => plugin.id === 'icloud');
      if (!cloud?.enabled) return;
      let current = await sync();
      if (!current.updatePause) throw new ApplicationError('maintenance_unavailable');
      if (current.updatePause.jobId && current.updatePause.jobId !== jobId) throw new ApplicationError('changed');
      await remember(); // Persist reservation intent even when no folders are enabled.
      const deadline = Date.now() + 120000;
      do {
        active(); current = await sync('pause', { updateJob: jobId });
        if (current.updatePause?.jobId !== jobId) throw new ApplicationError('changed');
        if (!current.mirrors.some(mirror => mirror.enabled || mirror.phase === 'running')) return;
        if (Date.now() >= deadline) throw new ApplicationError('unavailable');
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (true);
    },
    async restore(jobId) {
      active(); const current = await sync();
      if (!current.updatePause) throw new ApplicationError('maintenance_unavailable');
      if (current.updatePause.jobId === null) return current.updatePause.manualRecovery ? 'manual_recovery' : undefined;
      if (current.updatePause.jobId !== jobId) throw new ApplicationError('changed');
      const restored = await sync('enable', { updateJob: jobId });
      if (restored.updatePause?.jobId !== null) throw new ApplicationError('unavailable');
      if (restored.updatePause.manualRecovery) return 'manual_recovery';
    },
    runtime: runtimePorts(bb, controller.signal),
    cancel: () => { controller.abort(); return baseline.stop(); },
    load: () => bb.storage.kv.get('application-v1'), save: value => bb.storage.kv.set('application-v1', value),
    diagnose(stage, code) { bb.log.warn(`pa-updates stage=${stage} outcome=${code}`); },
  };
}
