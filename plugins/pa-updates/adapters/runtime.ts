import { createHash } from 'node:crypto';
import semver from 'semver';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { ApplicationError } from '../core/application-model.ts';
import type { RuntimePorts, RuntimeReview, RuntimeRow, RuntimeId } from '../core/runtime-model.ts';

type Sdk = BbPluginApi['sdk'];
type AppStatus = Awaited<ReturnType<Sdk['system']['appUpdate']>>;
type CliStatus = Awaited<ReturnType<Sdk['hosts']['providerCliStatus']>>[string];
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid = (value: string | null): string | null => value && value.length <= 64 && semver.valid(value) ? value : null;
const unavailable = (id: RuntimeId): RuntimeRow => ({ id, installed: null, available: null, source: 'unknown', fingerprint: '', state: 'unavailable', reason: 'unavailable' });

/** Only BB's own update/install APIs. No shell commands, session stops or host fallback. */
export function runtimePorts(bb: BbPluginApi, stopped: AbortSignal): RuntimePorts {
  const signal = () => AbortSignal.any([stopped, AbortSignal.timeout(60000)]);
  const target = async () => {
    const id = (await bb.sdk.system.config({ signal: signal() })).primaryHostId;
    if (!id) throw new ApplicationError('unavailable');
    const host = await bb.sdk.hosts.get({ hostId: id, signal: signal() });
    if (host.id !== id) throw new ApplicationError('changed');
    return { id, name: host.name.slice(0, 128) || id.slice(0, 128) };
  };
  const diagnose = (stage: 'runtime_target' | 'runtime_provider' | 'runtime_app') => bb.log.warn(`pa-updates stage=${stage} outcome=unavailable`);
  const assertHostId = async (expected: string | undefined) => {
    if (!expected || (await bb.sdk.system.config({ signal: signal() })).primaryHostId !== expected) throw new ApplicationError('changed');
  };
  const assertTarget = async (review: RuntimeReview) => { await assertHostId(review.target?.id); return review.target!; };
  const cliRow = (id: 'pi' | 'codex', hostId: string, status: CliStatus | undefined): RuntimeRow => {
    if (!status) return unavailable(id);
    const installed = valid(status.currentVersion), available = valid(status.latestVersion);
    const source = status.installSource === 'notInstalled' ? 'missing' : status.installSource;
    const owned = source === 'npmGlobal' && installed !== null && valid(status.npmGlobalPackageVersion) === installed;
    const missing = source === 'missing' && !status.installed;
    const supported = owned && status.installAction?.kind === 'update';
    const current = owned && available !== null && !status.needsUpdate && !semver.gt(available, installed!);
    const ready = supported && available !== null && installed !== null && semver.gt(available, installed);
    return { id, installed, available, source,
      fingerprint: fingerprint([hostId, id, installed, source, status.executablePath, status.npmPackageName, status.npmGlobalPackageVersion]),
      state: current ? 'current' : ready ? 'ready' : 'unavailable', reason: current || ready ? null : missing ? 'not_installed' : source === 'external' ? 'unsupported_install' : 'unavailable' };
  };
  const appRow = (hostId: string, status: AppStatus): RuntimeRow => {
    const source = status.support.kind === 'supported' ? status.support.mode : 'unknown';
    const channel = status.available?.channel;
    const supported = source === 'npm' ? channel === 'latest' : source === 'source' && channel === 'main';
    const blocked = status.support.kind !== 'supported' || status.blocked !== null || (channel !== undefined && !supported);
    const busy = status.activity.phase !== 'idle';
    return { id: 'bb', installed: status.current.version, available: status.available?.version ?? null, source,
      fingerprint: fingerprint([hostId, status.current, source]),
      state: blocked || busy ? 'unavailable' : status.available ? 'ready' : 'current',
      reason: busy ? 'busy' : status.blocked?.reason === 'fetch-failed' ? 'unavailable' : blocked ? 'unsupported_install' : null };
  };
  return {
    async inspect(onResult) {
      let host: RuntimeReview['target'] = null;
      try { host = await target(); } catch { diagnose('runtime_target'); /* No browser/local-machine fallback. */ }
      const report = (row: RuntimeRow) => { if (!stopped.aborted) onResult?.(structuredClone(row), host); return row; };
      if (!host) return { target: null, runningThreadCount: 0, rows: ['pi', 'codex', 'bb'].map(id => report(unavailable(id as RuntimeId))) };
      const hostId = host.id;
      // Provider status is one native read for both CLIs. Publish its two known
      // results independently of the concurrent BB check, whichever finishes first.
      const [providers, app] = await Promise.all([
        bb.sdk.hosts.providerCliStatus({ hostId, signal: signal() }).catch(() => { diagnose('runtime_provider'); return null; })
          .then(value => [report(cliRow('pi', hostId, value?.pi)), report(cliRow('codex', hostId, value?.codex))]),
        bb.sdk.system.appUpdate({ force: true, signal: signal() }).catch(() => { diagnose('runtime_app'); return null; }).then(value => {
          if (value?.blocked?.reason === 'fetch-failed') diagnose('runtime_app');
          return { row: report(value ? appRow(hostId, value) : unavailable('bb')), runningThreadCount: value?.runningThreadCount ?? 0 };
        }),
      ]);
      return { target: host, runningThreadCount: app.runningThreadCount, rows: [...providers, app.row] };
    },
    async updateCli(id, review) {
      const host = await assertTarget(review);
      const before = review.rows.find(row => row.id === id);
      const status = (await bb.sdk.hosts.providerCliStatus({ hostId: host.id, signal: signal() }))[id];
      const current = cliRow(id, host.id, status);
      if (!before || before.fingerprint !== current.fingerprint) throw new ApplicationError('changed');
      if (current.state === 'current' && current.installed) return { actual: current.installed, source: 'npmGlobal' };
      if (current.state !== 'ready' || !status?.installAction) throw new ApplicationError(current.reason ?? 'unavailable');
      await assertHostId(host.id); stopped.throwIfAborted();
      const events = await bb.sdk.hosts.installProviderCli({ hostId: host.id, provider: id, actionKind: status.installAction.kind });
      // Never persist or log native commands/output: they can contain environment/account data.
      if (!events.some(event => event.type === 'completed' && event.success) || events.some(event => event.type === 'error' || (event.type === 'completed' && !event.success))) throw new ApplicationError('unavailable');
      stopped.throwIfAborted(); await assertTarget(review);
      const actual = (await bb.sdk.hosts.providerCliStatus({ hostId: host.id, signal: signal() }))[id];
      const installed = valid(actual?.currentVersion ?? null);
      if (!actual?.installed || actual.installSource !== 'npmGlobal' || !installed || valid(actual.npmGlobalPackageVersion) !== installed || (before.installed && semver.lt(installed, before.installed))) throw new ApplicationError('unavailable');
      return { actual: installed, source: 'npmGlobal' };
    },
    async prepareBb(review, confirmInterruptingThreads) {
      const host = await assertTarget(review);
      const status = await bb.sdk.system.appUpdate({ force: true, signal: signal() });
      const before = review.rows.find(row => row.id === 'bb'), current = appRow(host.id, status);
      if (!before || before.fingerprint !== current.fingerprint) throw new ApplicationError('changed');
      if (current.state !== 'ready') throw new ApplicationError(current.reason ?? 'unavailable');
      if (status.runningThreadCount > 0 && !confirmInterruptingThreads) throw new ApplicationError('busy');
      return { hostId: host.id, previousResultId: status.lastResult?.id ?? null, requestedAt: new Date().toISOString(), fromVersion: status.current.version, fromCommit: status.current.commit };
    },
    async applyBb(intent, confirmInterruptingThreads) {
      await assertHostId(intent.hostId); stopped.throwIfAborted();
      try { await bb.sdk.system.applyAppUpdate({ confirmInterruptingThreads }); }
      catch (error) {
        // Native consent is checked again at admission. A new running thread
        // is a retryable refusal, not a fifteen-minute ambiguous restart.
        const status = await bb.sdk.system.appUpdate({ signal: signal() }).catch(() => null);
        if (status?.activity.phase === 'idle' && status.runningThreadCount > 0 && !confirmInterruptingThreads) throw new ApplicationError('busy');
        throw error;
      }
    },
    async reconcileBb(intent) {
      const host = await target();
      if (host.id !== intent.hostId) return { state: 'uncertain', actual: null };
      const status = await bb.sdk.system.appUpdate({ signal: signal() });
      if (status.activity.phase !== 'idle') return { state: 'pending', actual: null };
      const result = status.lastResult;
      // Launcher hello can be idle with the old result until full-stack-ready.
      // Read once and return: waiting inside plugin startup would delay readiness.
      if (!result || result.id === intent.previousResultId || Date.parse(result.finishedAt) < Date.parse(intent.requestedAt)) return { state: Date.now() - Date.parse(intent.requestedAt) < 15 * 60 * 1000 ? 'pending' : 'uncertain', actual: null };
      if (result.from.version !== intent.fromVersion || result.from.commit !== intent.fromCommit) return { state: 'uncertain', actual: null };
      if (result.outcome !== 'updated') return { state: 'failed', actual: status.current.version };
      if (status.current.version !== result.to.version || status.current.commit !== result.to.commit) return { state: 'uncertain', actual: status.current.version };
      return { state: 'updated', actual: status.current.version };
    },
  };
}
