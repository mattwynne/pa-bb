import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, lstat, writeFile, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CloudError } from '../core/ports.ts';
import type { TransferProgress } from '../core/ports.ts';
import { RcloneStatsStream } from './rclone-stats.ts';

export const COMMAND_TIMEOUTS = { listing: 5 * 60_000, transfer: 15 * 60_000, bisync: 20 * 60_000 } as const;
export const FLOCK_BINARY = '/usr/bin/flock';

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
  private started: Promise<void> | null = null;
  private stopping = false;
  private lock: Awaited<ReturnType<typeof open>> | null = null;
  private ownsLock = false;
  private socket: string;
  private config: string;
  private helper: string;
  private key: string;
  constructor(readonly root: string, private explicitBinary?: string) {
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
        if (!/^rclone v1\.75\.2\r?\n/.test(version)) continue;
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
  private flags() {
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    return ['--config', this.config, '--password-command', [process.execPath, this.helper, this.key].map(quote).join(' '),
      '--ask-password=false', '--cache-dir', join(this.root, 'cache'), '--log-level', 'ERROR',
      '--transfers', '2', '--checkers', '2', '--buffer-size', '4M', '--bwlimit', '8M', '--timeout', '30s', '--contimeout', '15s'];
  }
  async ensure() {
    if (this.stopping) throw new CloudError('interrupted');
    if (this.started) return this.started;
    const attempt = this.start(); this.started = attempt;
    try { await attempt; }
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
    for (const dir of ['state', 'secrets', 'cache', 'mirrors', 'baselines', 'backups']) await this.secureDirectory(join(this.root, dir));
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
      const child = spawn(this.binary!, ['rcd', '--rc-addr', `unix://${this.socket}`, '--rc-no-auth', ...this.flags()], { env: safeEnvironment(), stdio: 'ignore' });
      this.child = child;
      child.on('error', () => {});
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new CloudError('unavailable');
        try { await this.rawCall('rc/noop', {}); await chmod(this.socket, 0o600); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      throw new CloudError('unavailable');
    } catch (error) { await this.stop(); throw error instanceof CloudError ? error : new CloudError('unavailable'); }
  }
  private rawCall(method: string, body: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new CloudError('unavailable'));
      const req = request({ socketPath: this.socket, path: `/${method}`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) { req.destroy(); fail(); } else data += chunk; });
        res.on('error', fail);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new CloudError(res.statusCode === 401 || res.statusCode === 403 ? 'authentication' : 'sync_failed'));
          try { resolve(JSON.parse(data)); } catch { fail(); }
        });
      });
      req.setTimeout(120_000, () => { req.destroy(); fail(); }); req.on('error', fail);
      req.end(JSON.stringify(body));
    });
  }
  async call(method: string, body: Record<string, unknown>) { await this.ensure(); return this.rawCall(method, body); }
  async run(args: string[], capture = false, report?: (stats: TransferProgress) => void) {
    await this.ensure();
    const stats = report ? ['--use-json-log', '--stats', '1s', '--stats-log-level', 'NOTICE', '--log-level', 'NOTICE'] : [];
    const command = args[0];
    const timeout = command === 'bisync' ? COMMAND_TIMEOUTS.bisync : command === 'lsjson' ? COMMAND_TIMEOUTS.listing : COMMAND_TIMEOUTS.transfer;
    return this.execute(this.binary!, [...args, ...this.flags(), ...stats], capture, timeout, report, command === 'bisync' ? 'bisync' : 'generic');
  }
  private execute(binary: string, args: string[], capture: boolean, timeout: number, report?: (stats: TransferProgress) => void, context: 'bisync' | 'generic' = 'generic'): Promise<string> {
    return new Promise((resolve, reject) => {
      const stdio: any[] = ['ignore', capture ? 'pipe' : 'ignore', report ? 'pipe' : 'ignore'];
      if (this.lock) stdio.push(this.lock.fd);
      const child = spawn(binary, args, { env: safeEnvironment(), stdio });
      const stats = report ? new RcloneStatsStream(report) : null;
      child.stderr?.on('data', chunk => stats?.write(chunk));
      this.children.add(child); let output = ''; let overflow = false; let timedOut = false;
      child.stdout?.on('data', chunk => { if (output.length + chunk.length > 4 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } else output += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGINT'); }, timeout); timer.unref();
      const hard = setTimeout(() => child.kill('SIGKILL'), timeout + 95_000); hard.unref();
      const cleanup = () => { clearTimeout(timer); clearTimeout(hard); this.children.delete(child); };
      child.on('error', () => { cleanup(); reject(new CloudError('unavailable', { kind: 'command_start' })); });
      child.on('close', (code, signal) => {
        stats?.end(); cleanup();
        if (code === 0 && !overflow && !timedOut && !this.stopping) resolve(output);
        else {
          const proof = this.stopping ? { kind: 'command_stopped' as const } : overflow ? { kind: 'command_output_limit' as const } : timedOut ? { kind: 'command_timeout' as const } : signal ? { kind: 'command_signal' as const } : { kind: 'command_exit' as const, exitCode: code };
          let failure: 'interrupted' | 'recovery_required' | 'configuration' | 'capacity' | 'sync_failed';
          if (this.stopping || timedOut || signal) failure = 'interrupted';
          else if (context === 'bisync' && (code === 2 || code === 7)) failure = 'recovery_required';
          else if (context === 'generic' && code === 2) failure = 'configuration';
          else if (context === 'generic' && code === 8) failure = 'capacity';
          else if (context === 'generic' && code === 7) failure = 'recovery_required';
          else failure = 'sync_failed';
          reject(new CloudError(failure, proof));
        }
      });
    });
  }
  async stop() {
    this.stopping = true;
    const children = [...this.children, ...(this.child ? [this.child] : [])];
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', () => { clearTimeout(timer); resolve(); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 95_000); timer.unref(); child.kill('SIGINT');
    })));
    if (this.ownsLock) await unlink(this.socket).catch(() => {});
    await this.lock?.close().catch(() => {}); this.lock = null;
    this.ownsLock = false;
  }
}
