import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { VaultError, type Diagnose, type DesktopLinkOperation, type DesktopLinkResult } from '../core/ports.ts';
import { z } from 'zod';
import { validateNotePath } from './local-notes.ts';

export type DesktopBinaries = { desktop: string; cli: string };
export type DesktopConfiguration = { binaries?: DesktopBinaries; vaultId?: string; root?: string };
type Overrides = { desktopBinary?: string; desktopCli?: string; desktopVaultId?: string; desktopVaultRoot?: string };
type Target = { id: string; directory: string; identity: string };
type Check = (phase: 'before_launch' | 'before_command' | 'after_close', signal: AbortSignal) => Promise<void>;

const START_MS = 20_000;
const COMMAND_MS = 8_000;
const OUTPUT_BYTES = 8 * 1024 * 1024;
const readyProbe = 'code=app.workspace.layoutReady && app.metadataCache.initialized && app.metadataCache.isCacheClean() ? { directory: app.vault.adapter.getBasePath(), restricted: !app.plugins.isEnabled() && Object.keys(app.plugins.plugins).length === 0, updateLinks: app.vault.getConfig("alwaysUpdateLinks") } : null';
const exec = promisify(execFile);

export function desktopConfiguration(settings: Overrides, env = process.env): DesktopConfiguration | undefined {
  const environment = { desktopBinary: env.PA_OBSIDIAN_DESKTOP, desktopCli: env.PA_OBSIDIAN_CLI,
    desktopVaultId: env.PA_OBSIDIAN_DESKTOP_VAULT_ID, desktopVaultRoot: env.PA_OBSIDIAN_DESKTOP_ROOT };
  // Older installations can have a partial settings form alongside a working environment override.
  for (const source of [settings, environment]) {
    if (source.desktopBinary && source.desktopCli && source.desktopVaultId && /^[a-zA-Z0-9-]{1,64}$/.test(source.desktopVaultId))
      return { binaries: { desktop: source.desktopBinary, cli: source.desktopCli }, vaultId: source.desktopVaultId, root: source.desktopVaultRoot || undefined };
  }
  const source = Object.values(settings).some(Boolean) ? settings : environment;
  if (source.desktopBinary || source.desktopCli || (source.desktopVaultRoot && !source.desktopVaultId) ||
      (source.desktopVaultId && !/^[a-zA-Z0-9-]{1,64}$/.test(source.desktopVaultId))) return undefined;
  return { vaultId: source.desktopVaultId || undefined, root: source.desktopVaultRoot || undefined };
}

function exactNotePath(path: string) {
  validateNotePath(path);
  if (path.normalize('NFC') !== path || Buffer.from(path).toString() !== path ||
      path.split('/').some(part => part.trim() !== part || part.startsWith('.'))) throw new VaultError('unsupported');
  return path;
}

export function validateDesktopOperation(operation: DesktopLinkOperation) {
  if (operation.kind === 'backlinks' || (operation.kind === 'tasks' && operation.path)) exactNotePath(operation.path!);
}

const desktopHash = z.string().regex(/^[a-f0-9]{64}$/);
export const desktopMoveEvidence = z.strictObject({ backlinks: z.array(z.strictObject({
  path: z.string().min(1).max(1024), previousHash: desktopHash, hash: desktopHash,
})).max(64) });

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

function exited(child: ChildProcess, event: 'exit' | 'close') {
  return new Promise<number | null>(resolve => {
    child.once(event, resolve);
    child.once('error', () => resolve(null));
  });
}

async function withinExit(exit: Promise<number | null>, ms: number) {
  const wait = new AbortController();
  try { return await Promise.race([exit.then(code => ({ code })), delay(ms, undefined, { signal: wait.signal })]); }
  finally { wait.abort(); }
}

