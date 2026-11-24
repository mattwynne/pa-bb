import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { desktopRenameUncertain, VaultError, type Diagnose, type DesktopLinkOperation, type DesktopLinkResult } from '../core/ports.ts';
import { validateNotePath } from './local-notes.ts';

export type DesktopBinaries = { desktop: string; cli: string };
export type DesktopConfiguration = DesktopBinaries & { vaultId: string };
type Target = { id: string; directory: string };
type Check = (phase: 'before_launch' | 'before_command' | 'after_close', signal: AbortSignal) => Promise<void>;

const START_MS = 20_000;
const COMMAND_MS = 8_000;
const OUTPUT_BYTES = 512 * 1024;
const readyProbe = 'code=app.workspace.layoutReady && app.metadataCache.initialized && app.metadataCache.isCacheClean() ? { directory: app.vault.adapter.getBasePath(), restricted: !app.plugins.isEnabled() && Object.keys(app.plugins.plugins).length === 0, updateLinks: app.vault.getConfig("alwaysUpdateLinks") } : null';
const exec = promisify(execFile);

export function desktopConfiguration(env = process.env): DesktopConfiguration | undefined {
  const desktop = env.PA_OBSIDIAN_DESKTOP, cli = env.PA_OBSIDIAN_CLI, vaultId = env.PA_OBSIDIAN_DESKTOP_VAULT_ID;
  if (process.platform === 'linux' && desktop && cli && vaultId && /^[a-zA-Z0-9-]{1,64}$/.test(vaultId))
    return { desktop, cli, vaultId };
}

function exactNotePath(path: string) {
  validateNotePath(path);
  if (path.normalize('NFC') !== path || Buffer.from(path).toString() !== path ||
      path.split('/').some(part => part.trim() !== part || part.startsWith('.'))) throw new VaultError('unsupported');
  return path;
}

export function validateDesktopOperation(operation: DesktopLinkOperation) {
  exactNotePath(operation.path);
  if (operation.kind === 'rename') {
    exactNotePath(operation.destination);
    if (dirname(operation.path) !== dirname(operation.destination) || operation.path === operation.destination)
      throw new VaultError('unsupported');
  }
}

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

function backlinks(output: string): DesktopLinkResult {
  if (output === 'No backlinks found.') return { kind: 'backlinks', sources: [] };
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new VaultError('desktop_reply');
  const sources = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.file !== 'string' || sources.has(row.file)) throw new VaultError('desktop_reply');
    // Retain Obsidian's exact returned spelling for the caller to check against disk.
    sources.add(validateNotePath(row.file));
  }
  return { kind: 'backlinks', sources: [...sources] };
}

export class DesktopLinks {
  private active?: Promise<DesktopLinkResult>;
  private shutdown = new AbortController();

  constructor(private binaries: DesktopBinaries, private diagnose: Diagnose) {}

  async stop() {
    this.shutdown.abort();
    await this.active?.catch(() => {});
  }

  run(target: Target, operation: DesktopLinkOperation, check: Check, signal?: AbortSignal, assertSelected = () => {}) {
    if (this.active) throw new VaultError('busy', 'Wait for the current Obsidian Desktop operation to finish.');
    const request = signal ? AbortSignal.any([this.shutdown.signal, signal]) : this.shutdown.signal;
    const task = this.execute(target, operation, check, request, assertSelected).finally(() => { this.active = undefined; });
    this.active = task;
    return task;
  }

