import { z } from 'zod';
import semver from 'semver';
import { basename, dirname, join } from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { Baselines } from './baseline.ts';
import { runtimePorts } from './runtime.ts';
import { inspectCanonicalWorkspace, canonicalCheckout, unknownDevelopment, DevelopmentError } from './development.ts';
import { sourceFingerprint, sourceDetails } from './source-files.ts';
import { AppliedSources } from './applied-source.ts';
import { syncWorkspace } from './sync-workspace.ts';
import { sourceModePorts, sourceGeneration, sourceMoveCapabilities, sourceMoveSupported } from './source-mode.ts';
import type { Workspace } from '../core/workspace.ts';
import { ApplicationError, integrationId, installedSourcesSchema } from '../core/application.ts';
import type { ApplicationPorts, Assessment, IntegrationId, IntegrationInventoryRow, FailureCode, InstalledSource } from '../core/application.ts';
import { originUrl as SOURCE_URL } from '../core/workspace.ts';
const syncStatus = z.object({ updatePause: z.object({ version: z.literal(1), jobId: z.string().uuid().nullable(), manualRecovery: z.boolean().optional() }).optional(), mirrors: z.array(z.object({ id: z.string().uuid(), enabled: z.boolean(), phase: z.string(), failure: z.string().nullable() })).max(20) });
const validVersion = (value: string) => { if (value.length > 64 || !semver.valid(value)) throw new ApplicationError('unavailable'); return value; };
export function applicationPorts(bb: BbPluginApi, sourceUrl = SOURCE_URL, getDevelopmentCheckout?: () => Promise<string | undefined>, receiptRoot?: string): ApplicationPorts {
  const controller = new AbortController();
  const active = () => controller.signal.throwIfAborted();
  const signal = (timeout = 10000) => AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  const baseline = new Baselines(sourceUrl, undefined, controller.signal, {
    load: () => bb.storage.kv.get('active-baselines-v1'), save: value => bb.storage.kv.set('active-baselines-v1', value),
  });
  const list = () => bb.sdk.plugins.list({ signal: signal() });
  const available = new Map<IntegrationId, string>();
  let lastInventory: IntegrationInventoryRow[] = [];
  let workspace: Workspace | null = null;
  let localRows: Assessment[] = [], pendingLocal = false;
  const instance = randomUUID();
  const appliedSources = new AppliedSources({ load: () => bb.storage.kv.get('applied-source-v1'), save: value => bb.storage.kv.set('applied-source-v1', value) }, controller.signal);
  const checkout = async () => getDevelopmentCheckout ? await getDevelopmentCheckout() : canonicalCheckout();
  const localRoot = async (id: IntegrationId, root: string, requested: string) => {
    if (!requested.startsWith('path:')) return null;
    const base = await checkout(); if (!base) return null;
    try {
      const expected = await realpath(join(base, 'plugins', id));
      return await realpath(root) === expected && requested === `path:${expected}` ? expected : null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const localFingerprint = (root: string, enabled: boolean, applied: string | null) => createHash('sha256').update(JSON.stringify([root, enabled, applied])).digest('hex');
  const localSnapshot = async () => { const root = await checkout(); return root ? inspectCanonicalWorkspace(controller.signal, sourceUrl, root, 'HEAD').catch(() => null) : null; };
  const sourceAt = async (id: IntegrationId, path: string, snapshot: Workspace | null) => {
    const value = snapshot?.components[id];
    return value?.stamp ? { fingerprint: value.working, stamp: value.stamp } : sourceDetails(path);
  };
  const localVersion = async (root: string) => validVersion(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  const healthy = (plugin: Awaited<ReturnType<typeof list>>['plugins'][number]) => plugin.enabled ? plugin.status === 'running' && !plugin.statusDetail && (!plugin.app?.hasApp || plugin.app.bundle?.compatible) : plugin.status === 'disabled';
  let installedSourceFailure: 'source_unavailable' | 'unavailable' | null = null;
  const sourceDiagnostic = (outcome: typeof installedSourceFailure) => {
    if (outcome && outcome !== installedSourceFailure) bb.log.warn(`pa-updates stage=installed-sources outcome=${outcome}`);
    installedSourceFailure = outcome;
  };
  let selfUncertainLogged = false;
  const selfUncertain = (actual: string | null, code: FailureCode) => {
    if (!selfUncertainLogged) { selfUncertainLogged = true; bb.log.warn(`pa-updates stage=self-reconcile outcome=${code}`); }
    return { state: 'uncertain' as const, actual };
  };
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
  const runtime = runtimePorts(bb, controller.signal);
  const sourceMode = sourceModePorts(bb, { sourceUrl, checkout, receiptRoot, active,
    manifest: async (commit, id) => { try { return await baseline.manifest(commit, id); } finally { await baseline.close(); } },
    remember: (id, path, source, stamp) => appliedSources.remember(id, path, source, stamp),
  });
  const protectRestart = (row: import('../core/runtime-model.ts').RuntimeRow) => pendingLocal && row.id === 'bb' && row.state === 'ready'
    ? { ...row, state: 'unavailable' as const, reason: 'local_pending' as const } : row;
  return {
    sourceMode,
    async installedSources() {
      // Do not reuse lastInventory: CLI/other-thread installs bypass this controller.
      // No baselines, code hashing, native update checks, KV or Git operations.
      let unavailable = false;
      try {
        const listed = await list(); active();
        const rows: InstalledSource[] = [];
        for (const plugin of listed.plugins) {
          const id = integrationId.safeParse(plugin.id); if (!id.success) continue;
          const installed = plugin.version.length <= 64 && semver.valid(plugin.version) ? plugin.version : 'unknown';
          const row: InstalledSource = { id: id.data, installed, sourceEnabled: plugin.enabled, sourceMode: null, sourceGeneration: null };
          try {
            const provenance = await bb.sdk.plugins.getSource({ pluginId: id.data, signal: signal() }); active();
            row.sourceMode = await localRoot(id.data, plugin.rootDir, provenance.requested) ? 'local' : trusted(provenance, id.data) ? 'managed' : 'unsupported';
            row.sourceGeneration = sourceGeneration(plugin, provenance);
          } catch { active(); unavailable = true; }
          rows.push(row);
        }
        const result = installedSourcesSchema.parse(rows);
        sourceDiagnostic(unavailable ? 'source_unavailable' : null);
        return result;
      } catch {
        active(); sourceDiagnostic('unavailable');
        throw new Error('Installed sources unavailable. Check again in Settings.');
      }
    },
    async development() {
      workspace = null;
      try {
        const checkout = getDevelopmentCheckout ? await getDevelopmentCheckout() : canonicalCheckout();
        workspace = checkout ? await inspectCanonicalWorkspace(controller.signal, sourceUrl, checkout) : null;
        return workspace ? Object.fromEntries(integrationId.options.map(id => [id, workspace!.components[id].local ? 'unpublished' : 'clean'])) as import('../core/application-model.ts').DevelopmentWork : null;
      }
      catch (error) {
        if (!controller.signal.aborted) bb.log.warn(`pa-updates stage=development outcome=${error instanceof DevelopmentError ? error.category : 'unavailable'}`);
        return unknownDevelopment();
      }
    },
    workspace: () => workspace ? structuredClone(workspace) : null,
    localCandidates: () => structuredClone(localRows),
    async syncWorkspace(expected) {
      const root = await checkout(); if (!root) return { state: 'held' as const, reason: 'unavailable' as const };
      const result = await syncWorkspace(root, expected, controller.signal, sourceUrl); active();
      if (result.state === 'updated') workspace = result.workspace;
      return result;
    },
    inventory: () => structuredClone(lastInventory),
    async inspect(onResult, mode = 'origin') {
      const rows: Assessment[] = [], inventory: IntegrationInventoryRow[] = []; available.clear(); localRows = []; pendingLocal = false;
      const localWork = mode === 'local' ? await localSnapshot() : workspace;
      let capabilities = { direct: false, catalogGitToLocal: false };
      if (bb.server?.loopbackBaseUrl) {
        try { capabilities = await sourceMoveCapabilities(bb); }
        catch { active(); bb.log.warn('pa-updates stage=source-capability outcome=unavailable'); }
      }
      try {
        const listed = await list(); let retained = false;
        for (const plugin of listed.plugins) {
          const id = integrationId.safeParse(plugin.id); if (!id.success) continue;
          let assessment: { local: 'stock' | 'custom' | 'unknown'; fingerprint: string; originalVersion: string } | null = null;
          let applied: string | null = null;
          let sourceMode: IntegrationInventoryRow['sourceMode'] = 'unsupported';
          let generation: string | undefined;
          const facts = () => ({ workspace: workspace?.components[id.data] ?? null, applied, sourceMode, sourceEnabled: plugin.enabled,
            sourceSwitchSupported: sourceMoveSupported(capabilities, plugin.provenance, sourceMode ?? 'unsupported'),
            ...(typeof workspace?.originComparisonMatches === 'boolean' ? { originComparisonMatches: workspace.originComparisonMatches } : {}),
            ...(generation ? { sourceGeneration: generation } : {}) });
          const installed = plugin.version.length <= 64 && semver.valid(plugin.version) ? plugin.version : 'unknown';
          const snapshot = (state: IntegrationInventoryRow['state'], prerequisite: IntegrationInventoryRow['prerequisite'] = null) => {
            const row: IntegrationInventoryRow = { ...facts(), id: id.data, installed, state, local: assessment?.local ?? 'unknown', prerequisite };
            inventory.push(row); onResult?.(structuredClone(row));
          };
          try {
            validVersion(plugin.version);
            const provenance = await bb.sdk.plugins.getSource({ pluginId: id.data, signal: signal() });
            generation = sourceGeneration(plugin, provenance);
            const path = await localRoot(id.data, plugin.rootDir, provenance.requested);
            if (path) {
              sourceMode = 'local';
              const work = localWork?.components[id.data] ?? null;
              const details = await sourceAt(id.data, path, localWork), working = details.fingerprint;
              const known = await appliedSources.get(id.data, path);
              applied = healthy(plugin) && await appliedSources.confirmed(id.data, path, details.stamp) ? known : null;
              assessment = { local: known ? 'stock' : 'unknown', fingerprint: localFingerprint(path, plugin.enabled, known), originalVersion: installed };
              const version = await localVersion(path), fingerprint = assessment.fingerprint;
              const needsApply = !applied || applied !== working;
              if (needsApply) {
                localRows.push({ ...facts(), id: id.data, installed, available: version, local: assessment.local, fingerprint, targetFingerprint: working, prerequisite: null });
                if (mode === 'local') available.set(id.data, version);
                if (!known || !work || work.local) pendingLocal = true;
              }
              if (mode === 'local') { if (needsApply) rows.push(localRows.at(-1)!); snapshot('current'); continue; }
              if (work && known !== work.origin) {
                const blocked = !known ? 'baseline_unknown' as const : working !== work.origin && (workspace?.dirty || workspace?.ahead) ? 'source_work' as const : null;
                if (!work.upstream && working !== work.origin) { snapshot('current'); continue; }
                if (working === work.origin && !needsApply) { snapshot('current'); continue; }
                const target = await baseline.manifest(workspace!.originHead, id.data), offered = validVersion(target.version);
                available.set(id.data, offered);
                rows.push({ ...facts(), id: id.data, installed, available: offered, local: blocked ? 'unknown' : assessment.local, fingerprint, targetFingerprint: work.origin, prerequisite: blocked });
                snapshot('offered', blocked); continue;
              }
              snapshot('current'); continue;
            }
            if (mode === 'local') { snapshot('unavailable', 'unsupported_install'); continue; }
            const supported = trusted(provenance, id.data);
            sourceMode = supported ? 'managed' : 'unsupported';
            try {
              // Seed independently reconstructed originals even without an
              // integration offer: later BB updates may prune this builder.
              if (supported) {
                if (!retained) { await baseline.retain(listed.plugins.flatMap(plugin => { const id = integrationId.safeParse(plugin.id); return id.success ? [id.data] : []; })); retained = true; }
                assessment = await baseline.inspect(id.data, plugin.rootDir, revision(provenance.resolved));
                if (assessment.local === 'stock') applied = await sourceFingerprint(plugin.rootDir);
              }
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
            // Git code changes count even without a version bump. Conversely,
            // another plugin's commit must not update this component.
            const targetFingerprint = await baseline.sourceIdentity(checked.candidate.version, id.data);
            const installedFingerprint = await baseline.sourceIdentity(basename(dirname(dirname(plugin.rootDir))), id.data);
            if (targetFingerprint === installedFingerprint) {
              if (!assessment) throw new ApplicationError('baseline_unknown');
              snapshot('current'); continue;
            }
            available.set(id.data, offered);
            if (!assessment) throw new ApplicationError('baseline_unknown');
            rows.push({ ...facts(), id: id.data, installed, available: offered, local: assessment.local, fingerprint: assessment.fingerprint, targetFingerprint, prerequisite: null });
            snapshot('offered');
          } catch (error) {
            if (sourceMode === 'local' || plugin.source?.startsWith('path:')) pendingLocal = true;
            const code = error instanceof ApplicationError ? error.category : 'unavailable';
            if (code === 'storage' || code === 'interrupted') throw error;
            bb.log.warn(`pa-updates stage=review outcome=${code}`);
            snapshot('unavailable', code);
            // Only confirmed origin code changes belong in the offer/receipt path.
            const offered = available.get(id.data);
            if (offered) rows.push({ ...facts(), id: id.data, installed, available: offered, local: 'unknown', fingerprint: '', prerequisite: code });
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
        const before = (await list()).plugins.find(item => item.id === id);
        if (!before) throw new ApplicationError('changed');
        const initialSource = await bb.sdk.plugins.getSource({ pluginId: id, signal: signal() });
        const path = await localRoot(id, before.rootDir, initialSource.requested);
        if (path) {
          const known = await appliedSources.get(id, path), snapshot = await localSnapshot();
          const details = await sourceAt(id, path, snapshot), working = details.fingerprint;
          if (!authorized.target || working !== authorized.target || localFingerprint(path, before.enabled, known) !== authorized.fingerprint) throw new ApplicationError('changed');
          if (id === 'icloud' || id === 'obsidian') {
            const cloud = (await list()).plugins.find(plugin => plugin.id === 'icloud');
            if (cloud?.enabled) { const held = await sync(); if (held.updatePause?.jobId !== authorized.jobId || held.mirrors.some(mirror => mirror.enabled || mirror.phase === 'running')) throw new ApplicationError('changed'); }
          }
          active();
          // BB compiles path-source code and keeps its previous instance if the
          // candidate fails. Do not add a second compiler or reinstall it.
          await bb.sdk.plugins.reload({ pluginId: id }); active();
          const actual = (await list()).plugins.find(item => item.id === id);
          const after = await sourceAt(id, path, await localSnapshot());
          if (!actual || actual.enabled !== before.enabled || !healthy(actual) || after.fingerprint !== working || after.stamp !== details.stamp || !await localRoot(id, actual.rootDir, (await bb.sdk.plugins.getSource({ pluginId: id, signal: signal() })).requested)) throw new ApplicationError('unavailable');
          await appliedSources.remember(id, path, working, details.stamp); active();
          return { actual: validVersion(actual.version), updated: known !== working };
        }
        if (authorized.mode === 'local') throw new ApplicationError('unsupported_install');
        const beforeSource = await source(id);
        if (before.version !== authorized.installed) throw new ApplicationError('changed');
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
        if (!actual || actual.enabled !== before.enabled || !healthy(actual)) throw new ApplicationError('unavailable');
        const provenance = await source(id);
        const checked = await baseline.inspect(id, actual.rootDir, revision(provenance.resolved));
        if (checked.local !== 'stock') throw new ApplicationError('changed');
        if (actual.enabled) await bb.sdk.plugins.callRpc({ pluginId: id, method: 'status', input: null, outputSchema: z.unknown(), signal: signal() });
        return { actual: validVersion(actual.version), updated: outcome.applied };
      } finally { await baseline.close(); }
    },
    self: {
      async prepare(authorized) {
        try {
          const current = (await list()).plugins.find(item => item.id === 'pa-updates');
          const currentSource = await bb.sdk.plugins.getSource({ pluginId: 'pa-updates', signal: signal() });
          const path = current ? await localRoot('pa-updates', current.rootDir, currentSource.requested) : null;
          if (path && current) {
            const known = await appliedSources.get('pa-updates', path), snapshot = await localSnapshot();
            const details = await sourceAt('pa-updates', path, snapshot), working = details.fingerprint;
            if (!current.enabled || !authorized.target || working !== authorized.target || localFingerprint(path, current.enabled, known) !== authorized.fingerprint) throw new ApplicationError('changed');
            return { before: validVersion(current.version), source: currentSource.resolved, requestedAt: new Date().toISOString(), local: { path, expected: working, stamp: details.stamp, instance } };
          }
          if (authorized.mode === 'local') throw new ApplicationError('unsupported_install');
          const provenance = await source('pa-updates'), before = current;
          if (!before || !before.enabled || before.status !== 'running' || before.version !== authorized.installed) throw new ApplicationError('changed');
          const bytes = await baseline.inspect('pa-updates', before.rootDir, revision(provenance.resolved));
          if (bytes.fingerprint !== authorized.fingerprint) throw new ApplicationError('changed');
          active(); return { before: validVersion(before.version), source: provenance.resolved, requestedAt: new Date().toISOString() };
        } finally { await baseline.close(); }
      },
      async apply(intent) {
        if (intent.local) {
          const current = (await list()).plugins.find(item => item.id === 'pa-updates');
          const provenance = await bb.sdk.plugins.getSource({ pluginId: 'pa-updates', signal: signal() });
          const path = current ? await localRoot('pa-updates', current.rootDir, provenance.requested) : null;
          const details = path ? await sourceAt('pa-updates', path, await localSnapshot()) : null;
          if (!path || path !== intent.local.path || details?.fingerprint !== intent.local.expected || !intent.local.stamp || details.stamp !== intent.local.stamp || instance !== intent.local.instance) throw new ApplicationError('changed');
          active(); await bb.sdk.plugins.reload({ pluginId: 'pa-updates' }); active(); return;
        }
        const currentSource = await source('pa-updates'); active();
        if (currentSource.resolved !== intent.source) throw new ApplicationError('changed');
        // Only the native replacement is admitted here. Do not read or write
        // plugin state after disposal; the new instance owns reconciliation.
        const outcome = await bb.sdk.plugins.applyUpdate({ pluginId: 'pa-updates' });
        active(); if (outcome.outcome === 'rolled-back') throw new ApplicationError('unavailable');
      },
      async reconcile(intent, completed = false) {
        const expired = Date.now() - Date.parse(intent.requestedAt) >= 15 * 60_000;
        let actual: string | null = null;
        try {
          const running = (await list()).plugins.find(item => item.id === 'pa-updates');
          if (!running || !running.enabled || running.status !== 'running') return expired ? selfUncertain(actual, 'interrupted') : { state: 'pending', actual };
          actual = validVersion(running.version);
          if (intent.local) {
            if (instance === intent.local.instance) return completed ? { state: 'unchanged', actual } : expired ? selfUncertain(actual, 'interrupted') : { state: 'pending', actual };
            const provenance = await bb.sdk.plugins.getSource({ pluginId: 'pa-updates', signal: signal() });
            const path = await localRoot('pa-updates', running.rootDir, provenance.requested);
            const details = path ? await sourceAt('pa-updates', path, await localSnapshot()) : null;
            if (!path || path !== intent.local.path || !healthy(running) || details?.fingerprint !== intent.local.expected || !intent.local.stamp || details.stamp !== intent.local.stamp) throw new ApplicationError('changed');
            await appliedSources.remember('pa-updates', path, intent.local.expected, details.stamp); active();
            return { state: 'updated', actual };
          }
          const provenance = await source('pa-updates');
          if (actual === intent.before && provenance.resolved === intent.source) return completed ? { state: 'unchanged', actual } : expired ? selfUncertain(actual, 'interrupted') : { state: 'pending', actual };
          if (!healthy(running)) throw new ApplicationError('unavailable');
          const bytes = await baseline.inspect('pa-updates', running.rootDir, revision(provenance.resolved));
          if (bytes.local !== 'stock' || provenance.resolved === intent.source) throw new ApplicationError('changed');
          return { state: 'updated', actual };
        } catch (error) {
          active();
          if (error instanceof ApplicationError && error.category === 'storage') throw error;
          return selfUncertain(actual, error instanceof ApplicationError ? error.category : 'unavailable');
        } finally { await baseline.close(); }
      },
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
    runtime: { ...runtime, async inspect(report) {
      const result = await runtime.inspect((row, target) => report?.(protectRestart(row), target)); active();
      return { ...result, rows: result.rows.map(protectRestart) };
    } },
    cancel: async () => { controller.abort(); await Promise.all([baseline.stop(), appliedSources.drain(), sourceMode.drain()]); },
    load: () => bb.storage.kv.get('application-v1'), save: value => bb.storage.kv.set('application-v1', value),
    diagnose(stage, code) { bb.log.warn(`pa-updates stage=${stage} outcome=${code}`); },
  };
}
