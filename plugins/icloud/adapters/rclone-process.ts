import { rcConnectionFailure } from './rclone-connection-failure.ts';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, lstat, writeFile, unlink, symlink, rmdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { CloudError, category, evidence } from '../core/ports.ts';
import type { TransferProgress } from '../core/ports.ts';
import { projectRcloneRecord } from '../core/rclone-trace.ts';
import { obsidianStageExclude } from './mirror-wakeups.ts';
import { RcloneStatsStream } from './rclone-stats.ts';
import { RcloneBisyncObservation } from './rclone-bisync-observation.ts';
import { RcloneTrace } from './rclone-trace.ts';

// Ordinary bisync can legitimately list/compare without transfer counters.
// Bound explicit interruption, not the total duration of that native work.
export const COMMAND_TIMEOUTS = { listing: 5 * 60_000, transfer: 15 * 60_000, initialBisync: 20 * 60_000, bisync: null } as const;
export const FLOCK_BINARY = '/usr/bin/flock';
const LISTING_BENCHMARK_TIMEOUT_MS = 8 * 60_000;
const LISTING_CONFIG_FD = 4; // fd 3 is the inherited worker lock
export const listingCheckers = ['2', '4', '8'] as const;
export type ListingCheckers = typeof listingCheckers[number];
type ListingObservation = { configFd: number; signal?: AbortSignal; record: (record: unknown) => void };
type BisyncCheckers = '2' | '4';
type OwnedNoteInput = { configFd: number; phaseFd: number; frame: string };
type CommandObservation = { listing?: ListingObservation; bisyncCheckers?: BisyncCheckers; managedBisync?: true; ownedNote?: OwnedNoteInput };
export type ManagedNativeMirror = { binary: string; remote: `icloud:${string}`; workdir: string; binding: string };
export const nativeMutationLock = 'bb-managed-mutation.lock';
const sameManaged = (left: ManagedNativeMirror, right: ManagedNativeMirror) =>
  left.remote === right.remote && left.workdir === right.workdir && left.binding === right.binding && left.binary === right.binary;

type NativeMirrorRun = Pick<ManagedNativeMirror, 'remote' | 'workdir'> & { managed?: ManagedNativeMirror };
function disjointNativeMirrors(a: Pick<ManagedNativeMirror,'remote'|'workdir'>, b: Pick<ManagedNativeMirror,'remote'|'workdir'>) {
  if (a.workdir === b.workdir) return false;
  const remote = (value: string) => value.slice('icloud:'.length).normalize('NFC').toLowerCase();
  const left = remote(a.remote), right = remote(b.remote);
  return Boolean(left && right && left !== right && !left.startsWith(right+'/') && !right.startsWith(left+'/'));
}