  private async execute(target: Target, operation: DesktopLinkOperation, check: Check, signal: AbortSignal, assertSelected: () => void): Promise<DesktopLinkResult> {
    let phase: Parameters<Diagnose>[0] = 'desktop_setup';
    let dispatched = false;
    let completed = false;
    let runtime: string | undefined, stopDesktop: (() => Promise<void>) | undefined;
    try {
      try {
        signal.throwIfAborted();
        validateDesktopOperation(operation);
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(target.id) || !isAbsolute(target.directory) ||
            normalize(target.directory) !== target.directory || target.directory === '/') throw new VaultError('invalid_path');
        if (Object.values(this.binaries).some(binary => !isAbsolute(binary) || binary.includes('\0')))
          throw new VaultError('unavailable');
        await Promise.all(Object.values(this.binaries).map(binary => access(binary, constants.X_OK)));
        runtime = await mkdtemp('/tmp/pa-obsidian-');
        const cwd = runtime;
        const profile = join(cwd, 'config', 'obsidian');
        const env = {
          PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
          HOME: join(cwd, 'home'), TMPDIR: join(cwd, 'tmp'),
          XDG_RUNTIME_DIR: join(cwd, 'run'), XDG_CONFIG_HOME: join(cwd, 'config'),
          XDG_CACHE_HOME: join(cwd, 'cache'), XDG_DATA_HOME: join(cwd, 'data'), XDG_STATE_HOME: join(cwd, 'state'),
        };
        for (const directory of Object.values(env).slice(2)) await mkdir(directory, { mode: 0o700 });
        // Restricted mode defaults to on in a fresh profile. Never import the
        // operator's profile or change the vault's community-plugin settings.
        await mkdir(profile, { mode: 0o700 });
        await writeFile(join(profile, 'obsidian.json'), JSON.stringify({
          cli: true, vaults: { [target.id]: { path: target.directory, ts: 1, open: true } },
        }), { mode: 0o600, flag: 'wx' });
        await check('before_launch', signal);
        signal.throwIfAborted();
        assertSelected();
        phase = 'desktop_start';
        const child = spawn(this.binaries.desktop, [`--user-data-dir=${profile}`, '--ozone-platform=headless',
          '--disable-gpu', '--disable-crash-reporter'], { detached: true, env, cwd, stdio: 'ignore' });
        const exit = exited(child, 'exit');
        let stopped = false;
        void exit.then(() => { stopped = true; });
        const invoke = (args: string[], abort: AbortSignal, ms?: number) =>
          cli(this.binaries.cli, [`vault=${target.id}`, ...args], env, cwd, abort, ms);
        let ready = false;
        stopDesktop = async () => {
          // Preserve vendor shutdown when possible, then reap the private group
          // even if its leader has already exited.
          try {
            if (!stopped && ready) {
              await invoke(['eval', 'code=setTimeout(() => window.close(), 50); "closing"'], AbortSignal.timeout(1500)).catch(() => {});
              if (await withinExit(exit, 1500)) return;
            }
            killGroup(child, 'SIGTERM');
            if (await withinExit(exit, 500)) return;
          } finally {
            killGroup(child, 'SIGKILL');
            if (!(await withinExit(exit, 1000))) throw new VaultError('desktop_cleanup');
          }
        };

        const deadline = AbortSignal.timeout(START_MS);
        const startup = AbortSignal.any([signal, deadline]);
        const socket = join(env.XDG_RUNTIME_DIR, '.obsidian-cli.sock');
        let state: { directory?: unknown; restricted?: unknown; updateLinks?: unknown } | null = null;
        while (!stopped && !startup.aborted) {
          const entry = await lstat(socket).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
          if (entry?.isSocket()) {
            const output = await invoke(['eval', readyProbe], startup, 1500).catch(() => '');
            if (output.startsWith('=> {')) {
              state = JSON.parse(output.slice(3));
              break;
            }
          } else if (entry) throw new VaultError('desktop_reply');
          await delay(100, undefined, { signal: startup }).catch(() => {});
        }
        signal.throwIfAborted();
        if (!state) throw new VaultError(deadline.aborted ? 'desktop_timeout' : 'unavailable');
        if (state.directory !== target.directory) throw new VaultError('source_unavailable');
        ready = true;
        if (state.restricted !== true) throw new VaultError('desktop_restricted');
        if (operation.kind === 'rename' && state.updateLinks !== true)
          throw new VaultError('unsupported', 'Enable automatic link updates in this Obsidian vault before using Desktop rename.');
        phase = 'desktop_command';
        await check('before_command', signal);
        signal.throwIfAborted();
        assertSelected();
        if (stopped) throw new VaultError('unavailable');
        const path = `path=${operation.path}`;
        if (operation.kind === 'backlinks') {
          const output = await invoke(['backlinks', path, 'format=json'], signal);
          let result;
          try { result = backlinks(output); } catch { throw new VaultError('desktop_reply'); }
          completed = true;
          return result;
        }
        dispatched = true;
        const output = await invoke(['rename', path, `name=${basename(operation.destination)}`], signal);
        if (output !== `Renamed: ${operation.path} -> ${operation.destination}`) throw new VaultError('desktop_reply');
        completed = true;
        return { kind: 'rename', destination: operation.destination };
      } finally {
        try {
          try { await stopDesktop?.(); }
          finally { if (runtime) await rm(runtime, { recursive: true, force: true }); }
        } catch {
          phase = 'desktop_cleanup';
          throw new VaultError('desktop_cleanup');
        }
        if (completed && !signal.aborted) {
          await check('after_close', signal);
          assertSelected();
        }
        signal.throwIfAborted();
      }
    } catch (error) {
      const category = error instanceof VaultError ? error.category : signal.aborted ? 'cancelled' : 'unavailable';
      if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose(phase, category);
      if (dispatched) throw desktopRenameUncertain(true);
      throw new VaultError(category, error instanceof VaultError ? error.nextAction : 'Check the configured Obsidian Desktop installation.', true);
    }
  }
}
