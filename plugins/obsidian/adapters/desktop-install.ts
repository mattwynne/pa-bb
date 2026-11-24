import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { VaultError, type Diagnose } from '../core/ports.ts';
import type { DesktopBinaries } from './desktop-links.ts';

export const release = {
  version: '1.15.1',
  url: 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.1/obsidian-1.15.1.tar.gz',
  sha256: '09074f0635ecf366307d808d0fec06c01a87a0bcc66da6d34126ceece0eb8519',
};
const exec = promisify(execFile);
const maxBytes = 160 * 1024 * 1024;
const recovery = 'Open Obsidian settings, check the Desktop setup message, then retry.';
type Failure = 'unsupported_host' | 'download_failed' | 'checksum_failed' | 'extract_failed' | 'storage_failed';
type InstallState = 'pending' | 'installing' | 'installed' | Failure;

async function checkBundle(directory: string) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('directory');
  for (const file of ['obsidian', 'obsidian-cli', 'resources/obsidian.asar']) {
    const path = join(directory, file);
    const stat = await lstat(path);
    if (!stat.isFile() || !stat.size) throw new Error('bundle');
    await access(path, file.startsWith('resources/') ? constants.R_OK : constants.X_OK);
  }
}

export class ManagedDesktop {
  readonly binaries: DesktopBinaries;
  state: InstallState = 'pending';
  private readonly directory: string;
  private pending?: Promise<void>;

  constructor(private root: string, private diagnose: Diagnose, private pin = release, private download = fetch) {
    this.directory = join(root, pin.version + '-' + pin.sha256);
    this.binaries = { desktop: join(this.directory, 'obsidian'), cli: join(this.directory, 'obsidian-cli') };
  }

  get failed() { return this.state !== 'pending' && this.state !== 'installing' && this.state !== 'installed'; }

  async drain() { await this.pending?.catch(() => {}); }

  retry() {
    if (this.failed) this.state = 'pending';
  }

  async ensure(signal: AbortSignal, caller?: AbortSignal): Promise<void> {
    if (caller?.aborted) throw new VaultError('cancelled');
    const task = this.sharedInstall(signal);
    if (!caller) return task;
    // Disconnecting one caller must not interrupt the installation shared by other vaults.
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new VaultError('cancelled')); });
    caller.addEventListener('abort', cancel, { once: true });
    try { await Promise.race([task, cancelled]); }
    finally { caller.removeEventListener('abort', cancel); }
  }

  private sharedInstall(signal: AbortSignal): Promise<void> {
    if (this.pending) return this.pending;
    if (this.state === 'installed') return Promise.resolve();
    if (this.failed) return Promise.reject(new VaultError('desktop_setup', recovery, true));
    this.state = 'installing';
    this.pending = this.install(signal).catch(error => {
      if (signal.aborted) {
        this.state = 'pending';
        throw new VaultError('cancelled');
      }
      const category = error instanceof VaultError ? error.category as Failure : 'storage_failed';
      this.state = category;
      this.diagnose('desktop_install', category);
      throw new VaultError('desktop_setup', recovery, true);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async cached() {
    try { await lstat(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (await readFile(join(this.directory, '.verified-sha256'), 'utf8') !== this.pin.sha256) throw new Error('marker');
    await checkBundle(this.directory);
    return true;
  }

  private async install(stop: AbortSignal) {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new VaultError('unsupported_host');
    if (!isAbsolute(this.root)) throw new VaultError('storage_failed');
    const signal = AbortSignal.any([stop, AbortSignal.timeout(180_000)]);
    if (!await this.cached()) {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(join(this.root, '.install-'));
      try {
        const archive = join(stage, 'desktop.tar.gz'), bundle = join(stage, 'bundle');
        await this.fetchArchive(archive, signal);
        await mkdir(bundle, { mode: 0o700 });
        // Only the byte-for-byte pinned upstream archive reaches tar.
        try {
          await exec('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '-C', bundle],
            { signal, timeout: 90_000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin' } });
          await checkBundle(bundle);
        } catch { throw new VaultError('extract_failed'); }
        await writeFile(join(bundle, '.verified-sha256'), this.pin.sha256, { flag: 'wx', mode: 0o600 });
        signal.throwIfAborted();
        try { await rename(bundle, this.directory); }
        catch (error) {
          // An overlapping BB generation may have published the same complete release.
          if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '') || !await this.cached()) throw error;
        }
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    this.state = 'installed';
  }

  private async fetchArchive(path: string, signal: AbortSignal) {
    const hash = createHash('sha256');
    try {
      const response = await this.download(this.pin.url, { signal });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new VaultError('download_failed');
      }
      await pipeline(response.body, async function* (chunks) {
        let bytes = 0;
        for await (const chunk of chunks) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw new VaultError('download_failed');
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
    } catch (error) {
      if (['ENOSPC', 'EACCES', 'EROFS', 'EDQUOT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw new VaultError('storage_failed');
      throw new VaultError('download_failed');
    }
    if (hash.digest('hex') !== this.pin.sha256) throw new VaultError('checksum_failed');
  }
}
