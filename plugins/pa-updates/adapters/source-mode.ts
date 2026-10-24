import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import semver from 'semver';
import { z } from 'zod';
import { ApplicationError, SourceSwitchError, sourceSwitchSchema } from '../core/application-model.ts';
import type { IntegrationId, SourceSwitch } from '../core/application-model.ts';
import type { ApplicationPorts } from '../core/application.ts';
import { originUrl } from '../core/workspace.ts';
import { canonicalCheckout } from './development.ts';
import { sourceDetails } from './source-files.ts';
import { sourceModeRunnerScript } from './source-mode-runner.ts';
import type { SourceModeIntent } from './source-mode-runner.ts';

const pauseStatusSchema = z.object({ updatePause: z.object({ version: z.literal(1), jobId: z.string().uuid().nullable() }),
  mirrors: z.array(z.object({ id: z.string().uuid(), enabled: z.boolean(), phase: z.string().max(64) })).max(20) });
export const sourceGeneration = (plugin: { id: string; version: string; enabled: boolean; rootDir: string }, source: { requested: string; resolved: string; subdirectory?: string }) =>
  createHash('sha256').update(JSON.stringify([plugin.id, plugin.version, plugin.enabled, plugin.rootDir, source.requested, source.resolved, source.subdirectory ?? null])).digest('hex');
