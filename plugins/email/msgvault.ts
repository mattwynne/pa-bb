import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const settings = `[server]
bind_addr = "127.0.0.1"
daemon_auto_start = false
daemon_auto_restart = "never"
api_key_file = "api-key"

[analytics]
engine = "sql"
auto_build_cache = false
`;
const globals = (home: string) => ['--home', home, '--config', join(home, 'bb.toml'), '--no-log-file', '--log-level', 'error'];
const outputLimit = 2 * 1024 * 1024;
const cmd = 'msgvault';
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const previews = z.array(z.object({
  id: positiveId,
  subject: z.string(),
  from_email: z.string().nullish(),
  from_name: z.string().nullish(),
  sent_at: z.string().nullish(),
  match_snippet: z.string().nullish(),
  snippet: z.string().nullish(),
})).max(51);
const address = z.object({ email: z.string(), name: z.string().nullish() });
const details = z.object({
  id: positiveId,
  subject: z.string(),
  from: z.array(address).nullish(),
  to: z.array(address).nullish(),
  sent_at: z.string().nullish(),
  body_text: z.string().nullish(),
});

export class VaultError extends Error {
  constructor(readonly category: 'missing' | 'unsupported' | 'unavailable' | 'startup' | 'command' | 'receipt' | 'response') {
    super('MsgVault did not complete the operation.');
  }
}

type Daemon = { child: ChildProcess; ready: Promise<void>; users: number; idle?: NodeJS.Timeout; exited: Promise<void> };

export class MsgVault {
  private daemons = new Map<string, Daemon>();
  private readonly lifetime = new AbortController();

  constructor(private readonly diagnose: (category: string) => void) {}

  private env(home?: string) {
    return {
      PATH: process.env.PATH,
      ...(home ? { HOME: home, TMPDIR: home } : {}),
      LANG: 'C.UTF-8',
    };
  }

  async check(signal: AbortSignal): Promise<'ready' | 'missing' | 'unsupported' | 'unavailable'> {
    try {
      const { stdout } = await execute(cmd, ['version'], { env: this.env(), timeout: 3000, maxBuffer: 4096, signal });
      return /^msgvault v0\.26\.\d+(?:\s|$)/.test(stdout) ? 'ready' : 'unsupported';
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable'; }
  }

  private async local(home: string, args: string[], signal: AbortSignal, timeout: number, maxBuffer = outputLimit) {
    const result = await execute(cmd, [...globals(home), ...args], {
      cwd: home, env: this.env(home), timeout, maxBuffer, signal, killSignal: 'SIGKILL',
    });
    return result.stdout;
  }

  private async initialize(home: string) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    for (const [name, content] of [['api-key', randomBytes(32).toString('hex')], ['bb.toml', settings]]) {
      try { await writeFile(join(home, name), content, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }

  private async start(home: string) {
    await this.initialize(home);
    this.lifetime.signal.throwIfAborted();
    const child = spawn(cmd, [...globals(home), 'serve'], {
      cwd: home, env: this.env(home), stdio: 'ignore',
    });
    let finished = false;
    const exited = new Promise<void>(resolve => child.once('close', () => {
      finished = true;
      const active = this.daemons.get(home);
      if (active?.child === child) {
        clearTimeout(active.idle);
        this.daemons.delete(home);
      }
      resolve();
    }));
    child.on('error', () => { /* Readiness or command exit supplies the safe diagnostic. */ });
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]);
    const ready = (async () => {
      while (!finished) {
        signal.throwIfAborted();
        const status = await this.local(home, ['daemon', 'status'], signal, 2000).catch(() => '');
        if (status.startsWith('msgvault running at http://127.0.0.1:') &&
          status.split('\n').includes('  pid:     ' + child.pid)) return;
        await delay(100, undefined, { signal });
      }
      throw new VaultError('startup');
    })().catch(() => {
      child.kill('SIGKILL');
      throw new VaultError('startup');
    });
    const daemon: Daemon = { child, exited, ready, users: 0 };
    this.daemons.set(home, daemon);
    return daemon;
  }

  private starting = new Map<string, Promise<Daemon>>();
  private daemon(home: string) {
    const active = this.daemons.get(home);
    if (active && !active.child.killed) return Promise.resolve(active);
    const inFlight = this.starting.get(home);
    if (inFlight) return inFlight;
    const startup = (async () => {
      await active?.exited;
      return this.start(home);
    })().finally(() => this.starting.delete(home));
    this.starting.set(home, startup);
    return startup;
  }

  private async stop(daemon: Daemon) {
    daemon.child.kill('SIGTERM');
    const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 5000);
    timer.unref();
    try { await daemon.exited; } finally { clearTimeout(timer); }
  }