async function cli(binary: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal, ms = COMMAND_MS) {
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(ms);
  try {
    const { stdout, stderr } = await exec(binary, args, {
      env, cwd, timeout: ms + 1000, signal: AbortSignal.any([signal, timeout]),
      maxBuffer: OUTPUT_BYTES, killSignal: 'SIGKILL', encoding: 'buffer',
    });
    if (stderr.length) throw new VaultError('unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new VaultError(signal.aborted ? 'cancelled' : timeout.aborted ? 'desktop_timeout' :
      code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' : 'unavailable');
  }
}

type Session = {
  target: Target;
  invoke(args: string[], signal: AbortSignal, ms?: number): Promise<string>;
  alive(): boolean;
  exit: Promise<number | null>;
  close(): Promise<void>;
};

function json(output: string): unknown {
  try { return JSON.parse(output.startsWith('=> ') ? output.slice(3) : output); }
  catch { throw new VaultError('desktop_reply'); }
}

// BB can construct a replacement plugin before disposing the previous one.
// A process-wide lease prevents two generations from opening the vault at once.
const ownership = Symbol.for('pa-bb.obsidian.desktop-owner');
const processState = globalThis as typeof globalThis & { [ownership]?: Promise<void> };

async function claimDesktop(signal: AbortSignal) {
  while (processState[ownership]) {
    signal.throwIfAborted();
    const wait = processState[ownership];
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      void wait.then(() => { signal.removeEventListener('abort', cancel); resolve(); });
    });
  }
  signal.throwIfAborted();
  let release!: () => void;
  processState[ownership] = new Promise<void>(resolve => {
    release = () => { delete processState[ownership]; resolve(); };
  });
  return release;
}

export class DesktopLinks {
  private queue: Promise<unknown> = Promise.resolve();
  private shutdown = new AbortController();
  private session?: Session;

  constructor(private binaries: DesktopBinaries, private diagnose: Diagnose, private pinned = false) {}

  get running() { return this.session?.alive() ?? false; }

  get activeVaultId() { return this.session?.target.id; }