export function loopbackServer(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value.replace(/\/$/, '') !== url.origin) throw new ApplicationError('unsupported_install');
  return url.origin;
}
export function receiptDirectory(dataDir: string, home = homedir()) {
  if (!isAbsolute(dataDir) || dataDir.length > 4096 || /[\0\r\n]/.test(dataDir)) throw new ApplicationError('unsupported_install');
  return join(home, '.local/state/pa-updates/source-modes', createHash('sha256').update(dataDir).digest('hex'));
}
async function readJson(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 65536) throw new ApplicationError('storage'); return JSON.parse(await file.readFile('utf8')); }
  finally { await file.close(); }
}
async function atomic(path: string, value: unknown) {
  const file = await open(path + '.new', constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(path + '.new', path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function writePrivate(path: string, value: string) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
/** Only runtime declarations, not test/build tools. BB supplies its public SDK
 * shim; zod and other direct plugin imports still need real local packages.
 * Resolution reads package metadata only and never evaluates dependency code.
 */
function localDependencies(path: string, manifest: { dependencies?: unknown }): string[] {
  const dependencies = manifest.dependencies ?? {};
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) throw new SourceSwitchError('dependencies_missing');
  const names = Object.keys(dependencies);
  if (names.length > 128 || names.some(name => name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))) throw new SourceSwitchError('dependencies_missing');
  const required = names.filter(name => name !== '@get-bb/plugin-sdk');
  try { const resolver = createRequire(join(path, 'package.json')); for (const name of required) resolver.resolve(name); }
  catch { throw new SourceSwitchError('dependencies_missing'); }
  return required;
}
type Options = {
  /** Controlled overrides for disposable host fixtures, never RPC inputs. */
  sourceUrl?: string; checkout?: () => Promise<string | undefined>; receiptRoot?: string;
  active?(): void;
  /** Disposable test seam for delaying an already-issued atomic filesystem write. */
  atomicWrite?(path: string, value: unknown): Promise<void>;
  /** Private liveness seam: same semantics as process.kill(pid, 0). Only ESRCH
   * proves absence; success, EPERM and unknown results must all block. */
  probeProcess?(pid: number): void;
  manifest(commit: string, id: IntegrationId): Promise<{ version: string; engines?: { node?: string; bb?: string; bbPluginSdk?: string } }>;
  remember(id: IntegrationId, path: string, source: string, stamp: string): Promise<void>;
};
/** Durable filesystem receipts belong to this application, NOT BB's data/cache.
 * The runner owns writes until terminal; acknowledgment only verifies/cleans up.
 * Startup/refresh can observe but never spawn.
 */
export function sourceModePorts(bb: BbPluginApi, options: Options): NonNullable<ApplicationPorts['sourceMode']> {
  const sourceUrl = options.sourceUrl ?? originUrl;
  const root = () => options.receiptRoot ?? receiptDirectory(bb.server.experimental_dataDir);
  const location = (file: string) => join(root(), file);
  const privateDirectory = async () => {
    if (!isAbsolute(root()) || /[\0\r\n]/.test(root())) throw new ApplicationError('storage');
    await mkdir(root(), { recursive: true, mode: 0o700 });
    const stat = await lstat(root());
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root()) !== root()) throw new ApplicationError('storage');
    await chmod(root(), 0o700);
  };
  const writing = new Set<Promise<void>>();
  const ownedWrite = async (operation: () => Promise<void>) => {
    options.active?.();
    const issued = operation(); writing.add(issued);
    try { await issued; options.active?.(); }
    catch { options.active?.(); throw new ApplicationError('storage'); }
    finally { writing.delete(issued); }
  };
  const writeJson = (path: string, value: unknown) => ownedWrite(() => (options.atomicWrite ?? atomic)(path, value));
  const noNativeJobs = async () => {
    const installs = await bb.sdk.plugins.installJobs.list({ signal: AbortSignal.timeout(10000) });
    const updates = await bb.sdk.plugins.experimental_updateJobs.list({ signal: AbortSignal.timeout(10000) });
    if (installs.length > 512 || updates.length > 512 || [...installs, ...updates].some(job => !['succeeded', 'failed', 'cancelled'].includes(job.state))) throw new ApplicationError('busy');
  };
  const requireGone = (pid: unknown) => {
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new ApplicationError('busy');
    try { (options.probeProcess ?? (value => { process.kill(value, 0); }))(pid as number); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return;
      throw new ApplicationError('busy');
    }
    // An existing PID might be the owner OR a reused PID. Neither is proof.
    throw new ApplicationError('busy');
  };
  let logged: string | null = null;
  const observe = async (verify = false): Promise<SourceSwitch | null> => {
    // Older disposable SDK stubs have no server facts. They cannot admit a
    // switch; absence must not break unrelated ordinary-update inspections.
    if (!options.receiptRoot && !bb.server?.experimental_dataDir) return null;
    let receipt: SourceSwitch;
    try { receipt = sourceSwitchSchema.parse(await readJson(location('receipt.json'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ApplicationError('storage'); }
    // Observation may DERIVE attention on positive owned death, never transfer
    // ownership or write the receipt. Missing/ambiguous identity falls back to
    // the bounded timeout; neither outcome proves a native mutation failed.
    if (!['complete', 'attention'].includes(receipt.phase)) {
      let gone = false;
      try {
        const launch = await readJson(location('launch.json'));
        if (launch.jobId !== receipt.jobId) throw new ApplicationError('changed');
        for (const name of ['ready.json', 'permit.json']) {
          const gate = await readJson(location(name));
          if (gate.jobId !== receipt.jobId || gate.pid !== launch.pid) throw new ApplicationError('changed');
        }
        requireGone(launch.pid); gone = true;
      } catch { /* Observation cannot infer ownership from absent/unknown metadata. */ }
      if (gone || Date.now() - Date.parse(receipt.startedAt) > 12 * 60_000) receipt = { ...receipt, phase: 'attention', reason: 'interrupted', manualRecovery: true };
    }
    if (receipt.phase === 'attention' && logged !== `${receipt.jobId}:${receipt.reason}`) {
      logged = `${receipt.jobId}:${receipt.reason}`;
      bb.log.warn(`pa-updates stage=source-switch outcome=${receipt.reason}`);
    }
    if (verify && receipt.phase === 'complete' && receipt.syncReserved) {
      const status = await bb.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: pauseStatusSchema, signal: AbortSignal.timeout(10000) });
      options.active?.();
      if (!receipt.pauseHandoff || status.updatePause.jobId !== receipt.jobId || status.mirrors.some(m => m.enabled || m.phase === 'running')) {
        const attention: SourceSwitch = { ...receipt, phase: 'attention', reason: 'pause_required', manualRecovery: true };
        logged = `${receipt.jobId}:pause_required`;
        bb.log.warn('pa-updates stage=source-observe outcome=pause_required');
        await writeJson(location('receipt.json'), attention);
        return attention;
      }
    }
    let confirmed = false;
    try { confirmed = (await readJson(location('observed.json'))).jobId === receipt.jobId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApplicationError('storage'); }
    if (verify && !confirmed && !receipt.recovery && receipt.phase === 'complete' && receipt.target === 'local') {
      const intent = await readJson(location('intent.json')) as SourceModeIntent;
      if (intent.receipt.jobId !== receipt.jobId || !intent.local) throw new ApplicationError('storage');
      const plugin = (await bb.sdk.plugins.list()).plugins.find(p => p.id === receipt.id);
      const source = await bb.sdk.plugins.getSource({ pluginId: receipt.id });
      const details = await sourceDetails(intent.localPath); options.active?.();
      if (!plugin?.enabled || !['running', 'needs-configuration'].includes(plugin.status) || plugin.status === 'running' && plugin.statusDetail || plugin.app?.hasApp && !plugin.app.bundle?.compatible || source.requested !== `path:${intent.localPath}` || source.subdirectory || plugin.rootDir !== intent.localPath || details.fingerprint !== intent.local.fingerprint || details.stamp !== intent.local.stamp) {
        // The runner already proved the activation. Later edits/admin changes
        // do not erase that history, but must never bless today's loaded bytes.
        bb.log.warn('pa-updates stage=source-observe outcome=changed');
        await writeJson(location('observed.json'), { jobId: receipt.jobId });
        return receipt;
      }
      options.active?.();
      await options.remember(receipt.id, intent.localPath, details.fingerprint, details.stamp);
      await writeJson(location('observed.json'), { jobId: receipt.jobId });
    }
    return receipt;
  };
  return {
    observe,
    async drain() { await Promise.allSettled([...writing]); },
    async settle(receipt) {
      await ownedWrite(privateDirectory);
      logged = `${receipt.jobId}:${receipt.reason}`; // preflight owner already diagnosed this failure
      await writeJson(location('receipt.json'), sourceSwitchSchema.parse(receipt));
    },
    async recover(jobId) {
      // Timeouts never grant authority. Explicit recovery alone may take over
      // a nonterminal receipt, and only after positively proving its owner gone.
      const receipt = sourceSwitchSchema.parse(await readJson(location('receipt.json')));
      const rawTerminal = receipt.phase === 'attention';
      if (receipt.jobId !== jobId || !['ready', 'running', 'attention'].includes(receipt.phase)) throw new ApplicationError('busy');
      const intent = await readJson(location('intent.json')) as SourceModeIntent;
      if (intent.receipt.jobId !== jobId || intent.receipt.id !== receipt.id || intent.receipt.target !== receipt.target || intent.requirePause !== (receipt.id === 'icloud' || receipt.id === 'obsidian') || receipt.syncReserved && !intent.requirePause) throw new ApplicationError('changed');
      const baseUrl = loopbackServer(intent.baseUrl);
      if (baseUrl !== loopbackServer(bb.server.loopbackBaseUrl)) throw new ApplicationError('changed');
      await noNativeJobs(); options.active?.();
      let launch: { jobId: string; pid: number } | null = null;
      try { launch = z.object({ jobId: z.string().uuid(), pid: z.number().int().positive().safe() }).strict().parse(await readJson(location('launch.json'))); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new ApplicationError('busy'); }
      if (!rawTerminal && !launch) throw new ApplicationError('busy');
      if (launch) {
        if (launch.jobId !== jobId) throw new ApplicationError('changed');
        for (const name of ['ready.json', 'permit.json']) {
          try {
            const gate = await readJson(location(name));
            if (gate.jobId !== jobId || gate.pid !== launch.pid) throw new ApplicationError('changed');
          } catch (error) {
            // A proven terminal pre-permission launch failure can lack gates.
            // Missing gates cannot establish ownership of raw running state.
            if (!rawTerminal || (error as NodeJS.ErrnoException)?.code !== 'ENOENT' || receipt.removalAttempted || receipt.installAdmitted) throw new ApplicationError('busy');
          }
        }
        if (!rawTerminal) requireGone(launch.pid);
      }
      // Runner death does NOT settle a DELETE already delivered to BB. Only an
      // operator restart (positive absence of the admitting server) fences it.
      if (receipt.removalAttempted && !receipt.removed) requireGone(intent.serverPid);
      const registration = async () => {
        const plugin = (await bb.sdk.plugins.list({ signal: AbortSignal.timeout(10000) })).plugins.find(p => p.id === receipt.id);
        if (!plugin?.enabled || !['running', 'needs-configuration'].includes(plugin.status) || plugin.status === 'running' && plugin.statusDetail || plugin.app?.hasApp && !plugin.app.bundle?.compatible || plugin.version.length > 64 || !semver.valid(plugin.version)) throw new SourceSwitchError('verification_failed');
        const source = await bb.sdk.plugins.getSource({ pluginId: receipt.id, signal: AbortSignal.timeout(10000) });
        const target = receipt.target === 'local' ? source.requested === `path:${intent.localPath}` && !source.subdirectory && plugin.rootDir === intent.localPath
          : [`git:${intent.sourceUrl}@main`, `git:${intent.sourceUrl}@ref:main`].includes(source.requested) && source.subdirectory === `plugins/${receipt.id}`;
        const original = !receipt.removalAttempted && sourceGeneration(plugin, source) === intent.expected.generation && source.requested === intent.expected.requested && source.resolved === intent.expected.resolved && (source.subdirectory ?? null) === intent.expected.subdirectory;
        if (!target && !original) throw new SourceSwitchError('verification_failed');
        return { actual: plugin.version, generation: sourceGeneration(plugin, source), outcome: target ? 'target_verified' as const : 'aborted_before_removal' as const };
      };
      const before = await registration(); options.active?.();
      if (intent.requirePause) {
        const status = () => bb.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'status', input: null, outputSchema: pauseStatusSchema, signal: AbortSignal.timeout(10000) });
        let current = await status(); options.active?.();
        if (current.mirrors.some(m => m.enabled || m.phase === 'running')) throw new SourceSwitchError('pause_required');
        const mirrorIds = current.mirrors.map(m => m.id).sort();
        // A failed initial reserve has no durable handoff. Its old delivery can
        // outlive the RPC timeout/disposal, so require the admitting BB gone.
        // Acquiring the SAME UUID is then the provider's serial-queue barrier.
        if (current.updatePause.jobId === null && !receipt.pauseHandoff) {
          if (!rawTerminal || receipt.removalAttempted || !receipt.syncReserved || before.outcome !== 'aborted_before_removal') throw new SourceSwitchError('pause_required');
          requireGone(intent.serverPid); options.active?.();
          current = await bb.sdk.plugins.callRpc({ pluginId: 'icloud', method: 'pause', input: { updateJob: jobId }, outputSchema: pauseStatusSchema, signal: AbortSignal.timeout(15000) });
          options.active?.();
          if (current.updatePause.jobId !== jobId || current.mirrors.some(m => m.enabled || m.phase === 'running') || JSON.stringify(current.mirrors.map(m => m.id).sort()) !== JSON.stringify(mirrorIds)) throw new SourceSwitchError('pause_incomplete');
        }
        // Normal durable handoff/released cleanup never re-reserves. Every
        // current mirror is user-paused again to clear all owned resume rights.
        const released = receipt.pauseHandoff && receipt.syncReserved && current.updatePause.jobId === null;
        const heldJob = current.updatePause.jobId;
        if (heldJob !== jobId && !released) throw new SourceSwitchError('pause_required');
        for (const id of mirrorIds) {
          options.active?.();
          const response = await fetch(`${baseUrl}/api/v1/plugins/icloud/rpc/pause`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new SourceSwitchError('pause_incomplete'); }
          const reader = response.body?.getReader(); if (!reader) throw new SourceSwitchError('pause_incomplete');
          const chunks: Uint8Array[] = []; let size = 0;
          try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 1024 * 1024) throw new SourceSwitchError('pause_incomplete'); chunks.push(next.value); } }
          finally { await reader.cancel(); }
          const result = z.object({ ok: z.literal(true), result: pauseStatusSchema }).parse(JSON.parse(Buffer.concat(chunks).toString())).result;
          options.active?.();
          if (result.updatePause.jobId !== heldJob || result.mirrors.some(m => m.enabled || m.phase === 'running') || JSON.stringify(result.mirrors.map(m => m.id).sort()) !== JSON.stringify(mirrorIds)) throw new SourceSwitchError('pause_incomplete');
        }
        const after = await status(); options.active?.();
        if (after.updatePause.jobId !== heldJob || after.mirrors.some(m => m.enabled || m.phase === 'running') || JSON.stringify(after.mirrors.map(m => m.id).sort()) !== JSON.stringify(mirrorIds)) throw new SourceSwitchError('pause_incomplete');
        receipt.pauseHandoff = true; receipt.syncReserved = true;
      }
      await noNativeJobs(); const after = await registration(); options.active?.();
      if (after.generation !== before.generation || after.outcome !== before.outcome) throw new ApplicationError('changed');
      if (!rawTerminal) { receipt.phase = 'attention'; receipt.reason = 'interrupted'; }
      receipt.recovery = after.outcome; receipt.actual = after.actual;
      receipt.manualRecovery = true; receipt.updatedAt = new Date().toISOString();
      // No applied-source learning from a manual reinstall/current files. Only
      // the original successful-runner + unchanged-generation path can do that.
      await writeJson(location('observed.json'), { jobId });
      await writeJson(location('receipt.json'), receipt);
      return receipt;
    },
    async prepare(receipt, review) {
      const existing = await observe();
      options.active?.();
      if (existing && (existing.jobId === receipt.jobId || existing.manualRecovery || existing.syncReserved || !['complete', 'attention'].includes(existing.phase))) throw new ApplicationError('busy');
      const row = review.inventory?.find(row => row.id === receipt.id);
      if (!row?.sourceGeneration || !['managed', 'local'].includes(row.sourceMode ?? '') || (row.sourceMode === 'local') === (receipt.target === 'local')) throw new ApplicationError('changed');
      const baseUrl = loopbackServer(bb.server.loopbackBaseUrl);
      const listed = await bb.sdk.plugins.list({ signal: AbortSignal.timeout(10000) });
      const plugin = listed.plugins.find(p => p.id === receipt.id);
      if (!plugin) throw new ApplicationError('changed');
      if (!plugin.enabled) throw new SourceSwitchError('disabled');
      if (!['running', 'needs-configuration'].includes(plugin.status)) throw new ApplicationError('busy');
      const source = await bb.sdk.plugins.getSource({ pluginId: receipt.id, signal: AbortSignal.timeout(10000) });
      const checkout = options.checkout ? await options.checkout() : canonicalCheckout();
      if (!checkout || !isAbsolute(checkout) || /[\0\r\n]/.test(checkout)) throw new ApplicationError('unsupported_install');
      const localPath = await realpath(join(checkout, 'plugins', receipt.id));
      const managed = [`git:${sourceUrl}@main`, `git:${sourceUrl}@ref:main`].includes(source.requested) && source.subdirectory === `plugins/${receipt.id}`;
      const local = source.requested === `path:${localPath}` && plugin.rootDir === localPath && !source.subdirectory;
      if (sourceGeneration(plugin, source) !== row.sourceGeneration || row.sourceMode === 'managed' && !managed || row.sourceMode === 'local' && !local) throw new ApplicationError('changed');
      await noNativeJobs();
      let manifest;
      let dependencies: string[] = [];
      if (receipt.target === 'local') {
        manifest = await readJson(join(localPath, 'package.json'));
        const serverFile = await lstat(join(localPath, 'server.ts'));
        if (manifest.name !== `bb-plugin-${receipt.id}` || manifest.bb?.server !== './server.ts' || !serverFile.isFile() || serverFile.isSymbolicLink()) throw new ApplicationError('incompatible');
        dependencies = localDependencies(localPath, manifest);
      } else manifest = review.workspace ? await options.manifest(review.workspace.originHead, receipt.id) : null;
      if (!manifest || typeof manifest.version !== 'string' || manifest.version.length > 64 || !semver.valid(manifest.version)) throw new ApplicationError('incompatible');
      for (const engine of ['bb', 'bbPluginSdk', 'node']) {
        const value = manifest.engines?.[engine];
        if (value !== undefined && (typeof value !== 'string' || value.length > 256 || !semver.validRange(value))) throw new ApplicationError('incompatible');
      }
      if (manifest.engines?.node && !semver.satisfies(process.versions.node, manifest.engines.node)) throw new ApplicationError('incompatible');
      const host = await bb.sdk.system.version({ signal: AbortSignal.timeout(10000) });
      if (!manifest.engines?.bb || !manifest.engines?.bbPluginSdk || !semver.satisfies(host.currentVersion, manifest.engines.bb) || !semver.satisfies('0.6.37', manifest.engines.bbPluginSdk)) throw new ApplicationError('incompatible');
      const requirePause = receipt.id === 'icloud' || receipt.id === 'obsidian';
      if (requirePause) {
        const cloud = listed.plugins.find(p => p.id === 'icloud');
        if (!cloud?.enabled || !semver.satisfies(cloud.version, '>=0.3.0 <0.4.0')) throw new ApplicationError('maintenance_unavailable');
        // Retain the existing paired-interface restriction; a destructive switch
        // is not authorization to run an unreviewed paired migration.
        for (const id of ['icloud', 'obsidian']) {
          const pair = listed.plugins.find(p => p.id === id);
          if (pair && !semver.satisfies(pair.version, '>=0.3.0 <0.4.0')) throw new ApplicationError('paired_migration');
        }
        if (!semver.satisfies(manifest.version, '>=0.3.0 <0.4.0')) throw new ApplicationError('incompatible');
      }
      const details = receipt.target === 'local' ? await sourceDetails(localPath) : null;
      const intent: SourceModeIntent = { receipt, baseUrl, sourceUrl, localPath, serverPid: process.pid,
        expected: { generation: row.sourceGeneration, requested: source.requested, resolved: source.resolved, subdirectory: source.subdirectory ?? null },
        local: details ? { ...details, version: manifest.version } : null, dependencies, requirePause };
      options.active?.();
      await ownedWrite(privateDirectory); options.active?.();
      // Fixed bounded files; identity and gates contain no account content.
      for (const name of ['ready.json', 'permit.json', 'launch.json', 'launch-lock.json', 'observed.json', 'intent.json', 'runner.mjs']) await ownedWrite(() => rm(location(name), { force: true }));
      await ownedWrite(() => writePrivate(location('intent.json'), JSON.stringify(intent)));
      await ownedWrite(() => writePrivate(location('runner.mjs'), sourceModeRunnerScript));
      await writeJson(location('receipt.json'), receipt);
    },
    async launch(receipt) {
      // Re-read durable intent instead of accepting executable paths/URLs.
      const intent = await readJson(location('intent.json')) as SourceModeIntent;
      if (intent.receipt.jobId !== receipt.jobId || intent.receipt.id !== receipt.id || intent.receipt.target !== receipt.target) throw new ApplicationError('changed');
      let ownedLaunch = false, permitMayExist = false, failed = false, exited = false, closed = false;
      let child: ChildProcess | null = null, stopped: Promise<void> | null = null;
      try {
        // Exclusive ownership prevents a second caller from terminating or
        // overwriting a previously admitted runner, including on launch errors.
        await ownedWrite(() => writePrivate(location('launch-lock.json'), JSON.stringify({ jobId: receipt.jobId })));
        ownedLaunch = true;
        if (loopbackServer(bb.server.loopbackBaseUrl) !== intent.baseUrl) throw new ApplicationError('changed');
        await writeJson(location('receipt.json'), receipt); options.active?.();
        child = spawn(process.execPath, [location('runner.mjs')], { cwd: root(), detached: true, stdio: 'ignore', env: { LANG: 'C', HOME: homedir() } });
        child.on('error', () => { failed = true; });
        child.once('exit', () => { exited = true; });
        stopped = new Promise(resolve => { child!.once('close', () => { closed = true; resolve(); }); });
        child.unref();
        const pid = child.pid;
        if (!Number.isSafeInteger(pid) || !pid || pid <= 0) throw new ApplicationError('unavailable');
        // Immutable positive child identity is durable BEFORE readiness/permit.
        await ownedWrite(() => writePrivate(location('launch.json'), JSON.stringify({ jobId: receipt.jobId, pid })));
        for (let attempt = 0; attempt < 100; attempt++) {
          options.active?.();
          if (failed || exited || closed) throw new ApplicationError('unavailable');
          try {
            const ready = await readJson(location('ready.json'));
            const launch = await readJson(location('launch.json'));
            if (ready.jobId !== receipt.jobId || ready.pid !== pid || launch.jobId !== receipt.jobId || launch.pid !== pid) throw new ApplicationError('changed');
            if (ready.jobId === receipt.jobId) {
              options.active?.();
              if (failed || exited || closed) throw new ApplicationError('unavailable');
              // A gate write may succeed even if its acknowledgment is lost.
              // From this point on we NEVER kill or join this runner.
              permitMayExist = true;
              await ownedWrite(() => writePrivate(location('permit.json'), JSON.stringify({ jobId: receipt.jobId, pid }))); return;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new ApplicationError('unavailable');
      } catch (error) {
        if (ownedLaunch && !permitMayExist) {
          // Only this owned, NEVER-permitted child may be terminated/drained.
          // This belongs to launch, not disposal's local-filesystem-write drain.
          if (child && !closed) { try { child.kill('SIGKILL'); } catch { /* no raw process diagnostics */ } }
          const drained = !stopped || await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(false), 2000);
            void stopped!.then(() => { clearTimeout(timer); resolve(true); });
          });
          if (drained) {
            // The child cannot write another receipt and never had authority to
            // remove anything. The usual active fence prevents obsolete writes.
            await writeJson(location('receipt.json'), { ...receipt, phase: 'attention',
              reason: error instanceof ApplicationError && error.category === 'changed' ? 'changed' : 'unavailable',
              manualRecovery: receipt.syncReserved, removalAttempted: false, removed: false, installAdmitted: false,
              configuration: 'reset_expected', actual: null, updatedAt: new Date().toISOString() });
          }
        }
        throw error;
      }
    },
  };
}
