// Linux-only file port. Call ONLY while the iCloud native worker owns its flock
// and same-generation service admission. This class is not a standalone lock.
import { constants } from 'node:fs';
import { open, mkdir, readdir, opendir, lstat, rename, link, unlink, rmdir, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const FILE_LIMITS = { bytes: 1024 * 1024, entries: 10000, operations: 512, recoveryBytes: 64 * 1024 * 1024, retentionMs: 30 * 86400000 } as const;
export type FileCategory = 'invalid_path' | 'unsupported' | 'unavailable' | 'conflict' | 'capacity' | 'cancelled' | 'uncertain' | 'operation_reused' | 'operation_expired' | 'busy';
export class FileError extends Error { constructor(readonly category: FileCategory) { super(category); this.name = 'FileError'; } }
// On the supported Linux host ':' is an ordinary filename character, not a
// drive/stream selector. Root containment comes from segments and no-follow fds.
export function validateFilePath(path: string) {
  if (typeof path !== 'string' || path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || Buffer.byteLength(p) > 255)) throw new FileError('invalid_path');
  return path;
}
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const validId = (id: string) => /^[a-zA-Z0-9-]{1,64}$/.test(id);
const validOperation = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const issuedAt = (id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const same = (a: any, b: any) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const identity = (a: any, b: any) => a.dev === b.dev && a.ino === b.ino;
const equivalent = (a: { hash: string; info: any } | null, b: { hash: string; info: any } | null) => a === null || b === null ? a === b : a.hash === b.hash && same(a.info, b.info);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
export type CommitInput = { operationId: string; mirrorId: string; path: string; kind: 'create' | 'replace'; expectedHash: string | null; bytes: Buffer };
export type FileReceipt = { operationId: string; mirrorId: string; path: string; at: string; outcome: 'saved_locally_pending_sync' | 'not_saved' | 'uncertain'; hash: string; previousHash: string | null };
type Journal = FileReceipt & { phase: 'preparing' | 'prepared' | 'finished'; requestDigest: string; inode: { dev: number; ino: number } | null; kind: 'create' | 'replace' };
type Options = { maxRecoveryBytes?: number; maxOperations?: number; clock?: () => number; fault?: (stage: string) => void | Promise<void> };
export class FileStore {
  private active = false;
  private reconciledRoots = new Map<string, string>();
  private dirty = new Set<string>();
  constructor(private root: string, private options: Options = {}) {}
  private now() { return this.options.clock?.() ?? Date.now(); }
  private async fault(stage: string) { await this.options.fault?.(stage); }
  private async secureRoot() {
    if (process.platform !== 'linux') throw new FileError('unavailable');
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new FileError('unavailable');
  }
  private async parent(root: string, path: string) {
    validateFilePath(path);
    const handles: FileHandle[] = [];
    try {
      handles.push(await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      for (const part of path.split('/').slice(0, -1)) handles.push(await open(join(fdPath(handles.at(-1)!.fd), part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      return { handles, folder: handles.at(-1)!, path: join(fdPath(handles.at(-1)!.fd), path.split('/').at(-1)!), close: async () => { await Promise.all(handles.map(h => h.close())); } };
    } catch { await Promise.all(handles.map(h => h.close().catch(() => {}))); throw new FileError('invalid_path'); }
  }
  private async readAt(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat(); if (!before.isFile()) throw new FileError('invalid_path');
      if (before.size > FILE_LIMITS.bytes) throw new FileError('unsupported');
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await file.stat(); const named = await lstat(path);
      if (count !== before.size || !same(before, after) || !same(before, named)) throw new FileError('conflict');
      const content = bytes.subarray(0, count);
      return { bytes: content, hash: digest(content), info: after };
    } finally { await file.close(); }
  }
  // Exact identity is internal collision evidence, never a consumer CAS hash.
  async observe(root: string, path: string) {
    let parent: Awaited<ReturnType<FileStore['parent']>> | undefined;
    try {
      parent = await this.parent(root, path);
      let result: Awaited<ReturnType<FileStore['readAt']>> | null;
      try { result = await this.readAt(parent.path); }
      catch (e) { if (!missing(e)) throw e; result = null; }
      const fresh = await this.parent(root, path);
      try {
        if (!identity(await parent.folder.stat(), await fresh.folder.stat())) throw new FileError('conflict');
        if (result && !same(result.info, await lstat(fresh.path))) throw new FileError('conflict');
        if (!result) {
          try { await lstat(fresh.path); throw new FileError('conflict'); }
          catch (e) { if (!missing(e)) throw e; }
        }
      } finally { await fresh.close(); }
      return result ? { bytes: result.bytes, hash: result.hash, info: { dev: result.info.dev, ino: result.info.ino, size: result.info.size, mtimeMs: result.info.mtimeMs, ctimeMs: result.info.ctimeMs } } : null;
    } catch (e) { throw e instanceof FileError ? e : new FileError('unavailable'); }
    finally { await parent?.close(); }
  }
  async read(root: string, path: string) {
    const result = await this.observe(root, path);
    if (!result) throw new FileError('unavailable');
    return { bytes: result.bytes, hash: result.hash, readAt: new Date(this.now()).toISOString(), complete: true as const };
  }
  // Only the generation's command/application arbiter may call this. Stage is
  // an independent fsynced inode, never the sole authoritative overlay blob.
  async publishStage(root: string, path: string, stage: string, expected: { hash: string; info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } } | null) {
    const parent = await this.parent(root, path);
    try {
      const current = await this.observe(root, path);
      if (!equivalent(current, expected)) throw new FileError('conflict');
      const staged = await lstat(stage);
      if (!staged.isFile() || staged.isSymbolicLink() || staged.dev !== (await parent.folder.stat()).dev) throw new FileError('unavailable');
      const fresh = await this.parent(root, path);
      try {
        if (!identity(await parent.folder.stat(), await fresh.folder.stat()) || !equivalent(await this.observe(root, path), expected)) throw new FileError('conflict');
        await this.fault('before_mirror_publish');
        if (expected) await rename(stage, fresh.path);
        else await link(stage, fresh.path); // exclusive creation; stage can be removed after directory fsync
        await this.fault('after_mirror_rename');
        await this.fault('before_destination_dirsync');
        await fresh.folder.sync();
        await this.fault('after_destination_dirsync');
      } finally { await fresh.close(); }
      const result = await this.observe(root, path);
      if (!result || !identity(result.info, staged)) throw new FileError('uncertain');
      return result;
    } catch (e) { throw e instanceof FileError ? e : new FileError((e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'capacity' : 'uncertain'); }
    finally { await parent.close(); }
  }
  async moveExclusive(root: string, path: string, destination: string, expected: NonNullable<Awaited<ReturnType<FileStore['observe']>>>, signal?: AbortSignal, admission: () => void = () => {}) {
    const source = await this.parent(root, path);
    let target: Awaited<ReturnType<FileStore['parent']>> | undefined;
    try {
      target = await this.parent(root, destination);
      if (!equivalent(await this.observe(root, path), expected)) throw new FileError('conflict');
      if (signal?.aborted) throw new FileError('cancelled');
      await this.fault('before_move_link');
      admission();
      await link(source.path, target.path); // EEXIST is never replaced
      await this.fault('after_move_link');
      await target.folder.sync();
      await this.fault('after_move_destination_sync');
      const a = await this.observe(root, path), b = await this.observe(root, destination);
      // link changes ctime, so verify content and identity rather than old ctime.
      if (!a || !b || a.hash !== expected.hash || b.hash !== expected.hash || !identity(a.info, expected.info) || !identity(b.info, expected.info)) throw new FileError('uncertain');
      if (signal?.aborted) throw new FileError('uncertain');
      admission();
      await unlink(source.path);
      await this.fault('after_move_unlink');
      await source.folder.sync();
      await this.fault('after_move_source_sync');
    } finally { await source.close(); await target?.close(); }
  }
  async syncMoveDirectories(root: string, path: string, destination: string) {
    for (const name of [path, destination]) { const p = await this.parent(root, name); try { await p.folder.sync(); } finally { await p.close(); } }
  }
  async provePublishedStage(root: string, path: string, expected: { hash: string; info: { dev: number; ino: number } }) {
    const parent = await this.parent(root, path);
    try {
      const before = await this.observe(root, path);
      if (!before || before.hash !== expected.hash || !identity(before.info, expected.info)) throw new FileError('uncertain');
      // If a crash occurred after rename/link but before directory fsync, the
      // surviving destination inode is evidence, not yet a durable checkpoint.
      await parent.folder.sync();
      const after = await this.observe(root, path);
      if (!after || !equivalent(before, after)) throw new FileError('uncertain');
      return after;
    } catch (e) { throw e instanceof FileError ? e : new FileError('uncertain'); }
    finally { await parent.close(); }
  }
  // Bisync with --conflict-resolve none and --conflict-loser num appends the
  // configured suffix and a number. Inspect exact siblings under the anchored
  // parent; an unbounded/ambiguous set is uncertainty, never incoming absence.
  async conflictCopies(root: string, path: string) {
    const parent = await this.parent(root, path);
    try {
      const name = path.split('/').at(-1)!;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`^${escaped}\\.(icloud-conflict|bb-conflict)([1-9][0-9]*)$`);
      const found: Array<{ side: 'icloud' | 'bb'; number: number; observation: NonNullable<Awaited<ReturnType<FileStore['readAt']>>> }> = [];
      const folder = await opendir(fdPath(parent.folder.fd), { bufferSize: 32 });
      let count = 0;
      for await (const entry of folder) {
        if (++count > FILE_LIMITS.entries) throw new FileError('uncertain');
        const match = pattern.exec(entry.name); if (!match) continue;
        if (!entry.isFile() || found.length >= 32) throw new FileError('uncertain');
        const number = Number(match[2]); if (!Number.isSafeInteger(number)) throw new FileError('uncertain');
        const observed = await this.readAt(join(fdPath(parent.folder.fd), entry.name));
        found.push({ side: match[1] === 'icloud-conflict' ? 'icloud' : 'bb', number, observation: observed });
      }
      const fresh = await this.parent(root, path);
      try { if (!identity(await parent.folder.stat(), await fresh.folder.stat())) throw new FileError('uncertain'); }
      finally { await fresh.close(); }
      return found;
    } catch (e) { throw e instanceof FileError ? e : new FileError('uncertain'); }
    finally { await parent.close(); }
  }
  private async writeDurable(path: string, data: string | Buffer) {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  }
  private async syncDir(path: string) { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
  private async journal(dir: string, record: Journal) {
    const next = join(dir, 'receipt-next'); await unlink(next).catch(e => { if (!missing(e)) throw e; });
    await this.writeDurable(next, JSON.stringify(record)); await rename(next, join(dir, 'receipt')); await this.syncDir(dir);
  }
  private receipt(record: Journal): FileReceipt { const { operationId, mirrorId, path, at, outcome, hash, previousHash } = record; return { operationId, mirrorId, path, at, outcome, hash, previousHash }; }
  private async load(dir: string): Promise<Journal> {
    const info = await lstat(join(dir, 'receipt')); if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new FileError('uncertain');
    const file = await open(join(dir, 'receipt'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let record: Journal;
    try { record = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    if (!validOperation(record.operationId) || !validId(record.mirrorId) || !['preparing', 'prepared', 'finished'].includes(record.phase) || !['create', 'replace'].includes(record.kind) || !['not_saved', 'uncertain', 'saved_locally_pending_sync'].includes(record.outcome) || !/^[a-f0-9]{64}$/.test(record.hash) || !/^[a-f0-9]{64}$/.test(record.requestDigest) || !Number.isFinite(Date.parse(record.at))) throw new FileError('uncertain');
    validateFilePath(record.path); return record;
  }
  private async discardStage(dir: string) {
    try { await unlink(join(dir, 'stage')); await this.syncDir(dir); }
    catch (e) { if (!missing(e)) throw e; }
  }
  private async directories() {
    await this.secureRoot(); const entries = await readdir(this.root, { withFileTypes: true });
    if (entries.length > (this.options.maxOperations ?? FILE_LIMITS.operations)) throw new FileError('capacity');
    const dirs: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !validOperation(entry.name)) throw new FileError('uncertain');
      const dir = join(this.root, entry.name);
      try { await lstat(join(dir, 'receipt')); dirs.push(dir); }
      catch (e) {
        if (!missing(e)) throw e;
        // The first durable receipt precedes all file bytes and the commit.
        // Only an empty directory or its incomplete journal is a safe orphan.
        const orphan = await readdir(dir);
        if (orphan.some(name => name !== 'receipt-next')) throw new FileError('uncertain');
        await unlink(join(dir, 'receipt-next')).catch(error => { if (!missing(error)) throw error; });
        await rmdir(dir); await this.syncDir(this.root);
      }
    }
    return dirs;
  }
  private async capacity(previousBytes: number, stagedBytes: number) {
    const dirs = await this.directories(); let retained = 0; let bytes = 0;
    for (const dir of dirs) {
      const record = await this.load(dir);
      if (record.phase === 'finished' && record.outcome !== 'uncertain' && this.now() - Date.parse(record.at) > FILE_LIMITS.retentionMs && this.now() - issuedAt(record.operationId) > FILE_LIMITS.retentionMs) {
        // Timestamp-bearing IDs fence expired transport retries even after
        // bounded receipt pruning. Uncertain identities are never pruned.
        await rm(dir, { recursive: true }); await this.syncDir(this.root); continue;
      }
      retained++;
      if (record.phase === 'finished') await this.discardStage(dir);
      else {
        try { const stage = await lstat(join(dir, 'stage')); if (!stage.isFile() || stage.isSymbolicLink()) throw new FileError('uncertain'); bytes += stage.size; }
        catch (e) { if (!missing(e)) throw e; }
      }
      let info;
      try { info = await lstat(join(dir, 'previous')); } catch (e) { if (missing(e)) continue; throw e; }
      if (record.phase === 'finished' && record.outcome !== 'uncertain' && this.now() - Date.parse(record.at) > FILE_LIMITS.retentionMs) { await unlink(join(dir, 'previous')); await this.syncDir(dir); }
      else { if (!info.isFile() || info.isSymbolicLink()) throw new FileError('uncertain'); bytes += info.size; }
    }
    if (retained >= (this.options.maxOperations ?? FILE_LIMITS.operations)) throw new FileError('capacity');
    if (bytes + previousBytes + stagedBytes > (this.options.maxRecoveryBytes ?? FILE_LIMITS.recoveryBytes)) throw new FileError('capacity');
  }
  private async reconcileRecord(dir: string, root: string, record: Journal) {
    if (record.phase === 'finished') { await this.discardStage(dir); return record; }
    if (record.phase === 'preparing') { record.outcome = 'not_saved'; record.phase = 'finished'; await this.journal(dir, record); await this.discardStage(dir); return record; }
    let stageExists = false;
    try { const stage = await lstat(join(dir, 'stage')); stageExists = identity(stage, record.inode); } catch (e) { if (!missing(e)) throw e; }
    let current: Awaited<ReturnType<FileStore['readAt']>> | undefined;
    const parent = await this.parent(root, record.path);
    try { current = await this.readAt(parent.path).catch(() => undefined); } finally { await parent.close(); }
    // A durable staged inode now named at the destination proves this operation,
    // unlike matching text or a later sync timestamp. Never guess if it changed.
    if (current && record.inode && identity(current.info, record.inode) && current.hash === record.hash) record.outcome = 'saved_locally_pending_sync';
    else if (stageExists && record.kind === 'replace' && current?.hash === record.previousHash) record.outcome = 'not_saved';
    else record.outcome = 'uncertain';
    record.phase = 'finished'; await this.journal(dir, record); await this.discardStage(dir); return record;
  }
  async reconcile(mirrorId: string, root: string) {
    if (this.reconciledRoots.get(mirrorId) === root && !this.dirty.has(mirrorId)) return;
    try {
      for (const dir of await this.directories()) { const record = await this.load(dir); if (record.mirrorId === mirrorId) await this.reconcileRecord(dir, root, record); }
      if (this.reconciledRoots.size >= 64) this.reconciledRoots.delete(this.reconciledRoots.keys().next().value!);
      this.reconciledRoots.set(mirrorId, root); this.dirty.delete(mirrorId);
    } catch (e) { throw e instanceof FileError ? e : new FileError('uncertain'); }
  }
  // Migration-only enumeration under the real worker owner. The old digest
  // encoded JSON transport input; its validated semantic fields are indexed
  // separately by v2 before admitting any new publication.
  async legacyRecords(mirrorId: string, root: string) {
    await this.reconcile(mirrorId, root);
    const records: Array<{ receipt: FileReceipt; kind: 'create' | 'replace'; requestDigest: string; uncertain: boolean; previousBytes: number }> = [];
    for (const dir of await this.directories()) {
      const record = await this.load(dir);
      if (record.mirrorId === mirrorId) {
        if (record.phase !== 'finished') throw new FileError('uncertain');
        let previousBytes = 0, previousFound = false;
        try {
          const prior = await lstat(join(dir, 'previous'));
          if (!prior.isFile() || prior.isSymbolicLink() || prior.uid !== process.getuid?.() || prior.size > FILE_LIMITS.bytes || prior.size < 0) throw new FileError('uncertain');
          previousBytes = prior.size; previousFound = true;
          const observed = await this.readAt(join(dir, 'previous'));
          if (!record.previousHash || observed.hash !== record.previousHash) throw new FileError('uncertain');
        } catch (error) { if (!missing(error)) throw new FileError('uncertain'); }
        if (record.previousHash && record.outcome === 'saved_locally_pending_sync' && !previousFound) throw new FileError('uncertain');
        records.push({ receipt: this.receipt(record), kind: record.kind, requestDigest: record.requestDigest, uncertain: record.outcome === 'uncertain', previousBytes });
      }
    }
    return records;
  }
  async receipts(query: { mirrorId: string; operationId?: string; path?: string; since?: string; limit: number }) {
    try {
      if (!validId(query.mirrorId) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || (query.since && !Number.isFinite(Date.parse(query.since)))) throw new FileError('invalid_path');
      if (query.path) validateFilePath(query.path);
      if (query.operationId && !validOperation(query.operationId)) throw new FileError('invalid_path');
      const records: FileReceipt[] = [];
      for (const dir of await this.directories()) { const record = await this.load(dir); if (record.mirrorId === query.mirrorId && (!query.operationId || record.operationId === query.operationId) && (!query.path || record.path === query.path) && (!query.since || record.at >= query.since)) records.push(this.receipt(record)); }
      return records.sort((a, b) => b.at.localeCompare(a.at) || a.operationId.localeCompare(b.operationId)).slice(0, query.limit);
    } catch (e) { throw e instanceof FileError ? e : new FileError('unavailable'); }
  }
  async commit(root: string, input: CommitInput, signal: AbortSignal) {
    if (this.active) throw new FileError('busy'); this.active = true;
    let parent: Awaited<ReturnType<FileStore['parent']>> | undefined; let record: Journal | undefined; let dir: string | undefined; let committed = false;
    try {
      validateFilePath(input.path);
      if (!validOperation(input.operationId) || !validId(input.mirrorId) || !Buffer.isBuffer(input.bytes) || input.bytes.length > FILE_LIMITS.bytes || !['create', 'replace'].includes(input.kind) || (input.kind === 'create' ? input.expectedHash !== null : !/^[a-f0-9]{64}$/.test(input.expectedHash ?? ''))) throw new FileError('invalid_path');
      if (signal.aborted) throw new FileError('cancelled');
      await this.secureRoot(); dir = join(this.root, input.operationId);
      const requestDigest = digest(JSON.stringify({ ...input, bytes: digest(input.bytes) }));
      try {
        const existing = await this.load(dir);
        if (existing.requestDigest !== requestDigest) throw new FileError('operation_reused');
        const reconciled = await this.reconcileRecord(dir, root, existing);
        return this.receipt(reconciled);
      } catch (e) { if (!missing(e)) throw e; }
      if (this.now() - issuedAt(input.operationId) > FILE_LIMITS.retentionMs || issuedAt(input.operationId) > this.now() + 5 * 60000) throw new FileError('operation_expired');
      this.dirty.add(input.mirrorId);
      parent = await this.parent(root, input.path);
      let previous: Awaited<ReturnType<FileStore['readAt']>> | undefined;
      try { previous = await this.readAt(parent.path); } catch (e) { if (!missing(e)) throw e; }
      if (input.kind === 'create' ? !!previous : !previous || previous.hash !== input.expectedHash) throw new FileError('conflict');
      await this.capacity(previous ? previous.bytes.length : 0, input.bytes.length);
      await mkdir(dir, { mode: 0o700 }); await this.syncDir(this.root);
      record = { operationId: input.operationId, mirrorId: input.mirrorId, path: input.path, at: new Date(this.now()).toISOString(), outcome: 'uncertain', hash: digest(input.bytes), previousHash: previous?.hash ?? null, phase: 'preparing', requestDigest, inode: null, kind: input.kind };
      await this.journal(dir, record);
      if (previous) { await this.fault('previous'); await this.writeDurable(join(dir, 'previous'), previous.bytes); }
      await this.fault('stage'); await this.writeDurable(join(dir, 'stage'), input.bytes);
      const staged = await lstat(join(dir, 'stage')); const destination = await parent.folder.stat();
      if (staged.dev !== destination.dev) throw new FileError('unavailable');
      record.inode = { dev: staged.dev, ino: staged.ino }; record.phase = 'prepared';
      await this.fault('journal'); await this.journal(dir, record);
      await this.fault('before_commit');
      if (signal.aborted) throw new FileError('cancelled');
      const fresh = await this.parent(root, input.path);
      try {
        if (!identity(await parent.folder.stat(), await fresh.folder.stat())) throw new FileError('conflict');
        let latest: typeof previous;
        try { latest = await this.readAt(fresh.path); } catch (e) { if (!missing(e)) throw e; }
        if (input.kind === 'create' ? !!latest : !latest || !previous || !same(latest.info, previous.info) || latest.hash !== previous.hash) throw new FileError('conflict');
        // Native iCloud writers cannot run under our caller's worker admission.
        // Unrelated trusted writers are not an OS-wide transaction guarantee.
        if (input.kind === 'create') await link(join(dir, 'stage'), fresh.path);
        else await rename(join(dir, 'stage'), fresh.path);
        committed = true; await fresh.folder.sync();
      } finally { await fresh.close(); }
      await this.syncDir(dir); await this.fault('after_commit');
      record.outcome = 'saved_locally_pending_sync'; record.phase = 'finished'; await this.journal(dir, record);
      await unlink(join(dir, 'stage')).catch(e => { if (!missing(e)) throw e; }); await this.syncDir(dir);
      if (this.reconciledRoots.get(input.mirrorId) === root) this.dirty.delete(input.mirrorId);
      return this.receipt(record);
    } catch (e) {
      if (committed) throw new FileError('uncertain');
      if (record && dir) { record.outcome = 'not_saved'; record.phase = 'finished'; await this.journal(dir, record).then(() => this.discardStage(dir!)).catch(() => {}); }
      throw e instanceof FileError ? e : new FileError((e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'capacity' : 'unavailable');
    } finally { await parent?.close(); this.active = false; }
  }
}