  reset() {
    const task = this.queue.then(async () => {
      await this.session?.close();
      this.session = undefined;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async stop() {
    this.shutdown.abort();
    await this.queue;
    await this.session?.close();
    this.session = undefined;
  }

  run(target: Target, operation: DesktopLinkOperation, check: Check, signal?: AbortSignal, assertSelected = () => {}) {
    const request = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    const task = this.queue.then(async () => {
      let dispatched = false;
      let stage: Parameters<Diagnose>[0] = 'desktop_start';
      try {
        request.throwIfAborted();
        validateDesktopOperation(operation);
        assertSelected();
        if (this.session && (!this.session.alive() || this.session.target.id !== target.id ||
            this.session.target.directory !== target.directory || this.session.target.identity !== target.identity)) {
          await this.session.close();
          this.session = undefined;
        }
        if (!this.session) {
          await check('before_launch', request);
          assertSelected();
          const release = await claimDesktop(request);
          try {
            await check('before_launch', request);
            const launched = await this.launch(target, request);
            let closing: Promise<void> | undefined;
            const close = () => closing ??= launched.close().finally(release);
            this.session = { ...launched, close };
            void launched.exit.then(() => close()).catch(() => this.diagnose('desktop_cleanup', 'unavailable'));
          } catch (error) { release(); throw error; }
        }
        stage = 'desktop_command';
        await check('before_command', request);
        request.throwIfAborted();
        assertSelected();
        const invoke = (args: string[]) => this.session!.invoke(args, request);
        if (operation.kind === 'start') {
          await check('after_close', request);
          assertSelected();
          return { kind: 'start' } as const;
        }
        let value: unknown;
        switch (operation.kind) {
        case 'write':
          dispatched = true;
        case 'eval':
          value = json(await invoke(['eval', 'code=' + operation.code]));
          if (operation.kind === 'write') {
            if (value === false) dispatched = false;
            else if (value !== true) throw new VaultError('desktop_reply');
          }
          break;
        case 'backlinks': {
          const output = await invoke(['backlinks', 'path=' + operation.path, 'format=json']);
          value = output === 'No backlinks found.' ? [] : json(output);
          break;
        }
        case 'search': {
          const output = await invoke(['search:context', 'query=' + operation.query, 'format=json', 'limit=10001']);
          value = output === 'No matches found.' ? [] : json(output);
          break;
        }
        case 'tasks': {
          const output = await invoke(['tasks', ...(operation.path ? ['path=' + operation.path] : ['all']), 'format=json']);
          value = output === 'No tasks found.' ? [] : json(output);
          break;
        }
        case 'move': {
          dispatched = true;
          const source = JSON.stringify(operation.path);
          const destination = JSON.stringify(operation.destination);
          value = json(await invoke(['eval', `code=(async () => {
            const source = ${source}, destination = ${destination};
            const file = app.vault.getAbstractFileByPath(source);
            if (!file || app.vault.getAbstractFileByPath(destination) || await app.vault.adapter.exists(destination) ||
                !app.vault.getConfig("alwaysUpdateLinks")) return false;
            const { vault, metadataCache } = app;
            const folder = Array.isArray(file.children);
            const insideMove = path => path === source || (folder && path.startsWith(source + "/"));
            const hash = async text => {
              const bytes = new TextEncoder().encode(text);
              if (bytes.length > 1024 * 1024) throw new Error();
              const digest = await crypto.subtle.digest("SHA-256", bytes);
              return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
            };
            const candidates = new Map();
            try {
              for (let attempt = 0; attempt < 4 && !metadataCache.isCacheClean(); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 75));
              }
              if (metadataCache.isCacheClean()) {
                let bytes = 0;
                for (const [path, links] of Object.entries(metadataCache.resolvedLinks)) {
                  if (insideMove(path) || !Object.keys(links).some(insideMove)) continue;
                  const note = vault.getAbstractFileByPath(path);
                  if (note?.extension !== "md" || !note.stat || note.stat.size > 1024 * 1024) continue;
                  bytes += note.stat.size;
                  if (candidates.size === 64 || bytes > 4 * 1024 * 1024) break;
                  candidates.set(path, { note, previousHash: await hash(await vault.read(note)) });
                }
              }
            } catch { candidates.clear(); }
            if (file.path !== source || vault.getAbstractFileByPath(source) !== file ||
                vault.getAbstractFileByPath(destination) || await vault.adapter.exists(destination)) return false;
            const modified = new Set();
            const listener = candidates.size ? vault.on("modify", note => {
              if (candidates.get(note.path)?.note === note) modified.add(note.path);
            }) : undefined;
            try {
              await app.fileManager.renameFile(file, destination);
            } finally {
              if (listener) vault.offref(listener);
            }
            if (file.path !== destination) throw new Error();
            const backlinks = [];
            for (const path of modified) {
              const { note, previousHash } = candidates.get(path);
              if (note.path !== path || vault.getAbstractFileByPath(path) !== note || note.stat.size > 1024 * 1024) continue;
              try {
                const current = await hash(await vault.read(note));
                if (current !== previousHash) backlinks.push({ path, previousHash, hash: current });
              } catch { /* The regular scan handles notes without exact hashes. */ }
            }
            return { backlinks };
          })()`]));
          if (value === false) dispatched = false;
          else if (value !== true && !desktopMoveEvidence.safeParse(value).success) throw new VaultError('desktop_reply');
          break;
        }
        }
        await check('after_close', request);
        assertSelected();
        return { kind: operation.kind, value } as DesktopLinkResult;
      } catch (error) {
        const category = error instanceof VaultError ? error.category : request.aborted ? 'cancelled' : 'unavailable';
        if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose(stage, category);
        if (dispatched) throw new VaultError('uncertain', 'Inspect the move receipt before making another change.', true);
        throw new VaultError(category, error instanceof VaultError ? error.nextAction : 'Check the configured Obsidian Desktop installation.', true);
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  private async launch(target: Target, signal: AbortSignal): Promise<Session> {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(target.id) || !isAbsolute(target.directory) ||
        normalize(target.directory) !== target.directory || target.directory === '/' ||
        Object.values(this.binaries).some(binary => !isAbsolute(binary) || binary.includes('\0'))) throw new VaultError('invalid_path');
    await Promise.all(Object.values(this.binaries).map(binary => access(binary, constants.X_OK)));
    const runtime = await mkdtemp('/tmp/pa-obsidian-');
    const profile = join(runtime, 'config', 'obsidian');
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      HOME: join(runtime, 'home'), TMPDIR: join(runtime, 'tmp'),
      XDG_RUNTIME_DIR: join(runtime, 'run'), XDG_CONFIG_HOME: join(runtime, 'config'),
      XDG_CACHE_HOME: join(runtime, 'cache'), XDG_DATA_HOME: join(runtime, 'data'), XDG_STATE_HOME: join(runtime, 'state'),
    };
    let stop: (() => Promise<void>) | undefined;
    try {
      for (const directory of Object.values(env).slice(2)) await mkdir(directory, { mode: 0o700 });
      await mkdir(profile, { mode: 0o700 });
      await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
        cli: true, ...(this.pinned ? { updateDisabled: true } : {}), vaults: { [target.id]: { path: target.directory, ts: 1, open: true } },
      }), { mode: 0o600, flag: 'wx' });
      signal.throwIfAborted();
      const child = spawn(this.binaries.desktop, [`--user-data-dir=${profile}`, '--ozone-platform=headless',
        '--disable-gpu', '--disable-crash-reporter'], { detached: true, env, cwd: runtime, stdio: 'ignore' });
      const exit = exited(child, 'exit');
      let alive = true, ready = false;
      void exit.then(() => { alive = false; });
      const invoke = (args: string[], abort: AbortSignal, ms?: number) => {
        if (!alive) throw new VaultError('unavailable');
        return cli(this.binaries.cli, [`vault=${target.id}`, ...args], env, runtime, abort, ms);
      };
      stop = async () => {
        try {
          if (alive && ready) await invoke(['eval', 'code=setTimeout(() => window.close(), 50); "closing"'], AbortSignal.timeout(1500)).catch(() => {});
          if (alive && !(ready && await withinExit(exit, 1500))) {
            killGroup(child, 'SIGTERM');
            await withinExit(exit, 500);
          }
        } finally {
          killGroup(child, 'SIGKILL');
          await withinExit(exit, 1000);
        }
      };
      const deadline = AbortSignal.timeout(START_MS);
      const startup = AbortSignal.any([signal, deadline]);
      const socket = join(env.XDG_RUNTIME_DIR, '.obsidian-cli.sock');
      while (alive && !startup.aborted) {
        const entry = await lstat(socket).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (entry?.isSocket()) {
          const output = await invoke(['eval', readyProbe], startup, 1500).catch(() => '');
          if (output.startsWith('=> {')) {
            const state = JSON.parse(output.slice(3));
            if (state.directory !== target.directory) throw new VaultError('source_unavailable');
            if (state.restricted !== true) throw new VaultError('desktop_restricted');
            ready = true;
            return { target, invoke, exit, alive: () => alive, close: async () => {
              try { await stop?.(); } finally { await rm(runtime, { recursive: true, force: true }); }
            } };
          }
        } else if (entry) throw new VaultError('desktop_reply');
        await delay(100, undefined, { signal: startup }).catch(() => {});
      }
      signal.throwIfAborted();
      throw new VaultError(deadline.aborted ? 'desktop_timeout' : 'unavailable');
    } catch (error) {
      try { await stop?.(); } finally { await rm(runtime, { recursive: true, force: true }); }
      throw error;
    }
  }
}
