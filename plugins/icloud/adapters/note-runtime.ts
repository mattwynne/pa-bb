import type Database from 'better-sqlite3';
import { constants, lstatSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { CloudError } from '../core/ports.ts';
import type { Mirror, State } from '../core/ports.ts';
import { NoteError, NoteStore } from './note-store.ts';
import type { CommitInput } from './note-store.ts';
import { NoteOverlay } from './note-overlay.ts';
import type { Resolution } from './note-overlay.ts';
import { RcloneProcess } from './rclone-process.ts';
import { NoteSearch } from './note-search.ts';
import type { SearchRequest } from './note-search.ts';

// The flock, not a JS timer/lease, owns the generation. All native commands,
// RC/config calls and mirror mutations enter the same turn. Overlay publications
// have a separate admission fence and can proceed during this generation's child.
export class NoteRuntime {
  readonly overlay: NoteOverlay;
  readonly search: NoteSearch;
  private readonly context = new AsyncLocalStorage<{ revision: number; mirrorId: string }>();
  private queue: Promise<void> = Promise.resolve();
  private entered = new Set<Promise<unknown>>();
  private closed = false;
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
  constructor(readonly root: string, private db: Database.Database, readonly worker: RcloneProcess,
    private legacy: NoteStore, private state: () => State, private clock = () => Date.now(),
    private diagnose: (stage: string, category: string) => void = () => {}) {
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
        CREATE TABLE IF NOT EXISTS icloud_note_account (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);`);
      if (this.state().mirrors.some(m => m.initialized)) await this.bindAccount();
      await this.overlay.start();
      const config = this.db.prepare('SELECT revision, members FROM icloud_note_admission WHERE id=1').get() as { revision: number; members: string } | undefined;
      if (config) {
        let members: unknown;
        try { members = JSON.parse(config.members); } catch { throw new NoteError('uncertain'); }
        if (!Number.isSafeInteger(config.revision) || config.revision < 0 || !Array.isArray(members) || members.length > 20 || members.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) || new Set(members).size !== members.length) throw new NoteError('uncertain');
        this.revision = config.revision; this.members = new Set(members);
      }
      for (const mirror of this.state().mirrors.filter(m => m.initialized && m.phase !== 'retained')) {
        try { await this.local(mirror); await this.overlay.indexLegacy(mirror.id, this.localPath(mirror)); }
        catch (error) { this.blocked.add(mirror.id); if (error instanceof NoteError && error.category === 'uncertain') throw error; }
      }
      this.ready = true;
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
  private async local(mirror: Mirror) {
    if (!mirror.initialized || mirror.phase === 'retained' || ['rebuild', 'initialization', 'configuration'].includes(mirror.blocker ?? '')) throw new CloudError('source_changed');
    const bound = this.db.prepare('SELECT * FROM icloud_note_bindings WHERE mirror_id=?').get(mirror.id) as { folder_id: string; root_dev: number; root_ino: number; baseline_dev: number; baseline_ino: number } | undefined;
    if (bound && bound.folder_id !== mirror.folder.id) throw new CloudError('source_changed');
    const root = this.localPath(mirror), baseline = join(this.root, 'baselines', mirror.id);
    const [rootInfo, baselineInfo] = await Promise.all([lstat(root).catch(() => null), lstat(baseline).catch(() => null)]);
    if ([rootInfo, baselineInfo].some(info => !info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())) throw new CloudError('source_changed');
    if (bound && (bound.root_dev !== rootInfo!.dev || bound.root_ino !== rootInfo!.ino || bound.baseline_dev !== baselineInfo!.dev || bound.baseline_ino !== baselineInfo!.ino)) throw new CloudError('source_changed');
    let marker;
    try {
      marker = await open(join(baseline, 'initialized'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await marker.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size !== 1 || await marker.readFile('utf8') !== '1') throw new Error();
    } catch { throw new CloudError('source_changed'); }
    finally { await marker?.close(); }
    if (!bound) this.db.prepare('INSERT INTO icloud_note_bindings(mirror_id, folder_id, root_dev, root_ino, baseline_dev, baseline_ino) VALUES (?, ?, ?, ?, ?, ?)').run(mirror.id, mirror.folder.id, rootInfo!.dev, rootInfo!.ino, baselineInfo!.dev, baselineInfo!.ino);
    return root;
  }
  // Initial resync creates a previously uninitialized mirror. Only after its
  // marker is written may a native-idle turn bind and index it for local RPCs.
  async registerMirror(mirror: Mirror) {
    await this.turn(() => this.worker.withFiles(async () => {
      await this.bindAccount();
      const initialized = { ...mirror, initialized: true };
      await this.local(initialized);
      await this.overlay.indexLegacy(mirror.id, this.localPath(initialized));
      this.blocked.delete(mirror.id);
    }));
  }
  async availability(id: string): Promise<{ available: boolean; reason: 'ownership' | 'recovery_required' | 'source_changed' | null }> {
    if (!this.ready || this.closed) return { available: false, reason: 'ownership' };
    if (this.storageBlocked || this.blocked.has(id)) return { available: false, reason: 'recovery_required' };
    const mirror = this.mirror(id);
    if (!mirror) return { available: false, reason: 'source_changed' };
    try { await this.local(mirror); return { available: true, reason: null }; }
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
  private guard(id: string) {
    const active = this.context.getStore();
    if (this.storageBlocked) throw new CloudError('recovery_required');
    if (!this.ready || this.closed || !active || active.mirrorId !== id || active.revision !== this.revision || !this.members.has(id)) throw new CloudError('invalid_selection');
    const mirror = this.mirror(id);
    const bound = this.db.prepare('SELECT * FROM icloud_note_bindings WHERE mirror_id=?').get(id) as { folder_id: string; root_dev: number; root_ino: number; baseline_dev: number; baseline_ino: number } | undefined;
    if (!mirror || !bound || bound.folder_id !== mirror.folder.id || mirror.phase === 'retained') throw new CloudError('source_changed');
    try {
      const root = lstatSync(this.localPath(mirror)), baseline = lstatSync(join(this.root, 'baselines', id));
      const marker = openSync(join(this.root, 'baselines', id, 'initialized'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let valid = false;
      try {
        const info = fstatSync(marker);
        valid = info.isFile() && info.size === 1 && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 && readFileSync(marker, 'utf8') === '1';
      } finally { closeSync(marker); }
      if (!valid || !root.isDirectory() || !baseline.isDirectory() || root.isSymbolicLink() || baseline.isSymbolicLink() || root.dev !== bound.root_dev || root.ino !== bound.root_ino || baseline.dev !== bound.baseline_dev || baseline.ino !== bound.baseline_ino) throw new Error();
    } catch { throw new CloudError('source_changed'); }
  }
  async access<T>(id: string, revision: number, action: (root: string) => Promise<T>): Promise<T> {
    if (this.storageBlocked) throw new CloudError('recovery_required');
    if (!this.ready || this.closed || this.revision !== revision || !this.members.has(id)) throw new CloudError('invalid_selection');
    const availability = await this.availability(id);
    if (!availability.available) throw new CloudError('source_changed');
    this.guardWithin(id, revision);
    const task = this.context.run({ revision, mirrorId: id }, () => action(this.localPath(this.mirror(id)!)));
    this.entered.add(task);
    try { return await task; } finally { this.entered.delete(task); }
  }
  private guardWithin(id: string, revision: number) {
    if (this.closed || this.revision !== revision || !this.members.has(id)) throw new CloudError('invalid_selection');
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
  async commit(revision: number, input: CommitInput) {
    const result = await this.access(input.mirrorId, revision, root => this.overlay.commit(root, input));
    this.wake(); return result;
  }
  async resolve(id: string, revision: number, path: string, input: Resolution) {
    // Revision/version are current authorization, not part of the immutable
    // semantic resolution operation identity. Canonicalize RPC input here.
    const semantic: Resolution = { operationId: input.operationId, token: input.token, expectedLogicalHash: input.expectedLogicalHash,
      expectedIncomingHash: input.expectedIncomingHash, choice: input.choice, ...(input.text === undefined ? {} : { text: input.text }) };
    const result = await this.access(id, revision, root => this.overlay.resolve(root, id, path, semantic));
    this.wake(); return result;
  }
  // A turn holds native exclusivity from beforeRun through post-run inspection.
  // The bounded application quantum follows every command, even failed commands.
  private turn<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CloudError('interrupted'));
    const task = this.queue.then(async () => {
      if (this.closed) throw new CloudError('interrupted');
      try { return await action(); }
      finally { await this.quantum(); this.scheduleMaintenance(); }
    });
    this.queue = task.then(() => {}, () => {});
    return task;
  }
  call(method: string, body: Record<string, unknown>) {
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
  idleFiles<T>(action: () => Promise<T>) { return this.turn(() => this.worker.withFiles(action)); }
  run(args: string[], capture?: boolean, report?: Parameters<RcloneProcess['run']>[2]) {
    return this.turn(async () => {
      const id = args[0] === 'bisync' ? this.state().mirrors.find(m => m.initialized && this.localPath(m) === args[2])?.id : undefined;
      if (id && !args.includes('--resync')) {
        if (this.nativeBlocked.get(id) === 'native_failure' && this.mirror(id)?.blocker === null) this.nativeBlocked.delete(id); // explicit Retry cleared the prior blocker
        await this.quantum();
        if (this.nativeBlocked.has(id) || this.overlay.hasUnresolvedJournals(id)) throw new CloudError('recovery_required');
      }
      const eligible = id && !args.includes('--resync') ? this.overlay.beforeRun(id) : [];
      let succeeded = false;
      try { const output = await this.worker.run(args, capture, report); succeeded = true; return output; }
      catch (error) {
        if (id && error instanceof CloudError && ['recovery_required', 'capacity', 'configuration', 'invalid_selection'].includes(error.category)) this.nativeBlocked.set(id, 'native_failure');
        throw error;
      } finally {
        if (id && eligible.length) {
          try { await this.overlay.afterRun(this.localPath(this.mirror(id)!), id, eligible, succeeded); }
          catch { this.nativeBlocked.set(id, 'uncertain'); throw new CloudError('recovery_required'); }
        }
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
        this.diagnose('note_apply', error instanceof NoteError ? error.category : 'unavailable');
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
      this.maintenance = this.overlay.maintain(64).then(result => {
        if (result.examined === 64) setImmediate(() => this.scheduleMaintenance());
      }).catch(error => {
        this.storageBlocked = true;
        this.diagnose('note_maintenance', error instanceof NoteError ? error.category : 'unavailable');
      }).finally(() => { this.maintenance = null; });
    });
  }
  wake() {
    this.scheduleMaintenance();
    if (this.wakeScheduled || !this.ready || this.closed) return;
    this.wakeScheduled = true;
    setImmediate(() => { this.wakeScheduled = false; if (!this.closed) void this.turn(async () => {}).catch(() => {}); });
  }
  pendingAgeMs(id: string) { return this.overlay.pendingAgeMs(id); }
  applicationBlocker(id: string) { return this.nativeBlocked.get(id) === 'uncertain' ? 'application_uncertain' as const : this.nativeBlocked.has(id) ? 'native_recovery' as const : null; }
  async stop() {
    if (this.closed) return;
    this.closed = true; this.ready = false;
    await this.search.stop();
    await Promise.allSettled([...this.entered]);
    await this.queue;
    await this.maintenance;
    await this.worker.stop();
  }
}
