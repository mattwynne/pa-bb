import type Database from 'better-sqlite3';
import { constants, lstatSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { CloudError, evidence } from '../core/ports.ts';
import type { Diagnose, Mirror, State } from '../core/ports.ts';
import { NoteError, NoteStore } from './note-store.ts';
import type { CommitInput } from './note-store.ts';
import { NoteApplicationError, NoteOverlay } from './note-overlay.ts';
import type { Resolution } from './note-overlay.ts';
import { RcloneProcess } from './rclone-process.ts';
import type { ListingCheckers } from './rclone-process.ts';
import { selectedRemote } from './rclone-cloud-provider.ts';
import { NoteSearch } from './note-search.ts';
import { NoteMoves, type MoveInput } from './note-move.ts';
import type { SearchRequest } from './note-search.ts';
import { obsidianStageExclude, type MirrorWakeups } from './mirror-wakeups.ts';

const MAX_SAFE_BINDING_ID = BigInt(Number.MAX_SAFE_INTEGER);

// The flock, not a JS timer/lease, owns the generation. All native commands,
// config calls and mirror mutations enter the same turn. Directory-only cloud
// listings may share an active native command; they never access mirror files.
// Overlay publications
// have a separate admission fence and can proceed during this generation's child.
export class NoteRuntime {
  readonly moves: NoteMoves;
  private moving = false;
  readonly overlay: NoteOverlay;
  readonly search: NoteSearch;
  private readonly context = new AsyncLocalStorage<{ revision: number; mirrorId: string }>();
  private queue: Promise<void> = Promise.resolve();
  private turnsPending = 0;
  private nativeRunning = false;
  private nativeMirror: string | undefined;
  private directoryReads = new Set<Promise<unknown>>();
  private entered = new Set<Promise<unknown>>();
  private closed = false;
  private stopped: Promise<void> | null = null;
  private ready = false;
  private wakeScheduled = false;
  private maintenanceScheduled = false;
  private maintenance: Promise<void> | null = null;
  private storageBlocked = false;
  private revision: number | null = null;
  private members = new Set<string>();
  private blocked = new Set<string>();
  private nativeBlocked = new Map<string, 'uncertain' | 'native_failure'>();
  private lastMirror: string | null = null;
  private accountHash: string | null = null;
  private direct = new Set<string>();
  private legacyWrites = new Map<string, number>();
  constructor(readonly root: string, private db: Database.Database, readonly worker: RcloneProcess,
    private legacy: NoteStore, private state: () => State, private clock = () => Date.now(),
    private diagnose: Diagnose = () => {}, private mirrorWakeups?: MirrorWakeups) {
    this.moves = new NoteMoves(db, legacy, id => this.guard(id));
    this.overlay = new NoteOverlay(join(root, 'overlay'), db, legacy, clock, undefined, id => this.guard(id));
    this.search = new NoteSearch(legacy, { paths: id => this.overlay.searchPaths(id), reader: (id, path) => this.overlay.searchReader(this.localPath(this.mirror(id)!), id, path) });
  }
  async start() {
    // No overlay migration or durable admission before actual inherited-flock ownership.
    try { await this.worker.ensure(); }
    catch (error) {
      const failure = error instanceof CloudError && error.category === 'busy' ? 'busy' : 'unavailable';
      this.diagnose('note_owner', failure);
      throw new CloudError(failure);
    }
    try {
      this.db.pragma('synchronous = FULL');
      if (this.db.pragma('synchronous', { simple: true }) !== 2) throw new NoteError('unavailable');
      this.db.exec(`CREATE TABLE IF NOT EXISTS icloud_note_admission (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, members TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS icloud_note_bindings (mirror_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, root_dev INTEGER NOT NULL, root_ino INTEGER NOT NULL, baseline_dev INTEGER NOT NULL, baseline_ino INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS icloud_note_account (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS icloud_note_direct (mirror_id TEXT PRIMARY KEY);`);
      this.direct = new Set((this.db.prepare('SELECT mirror_id FROM icloud_note_direct').all() as { mirror_id: string }[]).map(row => row.mirror_id));
      if (this.state().mirrors.some(m => m.initialized)) await this.bindAccount();
      this.moves.start();
      await this.overlay.start();
      const config = this.db.prepare('SELECT revision, members FROM icloud_note_admission WHERE id=1').get() as { revision: number; members: string } | undefined;
      if (config) {
        let members: unknown;
        try { members = JSON.parse(config.members); } catch { throw new NoteError('uncertain'); }
        if (!Number.isSafeInteger(config.revision) || config.revision < 0 || !Array.isArray(members) || members.length > 20 || members.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) || new Set(members).size !== members.length) throw new NoteError('uncertain');
        this.revision = config.revision; this.members = new Set(members);
      }
      const watched = new Map<string, string>();
      for (const mirror of this.state().mirrors.filter(m => m.initialized && m.phase !== 'retained')) {
        try {
          const directory = await this.local(mirror);
          await this.overlay.indexLegacy(mirror.id, directory);
          if (this.direct.has(mirror.id)) watched.set(mirror.id, directory);
        }
        catch (error) { this.blocked.add(mirror.id); if (error instanceof NoteError && error.category === 'uncertain') throw error; }
      }
      // A disabled interrupted mirror is an operator-held recovery, not an
      // invitation to apply queued edits merely because the plugin restarted.
      for (const mirror of this.state().mirrors) if (!mirror.enabled && mirror.failure === 'interrupted' && this.overlay.pending().some(p => p.mirrorId === mirror.id)) this.nativeBlocked.set(mirror.id, 'uncertain');
      this.ready = true;
      for (const [id, directory] of watched) this.mirrorWakeups?.observe(id, directory);
      this.wake();
      this.scheduleMaintenance();
    } catch (error) {
      const failure = error instanceof NoteError ? error.category : error instanceof CloudError ? error.category : 'unavailable';
      this.diagnose('note_start', failure);
      await this.worker.stop();
      throw new CloudError(failure === 'uncertain' ? 'recovery_required' : failure === 'source_changed' ? 'source_changed' : 'unavailable');
    }
  }
  private async bindAccount() {
    // RC config/get is local encrypted configuration, not an Apple listing.
    // Only a digest of the account binding is persisted in the scoped index.
    let config: Record<string, unknown>;
    try { config = await this.worker.call('config/get', { name: 'icloud' }); }
    catch { throw new CloudError('source_changed'); }
    const type = config.type;
    const key = type === 'iclouddrive' ? config.apple_id : type === 'alias' ? config.remote : null;
    if (typeof key !== 'string' || !key || typeof type !== 'string') throw new CloudError('source_changed');
    const hash = createHash('sha256').update(JSON.stringify([type, type === 'iclouddrive' ? key.toLowerCase() : key])).digest('hex');
    const bound = this.db.prepare('SELECT fingerprint FROM icloud_note_account WHERE id=1').get() as { fingerprint: string } | undefined;
    if (bound && bound.fingerprint !== hash) throw new CloudError('source_changed');
    if (!bound) this.db.prepare('INSERT INTO icloud_note_account(id, fingerprint) VALUES (1, ?)').run(hash);
    this.accountHash = hash;
  }
  private mirror(id: string) { return this.state().mirrors.find(m => m.id === id); }
  private localPath(mirror: Mirror) { return join(this.root, 'mirrors', mirror.id); }
  private async local(mirror: Mirror, { interrupted = false, requireBinding = false } = {}) {
    if (!mirror.initialized || mirror.phase === 'retained' || (interrupted ? mirror.blocker !== 'rebuild' : ['rebuild', 'initialization', 'configuration'].includes(mirror.blocker ?? ''))) throw new CloudError('source_changed');
    const bound = this.db.prepare('SELECT * FROM icloud_note_bindings WHERE mirror_id=?').get(mirror.id) as { folder_id: string; root_dev: number; root_ino: number; baseline_dev: number; baseline_ino: number } | undefined;
    if (bound ? bound.folder_id !== mirror.folder.id : interrupted || requireBinding) throw new CloudError('source_changed');
    const root = this.localPath(mirror), baseline = join(this.root, 'baselines', mirror.id);
    const [rootInfo, baselineInfo] = await Promise.all([lstat(root).catch(() => null), lstat(baseline).catch(() => null)]);
    if ([rootInfo, baselineInfo].some(info => !info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())) throw new CloudError('source_changed');
    if (bound && (bound.root_dev !== rootInfo!.dev || bound.root_ino !== rootInfo!.ino || bound.baseline_dev !== baselineInfo!.dev || bound.baseline_ino !== baselineInfo!.ino)) throw new CloudError('source_changed');
    let marker;
    try {
      marker = await open(join(baseline, 'initialized'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await marker.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size !== 1 || await marker.readFile('utf8') !== '1') throw new Error();
    } catch { throw new CloudError('source_changed'); }
    finally { await marker?.close(); }
    if (!bound) this.db.prepare('INSERT INTO icloud_note_bindings(mirror_id, folder_id, root_dev, root_ino, baseline_dev, baseline_ino) VALUES (?, ?, ?, ?, ?, ?)').run(mirror.id, mirror.folder.id, rootInfo!.dev, rootInfo!.ino, baselineInfo!.dev, baselineInfo!.ino);
    return root;
  }
  // Initial resync creates a previously uninitialized mirror. Only after its
  // marker is written may a native-idle turn bind and index it for local RPCs.
  async registerMirror(mirror: Mirror) {
    await this.turn(async () => {
      // Config reads cannot enter withFiles. Keep account verification inside
      // this native-idle turn, before acquiring filesystem exclusion, so no
      // queued config change or native command can interleave with binding.
      await this.bindAccount();
      await this.worker.withFiles(async () => {
        const initialized = { ...mirror, initialized: true };
        await this.local(initialized);
        await this.overlay.indexLegacy(mirror.id, this.localPath(initialized));
        this.blocked.delete(mirror.id);
      });
    });
  }
  // One owned turn covers validation, the ordinary native baseline check and
  // final registration. The service keeps its durable failed/disabled record
  // throughout; only this validated local clone bypasses initialization.
  completeInitialRegistration(mirror: Mirror, args: string[], capture?: boolean, report?: Parameters<RcloneProcess['run']>[2]) {
    return this.turn(async () => {
      const current = this.mirror(mirror.id);
      if (!this.ready || this.storageBlocked || !current || current.initialized || current.enabled || current.phase !== 'failed' || current.failure !== 'source_changed' || current.blocker !== 'initialization' || !current.initialCompletionAttempted || current.folder.id !== mirror.folder.id || args[0] !== 'bisync' || args[2] !== this.localPath(current) || args.includes('--resync') || args.includes('--force') || args[args.indexOf('--workdir') + 1] !== join(this.root, 'baselines', current.id)) throw new CloudError('recovery_required');
      // A marker alone cannot prove the original account. This incident's
      // existing account binding must already exist; never adopt a new one.
      if (!this.db.prepare('SELECT fingerprint FROM icloud_note_account WHERE id=1').get()) throw new CloudError('source_changed');
      if (this.nativeBlocked.has(current.id) || this.overlay.hasUnresolvedJournals(current.id) || this.overlay.pending().some(item => item.mirrorId === current.id) || this.overlay.beforeRun(current.id).length) throw new CloudError('recovery_required');
      const initialized = { ...current, initialized: true, blocker: null };
      const validate = async () => {
        await this.bindAccount();
        await this.worker.withFiles(async () => {
          // Require private directories as well as the existing exact marker,
          // ownership, folder and inode checks. Never create/reset a baseline.
          for (const path of [this.localPath(current), join(this.root, 'baselines', current.id)]) {
            const info = await lstat(path).catch(() => null);
            if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new CloudError('source_changed');
          }
          await this.local(initialized);
        });
      };
      await validate();
      await this.nativeCommand(args, capture, report);
      await validate();
      await this.worker.withFiles(async () => {
        await this.overlay.indexLegacy(current.id, this.localPath(current));
        this.blocked.delete(current.id);
      });
      return '';
    });
  }
  async availability(id: string, { requireBinding = false } = {}): Promise<{ available: boolean; reason: 'ownership' | 'recovery_required' | 'source_changed' | null }> {
    if (!this.ready || this.closed) return { available: false, reason: 'ownership' };
    if (this.storageBlocked || this.blocked.has(id) || this.nativeBlocked.get(id) === 'uncertain' || this.mirror(id)?.blocker === 'rebuild') return { available: false, reason: 'recovery_required' };
    const mirror = this.mirror(id);
    if (!mirror) return { available: false, reason: 'source_changed' };
    try { await this.local(mirror, { requireBinding }); return { available: true, reason: null }; }
    catch { return { available: false, reason: 'source_changed' }; }
  }
  configure(revision: number, mirrorIds: string[]) {
    if (this.storageBlocked) throw new CloudError('recovery_required');
    if (!this.ready || this.closed) throw new CloudError('unavailable');
    if (!Number.isSafeInteger(revision) || revision < 0 || mirrorIds.length > 20 || mirrorIds.some(id => !/^[a-zA-Z0-9-]{1,64}$/.test(id))) throw new CloudError('invalid_selection');
    const ids = [...new Set(mirrorIds)].sort();
    this.db.transaction(() => {
      if (this.revision !== null && (revision < this.revision || (revision === this.revision && JSON.stringify(ids) !== JSON.stringify([...this.members].sort())))) throw new CloudError('invalid_selection');
      this.db.prepare('INSERT INTO icloud_note_admission(id, revision, members) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, members=excluded.members').run(revision, JSON.stringify(ids));
    })();
    // A failed SQLite commit must not advance the in-memory admission epoch.
    this.revision = revision; this.members = new Set(ids); this.search.invalidate(revision);
    return { revision };
  }
  private guard(id: string, exactIdentity = false) {
    const active = this.context.getStore();
    if (this.storageBlocked || this.blocked.has(id) || this.nativeBlocked.get(id) === 'uncertain' || ['rebuild', 'initialization', 'configuration'].includes(this.mirror(id)?.blocker ?? '')) throw new CloudError('recovery_required');
    if (!this.ready || this.closed || !active || active.mirrorId !== id || active.revision !== this.revision || !this.members.has(id)) throw new CloudError('invalid_selection');
    const mirror = this.mirror(id);
    const binding = this.db.prepare('SELECT * FROM icloud_note_bindings WHERE mirror_id=?');
    const bound = (exactIdentity ? binding.safeIntegers() : binding).get(id) as { folder_id: string; root_dev: number | bigint; root_ino: number | bigint; baseline_dev: number | bigint; baseline_ino: number | bigint } | undefined;
    if (!mirror || !bound || bound.folder_id !== mirror.folder.id || mirror.phase === 'retained') throw new CloudError('source_changed');
    // The existing binding was recorded from Number stats. An unsafe stored
    // value may already be rounded, so even an exact match to today's stat
    // cannot prove provenance. Reject it and any non-INTEGER SQLite value.
    if (exactIdentity && [bound.root_dev, bound.root_ino, bound.baseline_dev, bound.baseline_ino].some(value =>
      typeof value !== 'bigint' || value < 0n || value > MAX_SAFE_BINDING_ID)) throw new CloudError('source_changed');
    try {
      const stat = (path: string) => exactIdentity ? lstatSync(path, { bigint: true }) : lstatSync(path);
      const root = stat(this.localPath(mirror)), baseline = stat(join(this.root, 'baselines', id));
      const marker = openSync(join(this.root, 'baselines', id, 'initialized'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let valid = false;
      try {
        const info = fstatSync(marker);
        valid = info.isFile() && info.size === 1 && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && readFileSync(marker, 'utf8') === '1';
      } finally { closeSync(marker); }
      if (!valid || !root.isDirectory() || !baseline.isDirectory() || root.isSymbolicLink() || baseline.isSymbolicLink() || root.dev !== bound.root_dev || root.ino !== bound.root_ino || baseline.dev !== bound.baseline_dev || baseline.ino !== bound.baseline_ino) throw new Error();
    } catch { throw new CloudError('source_changed'); }
    return bound;
  }
  async access<T>(id: string, revision: number, action: (root: string) => Promise<T>, { requireBinding = false } = {}): Promise<T> {
    if (this.storageBlocked) throw new CloudError('recovery_required');
    if (!this.ready || this.closed || this.revision !== revision || !this.members.has(id)) throw new CloudError('invalid_selection');
    if (this.moving) throw new NoteError('busy');
    if (this.moves.blocked(id)) throw new NoteError('uncertain');
    const availability = await this.availability(id, { requireBinding });
    if (!availability.available) throw new CloudError('source_changed');
    this.guardWithin(id, revision);
    if (this.moving) throw new NoteError('busy');
    const task = this.context.run({ revision, mirrorId: id }, () => action(this.localPath(this.mirror(id)!)));
    this.entered.add(task);
    try { return await task; } finally { this.entered.delete(task); }
  }
  private guardWithin(id: string, revision: number) {
    if (this.blocked.has(id) || this.nativeBlocked.get(id) === 'uncertain' || this.mirror(id)?.blocker === 'rebuild') throw new CloudError('recovery_required');
    if (this.closed || this.revision !== revision || !this.members.has(id)) throw new CloudError('invalid_selection');
  }
  filesystemStatus(id: string, available: boolean) {
    if (!available || this.moves.blocked(id)) return 'unavailable' as const;
    return this.overlay.filesystemGate(id);
  }
  async mirrorDirectory(id: string, revision: number) {
    return this.handoffDirectory(id, revision, directory => {
      this.guard(id);
      return { directory };
    });
  }
  async mirrorDirectoryGrant(id: string, revision: number) {
    return this.handoffDirectory(id, revision, directory => {
      const { root_dev, root_ino } = this.guard(id, true);
      return { directory, rootDev: root_dev.toString(), rootIno: root_ino.toString() };
    }, { requireBinding: true });
  }
  private async handoffDirectory<T>(id: string, revision: number, authorize: (directory: string) => T, options?: { requireBinding: boolean }) {
    return this.access(id, revision, async directory => {
      // An entered move may have finished uncertain while availability awaited.
      if (this.moves.blocked(id)) throw new NoteError('uncertain');
      const authorized = authorize(directory);
      // No await separates the checks and durable fence. A legacy writer
      // either entered first or sees the fence.
      if (this.overlay.filesystemGate(id) !== 'ready') throw new NoteError('conflict');
      if (!this.direct.has(id)) {
        // A transfer already in progress may lack the staging-file exclusion.
        if (this.nativeRunning || this.legacyWrites.has(id)) throw new NoteError('busy');
        this.db.prepare('INSERT INTO icloud_note_direct(mirror_id) VALUES (?)').run(id);
        this.direct.add(id);
      }
      if (this.nativeMirror !== id) this.mirrorWakeups?.observe(id, directory);
      return authorized;
    }, options);
  }
  private async legacyWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.direct.has(id)) throw new NoteError('unsupported');
    this.legacyWrites.set(id, (this.legacyWrites.get(id) ?? 0) + 1);
    try { return await action(); }
    finally {
      const remaining = this.legacyWrites.get(id)! - 1;
      if (remaining) this.legacyWrites.set(id, remaining);
      else this.legacyWrites.delete(id);
    }
  }
  async children(input: { mirrorId: string; revision: number; folder: string }, signal?: AbortSignal) {
    return this.access(input.mirrorId, input.revision, async root => {
      const { noteChildren } = await import('./note-children.ts');
      const result = await noteChildren(root, input.folder, signal);
      this.guard(input.mirrorId); return result;
    });
  }
  async searchNotes(input: SearchRequest) {
    return this.access(input.mirrorId, input.revision, async root => {
      const result = await this.search.next(input, root, () => this.guard(input.mirrorId));
      this.guard(input.mirrorId); return result;
    });
  }
  async closeSearch(revision: number, cursor: string) {
    if (this.closed || revision !== this.revision) throw new CloudError('invalid_selection');
    await this.search.close(cursor); return null;
  }
  async read(id: string, revision: number, path: string, incomingToken?: string) {
    return this.access(id, revision, async root => {
      if (incomingToken === undefined) return this.overlay.read(root, id, path);
      const text = await this.overlay.readIncoming(id, path, incomingToken);
      if (text === null) return { absent: true as const };
      const { createHash } = await import('node:crypto');
      return { absent: false as const, text, hash: createHash('sha256').update(text).digest('hex'), readAt: new Date(this.clock()).toISOString(), complete: true as const };
    });
  }
  async receipts(id: string, revision: number, query: { mirrorId: string; operationId?: string; path?: string; since?: string; limit: number }) {
    if (this.storageBlocked) throw new CloudError('recovery_required');
    if (!this.ready || this.closed || this.revision !== revision || !this.members.has(id) || query.mirrorId !== id) throw new CloudError('invalid_selection');
    // Receipts are durable historical facts, not a read of a possibly absent
    // mirror. Revocation still fences them and the scope is always mandatory.
    return this.overlay.receipts(query);
  }
  async moveReceipts(id: string, revision: number, operationId: string) {
    if (this.closed || revision !== this.revision || !this.members.has(id)) throw new CloudError('invalid_selection');
    if (this.moving) throw new NoteError('busy');
    if (!this.moves.blocked(id)) return this.moves.receipts(id, operationId);
    // Inspect exact filesystem evidence under the existing native lock; no
    // link/unlink is replayed. Ambiguous two-name states remain blocked.
    return this.idleFiles(async () => {
      this.guardWithin(id, revision);
      const root = await this.local(this.mirror(id)!);
      await this.moves.inspect(root, id);
      return this.moves.receipts(id, operationId);
    });
  }
  async move(revision: number, input: MoveInput, signal?: AbortSignal) {
    return this.legacyWrite(input.mirrorId, () => this.moveLegacy(revision, input, signal));
  }
  private async moveLegacy(revision: number, input: MoveInput, signal?: AbortSignal) {
    // Do not queue a second move behind the first or let ordinary overlay
    // publications race canonical unlink. Existing entered saves finish first.
    if (this.moving || this.moves.blocked(input.mirrorId)) throw new NoteError('busy');
    await this.access(input.mirrorId, revision, async () => {});
    if (this.moving) throw new NoteError('busy');
    this.moving = true;
    try {
      await Promise.allSettled([...this.entered]);
      return await this.idleFiles(nativeSignal => this.context.run({ mirrorId: input.mirrorId, revision }, async () => {
        this.guard(input.mirrorId);
        for (const table of ['icloud_note_overlay_receipts', 'icloud_note_overlay_resolutions', 'icloud_note_overlay_legacy']) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).get(input.operationId)) throw new NoteError('operation_reused');
        const m = this.mirror(input.mirrorId)!;
        if (m.failure || m.blocker || this.nativeBlocked.has(m.id)) throw new NoteError('busy');
        for (const path of [input.path, input.destination]) {
          if (this.db.prepare('SELECT 1 FROM icloud_note_overlay_heads WHERE mirror_id=? AND path=?').get(m.id, path) || this.db.prepare('SELECT 1 FROM icloud_note_overlay_legacy WHERE mirror_id=? AND path=? AND uncertain=1').get(m.id, path)) throw new NoteError('busy');
        }
        return this.moves.move(this.localPath(m), input, signal ? AbortSignal.any([signal, nativeSignal]) : nativeSignal);
      }));
    } finally { this.moving = false; }
  }
  async commit(revision: number, input: CommitInput) {
    if (this.moves.has(input.operationId)) throw new NoteError('operation_reused');
    const result = await this.legacyWrite(input.mirrorId, () => this.access(input.mirrorId, revision, root => this.overlay.commit(root, input)));
    this.wake(); return result;
  }
  async resolve(id: string, revision: number, path: string, input: Resolution) {
    // Revision/version are current authorization, not part of the immutable
    // semantic resolution operation identity. Canonicalize RPC input here.
    const semantic: Resolution = { operationId: input.operationId, token: input.token, expectedLogicalHash: input.expectedLogicalHash,
      expectedIncomingHash: input.expectedIncomingHash, choice: input.choice, ...(input.text === undefined ? {} : { text: input.text }) };
    const result = await this.legacyWrite(id, () => this.access(id, revision, root => this.overlay.resolve(root, id, path, semantic)));
    this.wake(); return result;
  }
  // A turn holds native exclusivity from beforeRun through post-run inspection.
  // Ordinary commands run the bounded application quantum, even on failure.
  private turn<T>(action: () => Promise<T>, applyPending = true): Promise<T> {
    if (this.closed) return Promise.reject(new CloudError('interrupted'));
    this.turnsPending++;
    const task = this.queue.then(async () => {
      if (this.closed) throw new CloudError('interrupted');
      try { return await action(); }
      finally { if (applyPending) { await this.quantum(); this.scheduleMaintenance(); } }
    }).finally(() => { this.turnsPending--; });
    this.queue = task.then(() => {}, () => {});
    return task;
  }
  benchmarkListing(mirror: Mirror, checkers: ListingCheckers, signal?: AbortSignal) {
    if (this.turnsPending) throw new CloudError('busy');
    return this.turn(async () => {
      const current = this.mirror(mirror.id);
      if (!this.ready || this.storageBlocked || !current || current.folder.id !== mirror.folder.id) throw new CloudError('source_changed');
      await this.local(current, { requireBinding: true });
      return this.worker.benchmarkListing(selectedRemote(current), checkers, signal);
    }, false);
  }
  call(method: string, body: Record<string, unknown>) {
    // The existing owned daemon can list remote directories while its CLI syncs.
    // No config, cache mutation, local file read or arbitrary RC call bypasses
    // the native turn. Drain listings before post-run filesystem reconciliation.
    const opt = body.opt as Record<string, unknown> | undefined;
    if (!this.closed && this.nativeRunning && method === 'operations/list' && body.fs === 'icloud:' && typeof body.remote === 'string' && Object.keys(body).length === 3 && opt && Object.keys(opt).length === 1 && opt.dirsOnly === true) {
      if (this.directoryReads.size >= 32) return Promise.reject(new CloudError('busy'));
      const task = this.worker.call(method, body);
      this.directoryReads.add(task);
      return task.finally(() => { this.directoryReads.delete(task); });
    }
    return this.turn(async () => {
      if (method === 'config/create' && this.accountHash) {
        const params = body.parameters as Record<string, unknown> | undefined;
        const key = params?.apple_id;
        const fingerprint = typeof key === 'string' && body.type === 'iclouddrive' ? createHash('sha256').update(JSON.stringify(['iclouddrive', key.toLowerCase()])).digest('hex') : null;
        if (fingerprint !== this.accountHash) throw new CloudError('invalid_selection');
      }
      return this.worker.call(method, body);
    });
  }
  idleFiles<T>(action: (signal: AbortSignal) => Promise<T>) { return this.turn(() => this.worker.withFiles(action)); }
  private async nativeCommand(args: string[], capture?: boolean, report?: Parameters<RcloneProcess['run']>[2]) {
    for (const mirror of this.state().mirrors) if (mirror.initialized && args.includes(this.localPath(mirror)) && this.moves.blocked(mirror.id)) throw new NoteError('uncertain');
    const direct = args[0] === 'bisync' ? this.state().mirrors.find(m => this.direct.has(m.id) && this.localPath(m) === args[2]) : undefined;
    if (direct) await this.local(direct, { interrupted: direct.blocker === 'rebuild' });
    this.nativeRunning = true;
    this.nativeMirror = direct?.id;
    if (direct) this.mirrorWakeups?.suspend(direct.id);
    try { return await this.worker.run(direct ? [...args, '--exclude', obsidianStageExclude] : args, capture, report); }
    finally {
      this.nativeRunning = false;
      this.nativeMirror = undefined;
      if (direct && !this.closed) {
        const directory = await this.local(direct, { interrupted: direct.blocker === 'rebuild' }).catch(() => null);
        if (directory) this.mirrorWakeups?.observe(direct.id, directory);
      }
      await Promise.allSettled([...this.directoryReads]);
    }
  }
  run(args: string[], capture?: boolean, report?: Parameters<RcloneProcess['run']>[2]) {
    return this.turn(async () => {
      const id = args[0] === 'bisync' ? this.state().mirrors.find(m => m.initialized && this.localPath(m) === args[2])?.id : undefined;
      if (id && this.moves.blocked(id)) throw new NoteError('uncertain');
      if (id && !args.includes('--resync')) {
        if (this.nativeBlocked.get(id) === 'native_failure' && this.mirror(id)?.blocker === null) this.nativeBlocked.delete(id); // explicit Retry cleared the prior blocker
        await this.quantum();
        if (this.mirror(id)?.blocker === 'rebuild' || this.nativeBlocked.has(id) || this.overlay.hasUnresolvedJournals(id)) throw new CloudError('recovery_required');
      }
      const eligible = id && !args.includes('--resync') ? this.overlay.beforeRun(id) : [];
      let succeeded = false;
      let commandEvidence: ReturnType<typeof evidence> = null;
      try { const output = await this.nativeCommand(args, capture, report); succeeded = true; return output; }
      catch (error) {
        commandEvidence = evidence(error);
        if (id && error instanceof CloudError && ['recovery_required', 'capacity', 'configuration', 'invalid_selection'].includes(error.category)) this.nativeBlocked.set(id, 'native_failure');
        throw error;
      } finally {
        if (id && eligible.length) {
          try { await this.overlay.afterRun(this.localPath(this.mirror(id)!), id, eligible, succeeded); }
          catch (error) {
            this.nativeBlocked.set(id, 'uncertain');
            throw new CloudError('recovery_required', {
              kind: 'post_run_reconcile', reason: error instanceof NoteError && error.category === 'uncertain' ? 'uncertain' : 'unavailable',
              command: commandEvidence?.kind === 'post_run_reconcile' ? commandEvidence.command : commandEvidence,
            });
          }
        }
      }
    });
  }
  continueInterrupted(args: string[], capture?: boolean, report?: Parameters<RcloneProcess['run']>[2]) {
    return this.turn(async () => {
      const mirror = this.state().mirrors.find(m => this.localPath(m) === args[2]);
      if (!this.ready || this.storageBlocked || !mirror || mirror.blocker !== 'rebuild' || mirror.phase !== 'running' || args[0] !== 'bisync' || args.includes('--resync')) throw new CloudError('recovery_required');
      // The service persisted the existing rebuild fence BEFORE this turn.
      // Already-entered saves must drain through the final publication guard.
      await Promise.allSettled([...this.entered]);
      await this.bindAccount();
      const root = await this.local(mirror, { interrupted: true });
      const held = await this.overlay.interruptedCopies(root, mirror.id).catch(() => { throw new CloudError('recovery_required'); });
      try {
        const output = await this.nativeCommand(args, capture, report);
        await this.local(mirror, { interrupted: true });
        // Validate EVERY held head before collision capture or retirement. In
        // particular canonical D alongside B/C is not a verified conflict.
        await this.overlay.interruptedCopies(root, mirror.id, held);
        await this.overlay.afterRun(root, mirror.id, this.overlay.beforeRun(mirror.id), true);
        this.nativeBlocked.delete(mirror.id); this.blocked.delete(mirror.id);
        return output;
      } catch (error) {
        this.nativeBlocked.set(mirror.id, 'uncertain');
        if (error instanceof CloudError) throw error;
        throw new CloudError('recovery_required', { kind: 'post_run_reconcile', reason: error instanceof NoteError && error.category === 'uncertain' ? 'uncertain' : 'unavailable', command: null });
      }
    });
  }
  private async quantum() {
    if (!this.ready || this.closed) return;
    const start = performance.now(); let count = 0;
    const pending = this.overlay.pending();
    const mirrors = [...new Set(pending.map(p => p.mirrorId))].sort();
    const ordered: typeof pending = [];
    let cursor = this.lastMirror ? (mirrors.indexOf(this.lastMirror) + 1) % (mirrors.length || 1) : 0;
    while (ordered.length < pending.length && mirrors.length) {
      for (let i = 0; i < mirrors.length; i++) {
        const id = mirrors[(cursor + i) % mirrors.length];
        const item = pending.find(p => p.mirrorId === id && !ordered.includes(p));
        if (item) ordered.push(item);
      }
      cursor = (cursor + 1) % mirrors.length;
    }
    for (const item of ordered) {
      if (count >= 16 || performance.now() - start >= 1000) break;
      const mirror = this.mirror(item.mirrorId);
      if (!mirror || this.blocked.has(item.mirrorId) || this.nativeBlocked.has(item.mirrorId) || ['rebuild', 'initialization', 'configuration', 'capacity'].includes(mirror.blocker ?? '') || !(await this.availability(item.mirrorId)).available) continue;
      try {
        await this.worker.withFiles(() => this.overlay.apply(this.localPath(mirror), mirror.id, item.path));
        count++; this.lastMirror = mirror.id;
      } catch (error) {
        this.nativeBlocked.set(item.mirrorId, 'uncertain');
        this.diagnose('note_apply', error instanceof NoteError ? error.category : error instanceof CloudError ? error.category : 'unavailable', { evidence: null, ...(error instanceof NoteApplicationError ? { application: { stage: error.stage, outcome: error.outcome } } : { application: { stage: 'native_lock', outcome: 'uncertain' } }) });
      }
    }
    // Yield to an already queued native command. A fresh idle wake receives
    // another bounded turn; a blocked path cannot spin indefinitely.
    if (count && this.overlay.pending().length) this.wake();
  }
  private scheduleMaintenance() {
    if (this.maintenanceScheduled || this.maintenance || !this.ready || this.closed || this.storageBlocked) return;
    this.maintenanceScheduled = true;
    setImmediate(() => {
      this.maintenanceScheduled = false;
      if (!this.ready || this.closed || this.storageBlocked) return;
      let more = false;
      this.maintenance = this.overlay.maintain(64).then(result => {
        more = result.examined === 64;
      }).catch(error => {
        this.storageBlocked = true;
        this.diagnose('note_maintenance', error instanceof NoteError ? error.category : 'unavailable');
      }).finally(() => {
        this.maintenance = null;
        if (more) this.scheduleMaintenance();
      });
    });
  }
  wake() {
    this.scheduleMaintenance();
    if (this.wakeScheduled || !this.ready || this.closed) return;
    this.wakeScheduled = true;
    setImmediate(() => { this.wakeScheduled = false; if (!this.closed) void this.turn(async () => {}).catch(() => {}); });
  }
  // Existing client Retry invokes this before changing service enablement.
  // Recheck under native exclusivity; never infer safety from a warning category.
  async recoverUnapplied(id: string) {
    if (this.nativeBlocked.get(id) !== 'uncertain') return;
    return this.idleFiles(async () => {
      const checkedMirror = () => {
        const mirror = this.mirror(id);
        if (!this.ready || this.closed || this.storageBlocked || this.blocked.has(id) || this.moving || this.moves.blocked(id) ||
          !mirror || mirror.enabled || mirror.phase !== 'failed' || mirror.failure !== 'interrupted' || mirror.blocker !== null) throw new CloudError('recovery_required');
        return mirror;
      };
      try {
        const root = await this.local(checkedMirror());
        const paths = await this.overlay.proveUnapplied(root, id);
        for (const path of paths) {
          if (this.closed) throw new CloudError('interrupted');
          await this.local(checkedMirror());
          // apply retains its own immediate identity/CAS and durable journal.
          if (await this.overlay.apply(root, id, path) !== 'applied') throw new NoteError('uncertain');
        }
        await this.local(checkedMirror());
        checkedMirror();
        if (this.closed || this.overlay.hasUnresolvedJournals(id) || this.overlay.pending().some(p => p.mirrorId === id)) throw new NoteError('uncertain');
        this.nativeBlocked.delete(id);
      } catch (error) {
        this.nativeBlocked.set(id, 'uncertain');
        this.diagnose('note_application_recovery', error instanceof NoteError ? error.category : error instanceof CloudError ? error.category : 'unavailable', { evidence: null, application: error instanceof NoteApplicationError ? { stage: error.stage, outcome: error.outcome } : { stage: 'reconcile', outcome: 'uncertain' } });
        throw new CloudError('recovery_required');
      }
    });
  }
  activity() {
    return { nativeRunning: this.nativeRunning, localOperations: this.entered.size, turnsPending: this.turnsPending,
      busy: this.closed || !this.ready || this.search.active || this.nativeRunning || this.entered.size > 0 || this.turnsPending > 0 || this.directoryReads.size > 0 || this.moving || this.wakeScheduled || this.maintenanceScheduled || this.maintenance !== null };
  }
  canRestoreScheduling(id: string) {
    return this.ready && !this.closed && !this.storageBlocked && !this.blocked.has(id) &&
      !this.nativeBlocked.has(id) && !this.moves.blocked(id) && !this.overlay.hasUnresolvedJournals(id);
  }
  pendingAgeMs(id: string) { return this.overlay.pendingAgeMs(id); }
  applicationBlocker(id: string) { return this.mirror(id)?.blocker === 'rebuild' || this.nativeBlocked.get(id) === 'uncertain' ? 'application_uncertain' as const : this.nativeBlocked.has(id) ? 'native_recovery' as const : null; }
  requestStop() {
    this.closed = true; this.ready = false;
    this.mirrorWakeups?.stop();
    this.worker.requestStop();
  }
  stop(): Promise<void> {
    this.requestStop();
    return this.stopped ??= (async () => {
      await this.search.stop();
      await Promise.allSettled([...this.entered]);
      await this.queue;
      await this.maintenance;
      await this.worker.stop();
    })();
  }
}
