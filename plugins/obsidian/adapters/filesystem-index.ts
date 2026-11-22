import { watch, type FSWatcher, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { VaultError, type Diagnose, type NoteParser } from '../core/ports.ts';
import { VaultIndex, IndexBudget, abortError, untilAborted, type IndexedNote, type IndexOmission, type IndexView } from '../core/vault-index.ts';
import { identity, type DirectoryGrant, type LocalNotes } from './local-notes.ts';

export const INDEX_LIMITS = { vaults: 20, watchers: 16_384, watchersPerVault: 4_096, parallel: 2, entries: 100_000,
  viewBytes: 16 * 1024 * 1024, currentBytes: 96 * 1024 * 1024, retainedBytes: 32 * 1024 * 1024, scanMs: 120_000, debounceMs: 75, reconcileMs: 300_000 };
type Limits = typeof INDEX_LIMITS;
export type DirectoryGrantLookup = (id: string, revision: number, signal?: AbortSignal) => Promise<DirectoryGrant>;
type Watched = { handle: FSWatcher; info: Stats };
type Lane = { actor: VaultIndex; watches: Map<string, Watched>; grant?: DirectoryGrant; degraded: boolean; warnings: Set<string> };
const under = (path: string, scope: string) => !scope || path === scope || path.startsWith(scope + '/');
const sizeOf = (value: unknown) => JSON.stringify(value).length;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

/** Owns local scan slots and watch handles. Only VaultIndex publishes a view. */
export class FilesystemIndex {
  private lanes = new Map<string, Lane>();
  private retiring = new Map<string, Promise<void>>();
  private queuedStarts = new Set<string>();
  private eligible = new Set<string>();
  private revision?: number;
  private stopped = false;
  private watcherCount = 0;
  private active = 0;
  private waiting: Array<() => void> = [];
  private budget: IndexBudget;

  constructor(private files: LocalNotes, private directory: DirectoryGrantLookup, private parser: NoteParser, private diagnose: Diagnose,
    private limits = INDEX_LIMITS, private watchDirectory = watch, private revoked: (id: string) => void = () => {}) {
    this.budget = new IndexBudget({ current: limits.currentBytes, retained: limits.retainedBytes, building: limits.parallel * limits.viewBytes }, limits.viewBytes);
  }

  setEligible(revision: number, ids: readonly string[], reconcile = false) {
    if (this.stopped || (this.revision !== undefined && revision < this.revision)) return;
    const prior = revision === this.revision ? this.eligible : new Set<string>();
    const sameRevision = revision === this.revision;
    this.revision = revision; this.eligible = new Set(ids.slice(0, this.limits.vaults));
    for (const id of this.lanes.keys()) if (!sameRevision || !this.eligible.has(id)) this.retire(id);
    for (const id of this.queuedStarts) if (!this.eligible.has(id)) this.queuedStarts.delete(id);
    for (const id of this.eligible) if (!prior.has(id) || reconcile) {
      if (this.retiring.has(id)) this.queuedStarts.add(id);
      else this.lane(id, revision).actor.hint();
    }
  }

  async acquire(id: string, revision: number, signal?: AbortSignal) {
    const retiring = this.retiring.get(id);
    if (retiring) await (signal ? untilAborted(retiring, signal) : retiring);
    if (signal?.aborted) throw abortError(signal);
    if (this.stopped || revision !== this.revision || !this.eligible.has(id)) throw new VaultError('source_unavailable');
    return this.lane(id, revision).actor.acquire(signal);
  }

  async stop() {
    this.stopped = true; this.eligible.clear(); this.queuedStarts.clear();
    for (const id of this.lanes.keys()) this.retire(id, new VaultError('cancelled'));
    await Promise.all(this.retiring.values());
  }

  private retire(id: string, reason = new VaultError('source_unavailable')) {
    const lane = this.lanes.get(id); if (!lane) return;
    this.lanes.delete(id);
    this.revoked(id);
    for (const path of lane.watches.keys()) this.unwatch(lane, path);
    this.retiring.set(id, lane.actor.stop(reason).finally(() => {
      this.retiring.delete(id);
      if (this.queuedStarts.delete(id) && this.eligible.has(id)) this.lane(id, this.revision!).actor.hint();
    }));
  }

  private lane(id: string, revision: number) {
    const current = this.lanes.get(id); if (current) return current;
    const verifiedRoot = async (signal: AbortSignal) => {
      if (signal.aborted) throw abortError(signal);
      try {
        const grant = await this.directory(id, revision, signal);
        if (signal.aborted) throw abortError(signal);
        if (lane.grant && (lane.grant.directory !== grant.directory || lane.grant.rootDev !== grant.rootDev || lane.grant.rootIno !== grant.rootIno)) throw new VaultError('source_unavailable');
        const root = await this.files.openIndexRoot(grant);
        if (signal.aborted) { await root.close(); throw abortError(signal); }
        lane.grant ??= grant;
        return root;
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        const reason = error instanceof VaultError && error.diagnosticReported ? error : this.failure('source_unavailable', 'index_access');
        if (this.lanes.get(id) === lane) this.retire(id, reason);
        throw reason;
      }
    };
    const authorize = async (signal: AbortSignal) => { const root = await verifiedRoot(signal); await root.close(); };
    const lane: Lane = { watches: new Map(), degraded: false, warnings: new Set(),
      actor: new VaultIndex((previous, paths, signal) => this.scanSlot(signal, async () => {
        const root = await verifiedRoot(signal);
        let next;
        try { next = await this.build(lane, root, previous, paths, signal, authorize); }
        finally { try { await root.close(); } catch (error) { next?.release(); throw error; } }
        return next;
      }), authorize, error => error.diagnosticReported ? error : this.failure(error.category)) };
    this.lanes.set(id, lane);
    return lane;
  }

  private failure(category: string, stage: 'index_refresh' | 'index_access' = 'index_refresh') {
    this.diagnose(stage, category);
    return new VaultError(category, 'The local vault index could not refresh. Check source access or try again after reconciliation.', true);
  }

  private async scanSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw abortError(signal);
    if (this.active >= this.limits.parallel) {
      await new Promise<void>((resolve, reject) => {
        const next = () => { signal.removeEventListener('abort', cancel); this.active++; resolve(); };
        const cancel = () => { const index = this.waiting.indexOf(next); if (index >= 0) this.waiting.splice(index, 1); reject(abortError(signal)); };
        this.waiting.push(next); signal.addEventListener('abort', cancel, { once: true });
      });
    } else this.active++;
    try { if (signal.aborted) throw abortError(signal); return await run(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }

  private unwatch(lane: Lane, path: string) {
    const watched = lane.watches.get(path); if (!watched) return;
    lane.watches.delete(path); this.watcherCount--; watched.handle.close();
  }
  private watch(lane: Lane, path: string, pinned: string, info: Stats) {
    const prior = lane.watches.get(path);
    if (prior && identity(prior.info, info)) return;
    if (prior) this.unwatch(lane, path);
    const degraded = () => { if (!lane.degraded) { lane.degraded = true; this.diagnose('index_watch', 'unavailable'); } };
    if (this.watcherCount >= this.limits.watchers || lane.watches.size >= this.limits.watchersPerVault) { degraded(); return; }
    try {
      // Never join an event name to a path. The kernel watches the directory
      // inode opened by no-follow traversal while its descriptor is pinned.
      const handle = this.watchDirectory(pinned, { persistent: false, recursive: false }, (_event, filename) => {
        if (lane.watches.get(path)?.handle === handle) lane.actor.hint(filename === null ? undefined : path, this.limits.debounceMs);
      });
      lane.watches.set(path, { handle, info }); this.watcherCount++;
      handle.on('error', () => { if (lane.watches.get(path)?.handle === handle) { this.unwatch(lane, path); degraded(); } });
    } catch { degraded(); }
  }

  private async build(lane: Lane, root: FileHandle, previous: IndexView | undefined, paths: ReadonlySet<string> | null,
    signal: AbortSignal, authorize: (signal: AbortSignal) => Promise<void>) {
    const memory = this.budget.reservation();
    const notes: IndexedNote[] = [], directories = new Set<string>(), omissions = new Map<string, IndexOmission>();
    const scopes = paths ? [...paths] : [''];
    const starts = scopes.filter(path => !scopes.some(other => other !== path && under(path, other)));
    const untouched = (path: string) => !starts.some(scope => under(path, scope));
    const addNote = (note: IndexedNote) => { memory.add(256 + 4 * sizeOf(note)); notes.push(note); };
    const addDirectory = (path: string) => { if (!directories.has(path)) { memory.add(128 + 4 * path.length); directories.add(path); } };
    const omit = (path: string, kind: IndexOmission['kind']) => {
      const old = omissions.get(path);
      if (!old) memory.add(128 + 4 * path.length);
      if (!old || kind === 'tree') omissions.set(path, Object.freeze({ path, kind }));
    };
    const deadline = Date.now() + this.limits.scanMs;
    const check = () => {
      if (signal.aborted) throw abortError(signal);
      if (Date.now() > deadline) throw new VaultError('capacity');
    };
    let count = 0;
    try {
      memory.add(256);
      if (previous && paths) {
        for (const note of previous.notes) if (untouched(note.path)) addNote(note);
        for (const path of previous.directories) if (untouched(path)) addDirectory(path);
        for (const entry of previous.omissions) if (untouched(entry.path)) omit(entry.path, entry.kind);
      }
      const frontier = starts.map(path => ({ path, allowAbsent: !!paths }));
      let frontierBytes = frontier.reduce((bytes, { path }) => bytes + 2 * path.length + 128, 0);
      while (frontier.length) {
        check(); const { path, allowAbsent } = frontier.pop()!; frontierBytes -= 2 * path.length + 128;
        for await (const entry of this.files.indexDirectory(root, path, allowAbsent, (pinned, info) => {
          check(); this.watch(lane, path, pinned, info);
        })) {
          check();
          if (++count > this.limits.entries) throw new VaultError('capacity');
          if (entry.kind === 'directory') addDirectory(path);
          else if (entry.kind === 'unsupported') omit(entry.path, entry.scope);
          else if (entry.kind === 'child') {
            frontierBytes += 2 * entry.path.length + 128;
            if (frontierBytes > 2 * 1024 * 1024) throw new VaultError('capacity');
            frontier.push({ path: entry.path, allowAbsent: false });
          } else if (entry.kind === 'note') {
            let reader;
            try { reader = await this.files.searchReader(root, entry.path); }
            catch (error) {
              if (!(error instanceof VaultError && error.category === 'unsupported')) throw error;
              omit(entry.path, 'note'); continue;
            }
            try {
              check();
              const { properties, warnings } = this.parser.frontmatter(reader.text);
              const propertyWarning = warnings.length ? 'properties_unsupported' as const : undefined;
              let metadata: IndexedNote['metadata'];
              try {
                const { properties: _properties, ...parsed } = this.parser.parse(reader.text);
                if (sizeOf(parsed) <= 32768) metadata = parsed;
              } catch (error) { if (!(error instanceof VaultError && error.category === 'parser_limit')) throw error; }
              addNote(freeze({ path: entry.path, hash: reader.hash, readAt: reader.readAt, properties, propertyWarning, metadata,
                metadataWarning: metadata ? undefined : 'parser_limit' as const }));
            } finally { await reader.close(); }
          }
        }
      }
      if (notes.length + directories.size + omissions.size > this.limits.entries) throw new VaultError('capacity');
      await authorize(signal); check();
      notes.sort((a, b) => a.path < b.path ? -1 : a.path === b.path ? 0 : 1);
      const warnings = new Set<string>();
      if (omissions.size || notes.some(note => !!note.propertyWarning)) warnings.add('unsupported');
      if (notes.some(note => !!note.metadataWarning)) warnings.add('limit');
      return { view: Object.freeze({ notes: Object.freeze(notes), directories: Object.freeze([...directories]),
        omissions: Object.freeze([...omissions.values()]) }), memory, release: memory.release,
        published: () => {
          for (const path of lane.watches.keys()) if (!directories.has(path)) this.unwatch(lane, path);
          for (const warning of warnings) if (!lane.warnings.has(warning)) this.diagnose('index_refresh', warning);
          lane.warnings = warnings;
        },
      };
    } catch (error) { memory.release(); throw error; }
  }
}
