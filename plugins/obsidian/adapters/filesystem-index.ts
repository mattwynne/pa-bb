import { parseLinks, VaultLinks } from '../core/vault-links.ts';
import { watch, type FSWatcher, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { VaultError, type Diagnose, type NoteParser } from '../core/ports.ts';
import { VaultIndex, IndexBudget, abortError, untilAborted, type IndexedNote, type IndexOmission, type IndexView, type MoveIndexLease } from '../core/vault-index.ts';
import { identity, type DirectoryGrant, type LocalNotes } from './local-notes.ts';

export const INDEX_LIMITS = { vaults: 20, watchers: 16_384, watchersPerVault: 4_096, parallel: 2, entries: 100_000,
  viewBytes: 16 * 1024 * 1024, currentBytes: 96 * 1024 * 1024, retainedBytes: 32 * 1024 * 1024, scanMs: 120_000, debounceMs: 75, reconcileMs: 300_000 };
type Limits = typeof INDEX_LIMITS;
export type DirectoryGrantLookup = (id: string, revision: number, signal?: AbortSignal) => Promise<DirectoryGrant>;
type Watched = { handle: FSWatcher; info: Stats };
type Lane = { actor: VaultIndex; watches: Map<string, Watched>; open: (signal: AbortSignal) => Promise<FileHandle>; grant?: DirectoryGrant; degraded: boolean; warnings: Set<string> };
type MoveEvidence = { stamps: ReadonlyMap<string, string>; roots: readonly string[]; blockers: readonly IndexOmission[] };
const under = (path: string, scope: string) => !scope || path === scope || path.startsWith(scope + '/');
const isVaultMarker = (path: string) => path === '.obsidian' || path.endsWith('/.obsidian');
const inVaultConfig = (path: string) => path.split('/').slice(0, -1)
  .some(name => name === '.obsidian' || name === '.git' || name === 'node_modules');
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
  private moveEvidence = new WeakMap<IndexView, MoveEvidence>();

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

  private async eligibleLane(id: string, revision: number, signal?: AbortSignal) {
    const retiring = this.retiring.get(id);
    if (retiring) await (signal ? untilAborted(retiring, signal) : retiring);
    if (signal?.aborted) throw abortError(signal);
    if (this.stopped || revision !== this.revision || !this.eligible.has(id)) throw new VaultError('source_unavailable');
    return this.lane(id, revision);
  }

  async acquire(id: string, revision: number, signal?: AbortSignal) {
    return (await this.eligibleLane(id, revision, signal)).actor.acquire(signal);
  }

  async acquireForMove(id: string, revision: number, signal: AbortSignal): Promise<MoveIndexLease> {
    const lane = await this.eligibleLane(id, revision, signal);
    const acquire = async () => {
      const lease = await lane.actor.acquire(signal, true);
      try {
        const view = lease.view;
        const { stamps, roots, blockers } = this.moveEvidence.get(view)!;
        const checkMembership = async (signal: AbortSignal, directory?: string) => {
          lease.assertValid();
          const root = await lane.open(signal);
          try {
            if (directory !== undefined && lane.grant?.directory !== directory) throw new VaultError('source_unavailable');
            // A parent stamp covers added, removed and replaced entries even
            // when a watcher is missing or the event has not arrived yet.
            let batch: Promise<boolean>[] = [];
            const flush = async () => {
              if ((await Promise.allSettled(batch)).some(result => result.status !== 'fulfilled' || !result.value))
                throw new VaultError('conflict', 'Vault directory membership changed. Prepare a fresh folder move preview.');
              batch = [];
              if (signal.aborted) throw abortError(signal);
            };
            for (const [path, stamp] of stamps) {
              batch.push(this.files.indexDirectoryStamp(root, path).then(current => current === stamp));
              if (batch.length >= 16) await flush();
            }
            await flush();
            await lease.check(signal);
          } finally { await root.close(); }
        };
        await checkMembership(signal);
        lease.assertUnchanged?.();
        const boundaryUnverified = (path: string) => !inVaultConfig(path) && !roots.some(root => under(path, root));
        const invalidBoundary = view.omissions.some(({ path, boundary }) => (boundary || isVaultMarker(path)) && boundaryUnverified(path)) ||
          blockers.some(({ path }) => isVaultMarker(path) && boundaryUnverified(path)) ||
          view.attachments?.some(path => isVaultMarker(path) && boundaryUnverified(path));
        if (invalidBoundary) throw new VaultError('index_incomplete', 'The vault index could not verify the Obsidian vault boundaries. Inspect unsupported entries before preparing another move.');
        return Object.assign(lease, { roots, blockers, checkMembership });
      } catch (error) { lease.close(); throw error; }
    };
    try { return await acquire(); }
    catch (error) {
      // Reconcile a missed event or a scan raced by an external writer. Keep
      // this bounded and keep using the index's normal grant and scan limits.
      if (!(error instanceof VaultError && error.category === 'conflict') || signal.aborted) throw error;
      lane.actor.hint();
      return acquire();
    }
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
    const lane: Lane = { watches: new Map(), degraded: false, warnings: new Set(), open: verifiedRoot,
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

  private failure(category: string, stage: 'index_refresh' | 'index_access' = 'index_refresh', nextAction?: string) {
    this.diagnose(stage, category);
    return new VaultError(category, nextAction ?? 'The local vault index could not refresh. Check source access or try again after reconciliation.', true);
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
    const notes: IndexedNote[] = [], directories = new Set<string>(), attachments = new Set<string>(), omissions = new Map<string, IndexOmission>();
    const stamps = new Map<string, string>(), blockers = new Map<string, IndexOmission>();
    const scopes = paths ? [...paths] : [''];
    const starts = scopes.filter(path => !scopes.some(other => other !== path && under(path, other)));
    const untouched = (path: string) => !starts.some(scope => under(path, scope));
    const addNote = (note: IndexedNote) => { memory.add(256 + 4 * sizeOf(note)); notes.push(note); };
    const addDirectory = (path: string, stamp: string) => {
      if (!directories.has(path)) memory.add(256 + 4 * (path.length + stamp.length));
      directories.add(path); stamps.set(path, stamp);
    };
    const addAttachment = (path: string) => { memory.add(128 + 4 * path.length); attachments.add(path); };
    const omit = (path: string, kind: IndexOmission['kind'], boundary?: true) => {
      const old = omissions.get(path);
      if (!old) memory.add(128 + 4 * path.length);
      if (!old || kind === 'tree') omissions.set(path, Object.freeze({ path, kind, boundary: old?.boundary ?? boundary }));
    };
    const blockMove = (path: string, kind: IndexOmission['kind']) => {
      if (!blockers.has(path)) { memory.add(128 + 4 * path.length); blockers.set(path, Object.freeze({ path, kind })); }
    };
    const deadline = Date.now() + this.limits.scanMs;
    const check = () => {
      if (signal.aborted) throw abortError(signal);
      if (Date.now() > deadline) throw this.failure('scan_timeout', 'index_refresh', 'The local vault index scan timed out.');
    };
    let count = 0;
    try {
      memory.add(256);
      if (previous && paths) {
        for (const note of previous.notes) if (untouched(note.path)) addNote(note);
        const prior = this.moveEvidence.get(previous)!;
        for (const [path, stamp] of prior.stamps) if (untouched(path)) addDirectory(path, stamp);
        for (const entry of prior.blockers) if (untouched(entry.path)) blockMove(entry.path, entry.kind);
        for (const path of previous.attachments ?? []) if (untouched(path)) addAttachment(path);
        for (const entry of previous.omissions) if (untouched(entry.path)) omit(entry.path, entry.kind, entry.boundary);
      }
      const frontier = starts.map(path => ({ path, allowAbsent: !!paths }));
      let frontierBytes = frontier.reduce((bytes, { path }) => bytes + 2 * path.length + 128, 0);
      while (frontier.length) {
        check(); const { path, allowAbsent } = frontier.pop()!; frontierBytes -= 2 * path.length + 128;
        for await (const entry of this.files.indexDirectory(root, path, allowAbsent, (pinned, info) => {
          check(); this.watch(lane, path, pinned, info);
        })) {
          check();
          if (++count > this.limits.entries) throw this.failure('entry_cap', 'index_refresh', 'The local vault index scan reached its entry cap.');
          if (entry.kind === 'directory') addDirectory(path, entry.stamp);
          else if (entry.kind === 'attachment') addAttachment(entry.path);
          else if (entry.kind === 'unsupported') omit(entry.path, entry.scope, 'boundary' in entry ? entry.boundary : undefined);
          else if (entry.kind === 'move_blocker') blockMove(entry.path, entry.scope);
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
              let linkData: IndexedNote['linkData'];
              try {
                const parsed = parseLinks(reader.text, this.parser);
                if (sizeOf(parsed) <= 32768) linkData = parsed;
              } catch (error) { if (!(error instanceof VaultError && error.category === 'parser_limit')) throw error; }
              addNote(freeze({ linkData, path: entry.path, hash: reader.hash, readAt: reader.readAt, properties, propertyWarning, metadata,
                metadataWarning: metadata ? undefined : 'parser_limit' as const }));
            } finally { await reader.close(); }
          }
        }
      }
      if (notes.length + directories.size + attachments.size + omissions.size > this.limits.entries)
        throw this.failure('entry_cap', 'index_refresh', 'The local vault index reached its entry cap.');
      await authorize(signal); check();
      notes.sort((a, b) => a.path < b.path ? -1 : a.path === b.path ? 0 : 1);
      const warnings = new Set<string>();
      if (omissions.size || notes.some(note => !!note.propertyWarning)) warnings.add('unsupported');
      if (notes.some(note => !!note.metadataWarning || !note.linkData)) warnings.add('limit');
      const allPaths = [...notes.map(note => note.path), ...attachments];
      // Retain only the full-mirror lookup. Nested vault lookups are request scoped.
      memory.add(allPaths.reduce((bytes, path) => bytes + 256 + 4 * path.length, 0));
      const links = new VaultLinks(allPaths, '', notes);
      const view = Object.freeze({ notes: Object.freeze(notes), attachments: Object.freeze([...attachments]),
        links: (root: string) => root ? new VaultLinks(allPaths, root, notes) : links, directories: Object.freeze([...directories]),
        omissions: Object.freeze([...omissions.values()]) });
      const markers = new Set([...directories].filter(path => isVaultMarker(path) && !inVaultConfig(path))
        .map(path => path === '.obsidian' ? '' : path.slice(0, -'/.obsidian'.length)));
      const roots = [...markers].filter(path => {
        while (path) {
          path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          if (markers.has(path)) return false;
        }
        return true;
      }).sort();
      this.moveEvidence.set(view, { stamps, roots: Object.freeze(roots), blockers: Object.freeze([...blockers.values()]) });
      return { view, memory, release: memory.release,
        published: () => {
          for (const path of lane.watches.keys()) if (!directories.has(path)) this.unwatch(lane, path);
          for (const warning of warnings) if (!lane.warnings.has(warning)) this.diagnose('index_refresh', warning);
          lane.warnings = warnings;
        },
      };
    } catch (error) { memory.release(); throw error; }
  }
}