export function safeEnvironment(): NodeJS.ProcessEnv {
  // Never inherit provider options, credentials, proxies or BB process secrets.
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C.UTF-8', GOMEMLIMIT: '256MiB' };
}
export type CommandRunner = (args: string[], capture?: boolean, report?: (stats: TransferProgress) => void) => Promise<string>;
export type RcCall = (method: string, body: Record<string, unknown>) => Promise<any>;
export class RcloneProcess {
  private binary: string | null = null;
  private child: ChildProcess | null = null;
  private children = new Set<ChildProcess>();
  private listingChild: ChildProcess | null = null;
  private nativeScan: NativeMirrorRun | null = null;
  private fastActive: ManagedNativeMirror | null = null;
  private fileWork: { controller: AbortController; task: Promise<unknown> } | null = null;
  private started: Promise<void> | null = null;
  private stopping = false;
  private stopped: Promise<void> | null = null;
  private released: Promise<void> | null = null;
  private interruptions = new Map<ChildProcess, NodeJS.Timeout>();
  private lock: Awaited<ReturnType<typeof open>> | null = null;
  private ownsLock = false;
  private socket: string;
  private config: string;
  private helper: string;
  private key: string;
  readonly trace: RcloneTrace;
  // Constructor-only generated-fixture control. Never supplied by server/RPC/env.
  constructor(readonly root: string, private explicitBinary?: string, private testBandwidth?: string, traceWarning?: () => void, private stopGraceMs = 95_000) {
    if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 1 || stopGraceMs > 95_000) throw new CloudError('configuration');
    this.trace = new RcloneTrace(join(root, 'rclone-logs'), traceWarning);
    if (testBandwidth && !/^[1-9][0-9]{0,6}[kM]$/.test(testBandwidth)) throw new CloudError('configuration');
    this.socket = join(root, 'control.sock'); this.config = join(root, 'state', 'rclone.conf');
    this.helper = join(root, 'secrets', 'read-key.cjs'); this.key = join(root, 'secrets', 'config.key');
  }
  async checkAvailability() {
    if (process.platform !== 'linux') throw new CloudError('unavailable');
    try {
      await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8');
      const version = await this.execute(FLOCK_BINARY, ['--version'], true, 10_000);
      if (!/^flock from util-linux /m.test(version)) throw new Error();
    } catch { throw new CloudError('unavailable'); }
    for (const candidate of this.explicitBinary ? [this.explicitBinary] : ['rclone', '/usr/local/bin/rclone', '/usr/bin/rclone']) {
      try {
        const version = await this.execute(candidate, ['version', '--config', '/dev/null'], true, 10_000);
        if (!/^rclone v1\.(?:75\.2|76\.0)\r?\n/.test(version)) continue;
        this.binary = candidate; return;
      } catch { /* Try only fixed candidate paths, never emit raw spawn errors. */ }
    }
    throw new CloudError('unavailable');
  }
  private async secureDirectory(path: string) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new CloudError('unavailable');
    await chmod(path, 0o700);
  }
  private flags(checkers: ListingCheckers = '2', config = this.config) {
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return ['--config', config, '--password-command', [process.execPath, this.helper, this.key].map(quote).join(' '),
      '--ask-password=false', '--cache-dir', join(this.root, 'cache'), '--log-level', 'ERROR',
      '--transfers', '2', '--checkers', checkers, '--buffer-size', '4M', '--bwlimit', '8M', '--timeout', '30s', '--contimeout', '15s', ...(this.testBandwidth ? ['--bwlimit', this.testBandwidth] : [])];
  }
  async ensure() {
    if (this.stopping) throw new CloudError('interrupted');
    if (this.started) { await this.started; if (this.stopping) throw new CloudError('interrupted'); return; }
    const attempt = this.start(); this.started = attempt;
    try { await attempt; if (this.stopping) throw new CloudError('interrupted'); }
    catch (error) { if (this.started === attempt) this.started = null; throw error; }
  }
  private async hasLiveParentDaemon() {
    try {
      const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
      for (const pid of children) {
        try {
          const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
          if (args.includes('rcd') && args.some((arg, index) => arg === '--rc-addr' && args[index + 1] === `unix://${this.socket}`)) return true;
        } catch { /* A child may exit between the bounded proc reads. */ }
      }
    } catch { throw new CloudError('unavailable'); }
    return false;
  }
  private async start() {
    if (!isAbsolute(this.root) || Buffer.byteLength(this.socket) > 100) throw new CloudError('unavailable');
    await this.checkAvailability();
    await this.secureDirectory(this.root);
    for (const dir of ['state', 'secrets', 'cache', 'mirrors', 'baselines']) await this.secureDirectory(join(this.root, dir));
    // BB loads the replacement generation before disposing its predecessor.
    // A same-parent daemon is therefore live ownership, not an orphan to kill.
    if (await this.hasLiveParentDaemon()) throw new CloudError('busy');
    const lockPath = join(this.root, 'worker.lock');
    try {
      this.lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const info = await this.lock.stat();
      if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error();
      // flock operates on the inherited open file description. The lock then
      // remains held by every command child that inherits this descriptor,
      // even if the Node parent crashes, and vanishes when the last holder exits.
      const acquired = spawnSync(FLOCK_BINARY, ['--exclusive', '--nonblock', '3'], { env: safeEnvironment(), stdio: ['ignore', 'ignore', 'ignore', this.lock.fd] });
      if (acquired.status !== 0) throw new CloudError('busy');
      this.ownsLock = true;
    } catch (error) {
      await this.lock?.close().catch(() => {}); this.lock = null;
      throw error instanceof CloudError ? error : new CloudError('unavailable');
    }
    // Close the race between observing the predecessor and acquiring an
    // unlocked legacy marker. Do not mutate either pathname while it is live.
    if (await this.hasLiveParentDaemon()) {
      await this.lock.close().catch(() => {}); this.lock = null; this.ownsLock = false;
      throw new CloudError('busy');
    }
    try {
      // Start capture only after proving native ownership. Never trace account
      // setup, control-socket bodies, credential helpers or generic commands.
      await this.trace.start();
      let hasConfig = false;
      try { const data = await readFile(this.config, 'utf8'); hasConfig = true; if (!/^RCLONE_ENCRYPT_V0:$/m.test(data)) throw new CloudError('recovery_required'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasConfig) {
        const keyInfo = await lstat(this.key);
        if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) throw new CloudError('recovery_required');
      } else {
        try { const handle = await open(this.key, 'wx', 0o600); await handle.writeFile(randomBytes(48).toString('base64')); await handle.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      await chmod(this.key, 0o600);
      // Helper emits only to the child's private password pipe, never the BB logger.
      await writeFile(this.helper, "const fs = require('node:fs'); process.stdout.write(fs.readFileSync(process.argv[2], 'utf8'));\n", { mode: 0o600 });
      if (!hasConfig) {
        await writeFile(this.config, '', { mode: 0o600, flag: 'wx' });
        await this.execute(this.binary!, ['config', 'encryption', 'set', ...this.flags()], false, 30_000, undefined, 'generic');
      }
      await chmod(this.config, 0o600);
      // An orphaned control daemon cannot own sync work, and the flock proves
      // no old transfer child is still active. Retire it before rebinding.
      await this.rawCall('core/quit', {}).catch(() => {});
      await unlink(this.socket).catch(() => {});
      if (this.stopping) throw new CloudError('interrupted');
      const child = spawn(this.binary!, ['rcd', '--rc-addr', `unix://${this.socket}`, '--rc-no-auth', ...this.flags()], { env: safeEnvironment(), stdio: 'ignore' });
      this.child = child;
      child.on('error', () => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        if (this.stopping) throw new CloudError('interrupted');
        if (child.exitCode !== null || child.signalCode !== null) throw new CloudError('unavailable');
        try { await this.rawCall('rc/noop', {}); await chmod(this.socket, 0o600); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      throw new CloudError('unavailable');
    } catch (error) { this.requestStop(); await this.release(); throw error instanceof CloudError ? error : new CloudError('unavailable'); }
  }
  private rawCall(method: string, body: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new CloudError('unavailable'));
      const req = request({ socketPath: this.socket, path: `/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) { req.destroy(); fail(); } else data += chunk; });
        res.on('error', fail);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new CloudError(rcConnectionFailure(method, body, res.statusCode, data)));
          }
          try { resolve(JSON.parse(data)); } catch { fail(); }
        });
      });
      req.setTimeout(120_000, () => { req.destroy(); fail(); }); req.on('error', fail);
      req.end(JSON.stringify(body));
    });
  }
  async call(method: string, body: Record<string, unknown>) { await this.ensure(); if (this.stopping) throw new CloudError('interrupted'); if (this.fileWork || this.fastActive) throw new CloudError('busy'); return this.rawCall(method, body); }
  // Same native generation and inherited flock as run(), not a second mutex
  // claiming to exclude rclone. No native command may start during this work.
  async withFiles<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.ensure();
    if (this.stopping || this.fileWork || this.fastActive || this.children.size) throw new CloudError('busy');
    if (!this.ownsLock || !this.lock) throw new CloudError('unavailable');
    const controller = new AbortController();
    const task = Promise.resolve().then(() => operation(controller.signal));
    this.fileWork = { controller, task };
    try { return await task; } finally { this.fileWork = null; }
  }
  async run(args: string[], capture = false, report?: (stats: TransferProgress) => void, checkers: BisyncCheckers = '2', managed?: ManagedNativeMirror) {
    await this.ensure();
    if (this.fileWork || this.stopping || this.nativeScan) throw new CloudError('busy');
    const command = args[0];
    const remote = args[1];
    const workdir = args[args.indexOf('--workdir') + 1];
    const ordinary = command === 'bisync' && remote?.startsWith('icloud:') && workdir?.startsWith(join(this.root,'baselines')+'/')
      ? {remote:remote as `icloud:${string}`,workdir,managed} : null;
    if (this.fastActive && (!ordinary || !((managed && sameManaged(this.fastActive,managed)) ||
      disjointNativeMirrors(this.fastActive,ordinary)))) throw new CloudError('busy');
    if (managed && (command !== 'bisync' || args[1] !== managed.remote || args[args.indexOf('--workdir') + 1] !== managed.workdir ||
        args.includes('--resync') || !isAbsolute(managed.binary))) throw new CloudError('invalid_selection');
    const stats = report ? ['--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE', '--log-level', command === 'bisync' ? 'DEBUG' : 'NOTICE'] : command === 'bisync' ? ['--use-json-log', '--log-level', 'DEBUG'] : [];
    const timeout = command === 'bisync' ? args.includes('--resync') ? COMMAND_TIMEOUTS.initialBisync : COMMAND_TIMEOUTS.bisync : command === 'lsjson' ? COMMAND_TIMEOUTS.listing : COMMAND_TIMEOUTS.transfer;
    const bisync = command === 'bisync';
    const effectiveCheckers = bisync && !args.includes('--resync') ? checkers : '2';
    if (ordinary) this.nativeScan = ordinary;
    try {
      const binding = managed ? ['--bb-managed-binding', managed.binding] : [];
      return await this.execute(managed?.binary ?? this.binary!, [...args, ...binding, ...this.flags(effectiveCheckers), ...stats],
        capture, timeout, report, bisync ? 'bisync' : 'generic', bisync ? { bisyncCheckers: effectiveCheckers, ...(managed ? { managedBisync: true } : {}) } : undefined);
    } finally {
      if (ordinary) this.nativeScan = null;
    }
  }
  async noteDeliveryCommand(target: ManagedNativeMirror, operation: 'inspect' | 'replace' | 'recover' | 'create' | 'recover-create', payload: Record<string, unknown>) {
    await this.ensure();
    const scan = this.nativeScan;
    const compatibleScan = scan && ((scan.managed && sameManaged(scan.managed,target)) || disjointNativeMirrors(scan,target));
    if (this.stopping || this.fastActive || this.fileWork || (this.children.size && !compatibleScan) ||
        !this.ownsLock || !this.lock) throw new CloudError('busy');
    if (!isAbsolute(target.binary) || !isAbsolute(target.workdir)) throw new CloudError('invalid_selection');
    this.fastActive = target;
    let config: Awaited<ReturnType<typeof open>> | undefined;
    let phase: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: string | undefined;
    let link: string | undefined;
    try {
      config = await open(this.config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const configInfo = await config.stat();
      if (!configInfo.isFile() || configInfo.uid !== process.getuid?.() || configInfo.nlink !== 1 || (configInfo.mode & 0o077) !== 0)
        throw new CloudError('unavailable');
      phase = await open(join(target.workdir, nativeMutationLock), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const phaseInfo = await phase.stat();
      if (!phaseInfo.isFile() || phaseInfo.uid !== process.getuid?.() || phaseInfo.nlink !== 1 || (phaseInfo.mode & 0o077) !== 0)
        throw new CloudError('unavailable');
      temporary = await mkdtemp(join(this.root, 'state', 'delivery-'));
      link = join(temporary, 'config');
      await symlink(`/proc/self/fd/${LISTING_CONFIG_FD}`, link);
      const frame = JSON.stringify({ ...payload, binding: target.binding, workdir: target.workdir });
      if (Buffer.byteLength(frame) > (8 << 20)) throw new CloudError('capacity');
      const output = await this.execute(target.binary, ['bb-owned-note', operation, target.remote, ...this.flags('2', link),
        '--retries', '1', '--low-level-retries', '1'], true, 15_000, undefined, 'generic',
        { ownedNote: { configFd: config.fd, phaseFd: phase.fd, frame } });
      try { return JSON.parse(output) as unknown; } catch { throw new CloudError('sync_failed'); }
    } finally {
      await phase?.close().catch(() => {});
      await config?.close().catch(() => {});
      if (link) await unlink(link).catch(() => {});
      if (temporary) await rmdir(temporary).catch(() => {});
      this.fastActive = null;
    }
  }
  async benchmarkListing(remote: `icloud:${string}`, checkers: ListingCheckers, signal?: AbortSignal) {
    await this.ensure();
    if (this.fileWork || this.fastActive || this.children.size || !this.ownsLock || !this.lock) throw new CloudError('busy');
    if (!listingCheckers.includes(checkers)) throw new CloudError('invalid_selection');
    const started = performance.now();
    let retryRecords = 0, rateLimitRecords = 0, invalidLogRecords = 0;
    const summary = () => ({ checkers: Number(checkers), elapsedMs: Math.round(performance.now() - started), retryRecords, rateLimitRecords, invalidLogRecords });
    let config: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: string | undefined;
    let link: string | undefined;
    try {
      try {
        config = await open(this.config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await config.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error();
        temporary = await mkdtemp(join(this.root, 'state', 'listing-'));
        link = join(temporary, 'config');
        // Stock rclone resolves one link before choosing where to save its
        // config. In procfs it cannot create a temp file for a cookie update.
        // Reads use the original encrypted bytes via the inherited descriptor.
        await symlink(`/proc/self/fd/${LISTING_CONFIG_FD}`, link);
      } catch { throw new CloudError('unavailable'); }
      // For both supported versions, Count -> ListFn -> listRwalk -> Walk
      // uses Checkers directory workers. The active filter also makes stock
      // size refuse a source that now resolves to a file.
      const output = await this.execute(this.binary!, ['size', remote, '--json', '--disable', 'ListR',
        '--exclude', obsidianStageExclude, ...this.flags(checkers, link), '--use-json-log', '--log-level', 'DEBUG'],
      true, LISTING_BENCHMARK_TIMEOUT_MS, undefined, 'generic', { listing: { configFd: config.fd, signal, record: record => {
        const projected = projectRcloneRecord(record);
        if (projected.event === 'retry') retryRecords++;
        if (projected.category === 'rate_limited' || projected.httpStatus === 429) rateLimitRecords++;
        if (projected.event === 'invalid_record') invalidLogRecords++;
      } } });
      let count: unknown;
      try { count = JSON.parse(output)?.count; } catch { throw new CloudError('sync_failed'); }
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new CloudError('sync_failed');
      return { outcome: 'succeeded' as const, ...summary(), objects: count };
    } catch (error) {
      return { outcome: 'failed' as const, ...summary(), failure: category(error), evidence: evidence(error) };
    } finally {
      await config?.close();
      if (link) await unlink(link).catch(() => {});
      if (temporary) await rmdir(temporary).catch(() => {});
    }
  }
  private execute(binary: string, args: string[], capture: boolean, timeout: number | null, report?: (stats: TransferProgress) => void, context: 'bisync' | 'generic' = 'generic', { listing, bisyncCheckers, managedBisync, ownedNote }: CommandObservation = {}): Promise<string> {
    if (this.stopping || listing?.signal?.aborted) return Promise.reject(new CloudError('interrupted', { kind: 'command_stopped' }));
    return new Promise((resolve, reject) => {
      const observer = context === 'bisync' ? new RcloneBisyncObservation() : null;
      const commandId = randomUUID(), started = performance.now();
      const elapsed = () => Math.max(0, Math.round(performance.now() - started));
      const trace = (entry: Parameters<RcloneTrace['append']>[0]) => { if (observer) this.trace.append(entry); };
      trace({ at: new Date().toISOString(), commandId, elapsedMs: 0, event: 'command_start',
        ...(timeout === null ? {} : { timeoutMs: timeout }), ...(bisyncCheckers ? { checkers: bisyncCheckers === '4' ? 4 : 2 } : {}) });
      const stdio: any[] = [ownedNote ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore', report || observer || listing ? 'pipe' : 'ignore'];
      if (this.lock) stdio.push(this.lock.fd);
      if (listing) stdio.push(listing.configFd);
      if (ownedNote) stdio.push(ownedNote.configFd, ownedNote.phaseFd);
      const child = spawn(binary, args, { env: safeEnvironment(), stdio });
      if (ownedNote && child.stdin) {
        child.stdin.on('error', () => {}); // The bounded child outcome is authoritative.
        child.stdin.end(ownedNote.frame);
      }
      if (listing) this.listingChild = child;
      const abort = () => this.interrupt(child);
      listing?.signal?.addEventListener('abort', abort, { once: true });
      const stats = report || observer || listing ? new RcloneStatsStream(report, record => {
        observer?.observe(record);
        if (observer) this.trace.record(commandId, elapsed(), record);
        listing?.record(record);
      }) : null;
      this.children.add(child); let output = ''; let outputBytes = 0; let logBytes = 0; let overflow = false; let timedOut = false;
      const beyondLimit = () => { overflow = true; child.kill('SIGKILL'); };
      child.stderr?.on('data', chunk => {
        logBytes += chunk.length;
        if (listing && logBytes > 4 * 1024 * 1024) beyondLimit();
        else stats?.write(chunk);
      });
      child.stdout?.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > (ownedNote ? 4096 : listing ? 1024 : 4 * 1024 * 1024)) beyondLimit();
        else output += chunk;
      });
      const timer = timeout === null ? null : setTimeout(() => {
        timedOut = true;
        trace({ at: new Date().toISOString(), commandId, elapsedMs: elapsed(), event: 'command_timeout', timeoutMs: timeout });
        if (ownedNote) child.kill('SIGKILL');
        else this.interrupt(child);
      }, timeout);
      timer?.unref();
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        listing?.signal?.removeEventListener('abort', abort);
        if (this.listingChild === child) this.listingChild = null;
        clearTimeout(this.interruptions.get(child)); this.interruptions.delete(child);
        this.children.delete(child);
      };
      let settled = false;
      child.on('error', () => {
        settled = true; cleanup();
        trace({ at: new Date().toISOString(), commandId, elapsedMs: elapsed(), event: 'command_end', outcome: 'failed', evidence: 'command_start' });
        void this.trace.flush().then(() => reject(new CloudError('unavailable', { kind: 'command_start' })));
      });
      child.on('close', (code, signal) => {
        stats?.end(); cleanup();
        if (settled) return;
        settled = true;
        const stopped = this.stopping || listing?.signal?.aborted;
        if (code === 0 && !overflow && !timedOut && !stopped) {
          trace({ at: new Date().toISOString(), commandId, elapsedMs: elapsed(), event: 'command_end', outcome: 'succeeded', exitCode: 0 });
          void this.trace.flush().then(() => resolve(output));
        }
        else {
          const native = context === 'bisync' && code === 7 && !this.stopping && !overflow && !timedOut && !signal ? observer?.decision() : undefined;
          const proof = stopped ? { kind: 'command_stopped' as const } : overflow ? { kind: 'command_output_limit' as const } : timedOut ? { kind: 'command_timeout' as const } : signal ? { kind: 'command_signal' as const } : { kind: 'command_exit' as const, exitCode: code, ...(native ? { native, ...(observer?.reason() ? { reason: observer.reason() } : {}) } : {}) };
          let failure: 'busy' | 'interrupted' | 'recovery_required' | 'configuration' | 'capacity' | 'sync_failed';
          if (overflow && listing && !stopped) failure = 'capacity';
          else if (stopped || timedOut || signal) failure = 'interrupted';
          else if (managedBisync && code === 42) failure = 'busy';
          else if (managedBisync && code === 43) failure = 'sync_failed';
          else if (context === 'bisync' && code === 7) failure = native === 'retryable_abort' ? 'sync_failed' : 'recovery_required';
          else if (context === 'bisync' && code === 2) failure = 'recovery_required';
          else if (context === 'generic' && code === 2) failure = 'configuration';
          else if (context === 'generic' && code === 8) failure = 'capacity';
          else if (context === 'generic' && code === 7) failure = 'recovery_required';
          else failure = 'sync_failed';
          trace({ at: new Date().toISOString(), commandId, elapsedMs: elapsed(), event: 'command_end', outcome: 'failed', evidence: proof.kind, exitCode: code !== null && code >= 0 && code <= 10 ? code : null });
          void this.trace.flush().then(() => reject(new CloudError(failure, proof)));
        }
      });
    });
  }
  private interrupt(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null || this.interruptions.has(child)) return;
    if (this.listingChild === child) { child.kill('SIGKILL'); return; }
    // Do not send repeated SIGINTs: native bisync uses its grace period to
    // finish critical cleanup. Escalate once if that bounded grace expires.
    const timer = setTimeout(() => child.kill('SIGKILL'), this.stopGraceMs); timer.unref();
    this.interruptions.set(child, timer); child.kill('SIGINT');
  }
  requestStop() {
    this.stopping = true;
    this.fileWork?.controller.abort();
    for (const child of this.children) this.interrupt(child);
    // Keep the RC daemon and inherited flock alive for entered callbacks and
    // the runtime's post-run reconciliation. stop() releases them after drain.
  }
  stop(): Promise<void> {
    this.requestStop();
    return this.stopped ??= (async () => {
      await this.started?.catch(() => {});
      await this.release();
    })();
  }
  private release(): Promise<void> {
    return this.released ??= (async () => {
      await this.fileWork?.task.catch(() => {});
      const children = [...this.children, ...(this.child ? [this.child] : [])];
      await Promise.all(children.map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('close', () => {
          clearTimeout(this.interruptions.get(child)); this.interruptions.delete(child); resolve();
        });
        this.interrupt(child);
      })));
      await this.trace.stop();
      if (this.ownsLock) await unlink(this.socket).catch(() => {});
      await this.lock?.close().catch(() => {}); this.lock = null;
      this.ownsLock = false;
    })();
  }
}
