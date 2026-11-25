import { addNoteSectionLink, firstSectionTask, moveNoteSectionLink, noteSection, replaceNoteSection } from './note-section.ts';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { provenance } from './provenance.js';
import { MAX_NOTE_BYTES, VaultError } from './ports.ts';
import { linkReference } from './vault-links.ts';
import { compilePathGlob } from './path-glob.ts';
import type { Catalog, Configuration, Diagnose, InventoryInput, MirrorCatalog, VaultFiles, NoteParser, StateRepository, Source, Metadata, PathMove, Receipt, Resolution, SearchQuery } from './ports.ts';
export const LIMITS = { output: 48000, scanNotes: 500, scanBytes: 16 * 1024 * 1024, scanMs: 3000, rows: 500, page: 50, cursors: 10, cursorMs: 60000, proofs: 256 } as const;
export const READ_LIMITS = { sessions: 4, idleMs: 5 * 60000, lifetimeMs: 30 * 60000, bytes: MAX_NOTE_BYTES, serialized: 60000 } as const;
type SourceContext = { source: Source; revision: number; catalog: Catalog };
type ReadInput = { vaultId: string; path: string; heading?: string; blockId?: string; selector?: { version: 'incoming'; token: string }; cursor?: string };
type ReadSession = { vaultId: string; path: string; selector?: ReadInput['selector']; reader: string; hash: string; revision: number; source: string; offset: number; warnings: string[]; started: number; touched: number };
const validPath = (path: string, directory?: true) => { if (!path || (!directory && !path.endsWith('.md')) || path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new VaultError('invalid_path'); return path; };
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const lines = (text: string) => Math.max(1, text.replace(/\r?\n$/, '').split('\n').length);
export class Obsidian {
  private state: Configuration = { revision: 0, vaultIds: [], pending: [] };
  private proofs = new Map<string, { hash: string; revision: number; reader: string }>();
  private reads = new Map<string, ReadSession>();
  private readReservations = 0;
  private cursors = new Map<string, { rows: any[]; offset: number; at: number; revision: number; source: string; incomplete: boolean; failures: any[]; warnings: string[] }>();
  private stopped = false;
  private stateQueue: Promise<void> = Promise.resolve();
  private configurationQueue: Promise<void> = Promise.resolve();
  private confirmedRevision?: number;
  constructor(private catalog: MirrorCatalog, private files: VaultFiles, private parser: NoteParser,
    private repository: StateRepository, private id: () => string, private clock: () => number, private diagnose: Diagnose) {}
  async start() {
    this.state = await this.repository.load() ?? this.state;
    this.files.desktopConfiguration?.(this.state);
  }
  async stop() { this.stopped = true; this.proofs.clear(); this.reads.clear(); this.cursors.clear(); }
  private key(vaultId: string, path: string) { return `${vaultId}/${path}`; }
  private invalidate() { this.proofs.clear(); this.reads.clear(); this.cursors.clear(); this.files.desktopConfiguration?.(this.state); }
  // Only durable state transitions enter this queue. Never await a note RPC in it.
  private update<T>(action: () => Promise<T>): Promise<T> {
    const task = this.stateQueue.then(async () => { if (this.stopped) throw new VaultError('unavailable'); return action(); });
    this.stateQueue = task.then(() => {}, () => {}); return task;
  }
  private async save(state: Configuration) { await this.repository.save(structuredClone(state)); this.state = state; }
  private configure<T>(action: () => Promise<T>): Promise<T> {
    const task = this.configurationQueue.then(action);
    this.configurationQueue = task.then(() => {}, () => {}); return task;
  }
  private async confirm(state: Configuration) {
    await this.files.configure(state);
    await this.update(async () => {
      if (this.state.revision !== state.revision) return;
      if (this.state.unconfirmedRevision === state.revision) await this.save({ ...this.state, unconfirmedRevision: undefined });
      this.confirmedRevision = state.revision;
    });
  }
  private async remember(catalog: Catalog) {
    await this.update(async () => {
      const names = { ...this.state.names }; let changed = false;
      for (const source of catalog.sources) if (this.state.vaultIds.includes(source.id) && names[source.id] !== source.name) { names[source.id] = source.name; changed = true; }
      if (changed) await this.save({ ...this.state, names });
    });
  }
  async connect(vaultId: string) {
    return this.configure(async () => {
      const catalog = await this.catalog.snapshot();
      if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
      const source = catalog.sources.find(s => s.id === vaultId);
      if (!source?.local.available) throw new VaultError('source_unavailable', catalog.nextAction ?? 'Check the local source in iCloud settings.');
      const next = await this.update(async () => {
        if (this.state.vaultIds.includes(vaultId)) return this.state;
        if (this.state.vaultIds.length >= 20) throw new VaultError('capacity');
        const next = { ...this.state, revision: this.state.revision + 1, vaultIds: [...this.state.vaultIds, vaultId], names: { ...this.state.names, [vaultId]: source.name }, unconfirmedRevision: this.state.revision + 1 };
        await this.save(next); this.invalidate(); return next;
      });
      await this.confirm(next);
    });
  }
  async remove(vaultId: string) {
    return this.configure(async () => {
      const catalog = await this.catalog.snapshot();
      if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
      const next = await this.update(async () => {
        if (!this.state.vaultIds.includes(vaultId)) return this.state;
        const names = { ...this.state.names }; delete names[vaultId];
        const next = { ...this.state, revision: this.state.revision + 1, vaultIds: this.state.vaultIds.filter(id => id !== vaultId), names, pending: this.state.pending?.filter(p => p.vaultId !== vaultId) ?? [], unconfirmedRevision: this.state.revision + 1 };
        await this.save(next); this.invalidate(); return next;
      });
      await this.confirm(next);
    });
  }
  private fingerprint(catalog: Catalog) { return JSON.stringify({ compatible: catalog.compatible, sources: catalog.sources.map(s => [s.id, s.local.available, s.local.reason, catalog.filesystem?.[s.id]]) }); }
  private async source(vaultId: string, desktop?: { signal?: AbortSignal }): Promise<SourceContext> {
    if (this.stopped || !this.state.vaultIds.includes(vaultId)) throw new VaultError('not_connected', 'Connect this vault in Obsidian settings.');
    const revision = this.state.revision;
    const catalog = desktop && this.catalog.desktopSnapshot ? await this.catalog.desktopSnapshot(desktop.signal) : await this.catalog.snapshot();
    if (!catalog.compatible) throw new VaultError('incompatible', catalog.nextAction ?? 'Update both plugins for note access v2.');
    const source = catalog.sources.find(s => s.id === vaultId);
    if (!source?.local.available) throw new VaultError('source_unavailable', 'Local note access is unavailable. Check this source in iCloud settings.');
    this.check(vaultId, revision);
    await this.confirm(this.state); this.check(vaultId, revision);
    await this.remember(catalog); this.check(vaultId, revision);
    return { source, revision, catalog };
  }
  private check(vaultId: string, revision: number) { if (this.stopped || this.state.revision !== revision || !this.state.vaultIds.includes(vaultId)) throw new VaultError('not_connected', 'The connected vaults changed. Check Obsidian settings.'); }
  receiptScope() {
    this.checkRevision(this.state.revision);
    return { vaultIds: [...this.state.vaultIds], revision: this.state.revision, pending: [...(this.state.pending ?? [])] };
  }
  checkReceiptScope(revision: number, vaultId?: string) {
    this.checkRevision(revision);
    if (vaultId) this.check(vaultId, revision);
  }
  finalizeReceiptMarker(operationId: string) { return this.clearPending(operationId); }
  private provenance = provenance;
  private async note(vaultId: string, path: string) {
    validPath(path); const context = await this.source(vaultId); const note = await this.files.read(vaultId, context.revision, path); this.check(vaultId, context.revision);
    return { ...context, note };
  }
  async status(input: { vaultId?: string; operationId?: string; path?: string; since?: string; limit?: number } = {}) {
    if (input.path) { validPath(input.path); if (!input.vaultId) throw new VaultError('invalid_query', 'Select an exact vault ID for path inspection.'); }
    if (input.vaultId && !this.state.vaultIds.includes(input.vaultId)) throw new VaultError('not_connected');
    const matchesPending = (pending: NonNullable<Configuration['pending']>[number]) => this.state.vaultIds.includes(pending.vaultId)
      && (!input.vaultId || pending.vaultId === input.vaultId) && (!input.path || pending.path === input.path)
      && (!input.operationId || pending.operationId === input.operationId);
    const catalog = await this.catalog.snapshot(); const revision = this.state.revision;
    if (catalog.compatible) await this.remember(catalog);
    const vaults = this.inventoryVaults(catalog);
    let conflict: { vaultId: string; path: string; inspection: Awaited<ReturnType<VaultFiles['inspect']>> } | null = null;
    let conflictFailure: string | null = null;
    const receipts: Receipt[] = []; const receiptFailures: Array<{ vaultId?: string; category: string }> = [];
    if (catalog.compatible) {
      try {
        await this.confirm(this.state); this.checkRevision(revision);
        if (input.vaultId && input.path) {
          try { conflict = { vaultId: input.vaultId, path: input.path, inspection: await this.files.inspect(input.vaultId, revision, input.path) }; this.checkRevision(revision); }
          catch (e) { this.checkRevision(revision); conflictFailure = e instanceof VaultError ? e.category : 'unavailable'; if (!(e instanceof VaultError && e.diagnosticReported)) this.diagnose('rpc', conflictFailure); }
        }
        for (const id of (input.vaultId ? [input.vaultId] : this.state.vaultIds)) {
          try {
            receipts.push(...await this.files.receipts({ mirrorId: id, revision, operationId: input.operationId, path: input.path, since: input.since, limit: Math.min(input.limit ?? 20, 100) }));
            // Recent pages are not a recovery index. Inspect each persisted ID in its own scope.
            for (const pending of (this.state.pending ?? []).filter(p => p.vaultId === id && matchesPending(p))) {
              if (receipts.some(r => r.operationId === pending.operationId)) continue;
              receipts.push(...await this.files.receipts({ mirrorId: id, revision, path: pending.path, operationId: pending.operationId, limit: 1 }));
            }
          } catch (e) { receiptFailures.push({ vaultId: id, category: e instanceof VaultError ? e.category : 'unavailable' }); }
        }
      } catch (e) { receiptFailures.push({ category: e instanceof VaultError ? e.category : 'unavailable' }); }
    } else { const category = catalog.setup === 'incompatible' ? 'incompatible' : 'source_unavailable'; receiptFailures.push({ category }); if (input.path) conflictFailure = category; }
    this.checkRevision(revision);
    const resolved = new Set(receipts.filter(r => r.outcome !== 'uncertain').map(r => r.operationId));
    const limit = Math.min(input.limit ?? 20, 100);
    const vaultIds = input.vaultId ? [input.vaultId] : this.state.vaultIds;
    const legacyMarkers = (this.state.pending ?? []).filter(matchesPending);
    let localPending;
    try {
      localPending = await this.files.statusPending?.(vaultIds, { path: input.path, operationId: input.operationId, limit }, legacyMarkers);
      localPending?.settledLegacy.forEach(id => resolved.add(id));
    } catch (error) {
      receiptFailures.push({ category: error instanceof VaultError ? error.category : 'unavailable' });
      this.diagnose('state', 'unavailable');
    }
    if (resolved.size && legacyMarkers.some(marker => resolved.has(marker.operationId))) await this.update(async () => { if (this.state.revision === revision) await this.save({ ...this.state, pending: this.state.pending?.filter(p => !resolved.has(p.operationId)) }); });
    this.checkRevision(revision);
    const knownLocal = new Set(localPending?.knownLegacy ?? []);
    const legacyPending = (this.state.pending ?? []).filter(row => matchesPending(row) && !knownLocal.has(row.operationId));
    const uncertain = [...(localPending?.rows.map(({ mirrorId, operationId, path, at, kind }) =>
      ({ vaultId: mirrorId, operationId, path, at, kind })) ?? []), ...legacyPending];
    const uncertainOperationCount = (localPending?.count ?? 0) + legacyPending.length;
    const uncertainOperations = uncertain.slice(0, limit);
    return { ...(this.files.desktopStatus ? { desktop: this.files.desktopStatus() } : {}), ...(this.files.children ? { childrenAccessVersion: 1 as const } : {}), search: catalog.search ?? { version: 1 as const, available: false, reason: 'unavailable' as const }, revision, conflict, conflictFailure, setup: catalog.setup, nextAction: catalog.nextAction, vaults, eligible: catalog.compatible ? catalog.sources.filter(s => s.local.available && !this.state.vaultIds.includes(s.id)) : [], receipts: receipts.sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit ?? 20), receiptFailures, uncertainOperations, uncertainOperationCount, uncertainOperationsIncomplete: uncertainOperations.length < uncertainOperationCount, configurationUnconfirmed: this.state.unconfirmedRevision === revision, evidenceOnly: true as const };
  }
  private inventoryVaults(catalog: Catalog) {
    return this.state.vaultIds.map(vaultId => {
      const source = catalog.sources.find(s => s.id === vaultId) ?? null;
      return { vaultId, name: (catalog.compatible ? source?.name : undefined) ?? this.state.names?.[vaultId] ?? null, source };
    });
  }
  async vaultLocations() {
    const vaults: Array<{ id: string; root: string; name: string }> = []; let incomplete = false;
    for (const id of this.state.vaultIds) {
      try {
        const { source, revision } = await this.source(id);
        const result = await this.files.vaultRoots(id, revision); this.check(id, revision);
        incomplete ||= result.incomplete;
        for (const root of result.roots) {
          if (root && (/[\\\\\x00-\x1f\x7f]/.test(root) || root.split('/').some(p => !p || p === '.' || p === '..'))) throw new VaultError('invalid_path');
          vaults.push({ id, root, name: root ? root.split('/').at(-1)! : source.name });
        }
      } catch { this.diagnose('rpc', 'unavailable'); incomplete = true; }
    }
    return { vaults, incomplete };
  }
  async vaultInventory(input: InventoryInput, signal?: AbortSignal) {
    const revision = this.state.revision;
    this.check(input.vaultId, revision);
    const inventory = this.files.vaultInventory?.bind(this.files);
    if (!inventory) throw new VaultError('desktop_setup');
    const sourceLookup = this.source(input.vaultId, { signal });
    // Once the revision is registered, Desktop's before/after grants authorize
    // the inventory independently. The status result is also required.
    const read = this.confirmedRevision === revision && this.catalog.desktopSnapshot
      ? inventory(input, revision, signal)
      : sourceLookup.then(() => inventory(input, revision, signal));
    const [{ source }, result] = await Promise.all([sourceLookup, read]);
    this.check(input.vaultId, revision);
    if (signal?.aborted) throw new VaultError('cancelled');
    const { id: vaultId, name, lastSuccess, cloudConnected, enabled, phase, failure } = source;
    return { ...result, source: { vaultId, name, lastSuccess, cloudConnected, enabled, phase, failure } };
  }
  async inventoryRevision(input: { vaultId: string; folders: string[] }, signal?: AbortSignal) {
    const revision = this.state.revision;
    this.check(input.vaultId, revision);
    const probe = this.files.inventoryRevision?.bind(this.files);
    if (!probe) throw new VaultError('desktop_setup');
    if (this.confirmedRevision !== revision) await this.source(input.vaultId, { signal });
    const token = await probe(input.vaultId, input.folders, revision, signal);
    this.check(input.vaultId, revision);
    if (signal?.aborted) throw new VaultError('cancelled');
    return token;
  }
  async listChildren(input: { vaultId: string; folder: string }, signal?: AbortSignal) {
    validPath(input.folder, true);
    const inventory = await this.vaultInventory({ vaultId: input.vaultId, root: input.folder, fields: [] }, signal);
    const parent = input.folder;
    return { entries: [
      ...inventory.folders.filter(path => posix.dirname(path) === parent).map(path => ({ name: posix.basename(path), kind: 'directory' as const })),
      ...inventory.notes.filter(row => posix.dirname(row.path) === parent).map(row => ({ name: posix.basename(row.path), kind: 'markdown' as const })),
    ], incomplete: inventory.incomplete || !inventory.folders.includes(parent) };
  }
  private async desktopRead(vaultId: string, revision: number, path: string, signal?: AbortSignal) {
    if (!this.files.desktopNote) throw new VaultError('desktop_setup');
    const text = await this.files.desktopNote(vaultId, revision, path, signal);
    return { text, hash: createHash('sha256').update(text).digest('hex'), readAt: new Date(this.clock()).toISOString(), complete: true as const };
  }
  private checkRevision(revision: number) { if (this.stopped || this.state.revision !== revision) throw new VaultError('not_connected'); }
  async read(input: ReadInput, signal?: AbortSignal, reader = '') {
    if ((input.selector || input.cursor) && (input.heading || input.blockId)) throw new VaultError('invalid_query', 'Read a section separately from incoming versions or continuations.');
    if (input.heading && input.blockId) throw new VaultError('invalid_query', 'Choose a heading or a block, not both.');
    validPath(input.path);
    const now = this.clock();
    for (const [cursor, session] of this.reads) if (now - session.touched > READ_LIMITS.idleMs || now - session.started > READ_LIMITS.lifetimeMs) this.reads.delete(cursor);
    let session = input.cursor ? this.reads.get(input.cursor) : undefined;
    if (input.cursor) {
      if (!session || session.reader !== reader || session.vaultId !== input.vaultId || session.path !== input.path || session.selector?.token !== input.selector?.token || session.revision !== this.state.revision) throw new VaultError('cursor_expired', 'Start a fresh whole-note read; this continuation is unavailable or belongs to another read.');
      // Claim before any await: overlapping/replayed calls cannot skip a page.
      this.reads.delete(input.cursor);
      this.readReservations++;
    }
    try {
    const cancelled = () => { if (signal?.aborted) throw new VaultError('cancelled'); };
    cancelled();
    const context = await this.source(input.vaultId, input.selector ? undefined : { signal });
    const incoming = input.selector ? await this.files.readIncoming(input.vaultId, context.revision, input.path, input.selector.token) : null;
    this.check(input.vaultId, context.revision); cancelled();
    if (incoming?.absent) {
      if (session) throw new VaultError('conflict', 'The incoming version changed. Inspect the conflict again.');
      return { ...this.provenance(context.source, new Date(this.clock()).toISOString()), path: input.path, selector: 'incoming', absent: true as const, complete: false as const, editReady: false, hash: null, text: undefined, nextCursor: null, warnings: [] as string[], evidenceOnly: true as const };
    }
    const note = input.selector ? incoming as import('./ports.ts').CompleteNote : await this.desktopRead(input.vaultId, context.revision, input.path, signal);
    const { source, revision } = context;
    this.check(input.vaultId, revision); cancelled();
    const totalBytes = Buffer.byteLength(note.text);
    if (!note.complete || totalBytes > READ_LIMITS.bytes || createHash('sha256').update(note.text).digest('hex') !== note.hash) throw new VaultError('unsupported', 'The source did not return a bounded, complete, hash-verified note.');
    // Desktop reads already recheck the exact directory grant before releasing
    // content. Incoming reads use the retained iCloud path.
    const catalog = !input.selector && this.files.desktopNoteReauthorizes ? context.catalog : await this.catalog.snapshot();
    this.check(input.vaultId, revision); cancelled();
    const fingerprint = this.fingerprint(catalog);
    if (fingerprint !== this.fingerprint(context.catalog) || (session && (session.hash !== note.hash || session.source !== fingerprint))) throw new VaultError('conflict', 'The note or local source changed. Start a fresh whole-note read.');
    let start = session?.offset ?? 0, end = note.text.length;
    let warnings = session ? [...session.warnings] : [];
    let metadata: Metadata | undefined;
    if (!session) {
      try { metadata = this.parser.parse(note.text); warnings = [...metadata.warnings]; }
      catch (error) { if (input.heading || input.blockId || !(error instanceof VaultError && error.category === 'parser_limit')) throw error; warnings.push('parser_limit'); this.diagnose('parse', 'limit'); }
    }
    const section = !!(input.heading || input.blockId);
    if (section) {
      const meta = metadata!;
      const candidates = input.blockId ? meta.blocks.filter(b => b.id === input.blockId) : meta.headings.filter(h => h.title.toLocaleLowerCase('und') === input.heading!.toLocaleLowerCase('und'));
      if (candidates.length !== 1) throw new VaultError(candidates.length ? 'ambiguous_link' : 'missing_link');
      start = candidates[0].start; end = candidates[0].end;
      if (input.heading) { const heading = candidates[0] as Metadata['headings'][0]; end = meta.headings.find(h => h.start > start && h.depth <= heading.depth)?.start ?? note.text.length; }
    }
    let stop = Math.min(end, start + LIMITS.output);
    // Never split a surrogate pair. Exact original text/line endings are retained.
    const boundary = (at: number) => at > start && /[\uD800-\uDBFF]/.test(note.text[at - 1]) && /[\uDC00-\uDFFF]/.test(note.text[at] ?? '') ? at - 1 : at;
    stop = boundary(stop);
    const resultAt = (at: number, nextCursor: string | null) => {
      // Paged reads require one final empty acknowledgement after all content.
      const complete = !section && (session ? start === note.text.length : at === note.text.length && nextCursor === null);
      return { ...this.provenance(source, note.readAt), path: input.path, ...(input.selector ? { selector: 'incoming', absent: false } : {}), lineStart: note.text.slice(0, start).split('\n').length, lineEnd: Math.max(note.text.slice(0, start).split('\n').length, note.text.slice(0, at).replace(/\r?\n$/, '').split('\n').length), offset: start, nextOffset: at, totalChars: note.text.length, totalBytes, text: note.text.slice(start, at), hash: note.hash, complete, editReady: complete && !input.selector && !warnings.includes('parser_limit'), warnings: at < end ? [...warnings, 'output_limit'] : warnings, evidenceOnly: true, nextCursor };
    };
    // Budget the actual JSON escaping AND provenance before issuing a cursor/proof.
    // Reserve cursor space even when a candidate might fit in a single response.
    const token = this.id();
    while (JSON.stringify(resultAt(stop, token)).length > READ_LIMITS.serialized && stop > start) stop = boundary(start + Math.floor((stop - start) / 2));
    const continued = !section && (!!session ? start < end : stop < end);
    const nextCursor = continued ? token : null;
    const result = resultAt(stop, nextCursor);
    if (JSON.stringify(result).length > READ_LIMITS.serialized || (stop === start && start < end)) throw new VaultError('output_limit', 'This read could not fit a bounded response. No edit proof was issued.');
    this.check(input.vaultId, revision); cancelled();
    if (session && (this.clock() - session.touched > READ_LIMITS.idleMs || this.clock() - session.started > READ_LIMITS.lifetimeMs)) throw new VaultError('cursor_expired', 'This read expired while checking the source. Start a fresh whole-note read.');
    if (continued) {
      if (!session) {
        if (this.reads.size + this.readReservations >= READ_LIMITS.sessions) {
          if (!this.reads.size) throw new VaultError('capacity', 'All whole-note read slots are in use. Finish an active read, then start again.');
          this.reads.delete(this.reads.keys().next().value!);
        }
        session = { vaultId: input.vaultId, path: input.path, selector: input.selector, reader, hash: note.hash, revision, source: fingerprint, offset: 0, warnings, started: now, touched: now };
      }
      this.reads.set(token, { ...session, offset: stop, touched: this.clock() });
    }
    if (result.editReady) {
      if (this.proofs.size >= LIMITS.proofs) this.proofs.delete(this.proofs.keys().next().value!);
      this.proofs.set(this.key(input.vaultId, input.path), { hash: note.hash, revision, reader });
    }
    return result;
    } finally {
      if (input.cursor) this.readReservations--;
    }
  }
  private async desktop(vaultId: string, revision: number, operation: Parameters<NonNullable<VaultFiles['desktop']>>[2], signal?: AbortSignal) {
    if (!this.files.desktop) throw new VaultError('desktop_setup');
    return this.files.desktop(vaultId, revision, operation, signal);
  }

  async metadata(input: { vaultId: string; path: string; backlinks?: boolean }, signal?: AbortSignal) {
    validPath(input.path);
    const { source, revision } = await this.source(input.vaultId);
    const note = await this.desktopRead(input.vaultId, revision, input.path, signal);
    const parsed = this.parser.parse(note.text);
    const links = parsed.links.slice(0, 100);
    const refs = links.map(link => linkReference(link.target));
    if (!this.files.desktopTargets) throw new VaultError('desktop_setup');
    const targets = await this.files.desktopTargets(input.vaultId, revision, input.path,
      refs.map(ref => ref.status === 'internal' ? ref.name : ''), signal);
    const backlinkSources = input.backlinks ? await this.desktop(input.vaultId, revision, { kind: 'backlinks', path: input.path }, signal) as string[] : [];
    this.check(input.vaultId, revision);
    let budget = 8000;
    const bounded = backlinkSources.slice(0, 200).filter(path => (budget -= JSON.stringify(path).length + 1) >= 0);
    return { ...this.provenance(source, note.readAt), path: input.path, hash: note.hash, ...parsed,
      tags: parsed.tags.slice(0, 100), headings: parsed.headings.slice(0, 100), blocks: parsed.blocks.slice(0, 100), tasks: parsed.tasks.slice(0, 100),
      links: links.map((link, i) => ({ ...link, source: input.path, resolution: refs[i].status !== 'internal' ? { status: 'unsupported' as const } :
        refs[i].name ? targets[i] :
        { status: 'resolved' as const, target: input.path } })),
      ...(input.backlinks ? { backlinks: [], backlinkSources: bounded, backlinkSourcesTruncated: bounded.length < backlinkSources.length,
        backlinksIncomplete: true, backlinkCoverage: 'partial' } : {}), evidenceOnly: true };
  }

  private async pageRows(input: { vaultId?: string; cursor?: string; limit?: number }, kind: 'search' | 'tasks', create: () => Promise<{ rows: any[]; incomplete: boolean; failures: any[]; warnings: string[] }>) {
    const revision = this.state.revision;
    const { cursor: _cursor, limit: _limit, ...filters } = input;
    const source = JSON.stringify({kind, ...filters});
    const cursor = input.cursor ?? this.id();
    let state = this.cursors.get(cursor);
    if (input.cursor && (!state || state.revision !== revision || Object.entries({ kind, ...filters }).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(JSON.parse(state!.source)[key])) || this.clock() - state.at > LIMITS.cursorMs))
      throw new VaultError('cursor_expired', 'Start a fresh query; the cursor expired or the query changed.');
    this.cursors.delete(cursor);
    if (state) for (const vaultId of new Set(state.rows.map(row => row.vaultId as string))) {
      try {
        const context = await this.source(vaultId);
        await this.desktop(vaultId, context.revision, { kind: 'start' });
      } catch (error) {
        if (error instanceof VaultError && error.category === 'source_unavailable')
          throw new VaultError('cursor_expired', 'Local access changed. Start the query again.', error.diagnosticReported);
        throw error;
      }
    }
    if (!state) state = { ...await create(), offset: 0, at: this.clock(), revision, source };
    this.checkRevision(revision);
    const results = [];
    let bytes = 0;
    while (state.offset < state.rows.length && results.length < (input.limit ?? 20)) {
      const row = state.rows[state.offset];
      bytes += JSON.stringify(row).length;
      if (bytes > LIMITS.output) {
        if (!results.length) throw new VaultError('output_limit');
        break;
      }
      results.push(row);
      state.offset++;
    }
    const nextCursor = state.offset < state.rows.length ? cursor : null;
    if (nextCursor) {
      if (this.cursors.size >= LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(cursor, state);
    }
    return { results, nextCursor, incomplete: state.incomplete, failures: state.failures, warnings: state.warnings,
      matchedNotesSoFar: state.rows.length, startedAt: new Date(state.at).toISOString(), evidenceOnly: true as const };
  }

  private async selected(input: { vaultId?: string }, read: (id: string, context: SourceContext) => Promise<{ rows: any[]; incomplete: boolean }>) {
    const rows: any[] = [], failures: Array<{ vaultId: string; category: string }> = [];
    let incomplete = false;
    const ids = input.vaultId ? [input.vaultId] : [...this.state.vaultIds];
    if (!ids.length) return { rows, failures, incomplete: false, warnings: [] };
    for (const vaultId of ids) {
      try {
        const context = await this.source(vaultId);
        const result = await read(vaultId, context);
        this.check(vaultId, context.revision);
        rows.push(...result.rows);
        incomplete ||= result.incomplete;
      } catch (error) {
        const category = error instanceof VaultError ? error.category : 'unavailable';
        if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('tool', category);
        if (['cancelled', 'not_connected', 'desktop_setup'].includes(category)) throw error;
        failures.push({ vaultId, category });
        incomplete = true;
      }
    }
    return { rows, failures, incomplete, warnings: ['desktop_visible_notes'] };
  }

  async search(input: SearchQuery, signal?: AbortSignal) {
    if (!input.cursor && !input.text && !input.tag && !input.pathGlob && !input.properties?.length && !input.folders?.length && input.mode !== 'count') throw new VaultError('invalid_query');
    const matcher = input.pathGlob ? compilePathGlob(input.pathGlob) : undefined;
    const within = (path: string, folder: string) => path === folder || path.startsWith(folder + '/');
    const result = await this.pageRows({ ...input, ...(input.mode === 'count' ? { limit: 1 } : {}) }, 'search',
      () => this.selected(input, async (vaultId, { source, revision }) => {
        if (!this.files.vaultInventory) throw new VaultError('desktop_setup');
        const files = await this.files.vaultInventory({ vaultId, root: '', folders: input.folders, fields: (input.properties ?? []).map(p => p.key), tags: !!input.tag }, revision, signal);
        const searched = input.text ? await this.desktop(vaultId, revision, { kind: 'search', query: JSON.stringify(input.text) }, signal) as Array<{ file: string; matches: { line: number; text: string }[] }> : undefined;
        const matches = searched && new Map(searched.map(row => [row.file, row.matches[0]]));
        const tag = input.tag?.replace(/^#/, '').toLocaleLowerCase('und');
        const scoped = files.notes.filter(row => (!input.excludeFolders?.some(folder => within(row.path, folder))) && (!matcher || matcher(row.path)) &&
          (!matches || matches.has(row.path)) && (!tag || row.tags?.some(t => {
            const name = t.replace(/^#/, '').toLocaleLowerCase('und');
            return name === tag || name.startsWith(tag + '/');
          })));
        const rows = scoped.filter(row => !input.properties?.some(({ key, equals }) => !Object.hasOwn(row.properties, key) || row.properties[key] !== equals))
          .map(row => {
            const match = matches?.get(row.path);
            return { ...this.provenance(source, new Date(this.clock()).toISOString()), path: row.path,
              ...(match ? { lineStart: match.line, lineEnd: match.line, snippet: match.text.slice(0, 240) } : {}),
              ...(input.properties ? { properties: row.properties } : {}) };
          });
        return { rows, incomplete: files.incomplete || !!searched && searched.length >= 10001 || scoped.some(row => row.malformed) };
      }));
    return { ...result, ...(input.mode === 'count' ? { results: [], nextCursor: null } : {}),
      coverage: {
        state: result.incomplete ? 'partial' : 'complete', failedSources: result.failures.length,
        startedAt: result.startedAt, observedAt: new Date(this.clock()).toISOString(),
        consistency: 'Desktop-visible notes in each selected vault. Desktop can omit hidden notes.',
      },
      totalMatches: result.incomplete || result.nextCursor && input.mode !== 'count' ? null : result.matchedNotesSoFar };
  }

  tasks(input: { vaultId?: string; path?: string; folder?: string; complete?: boolean; cursor?: string; limit?: number }, signal?: AbortSignal) {
    if (input.path) validPath(input.path);
    if (input.folder) validPath(input.folder, true);
    return this.pageRows(input, 'tasks', () => this.selected(input, async (vaultId, { source, revision }) => {
      const data = await this.desktop(vaultId, revision, { kind: 'tasks', path: input.path }, signal) as Array<{ file: string; line: number; status: string; text: string }>;
      return { rows: data.filter(r => (!input.folder || r.file.startsWith(input.folder + '/')) &&
        (input.complete === undefined || (r.status !== ' ') === input.complete)).map(r => ({
        ...this.provenance(source, new Date(this.clock()).toISOString()), path: r.file, lineStart: r.line,
        lineEnd: r.line, text: r.text.slice(0, 240), marker: r.status, complete: r.status !== ' ',
      })), incomplete: !input.path };
    }));
  }

  async resolve(input: { vaultId: string; path: string; link: string }, signal?: AbortSignal, reader = '') {
    validPath(input.path);
    let spelling = input.link;
    if (/^!?\[\[/.test(spelling)) spelling = spelling.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0];
    else if (/^!?\[/.test(spelling)) {
      const link = this.parser.parse(spelling).links.find(row => row.syntax === 'markdown' && row.start === 0 && row.end === spelling.length);
      if (!link) throw new VaultError('invalid_link');
      spelling = link.target;
    }
    const ref = linkReference(spelling);
    if (ref.status === 'external') throw new VaultError('external_link', 'External URLs and cross-vault references are not fetched.');
    if (ref.status !== 'internal') throw new VaultError('invalid_link');
    const { revision } = await this.source(input.vaultId);
    if (!this.files.desktopTargets) throw new VaultError('desktop_setup');
    const [resolution] = ref.name ? await this.files.desktopTargets(input.vaultId, revision, input.path, [ref.name], signal)
      : [{ status: 'resolved' as const, target: input.path }];
    const { target } = resolution;
    this.check(input.vaultId, revision);
    if (!target?.endsWith('.md')) return { vaultId: input.vaultId, ...resolution, evidenceOnly: true };
    const result = await this.read({ vaultId: input.vaultId, path: target, ...(ref.subpath.startsWith('^') ? { blockId: ref.subpath.slice(1) } : ref.subpath ? { heading: ref.subpath } : {}) }, signal, reader);
    return { ...result, target, status: 'resolved' as const };
  }

  async noteEvidence(input: { vaultId: string; path: string; operationId?: string }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    const { note, revision } = await this.note(input.vaultId, input.path);
    const parsed = this.parser.frontmatter(note.text);
    if (parsed.warnings.length) throw new VaultError('properties_unsupported');
    const receipt = input.operationId ? (await this.files.receipts({ mirrorId: input.vaultId, revision,
      operationId: input.operationId, path: input.path, limit: 1 })).find(row => row.kind === 'save') : undefined;
    this.check(input.vaultId, revision);
    return { hash: note.hash, properties: parsed.properties, receipt: receipt?.outcome ?? null };
  }

  async readNoteSection(input: { vaultId: string; path: string; heading: string }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    const { note } = await this.note(input.vaultId, input.path);
    const { text } = noteSection(this.parser, note.text, input.heading);
    if (text.length > 16000) throw new VaultError('output_limit', 'Open the section in Obsidian to read it in full.');
    return { hash: note.hash, text };
  }

  async readSectionTask(input: { vaultId: string; path: string; heading: string }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    const { note } = await this.note(input.vaultId, input.path);
    if (signal?.aborted) throw new VaultError('cancelled');
    const text = firstSectionTask(this.parser, note.text, input.heading);
    if (text && text.length > 16000) throw new VaultError('output_limit', 'Open the task in Obsidian to read it in full.');
    return { text };
  }

  writeNoteSection(input: { vaultId: string; path: string; heading: string; expectedHash: string; operationId: string; text: string }, signal?: AbortSignal) {
    return this.writeCheckedNote(input, before => replaceNoteSection(this.parser, before, input.heading, input.text), signal);
  }

  addSectionLink(input: { vaultId: string; path: string; expectedHash: string; operationId: string; heading: string; title: string; url: string }, signal?: AbortSignal) {
    return this.writeCheckedNote(input, before => addNoteSectionLink(this.parser, before, input), signal);
  }

  moveSectionLink(input: { vaultId: string; path: string; expectedHash: string; operationId: string; from: string[]; to: string; url: string }, signal?: AbortSignal) {
    return this.writeCheckedNote(input, before => moveNoteSectionLink(this.parser, before, input), signal);
  }

  private async writeCheckedNote({ vaultId, path, expectedHash, operationId }: {
    vaultId: string; path: string; expectedHash: string; operationId: string;
  }, prepare: (text: string) => string, signal?: AbortSignal) {
    let started = false;
    try {
      const version = await this.note(vaultId, path);
      if (version.note.hash !== expectedHash) return { operationId, outcome: 'not_saved' as const, reason: 'changed' as const };
      // Recheck the version in write() and in the adapter commit.
      started = true;
      const result = await this.write(vaultId, path, expectedHash, prepare, false, signal, '', operationId, false, version.revision);
      return { operationId, outcome: result.receipt.outcome };
    } catch (error) {
      if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('rpc', error instanceof VaultError ? error.category : 'unavailable');
      if (error instanceof VaultError && error.category === 'conflict')
        return { operationId, outcome: 'not_saved' as const, reason: 'changed' as const };
      if (error instanceof VaultError && ['invalid_section', 'ambiguous_link', 'properties_unsupported', 'parser_limit'].includes(error.category))
        return { operationId, outcome: 'not_saved' as const, reason: 'invalid_section' as const };
      return { operationId, outcome: started ? 'uncertain' as const : 'not_saved' as const };
    }
  }

  async writeProperties(input: { vaultId: string; path: string; expectedHash?: string; operationId?: string; set?: Record<string, unknown>; remove?: string[] }, signal?: AbortSignal) {
    const { note, revision } = await this.note(input.vaultId, input.path);
    const operationId = input.operationId ?? this.operationId();
    if (input.expectedHash && input.expectedHash !== note.hash) return { operationId, outcome: 'not_saved' as const };
    const reader = this.id();
    this.proofs.set(this.key(input.vaultId, input.path), { hash: note.hash, revision, reader });
    try {
      const result = await this.properties({ ...input, expectedHash: note.hash }, signal, reader, operationId);
      return { operationId, outcome: result.receipt.outcome };
    } catch (error) {
      if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('rpc', error instanceof VaultError ? error.category : 'unavailable');
      return { operationId, outcome: error instanceof VaultError && ['conflict', 'properties_unsupported', 'cancelled', 'complete_read_required', 'desktop_setup'].includes(error.category)
        ? 'not_saved' as const : 'uncertain' as const };
    } finally {
      const proof = this.proofs.get(this.key(input.vaultId, input.path));
      if (proof?.reader === reader) this.proofs.delete(this.key(input.vaultId, input.path));
    }
  }

  async movePath(input: Omit<PathMove, 'operationId'> & { operationId?: string }, signal?: AbortSignal) {
    const { revision } = await this.source(input.vaultId);
    if (!this.files.movePath) throw new VaultError('desktop_setup');
    const operationId = input.operationId ?? this.operationId();
    await this.update(() => this.assertLegacyFree(input.vaultId, [input.path, input.destination], revision));
    if (this.state.moves?.some(row => row.operationId === operationId)) throw new VaultError('operation_reused');
    const result = await this.files.movePath({ ...input, operationId }, revision, signal);
    try { this.check(input.vaultId, revision); }
    catch { return { ...result, outcome: 'uncertain' as const }; }
    return result;
  }

  async moveReceipt(input: { vaultId: string; operationId: string }) {
    const { revision } = await this.source(input.vaultId);
    const receipt = await this.files.moveReceipt?.(input.vaultId, revision, input.operationId) ?? null;
    const old = this.state.moves?.find(row => row.vaultId === input.vaultId && row.operationId === input.operationId);
    this.check(input.vaultId, revision);
    if (!old) return receipt;
    const outcome = old.refused ? 'not_moved' : receipt?.outcome ?? 'uncertain';
    const legacy = { paired: old.project === 'paired', ...(old.expectedHash ? { expectedHash: old.expectedHash } : {}), ...(old.root ? { root: old.root } : {}), outcome: outcome !== 'moved_locally_pending_sync' ? outcome :
      old.repairs.every(row => row.outcome === 'saved') && (old.verification?.state === 'verified' || (!old.project && !old.verifyLinks))
        ? 'moved_supported_links_updated' as const : 'moved_links_partial' as const };
    const { vaultId, path, destination, operationId } = old;
    return { vaultId, path, destination, operationId, outcome, legacy };
  }

  private async assertLegacyFree(vaultId: string, paths: string[], revision: number) {
    this.check(vaultId, revision);
    const markers = (this.state.pending ?? []).filter(row =>
      row.vaultId === vaultId && paths.some(path => overlaps(path, row.path)));
    if (!markers.length) return;
    const status = await this.files.statusPending?.([vaultId], { limit: 1 }, markers);
    const settled = new Set(status?.settledLegacy ?? []);
    if (settled.size) await this.save({ ...this.state, pending: this.state.pending?.filter(row => !settled.has(row.operationId)) });
    if (markers.some(row => !settled.has(row.operationId)))
      throw new VaultError('uncertain', 'Inspect the earlier operation receipt before changing these paths.');
  }
  private usesLocalReceipts(vaultId: string, catalog: Catalog, native = false) {
    return this.files.localReceiptWrites ? native || catalog.filesystem?.[vaultId] === 'ready' : undefined;
  }
  private async pending(vaultId: string, path: string, operationId: string, revision: number, kind: 'save' | 'resolution', local?: boolean) {
    await this.update(async () => {
      await this.assertLegacyFree(vaultId, [path], revision);
      if (local) return;
      if ((this.state.pending?.length ?? 0) >= 100) throw new VaultError('capacity', 'Inspect unresolved operations before preparing more writes.');
      await this.save({ ...this.state, pending: [...(this.state.pending ?? []), { operationId, vaultId, path, kind, at: new Date(this.clock()).toISOString() }] });
    });
  }
  private async clearPending(operationId: string) { await this.update(async () => {
    if (this.state.pending?.some(p => p.operationId === operationId)) await this.save({ ...this.state, pending: this.state.pending?.filter(p => p.operationId !== operationId) });
  }); }
  private operationId() { const time = Math.floor(this.clock()).toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${this.id().slice(15)}`; }
  private async write(vaultId: string, path: string, expectedHash: string | null, prepare: (text: string) => string, create = false, signal?: AbortSignal, reader = '', requestedOperationId?: string, native = false, checkedRevision?: number) {
    if (signal?.aborted) throw new VaultError('cancelled');
    validPath(path); const { revision, source, catalog } = await this.source(vaultId);
    let text = '';
    if (!create) {
      const proof = this.proofs.get(this.key(vaultId, path));
      if (checkedRevision !== undefined ? checkedRevision !== revision : !proof || proof.hash !== expectedHash || proof.revision !== revision || proof.reader !== reader)
        throw new VaultError('complete_read_required', 'Read the complete note, then prepare a change against its whole-note hash.');
      const current = await this.files.read(vaultId, revision, path); this.check(vaultId, revision);
      if (current.hash !== expectedHash) { this.proofs.delete(this.key(vaultId, path)); throw new VaultError('conflict', 'The note changed. Reread it and prepare a fresh change.'); } text = current.text;
    }
    const next = prepare(text); const metadata = this.parser.parse(next);
    if (metadata.warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported', 'The proposed note has malformed or unsupported properties. Correct the explicit change before saving.');
    const oldTags = this.parser.frontmatter(text).properties.tags as string[] | undefined;
    const newTags = metadata.properties.tags as string[] | undefined;
    const removedPropertyTags = (oldTags ?? []).filter(tag => !newTags?.includes(tag));
    this.check(vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
    const operationId = requestedOperationId ?? this.operationId();
    const local = this.usesLocalReceipts(vaultId, catalog, native);
    await this.pending(vaultId, path, operationId, revision, 'save', local);
    try {
      this.check(vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
      // The file adapter rechecks authorization immediately before local publication.
      const input = { mirrorId: vaultId, revision, path, operationId, expectedHash, text: next, ...(local === undefined ? {} : { local }), kind: create ? 'create' as const : 'replace' as const };
      if (native && !this.files.desktopCommit) throw new VaultError('desktop_setup', 'Configure Desktop for these note edits.');
      const receipt = native ? await this.files.desktopCommit!(input, text, signal) : await this.files.commit(input);
      if (!local && receipt.outcome !== 'uncertain') await this.clearPending(operationId);
      this.proofs.delete(this.key(vaultId, path)); this.check(vaultId, revision);
      return { ...this.provenance(source, receipt.at), path, lineStart: 1, lineEnd: lines(next), operationId, receipt: { ...receipt, kind: 'save' as const }, change: { previousHash: expectedHash, hash: receipt.hash, beforeBytes: Buffer.byteLength(text), afterBytes: Buffer.byteLength(next), removedPropertyTags }, message: receipt.outcome === 'saved_locally_pending_sync' ? 'Saved locally, pending iCloud sync. This does not verify delivery to iCloud or a phone.' : 'The outcome is not a confirmed save. Inspect receipts; do not repeat the edit.' };
    } catch (e) {
      if (!local && e instanceof VaultError && ['busy', 'conflict', 'capacity', 'cancelled', 'invalid_path', 'unsupported', 'not_connected', 'source_unavailable', 'operation_reused', 'incompatible', 'desktop_setup'].includes(e.category)) await this.clearPending(operationId);
      throw e;
    }
  }
  async recover(input: { vaultId: string; path: string; token: string; expectedLogicalHash: string; expectedIncomingHash: string | null; choice: Resolution['choice']; text?: string }, signal?: AbortSignal) {
    if (signal?.aborted) throw new VaultError('cancelled');
    validPath(input.path); const { revision, source, catalog } = await this.source(input.vaultId);
    if ((input.choice === 'replace') !== (input.text !== undefined)) throw new VaultError('ambiguous_edit');
    if (input.text !== undefined && this.parser.parse(input.text).warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported');
    const operationId = this.operationId();
    const local = this.usesLocalReceipts(input.vaultId, catalog);
    await this.pending(input.vaultId, input.path, operationId, revision, 'resolution', local);
    let resolved = false;
    try {
      this.check(input.vaultId, revision); if (signal?.aborted) throw new VaultError('cancelled');
      const result = await this.files.resolve({ ...(local === undefined ? {} : { local }), mirrorId: input.vaultId, revision, path: input.path, operationId, token: input.token, expectedLogicalHash: input.expectedLogicalHash, expectedIncomingHash: input.expectedIncomingHash, choice: input.choice, ...(input.text === undefined ? {} : { text: input.text }) });
      resolved = true;
      const matches = await this.files.receipts({ mirrorId: input.vaultId, revision, path: input.path, operationId, limit: 1 });
      const receipt = matches.find((r): r is Extract<Receipt, { kind: 'resolution' }> => r.kind === 'resolution' && r.operationId === operationId && r.path === input.path);
      if (!receipt || receipt.outcome !== result.outcome || receipt.hash !== result.hash) throw new VaultError('uncertain', 'Inspect the exact resolution receipt; do not repeat the choice.');
      if (!local) await this.clearPending(operationId);
      this.proofs.delete(this.key(input.vaultId, input.path)); this.check(input.vaultId, revision);
      return { ...this.provenance(source, receipt.at), path: input.path, operationId, receipt, message: result.outcome === 'adopted_absence' ? 'Adopted incoming absence locally; no cloud deletion was requested.' : 'Resolution recorded locally; cloud delivery is not verified.' };
    } catch (e) {
      if (!local && !resolved && e instanceof VaultError && ['busy', 'conflict', 'capacity', 'cancelled', 'invalid_path', 'unsupported', 'not_connected', 'source_unavailable', 'operation_reused', 'incompatible'].includes(e.category)) await this.clearPending(operationId);
      if (resolved && !(e instanceof VaultError && e.category === 'uncertain')) throw new VaultError('uncertain', 'The resolution was recorded but its receipt could not be confirmed. Inspect the exact operation ID; do not repeat it.');
      throw e;
    }
  }
  create(input: { vaultId: string; path: string; text: string; operationId?: string }, signal?: AbortSignal) { return this.write(input.vaultId, input.path, null, () => input.text, true, signal, undefined, input.operationId); }
  edit(input: { vaultId: string; path: string; expectedHash?: string; resolution?: { token: string; expectedLogicalHash: string; expectedIncomingHash: string | null; choice: Resolution['choice']; text?: string }; append?: string; replacements?: Array<{ oldText: string; newText: string }>; task?: { line: number; marker: string } }, signal?: AbortSignal, reader = '') {
    if (input.resolution) { if (input.expectedHash !== undefined || input.append !== undefined || input.replacements !== undefined || input.task !== undefined) throw new VaultError('ambiguous_edit'); return this.recover({ vaultId: input.vaultId, path: input.path, ...input.resolution }, signal); }
    if (!input.expectedHash) throw new VaultError('complete_read_required');
    return this.write(input.vaultId, input.path, input.expectedHash, text => {
      if ([input.append !== undefined, !!input.replacements?.length, !!input.task].filter(Boolean).length !== 1) throw new VaultError('ambiguous_edit');
      if (input.task) { const task = this.parser.parse(text).tasks.filter(t => t.line === input.task!.line); if (task.length !== 1 || [...input.task.marker].length !== 1 || /[\]\r\n]/.test(input.task.marker)) throw new VaultError('ambiguous_edit'); return this.parser.edit(text, [{ oldText: text.slice(task[0].start, task[0].end), newText: text.slice(task[0].start, task[0].markerOffset) + input.task.marker + text.slice(task[0].markerOffset + task[0].marker.length, task[0].end) }]); }
      return input.append !== undefined ? this.parser.edit(text, []) + input.append : this.parser.edit(text, input.replacements!);
    }, false, signal, reader, undefined, !!input.task);
  }
  properties(input: { vaultId: string; path: string; expectedHash: string; set?: Record<string, unknown>; remove?: string[]; addAliases?: string[] }, signal?: AbortSignal, reader = '', operationId?: string) {
    return this.write(input.vaultId, input.path, input.expectedHash, text => { const set = { ...input.set }; if (input.addAliases?.length) { if ('aliases' in set || input.remove?.includes('aliases')) throw new VaultError('ambiguous_edit'); set.aliases = [...new Set([...this.parser.parse(text).aliases, ...input.addAliases])]; } return this.parser.properties(text, { set, remove: input.remove ?? [] }); }, false, signal, reader, operationId, !input.addAliases?.length && Object.keys(input.set ?? {}).length + (input.remove?.length ?? 0) === 1);
  }
}
