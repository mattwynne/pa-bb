// Linux file primitives carried forward from the iCloud note store. All paths
// below a host-authorized mirror are traversed with no-follow directory handles.
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { open, opendir, lstat, rename, link, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_NOTE_BYTES, VaultError } from '../core/ports.ts';

// Node exposes rename without RENAME_NOREPLACE. The system Python/libc
// bridge calls it directly and has no overwrite or cross-device fallback.
const renameNoReplace = `
import ctypes, errno, os, sys
rename = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
if rename is None:
    sys.exit(4)
if len(sys.argv) == 1:
    sys.exit(0)
rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
rename.restype = ctypes.c_int
if rename(3, os.fsencode(sys.argv[1]), 4, os.fsencode(sys.argv[2]), 1) != 0:
    error = ctypes.get_errno()
    if error in (errno.EEXIST, errno.ENOTEMPTY):
        sys.exit(3)
    if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.EXDEV):
        sys.exit(4)
    sys.exit(5)
`;
function renameHelper(args: string[] = [], descriptors: number[] = []) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn('python3', ['-I', '-S', '-c', renameNoReplace, ...args], {
      stdio: ['ignore', 'ignore', 'ignore', ...descriptors],
    });
    child.once('error', reject);
    child.once('close', resolve);
  });
}
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
const directoryStamp = (info: BigIntStats) => [info.dev, info.ino, info.mtimeNs, info.ctimeNs].join(':');
const isConflictCopy = (name: string) => /\.(?:icloud|bb)-conflict[1-9][0-9]*$/.test(name);
type Observation = { text: string; hash: string; info: Stats };
export const equivalent = (a: Observation | null, b: Observation | null) => a === null || b === null ? a === b : a.hash === b.hash && same(a.info, b.info);
export type SearchPath = { path: string } | { progress: true } | { warning: 'note_unavailable' | 'unsupported' | 'capacity' };
export type SearchReader = { file: FileHandle; info: Stats; text: string; hash: string; readAt: string; verify(): Promise<void>; close(): Promise<void> };
export type DirectoryGrant = { directory: string; rootDev: string; rootIno: string };
// Positional reads never advance a descriptor inherited by ripgrep. Recheck the
// same pinned inode and exact bytes, not a replacement opened by its pathname.
export async function pinSearchFile(file: FileHandle, named: (info: Stats) => Promise<void>, index = false): Promise<SearchReader> {
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
    catch (error) { if (index) throw new VaultError('unsupported'); throw error; }
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
  private async parent(root: string | FileHandle, path: string, validatedFolder = false, allowAbsent = false) {
    if (!validatedFolder) validateRelativePath(path);
    const handles: FileHandle[] = [];
    try {
      let folder: FileHandle;
      if (typeof root === 'string') { folder = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(folder); }
      else folder = root; // borrow the verified index root; never reopen its pathname
      for (const part of path.split('/').slice(0, -1)) {
        folder = await open(join(fdPath(folder.fd), part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(folder);
      }
      return { handles, folder, path: join(fdPath(folder.fd), path.split('/').at(-1)!), close: async () => { await Promise.all(handles.map(h => h.close())); } };
    } catch (error) {
      const absent = allowAbsent && typeof root !== 'string' && missing(error);
      await Promise.all(handles.map(h => h.close().catch(() => {})));
      if (absent || error instanceof VaultError) throw error;
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
  async list(root: string, includeAttachments = false, scope = '', strict = false) {
    const paths: string[] = [], attachments: string[] = []; let count = 0; const started = Date.now(); let incomplete = false; const warnings = new Set<string>();
    const walk = async (folder: FileHandle, prefix: string) => {
      // Stream entries: a huge directory must not allocate an unbounded array.
      const directory = await opendir(fdPath(folder.fd), { bufferSize: 32, encoding: strict ? 'buffer' as BufferEncoding : 'utf8' });
      for await (const entry of directory) {
        if (++count > NOTE_LIMITS.entries) { incomplete = true; warnings.add(strict ? 'entry_cap' : 'scan_limit'); return; }
        if (Date.now() - started > NOTE_LIMITS.scanMs) { incomplete = true; warnings.add(strict ? 'scan_timeout' : 'scan_limit'); return; }
        let name = entry.name;
        if (strict) {
          try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.name as unknown as Buffer); }
          catch { incomplete = true; warnings.add('unsupported_path'); continue; }
        }
        const path = prefix + name;
        if (strict && (isConflictCopy(name) || (!entry.isDirectory() && !entry.isFile())))
          throw new VaultError('unavailable', `Cannot verify the full vault listing at ${path.slice(0, 1024)}. Inspect this unsupported entry or conflict copy.`);
        if (entry.isSymbolicLink()) { incomplete = true; warnings.add('symlink_skipped'); continue; }
        if (entry.isDirectory()) {
          try { validateRelativePath(path); } catch { incomplete = true; warnings.add('unsupported_path'); continue; }
          let child: FileHandle | undefined;
          try { child = await open(join(fdPath(folder.fd), name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); await walk(child, path + '/'); }
          catch (error) {
            if (strict) throw error instanceof VaultError ? error : new VaultError('unavailable', `Cannot read the full vault listing at ${path}.`);
            incomplete = true; warnings.add('unreadable_directory');
          }
          finally { await child?.close(); }
        } else if (entry.isFile() && path.endsWith('.md')) { try { paths.push(validateNotePath(path)); } catch { incomplete = true; warnings.add('unsupported_path'); } }
        else if (includeAttachments && entry.isFile()) {
          try { attachments.push(validateRelativePath(path)); } catch { incomplete = true; warnings.add('unsupported_path'); }
        }
      }
    };
    let folder: FileHandle | undefined;
    const parent = scope ? await this.parent(root, scope) : undefined;
    try {
      folder = await open(parent?.path ?? root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await walk(folder, scope ? scope + '/' : '');
      if (parent) {
        await this.verifyParent(root, scope, parent.folder);
        if (!identity(await folder.stat(), await lstat(parent.path))) throw new VaultError('conflict');
      }
    } catch (error) { throw strict && error instanceof VaultError ? error : new VaultError('unavailable'); }
    finally { await folder?.close(); await parent?.close(); }
    return { paths: paths.sort(), attachments: attachments.sort(), incomplete, warnings: [...warnings] };
  }
  async searchReader(root: string | FileHandle, path: string): Promise<SearchReader> {
    const parent = await this.parent(root, path); let file: FileHandle | undefined;
    try {
      file = await open(parent.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // Keep only the immediate directory pin while rg runs, not an ancestry
      // chain per reader. Fresh traversal below still verifies containment.
      await Promise.all(parent.handles.splice(0, parent.handles.length - 1).map(handle => handle.close()));
      return await pinSearchFile(file, async info => {
        const fresh = await this.parent(root, path);
        try { if (!identity(await parent.folder.stat(), await fresh.folder.stat()) || !same(info, await lstat(fresh.path))) throw new VaultError('conflict'); }
        finally { await fresh.close(); }
      }, typeof root !== 'string').then(reader => { let closed = false; return { ...reader, async close() { if (closed) return; closed = true; try { await reader.close(); } finally { await parent.close(); } } }; });
    } catch (error) { await file?.close().catch(() => {}); await parent.close(); throw error instanceof VaultError ? error : new VaultError('unavailable'); }
  }
  // Separate strict index walk: only ENOENT beneath an authorized, pinned
  // root can remove a scoped directory. Other open/read errors abort a build.
  async openIndexRoot(grant: DirectoryGrant) {
    const root = await open(grant.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await root.stat({ bigint: true });
      if (info.dev.toString() !== grant.rootDev || info.ino.toString() !== grant.rootIno) throw new VaultError('source_unavailable');
      return root;
    } catch (error) { await root.close(); throw error; }
  }
  // Find the outermost Obsidian vault on the requested note's ancestry, as
  // vaultRoots() does. The authorized mirror is the upper boundary.
  async desktopTarget(grant: DirectoryGrant, path: string, destination?: string, afterClose = false) {
    const root = await this.openIndexRoot(grant);
    try {
      const parent = await this.parent(root, path);
      try {
        const ancestors = [root, ...parent.handles];
        const parts = path.split('/');
        for (const [depth, ancestor] of ancestors.entries()) {
          const marker = join(fdPath(ancestor.fd), '.obsidian');
          const settings = await lstat(marker, { bigint: true }).catch(error => {
            if (!missing(error)) throw error;
          });
          if (!settings) continue;
          if (!settings.isDirectory()) throw new VaultError('invalid_path');
          if (!afterClose) {
            const note = await lstat(parent.path).catch(error => {
              if (!missing(error)) throw error;
            });
            if (!note?.isFile()) throw new VaultError('invalid_path');
            if (destination) {
              const occupied = await lstat(join(fdPath(parent.folder.fd), destination.split('/').at(-1)!)).catch(error => {
                if (!missing(error)) throw error;
              });
              if (occupied) throw new VaultError('conflict', 'Choose an unoccupied destination.');
            }
          }
          const info = await ancestor.stat({ bigint: true });
          const prefix = parts.slice(0, depth).join('/');
          return { prefix, directory: join(grant.directory, prefix), dev: info.dev, ino: info.ino, settingsIno: settings.ino, settingsDev: settings.dev };
        }
        throw new VaultError('unsupported', 'Choose a note inside an Obsidian vault with a local settings directory.');
      } finally { await parent.close(); }
    } finally { await root.close(); }
  }
  async indexDirectoryStamp(root: FileHandle, path: string) {
    const parent = await this.parent(root, path ? path + '/.md' : '.md', true, true);
    try { return directoryStamp(await parent.folder.stat({ bigint: true })); }
    finally { await parent.close(); }
  }
  async *indexDirectory(root: FileHandle, path: string, allowAbsent: boolean, opened: (pinnedPath: string, info: Stats) => void) {
    if (path) validateRelativePath(path);
    const marker = path ? `${path}/.md` : '.md';
    let parent;
    try { parent = await this.parent(root, marker, true, allowAbsent); }
    catch (error) { if (allowAbsent && missing(error)) return; throw error; }
    let directory;
    try {
      await Promise.all(parent.handles.splice(0, parent.handles.length - 1).map(handle => handle.close()));
      const info = await parent.folder.stat();
      const stamp = directoryStamp(await parent.folder.stat({ bigint: true }));
      const pinned = fdPath(parent.folder.fd);
      directory = await opendir(pinned, { bufferSize: 32, encoding: 'buffer' as BufferEncoding });
      opened(pinned, info);
      yield { kind: 'directory' as const, path, stamp };
      for await (const entry of directory) {
        const bytes = entry.name as unknown as Buffer;
        let name: string;
        try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { yield { kind: 'unsupported' as const, path, scope: 'tree' as const, boundary: true as const }; continue; }
        const relative = path ? `${path}/${name}` : name;
        if (isConflictCopy(name)) yield { kind: 'move_blocker' as const, path: relative, scope: 'tree' as const };
        if (entry.isSymbolicLink()) { yield { kind: 'unsupported' as const, path: relative, scope: 'tree' as const }; continue; }
        if (entry.isDirectory() || relative.endsWith('.md')) {
          const scope = entry.isDirectory() ? 'tree' as const : 'note' as const;
          try { validateRelativePath(relative); }
          catch { yield { kind: 'unsupported' as const, path: relative, scope, boundary: entry.isDirectory() ? true as const : undefined }; continue; }
          yield entry.isDirectory() ? { kind: 'child' as const, path: relative } :
            entry.isFile() ? { kind: 'note' as const, path: relative } : { kind: 'unsupported' as const, path: relative, scope };
        } else if (entry.isFile()) {
          try { yield { kind: 'attachment' as const, path: validateRelativePath(relative) }; }
          catch { yield { kind: 'unsupported' as const, path: relative, scope: 'note' as const }; }
        } else yield { kind: 'move_blocker' as const, path: relative, scope: 'tree' as const };
      }
      const fresh = await this.parent(root, marker, true);
      try { if (!identity(info, await fresh.folder.stat())) throw new VaultError('conflict'); }
      finally { await fresh.close(); }
    } finally { await directory?.close().catch(() => {}); await parent.close(); }
  }
  // Streaming discovery for search. Unlike list(), a yield is a continuation,
  // never a terminal alphabetical prefix. Every directory is opened no-follow.
  async *searchPaths(root: string, scope?: { file(path: string): boolean; directory(path: string): boolean }): AsyncGenerator<SearchPath> {
    // Only one directory stream remains pinned across responses. A bounded
    // path frontier avoids retaining a descriptor pair per nested directory.
    const frontier = ['']; let bytes = 0;
    while (frontier.length) {
      const prefix = frontier.pop()!; bytes -= prefix ? Buffer.byteLength(prefix) + 128 : 0;
      let parent: Awaited<ReturnType<LocalNotes['parent']>> | undefined;
      let directory: Awaited<ReturnType<typeof opendir>> | undefined;
      try {
        parent = await this.parent(root, prefix ? prefix + '/.md' : '.md', true);
        await Promise.all(parent.handles.splice(0, parent.handles.length - 1).map(handle => handle.close()));
        directory = await opendir(fdPath(parent.folder.fd), { bufferSize: 32 });
        for await (const entry of directory) {
          const path = (prefix ? prefix + '/' : '') + entry.name;
          yield { progress: true }; // even no-note directories advance the slice
          if (entry.isDirectory()) {
            if (scope && !scope.directory(path)) continue;
            try { validateRelativePath(path); } catch { yield { warning: 'unsupported' }; continue; }
            if (bytes + Buffer.byteLength(path) + 128 > 2 * 1024 * 1024) { yield { warning: 'capacity' }; continue; }
            frontier.push(path); bytes += Buffer.byteLength(path) + 128;
          } else if (path.endsWith('.md') && (!scope || scope.file(path))) {
            if (!entry.isFile()) { yield { warning: 'unsupported' }; continue; }
            try { yield { path: validateNotePath(path) }; } catch { yield { warning: 'unsupported' }; }
          }
        }
      } catch { yield { warning: 'note_unavailable' }; }
      finally { await directory?.close().catch(() => {}); await parent?.close(); }
    }
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
    before: (stage: Stats) => Promise<void>, check: () => Promise<void>, committed: () => void) {
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

  async move(root: string, path: string, destination: string, expected: Observation, check: () => Promise<void>, committed: () => void, afterLink?: () => Promise<void>, beforeLink?: () => Promise<() => void>) {
    const source = await this.parent(root, path);
    try {
      const target = await this.parent(root, destination);
      try {
        const assertLinkPlan = await beforeLink?.();
        await check();
        await this.verifyParent(root, path, source.folder);
        await this.verifyParent(root, destination, target.folder);
        if (!equivalent(await this.observe(root, path), expected) || await this.observe(root, destination)) throw new VaultError('conflict');
        assertLinkPlan?.();
        try { await link(source.path, target.path); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new VaultError('conflict'); throw error; }
        committed();
        await target.folder.sync();
        await afterLink?.();
        await check();
        await this.verifyParent(root, path, source.folder);
        await this.verifyParent(root, destination, target.folder);
        const a = await this.observe(root, path), b = await this.observe(root, destination);
        if (!a || !b || a.hash !== expected.hash || b.hash !== expected.hash || !identity(a.info, expected.info) || !identity(b.info, expected.info)) throw new VaultError('uncertain');
        await unlink(source.path);
        await source.folder.sync();
      } finally { await target.close(); }
    } finally { await source.close(); }
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

  // Record names and identities for the entire tree, including empty folders
  // and attachments. A single rename preserves the original inodes and bytes.
  async projectTree(root: string, path: string, directoryMove?: { destination: string }) {
    const parent = await this.parent(root, path);
    const started = Date.now();
    const entries = new Map<string, Stats>();
    const walk = async (directory: string, prefix: string) => {
      const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const listing = await opendir(fdPath(folder.fd), { encoding: directoryMove ? 'buffer' as BufferEncoding : 'utf8' });
        for await (const entry of listing) {
          if (entries.size >= NOTE_LIMITS.entries)
            throw new VaultError(directoryMove ? 'entry_cap' : 'capacity', 'The source folder tree reached its entry cap.');
          if (Date.now() - started >= NOTE_LIMITS.scanMs)
            throw new VaultError(directoryMove ? 'scan_timeout' : 'capacity', 'The source folder tree scan timed out.');
          let name = entry.name;
          if (directoryMove) {
            try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.name as unknown as Buffer); }
            catch { throw new VaultError('invalid_path', 'The source folder contains a filename that is not valid UTF-8.'); }
            if (name === '.obsidian') throw new VaultError('conflict', 'The source folder contains an Obsidian vault boundary.');
            validateRelativePath(path + '/' + prefix + name);
            validateRelativePath(directoryMove.destination + '/' + prefix + name);
          }
          const child = prefix + name;
          const entryPath = join(fdPath(folder.fd), name);
          const info = await lstat(entryPath);
          if ((!info.isFile() && !info.isDirectory()) || isConflictCopy(name))
            throw new VaultError('conflict', 'Inspect unsupported entries or conflict copies in the project folder.');
          entries.set(child, info);
          if (info.isDirectory()) await walk(entryPath, child + '/');
        }
      } finally { await folder.close(); }
    };
    try {
      const info = await this.statEntry(parent.path);
      if (!info?.isDirectory()) throw new VaultError('conflict', 'The source path does not name an existing folder.');
      await walk(parent.path, '');
      const current = await lstat(parent.path);
      if (!same(info, current)) throw new VaultError('conflict');
      await this.verifyParent(root, path, parent.folder);
      const names = [...entries.keys()].sort();
      return {
        info,
        notes: names.filter(name => entries.get(name)!.isFile() && name.endsWith('.md')),
        fingerprint: digest(JSON.stringify(names.map(name => {
          const { dev, ino, size, mtimeMs, ctimeMs } = entries.get(name)!;
          return directoryMove ? [name, dev, ino, size, mtimeMs, ctimeMs] : [name, dev, ino, size, mtimeMs];
        }))),
      };
    } finally { await parent.close(); }
  }

  private folderMoveSupport?: Promise<void>;

  async checkProjectFolderMove(root: string, to: string, source: Stats) {
    this.folderMoveSupport ??= renameHelper().then(code => {
      if (code !== 0) throw new VaultError('unsupported', 'Project folder moves require Linux no-replace rename support through system Python 3.');
    }, () => { throw new VaultError('unsupported', 'Project folder moves require Linux no-replace rename support through system Python 3.'); });
    await this.folderMoveSupport;
    const parent = await this.parent(root, to);
    try {
      if (source.dev !== (await parent.folder.stat()).dev)
        throw new VaultError('unsupported', 'The project folder and destination must share a filesystem.');
      await this.verifyParent(root, to, parent.folder);
      return await parent.folder.stat();
    } finally { await parent.close(); }
  }

  async moveProjectFolder(root: string, from: string, to: string, expected: Stats,
    check: () => Promise<void>, started: () => void, expectedParent?: Stats) {
    const source = await this.parent(root, from);
    try {
      const target = await this.parent(root, to);
      try {
        await check();
        await this.verifyParent(root, from, source.folder);
        await this.verifyParent(root, to, target.folder);
        if (expectedParent && !identity(expectedParent, await target.folder.stat())) throw new VaultError('conflict', 'The destination parent changed.');
        const current = await this.statEntry(source.path);
        if (!current?.isDirectory() || !same(current, expected) || await this.statEntry(target.path)) throw new VaultError('conflict');
        const names = [from.split('/').at(-1)!, to.split('/').at(-1)!];
        let code: number | null;
        try { code = await renameHelper(names, [source.folder.fd, target.folder.fd]); }
        catch { throw new VaultError('unsupported', 'The no-replace rename helper could not start.'); }
        if (code === 3) throw new VaultError('conflict', 'The destination project folder already exists.');
        if (code === 4) throw new VaultError('unsupported', 'The filesystem refused a no-replace rename.');
        if (code === 5) throw new VaultError('unavailable', 'The filesystem rejected the project folder rename.');
        started();
        if (code !== 0) throw new VaultError('uncertain');
        await source.folder.sync();
        await target.folder.sync();
        await this.verifyParent(root, from, source.folder);
        await this.verifyParent(root, to, target.folder);
        const moved = await this.statEntry(target.path);
        if (!moved?.isDirectory() || !identity(moved, expected) || await this.statEntry(source.path)) throw new VaultError('uncertain');
      } finally { await target.close(); }
    } finally { await source.close(); }
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