  private async run(home: string, args: string[], requested: AbortSignal, timeout: number, maxBuffer?: number) {
    const signal = AbortSignal.any([requested, this.lifetime.signal]);
    signal.throwIfAborted();
    let daemon: Daemon;
    try { daemon = await this.daemon(home); }
    catch { throw new VaultError('startup'); }
    clearTimeout(daemon.idle);
    daemon.users++;
    try {
      await daemon.ready;
      signal.throwIfAborted();
      try { return await this.local(home, ['--local', ...args], signal, timeout, maxBuffer); }
      catch { throw new VaultError('command'); }
    } finally {
      if (--daemon.users === 0 && !this.lifetime.signal.aborted) {
        daemon.idle = setTimeout(() => { void this.stop(daemon).catch(() => this.diagnose('shutdown')); }, 90_000);
        daemon.idle.unref();
      }
    }
  }

  async import(home: string, source: string, folder: string, count: number, signal: AbortSignal) {
    const output = await this.run(home, [
      'import-eml', '--identifier', source, '--no-resume', '--no-attachments', '--no-default-identity', '--', folder,
    ], signal, 45_000);
    const summary = /^Messages: (\d+) added, (\d+) updated, (\d+) skipped, (\d+) error\(s\)$/m.exec(output);
    if (!summary || Number(summary[4]) !== 0 ||
      Number(summary[1]) + Number(summary[2]) + Number(summary[3]) !== count) throw new VaultError('receipt');
  }

  async search(home: string, query: string, limit: number, signal: AbortSignal) {
    const output = await this.run(home, ['search', '--json', '--snippet', '--message-type', 'email', '--limit', String(limit), '--', query], signal, 12_000);
    try {
      return previews.parse(JSON.parse(output) ?? []).map(row => ({
        id: row.id, subject: row.subject.slice(0, 400), from: row.from_email?.slice(0, 320) ?? null,
        sender: row.from_name?.slice(0, 200) ?? null, sentAt: row.sent_at ?? null,
        snippet: (row.match_snippet || row.snippet || '').slice(0, 600),
      }));
    } catch { throw new VaultError('response'); }
  }

  async read(home: string, id: number, signal: AbortSignal) {
    const output = await this.run(home, ['show-message', '--json', '--strip-quoted', '--', String(id)], signal, 12_000, 48 * 1024 * 1024);
    try {
      const row = details.parse(JSON.parse(output));
      if (row.id !== id) throw new Error();
      const addressList = (addresses: typeof row.from) => (addresses ?? []).slice(0, 20)
        .map(item => ({ email: item.email.slice(0, 320), name: item.name?.slice(0, 200) ?? null }));
      const body = row.body_text ?? '';
      return {
        id, subject: row.subject.slice(0, 400), from: addressList(row.from), to: addressList(row.to),
        sentAt: row.sent_at ?? null, body: body.slice(0, 20_000), truncated: body.length > 20_000,
      };
    } catch { throw new VaultError('response'); }
  }

  async close() {
    this.lifetime.abort();
    await Promise.allSettled(this.starting.values());
    await Promise.allSettled([...this.daemons.values()].map(async daemon => {
      clearTimeout(daemon.idle);
      await this.stop(daemon);
    }));
  }
}
