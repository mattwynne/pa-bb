import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { chmod, mkdir, open, readFile, lstat, writeFile, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CloudError } from '../core/ports.ts';

export function safeEnvironment(): NodeJS.ProcessEnv {
  // Never inherit provider options, credentials, proxies or BB process secrets.
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME, LANG: 'C.UTF-8', GOMEMLIMIT: '256MiB' };
}
export type CommandRunner = (args: string[], capture?: boolean) => Promise<string>;
export type RcCall = (method: string, body: Record<string, unknown>) => Promise<any>;
export class RcloneProcess {
  private binary: string | null = null;
  private child: ChildProcess | null = null;
  private children = new Set<ChildProcess>();
  private started: Promise<void> | null = null;
  private stopping = false;
  private lockHeld = false;
  private socket: string;
  private config: string;
  private helper: string;
  private key: string;
  constructor(readonly root: string, private explicitBinary?: string) {
    this.socket = join(root, 'control.sock'); this.config = join(root, 'state', 'rclone.conf');
    this.helper = join(root, 'secrets', 'read-key.cjs'); this.key = join(root, 'secrets', 'config.key');
  }
  async checkAvailability() {
    if (process.platform === 'win32') throw new CloudError('unavailable');
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
      '--retries', '1', '--low-level-retries', '1', '--transfers', '2', '--checkers', '2', '--buffer-size', '4M', '--bwlimit', '8M', '--timeout', '30s', '--contimeout', '15s'];
  }
  async ensure() {
    if (this.stopping) throw new CloudError('interrupted');
    this.started ??= this.start();
    return this.started;
  }
  private async start() {
    if (!isAbsolute(this.root) || Buffer.byteLength(this.socket) > 100) throw new CloudError('unavailable');
    await this.checkAvailability();
    await this.secureDirectory(this.root);
    for (const dir of ['state', 'secrets', 'cache', 'mirrors', 'baselines', 'backups']) await this.secureDirectory(join(this.root, dir));
    try { const handle = await open(join(this.root, 'worker.lock'), 'wx', 0o600); await handle.close(); this.lockHeld = true; }
    catch { throw new CloudError('recovery_required'); }
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
        await this.execute(this.binary!, ['config', 'encryption', 'set', ...this.flags()], false, 30_000);
      }
      await chmod(this.config, 0o600);
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
  async run(args: string[], capture = false) { await this.ensure(); return this.execute(this.binary!, [...args, ...this.flags()], capture, 10 * 60_000); }
  private execute(binary: string, args: string[], capture: boolean, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env: safeEnvironment(), stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
      this.children.add(child); let output = ''; let overflow = false; let timedOut = false;
      child.stdout?.on('data', chunk => { if (output.length + chunk.length > 4 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } else output += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGINT'); }, timeout); timer.unref();
      const hard = setTimeout(() => child.kill('SIGKILL'), timeout + 95_000); hard.unref();
      const cleanup = () => { clearTimeout(timer); clearTimeout(hard); this.children.delete(child); };
      child.on('error', () => { cleanup(); reject(new CloudError('unavailable')); });
      child.on('close', (code, signal) => {
        cleanup();
        if (code === 0 && !overflow && !timedOut && !this.stopping) resolve(output);
        else reject(new CloudError(this.stopping || timedOut || signal ? 'interrupted' : code === 7 ? 'recovery_required' : 'sync_failed'));
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
    if (this.lockHeld) {
      await unlink(this.socket).catch(() => {});
      await unlink(join(this.root, 'worker.lock')); this.lockHeld = false;
    }
  }
}
