// Linux file primitives carried forward from the iCloud note store. All paths
// below a host-authorized mirror are traversed with no-follow directory handles.
import { constants, type Stats } from 'node:fs';
import { open, opendir, lstat, rename, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_NOTE_BYTES, VaultError } from '../core/ports.ts';

const NOTE_LIMITS = { bytes: MAX_NOTE_BYTES, entries: 10000, scanMs: 2000 };
export function validateRelativePath(path: string) {
  if (path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) throw new VaultError('invalid_path');
  return path;
}
export function validateNotePath(path: string) {
  if (!path.endsWith('.md')) throw new VaultError('invalid_path');
  return validateRelativePath(path);
}
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export const identity = (a: Pick<Stats, 'dev' | 'ino'>, b: Pick<Stats, 'dev' | 'ino'>) => a.dev === b.dev && a.ino === b.ino;
const same = (a: Stats, b: Stats) => identity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const isConflictCopy = (name: string) => /\.(?:icloud|bb)-conflict[1-9][0-9]*$/.test(name);
type Observation = { text: string; hash: string; info: Stats };
export const equivalent = (a: Observation | null, b: Observation | null) => a === null || b === null ? a === b : a.hash === b.hash && same(a.info, b.info);
export type SearchReader = { file: FileHandle; info: Stats; text: string; hash: string; readAt: string; verify(): Promise<void>; close(): Promise<void> };
export type DirectoryGrant = { directory: string; rootDev: string; rootIno: string };
// Positional reads never advance a descriptor inherited by ripgrep. Recheck the
// same pinned inode and exact bytes, not a replacement opened by its pathname.
export async function pinSearchFile(file: FileHandle, named: (info: Stats) => Promise<void>): Promise<SearchReader> {
  try {
    const before = await file.stat(), stamp = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > NOTE_LIMITS.bytes) throw new VaultError('unsupported');
    const read = async () => {
      const bytes = Buffer.alloc(before.size + 1); let count = 0;
      while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      if (count !== before.size) throw new VaultError('conflict');
      return bytes.subarray(0, count);
    };
    const bytes = await read(), hash = digest(bytes);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new VaultError('unsupported'); }
    if (text.includes('\0')) throw new VaultError('unsupported');
    const verify = async () => {
      const bytes = await read(), after = await file.stat({ bigint: true });
      // Exact nanosecond stamps avoid rounding a fast write down to the same
      // millisecond number.
      if (stamp.dev !== after.dev || stamp.ino !== after.ino || stamp.size !== after.size || stamp.mtimeNs !== after.mtimeNs || stamp.ctimeNs !== after.ctimeNs || digest(bytes) !== hash) throw new VaultError('conflict');
      await named(before);
    };
    await verify(); let closed = false;
    return { file, info: before, text, hash, readAt: new Date().toISOString(), verify, async close() { if (!closed) { closed = true; await file.close(); } } };
  } catch (error) { await file.close().catch(() => {}); throw error instanceof VaultError ? error : new VaultError('unavailable'); }
}
export class LocalNotes {
  private async parent(root: string | FileHandle, path: string, validatedFolder = false) {
    if (!validatedFolder) validateRelativePath(path);
    const handles: FileHandle[] = [];
    try {
      let folder: FileHandle;
      if (typeof root === 'string') { folder = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(folder); }
      else folder = root;
      for (const part of path.split('/').slice(0, -1)) {
        folder = await open(join(fdPath(folder.fd), part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(folder);
      }
      return { handles, folder, path: join(fdPath(folder.fd), path.split('/').at(-1)!), close: async () => { await Promise.all(handles.map(h => h.close())); } };
    } catch (error) {
      await Promise.all(handles.map(h => h.close().catch(() => {})));
      if (error instanceof VaultError) throw error;
      throw new VaultError('invalid_path');
    }
  }
  private async readAt(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const reader = await pinSearchFile(file, async info => {
      if (!same(info, await lstat(path))) throw new VaultError('conflict');
    });
    try { return { text: reader.text, hash: reader.hash, info: reader.info }; }
    finally { await reader.close(); }
  }
  // Exact identity is internal collision evidence, never a consumer CAS hash.
  async observe(root: string, path: string) {
    let parent: Awaited<ReturnType<LocalNotes['parent']>> | undefined;
    try {
      parent = await this.parent(root, path);
      let result: Awaited<ReturnType<LocalNotes['readAt']>> | null;
      try { result = await this.readAt(parent.path); }
      catch (e) { if (!missing(e)) throw e; result = null; }
      const fresh = await this.parent(root, path);
      try {
        if (!identity(await parent.folder.stat(), await fresh.folder.stat())) throw new VaultError('conflict');
        if (result && !same(result.info, await lstat(fresh.path))) throw new VaultError('conflict');
        if (!result) {
          try { await lstat(fresh.path); throw new VaultError('conflict'); }
          catch (e) { if (!missing(e)) throw e; }
        }
      } finally { await fresh.close(); }
      return result;
    } catch (e) { throw e instanceof VaultError ? e : new VaultError('unavailable'); }
    finally { await parent?.close(); }
  }
  async read(root: string, path: string) {
    validateNotePath(path);
    const result = await this.observe(root, path);
    if (!result) throw new VaultError('unavailable');
    return { text: result.text, hash: result.hash, readAt: new Date(Date.now()).toISOString(), complete: true as const };
  }
  async conflictCopies(root: string, path: string) {
    const parent = await this.parent(root, path);
    try {
      const name = path.split('/').at(-1)!;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^${escaped}\\.(icloud-conflict|bb-conflict)([1-9][0-9]*)$`);
      const found: Array<{ path: string; side: 'icloud' | 'bb'; number: number; observation: NonNullable<Awaited<ReturnType<LocalNotes['readAt']>>> }> = [];
      const folder = await opendir(fdPath(parent.folder.fd), { bufferSize: 32 });
      let count = 0;
      for await (const entry of folder) {
        if (++count > NOTE_LIMITS.entries) throw new VaultError('conflict', 'Inspect the conflict copies in the vault directory.');
        const match = pattern.exec(entry.name); if (!match) continue;
        if (!entry.isFile() || found.length >= 32) throw new VaultError('conflict', 'Inspect the conflict copies in the vault directory.');
        const number = Number(match[2]); if (!Number.isSafeInteger(number)) throw new VaultError('conflict', 'Inspect the conflict copies in the vault directory.');
        const copyPath = validateRelativePath(path.slice(0, path.length - name.length) + entry.name);
        const observed = await this.readAt(join(fdPath(parent.folder.fd), entry.name));
        found.push({ path: copyPath, side: match[1] === 'icloud-conflict' ? 'icloud' : 'bb', number, observation: observed });
      }
      const fresh = await this.parent(root, path);
      try { if (!identity(await parent.folder.stat(), await fresh.folder.stat())) throw new VaultError('conflict', 'Inspect the conflict copies in the vault directory.'); }
      finally { await fresh.close(); }
      return found;
    } catch (e) { throw e instanceof VaultError ? e : new VaultError('conflict', 'Inspect the conflict copies in the vault directory.'); }
    finally { await parent.close(); }
  }
  async desktopRoot(grant: DirectoryGrant, prefix: string) {
    const root = await open(grant.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const mirror = await root.stat({ bigint: true });
      if (mirror.dev.toString() !== grant.rootDev || mirror.ino.toString() !== grant.rootIno) throw new VaultError('source_unavailable');
      const parent = await this.parent(root, prefix ? prefix + '/.obsidian' : '.obsidian');
      try {
        const settings = await lstat(parent.path, { bigint: true });
        if (!settings.isDirectory()) throw new VaultError('source_unavailable');
        const info = await parent.folder.stat({ bigint: true });
        return { prefix, directory: join(grant.directory, prefix), dev: info.dev, ino: info.ino, settingsDev: settings.dev, settingsIno: settings.ino };
      } finally { await parent.close(); }
    } finally { await root.close(); }
  }
  async rootIdentity(root: string) {
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { return await handle.stat(); } finally { await handle.close(); }
  }

  async children(root: string, folder: string) {
    validateRelativePath(folder);
    const parent = await this.parent(root, folder + '/.md', true);
    const entries: Array<{ name: string; kind: 'directory' | 'markdown' }> = [];
    let incomplete = false, seen = 0, bytes = 0;
    const started = Date.now();
    try {
      const directory = await opendir(fdPath(parent.folder.fd));
      for await (const child of directory) {
        if (++seen > 5000 || Date.now() - started > NOTE_LIMITS.scanMs) { incomplete = true; break; }
        if (child.isSymbolicLink()) { incomplete = true; continue; }
        const kind = child.isDirectory() ? 'directory' : child.isFile() && child.name.endsWith('.md') ? 'markdown' : null;
        if (!kind) continue;
        try { validateRelativePath(folder + '/' + child.name); } catch { incomplete = true; continue; }
        bytes += Buffer.byteLength(child.name) + 40;
        if (bytes > 512 * 1024) { incomplete = true; break; }
        entries.push({ name: child.name, kind });
      }
    } finally { await parent.close(); }
    return { entries: entries.sort((a, b) => a.name.localeCompare(b.name, 'en')), incomplete };
  }

  async vaultRoots(root: string) {
    const roots: string[] = [];
    const started = Date.now();
    const warnings = new Set<string>();
    let incomplete = false, entries = 0;
    const scanLimited = (entryCapReached: boolean) => {
      if (entryCapReached) warnings.add('entry_cap');
      if (Date.now() - started > NOTE_LIMITS.scanMs) warnings.add('scan_timeout');
      return warnings.size > 0;
    };
    const walk = async (path: string, relative: string, depth: number) => {
      if (scanLimited(entries >= NOTE_LIMITS.entries) || depth > 32 || roots.length >= 100) { incomplete = true; return; }
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const pinned = fdPath(handle.fd);
        try {
          const marker = await open(join(pinned, '.obsidian'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await marker.close();
          roots.push(relative);
          return;
        } catch (error) { if (!missing(error)) incomplete = true; }
        const directory = await opendir(pinned);
        for await (const child of directory) {
          entries++;
          if (scanLimited(entries > NOTE_LIMITS.entries)) { incomplete = true; break; }
          if (!child.isDirectory() || ['.obsidian', '.git', 'node_modules'].includes(child.name)) continue;
          const next = relative ? relative + '/' + child.name : child.name;
          try { validateRelativePath(next); await walk(join(pinned, child.name), next, depth + 1); }
          catch { incomplete = true; }
        }
      } finally { await handle.close(); }
    };
    await walk(root, '', 0);
    return { roots: roots.sort(), incomplete, warnings: [...warnings] };
  }

  // Staging names are reserved in paired iCloud sync. Stage and destination
  // share a parent so publication is atomic (and creation never clobbers).
  async publish(root: string, path: string, text: string, expected: Observation | null,
    before: (stage: Stats) => Promise<void>, check: () => Promise<void>, dispatch: () => void, committed: () => void) {
    const bytes = Buffer.from(text);
    if (bytes.length > NOTE_LIMITS.bytes || bytes.toString() !== text || text.includes('\0')) throw new VaultError('unsupported');
    const parent = await this.parent(root, path);
    const stage = join(fdPath(parent.folder.fd), `.obsidian-bb-${randomUUID()}.tmp`);
    let staged = false;
    try {
      const file = await open(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, expected ? expected.info.mode & 0o777 : 0o600);
      staged = true;
      let info: Stats;
      try {
        if (expected) await file.chmod(expected.info.mode & 0o777);
        await file.writeFile(bytes);
        await file.sync();
        info = await file.stat();
      } finally { await file.close(); }
      await before(info);
      await check();
      const fresh = await this.parent(root, path);
      try {
        if (!identity(await parent.folder.stat(), await fresh.folder.stat()) || !equivalent(await this.observe(root, path), expected)) throw new VaultError('conflict');
        dispatch();
        if (expected) await rename(stage, fresh.path);
        else await link(stage, fresh.path);
        committed();
        if (!expected) await unlink(stage);
        staged = false;
        await fresh.folder.sync();
        const result = await this.observe(root, path);
        if (!result || !identity(info, result.info) || result.hash !== digest(bytes)) throw new VaultError('uncertain');
      } finally { await fresh.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new VaultError('conflict');
      throw error;
    } finally {
      try { if (staged) await unlink(stage).catch(() => {}); }
      finally { await parent.close(); }
    }
  }

  private async statEntry(path: string) {
    try { return await lstat(path); }
    catch (error) { if (missing(error)) return null; throw error; }
  }

  async entry(root: string, path: string) {
    const parent = await this.parent(root, path);
    try {
      const info = await this.statEntry(parent.path);
      await this.verifyParent(root, path, parent.folder);
      return info;
    } finally { await parent.close(); }
  }

  async removeCopy(root: string, path: string, expected: Observation) {
    const parent = await this.parent(root, path);
    try {
      if (!equivalent(await this.observe(root, path), expected)) throw new VaultError('uncertain');
      await this.verifyParent(root, path, parent.folder);
      await unlink(parent.path);
      await parent.folder.sync();
    } finally { await parent.close(); }
  }

  async syncParent(root: string, path: string) {
    const parent = await this.parent(root, path);
    try { await parent.folder.sync(); } finally { await parent.close(); }
  }

  private async verifyParent(root: string, path: string, folder: FileHandle) {
    const fresh = await this.parent(root, path);
    try {
      if (!identity(await folder.stat(), await fresh.folder.stat())) throw new VaultError('conflict');
    } finally { await fresh.close(); }
  }
}
