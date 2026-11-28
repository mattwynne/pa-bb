import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PhotosError } from './errors.ts';

const flock = '/usr/bin/flock';
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', GOMEMLIMIT: '256MiB' };
const remote = 'apple-photos';

// The pipe closes if BB exits abruptly. Keep the native lock in rclone itself
// until it exits, even if the supervisor or its parent is interrupted.
const supervise = `
  const { spawn } = require('node:child_process');
  const [binary, ...args] = process.argv.slice(1);
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore', 3] });
  let timer;
  function stop() {
    child.kill();
    timer ??= setTimeout(() => child.kill('SIGKILL'), 3000);
  }
  process.stdin.resume();
  process.stdin.on('end', stop);
  process.on('SIGTERM', stop);
  child.once('error', () => process.exit(1));
  child.once('exit', code => process.exit(code ?? 1));
`;

async function privateDirectory(dir: string) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new PhotosError('host');
  await chmod(dir, 0o700);
}

export interface AppleRemote {
  rpc(method: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  object(parts: string[], signal: AbortSignal): Promise<IncomingMessage>;
  resetAccount(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export function rcloneRemote(root: string): AppleRemote {
  let starting: Promise<void> | undefined;
  let worker: { stopped: Promise<void>; stop(): void; alive(): boolean } | undefined;
  let runtime: string | undefined;
  let socket: string | undefined;
  const lifetime = new AbortController();

  function send(method: 'GET' | 'POST', path: string, signal: AbortSignal, body?: Record<string, unknown>) {
    const data = body ? JSON.stringify(body) : undefined;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: socket, path, method, signal,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : undefined,
      }, resolve);
      req.on('error', reject);
      req.end(data);
    });
  }

  async function start() {
    if (process.platform !== 'linux') throw new PhotosError('host');
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)]);
    await privateDirectory(root);
    const lock = await open(join(root, 'worker.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await lock.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new PhotosError('host');
      const acquired = spawnSync(flock, ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd], env: environment, timeout: 2000 });
      if (acquired.status !== 0) throw new PhotosError(acquired.status === 1 ? 'busy' : 'host');
      const config = join(root, 'rclone.conf');
      const key = join(root, 'config.key');
      const helper = join(root, 'read-key.cjs');
      await writeFile(helper, "process.stdout.write(require('node:fs').readFileSync(process.argv[2]));\n", { flag: constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, mode: 0o600 });
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const flags = ['--config', config, '--password-command', [process.execPath, helper, key].map(quote).join(' '),
        '--ask-password=false', '--cache-dir', join(root, 'cache'), '--log-level', 'ERROR', '--contimeout', '15s', '--timeout', '45s'];
      const existing = await lstat(config).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing && (!existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o077))) throw new PhotosError('host');
      if (!existing) {
        await writeFile(key, randomBytes(48).toString('base64'), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      const keyInfo = await lstat(key);
      if (!keyInfo.isFile() || keyInfo.uid !== process.getuid?.() || (keyInfo.mode & 0o077) || keyInfo.size !== 64) throw new PhotosError('host');
      if (!existing) {
        // rclone creates its encrypted config without an initial plaintext file.
        const encrypted = spawnSync('rclone', ['config', 'encryption', 'set', ...flags], {
          env: environment, stdio: ['ignore', 'ignore', 'ignore', lock.fd], timeout: 10_000,
        });
        if (encrypted.status !== 0) throw new PhotosError('host');
      }
      const file = await open(config, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(512);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (!/^RCLONE_ENCRYPT_V0:$/m.test(header.subarray(0, bytesRead).toString())) throw new PhotosError('host');
      } finally { await file.close(); }
      signal.throwIfAborted();
      runtime = await mkdtemp('/tmp/bb-photos-');
      socket = join(runtime, 'control.sock');
      const child = spawn(process.execPath, ['-e', supervise, 'rclone', 'rcd', '--rc-no-auth', '--rc-serve',
        '--rc-serve-no-modtime', '--rc-addr', `unix://${socket}`, ...flags], {
        env: environment, stdio: ['pipe', 'ignore', 'ignore', lock.fd] as const,
      });
      // The first stdio entry is a pipe.
      const stdin = child.stdin!;
      stdin.on('error', () => {});
      child.on('error', () => {});
      const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
      worker = { stopped, stop: () => stdin.end(), alive: () => child.exitCode === null && child.signalCode === null };
      await Promise.race([stopped.then(() => { throw new PhotosError('host'); }), (async () => {
        for (;;) {
          signal.throwIfAborted();
          const response = await send('POST', '/rc/noop', signal, {}).catch(() => null);
          response?.resume();
          if (response?.statusCode === 200) break;
          await delay(60, undefined, { signal });
        }
      })()]);
      await chmod(socket, 0o600);
    } catch (error) {
      await stopWorker();
      throw error instanceof PhotosError ? error : new PhotosError('host');
    } finally { await lock.close(); }
  }

  async function stopWorker() {
    worker?.stop();
    await worker?.stopped;
    worker = undefined;
    if (runtime) await rm(runtime, { recursive: true, force: true });
    runtime = undefined;
    socket = undefined;
  }

  async function ready() {
    lifetime.signal.throwIfAborted();
    if (worker && !worker.alive()) {
      await stopWorker();
      starting = undefined;
    }
    starting ??= start().catch(error => { starting = undefined; throw error; });
    await starting;
  }

  const client: AppleRemote = {
    async rpc(method, body, signal) {
      await ready();
      const response = await send('POST', `/${method}`, AbortSignal.any([signal, lifetime.signal]), body);
      if (response.statusCode !== 200) {
        response.destroy();
        if (method === 'config/create') throw new PhotosError('sign_in');
        if (method === 'config/update') throw new PhotosError('verification');
        throw new PhotosError('unavailable');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > 48 * 1024 * 1024) throw new PhotosError('limit');
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks, bytes).toString()); }
      catch { throw new PhotosError('unavailable'); }
    },
    async object(parts, signal) {
      await ready();
      const path = `/${encodeURIComponent(`[${remote}:]`)}/${parts.map(encodeURIComponent).join('/')}`;
      return send('GET', path, AbortSignal.any([signal, lifetime.signal]));
    },
    async resetAccount(signal) {
      // The rclone cache keys include the local remote's name. Clear its
      // entries before that name can be used with a different Apple account.
      await client.rpc('config/delete', { name: remote }, signal);
      await client.rpc('fscache/clear', {}, signal);
      await rm(join(root, 'cache'), { recursive: true, force: true });
    },
    async close() {
      lifetime.abort();
      await starting?.catch(() => {});
      await stopWorker();
    },
  };
  return client;
}
