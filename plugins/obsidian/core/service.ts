import { posix } from 'node:path';
import { VaultError } from './ports.ts';
import type { Catalog, Configuration, MirrorCatalog, VaultFiles, NoteParser, StateRepository, Diagnose, Source, Metadata } from './ports.ts';
export const LIMITS = { output: 48000, scanNotes: 500, scanBytes: 16 * 1024 * 1024, scanMs: 3000, rows: 500, page: 50, cursors: 10, cursorMs: 60000, proofs: 256 } as const;
const validPath = (path: string) => { if (!path || !path.endsWith('.md') || path.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new VaultError('invalid_path'); return path; };
const lines = (text: string) => Math.max(1, text.replace(/\r?\n$/, '').split('\n').length);
export class Obsidian {
  private state: Configuration = { revision: 0, vaultIds: [], pending: [] };
  private proofs = new Map<string, { hash: string; revision: number }>();
  private cursors = new Map<string, { rows: any[]; offset: number; at: number; revision: number; source: string; incomplete: boolean; failures: any[]; warnings: string[] }>();
  private busy = false; private stopped = false;
  constructor(private catalog: MirrorCatalog, private files: VaultFiles, private parser: NoteParser, private repository: StateRepository, private id: () => string, private clock: () => number, private diagnose: Diagnose) {}
  async start() { this.state = await this.repository.load() ?? this.state; }
  stop() { this.stopped = true; this.proofs.clear(); this.cursors.clear(); }
  private key(vaultId: string, path: string) { return `${vaultId}/${path}`; }
  private invalidate() { this.proofs.clear(); this.cursors.clear(); }
  private async change<T>(action: () => Promise<T>): Promise<T> { if (this.busy || this.stopped) throw new VaultError('busy'); this.busy = true; try { return await action(); } finally { this.busy = false; } }
  private async save(state: Configuration) { await this.repository.save(structuredClone(state)); this.state = state; }
  async connect(vaultId: string) {
    return this.change(async () => {
      const catalog = await this.catalog.snapshot(); const source = catalog.sources.find(s => s.id === vaultId);
      if (!source?.initialized || !source.lastSuccess || !['ready', 'paused'].includes(source.phase) || source.failure) throw new VaultError('source_unavailable', catalog.nextAction ?? 'Finish initial sync in iCloud settings.');
      if (this.state.vaultIds.includes(vaultId)) return;
      if (this.state.vaultIds.length >= 20) throw new VaultError('capacity');
      const next = { ...this.state, revision: this.state.revision + 1, vaultIds: [...this.state.vaultIds, vaultId] };
      await this.save(next); this.invalidate(); await this.files.configure(next);
    });
  }
  async remove(vaultId: string) {
    return this.change(async () => {
      const next = { revision: this.state.revision + 1, vaultIds: this.state.vaultIds.filter(id => id !== vaultId), pending: this.state.pending?.filter(p => p.vaultId !== vaultId) ?? [] };
      await this.save(next); this.invalidate(); await this.files.configure(next);
    });
  }
  private fingerprint(catalog: Catalog) { return JSON.stringify({ setup: catalog.setup, connected: catalog.connected, sources: catalog.sources }); }
  private async source(vaultId: string, write = false) {
    if (this.stopped || !this.state.vaultIds.includes(vaultId)) throw new VaultError('not_connected', 'Connect this vault in Obsidian settings.');
    const revision = this.state.revision; const catalog = await this.catalog.snapshot();
    const source = catalog.sources.find(s => s.id === vaultId);
    if (!source?.initialized || !source.lastSuccess || source.failure || !['ready', 'paused'].includes(source.phase) || (write && (!catalog.connected || !source.enabled || source.phase !== 'ready'))) throw new VaultError(source?.phase === 'running' ? 'busy' : 'source_unavailable', catalog.nextAction ?? 'Check this vault in iCloud settings.');
    this.check(vaultId, revision); await this.files.configure(this.state); this.check(vaultId, revision);
    return { source, revision, catalog };
  }
  private check(vaultId: string, revision: number) { if (this.stopped || this.state.revision !== revision || !this.state.vaultIds.includes(vaultId)) throw new VaultError('not_connected', 'The connected vaults changed. Check Obsidian settings.'); }
  private provenance(source: Source, at: string) { return { vaultId: source.id, vaultName: source.name, localObservedAt: at, lastSuccessfulSync: source.lastSuccess, stale: source.phase !== 'ready' || !source.enabled, delivery: 'Local observation only; a sync timestamp is not proof of these bytes in iCloud or on a device.' }; }
  private async note(vaultId: string, path: string, write = false) {
    validPath(path); const context = await this.source(vaultId, write); const note = await this.files.read(vaultId, context.revision, path); this.check(vaultId, context.revision);
    return { ...context, note };
  }
  async status(input: { vaultId?: string; operationId?: string; path?: string; since?: string; limit?: number } = {}) {
    if (input.path) validPath(input.path);
    if (input.vaultId && !this.state.vaultIds.includes(input.vaultId)) throw new VaultError('not_connected');
    const catalog = await this.catalog.snapshot(); const revision = this.state.revision;
    const vaults = this.state.vaultIds.map(id => ({ vaultId: id, source: catalog.sources.find(s => s.id === id) ?? null }));
    const receipts: any[] = []; const receiptFailures: any[] = [];
    try {
      await this.files.configure(this.state);
      for (const id of (input.vaultId ? [input.vaultId] : this.state.vaultIds)) {
        try { receipts.push(...await this.files.receipts({ mirrorId: id, revision, operationId: input.operationId, path: input.path, since: input.since, limit: Math.min(input.limit ?? 20, 100) })); }
        catch (e) { receiptFailures.push({ vaultId: id, category: e instanceof VaultError ? e.category : 'unavailable' }); }
      }
    } catch (e) { receiptFailures.push({ category: e instanceof VaultError ? e.category : 'unavailable' }); }
    if (revision !== this.state.revision) throw new VaultError('not_connected');
    const resolved = new Set(receipts.filter(r => r.outcome !== 'uncertain').map(r => r.operationId));
    if (this.state.pending?.some(p => resolved.has(p.operationId))) await this.change(() => this.save({ ...this.state, pending: this.state.pending?.filter(p => !resolved.has(p.operationId)) }));
    if (revision !== this.state.revision) throw new VaultError('not_connected');
    return { revision, setup: catalog.setup, nextAction: catalog.nextAction, vaults, eligible: catalog.sources.filter(s => s.initialized && s.lastSuccess && ['ready', 'paused'].includes(s.phase) && !s.failure && !this.state.vaultIds.includes(s.id)), receipts: receipts.sort((a, b) => b.at.localeCompare(a.at)).slice(0, input.limit ?? 20), receiptFailures, uncertainOperations: (this.state.pending ?? []).filter(p => this.state.vaultIds.includes(p.vaultId)), evidenceOnly: true as const };
  }
  async read(input: { vaultId: string; path: string; heading?: string; blockId?: string }) {
    if (input.heading && input.blockId) throw new VaultError('invalid_query', 'Choose a heading or a block, not both.');
    const { source, revision, note } = await this.note(input.vaultId, input.path); let start = 0; let end = note.text.length; let warnings: string[] = [];
    let metadata: Metadata | undefined;
    try { metadata = this.parser.parse(note.text); warnings = metadata.warnings; }
    catch (error) { if (input.heading || input.blockId || !(error instanceof VaultError && error.category === 'parser_limit')) throw error; warnings.push('parser_limit'); this.diagnose('parse', 'limit'); }
    if (input.heading || input.blockId) {
      const meta = metadata!;
      const candidates = input.blockId ? meta.blocks.filter(b => b.id === input.blockId) : meta.headings.filter(h => h.title.toLocaleLowerCase('und') === input.heading!.toLocaleLowerCase('und'));
      if (candidates.length !== 1) throw new VaultError(candidates.length ? 'ambiguous_link' : 'missing_link');
      start = candidates[0].start; end = candidates[0].end;
      if (input.heading) { const heading = candidates[0] as Metadata['headings'][0]; end = meta.headings.find(h => h.start > start && h.depth <= heading.depth)?.start ?? note.text.length; }
    }
    const selected = note.text.slice(start, end); const text = selected.slice(0, LIMITS.output); const complete = !input.heading && !input.blockId && text.length === note.text.length;
    if (text.length < selected.length) warnings.push('output_limit');
    this.check(input.vaultId, revision);
    if (complete) { if (this.proofs.size >= LIMITS.proofs) this.proofs.delete(this.proofs.keys().next().value!); this.proofs.set(this.key(input.vaultId, input.path), { hash: note.hash, revision }); }
    return { ...this.provenance(source, note.readAt), path: input.path, lineStart: note.text.slice(0, start).split('\n').length, lineEnd: note.text.slice(0, start + text.length).replace(/\r?\n$/, '').split('\n').length, text, hash: note.hash, complete, warnings, evidenceOnly: true };
  }
  async metadata(input: { vaultId: string; path: string }) {
    const { source, revision, note } = await this.note(input.vaultId, input.path); const meta = this.parser.parse(note.text);
    const compact = { ...meta, tags: meta.tags.slice(0, 100), links: meta.links.slice(0, 100), headings: meta.headings.slice(0, 100), blocks: meta.blocks.slice(0, 100), tasks: meta.tasks.slice(0, 100) };
    if (['tags', 'links', 'headings', 'blocks', 'tasks'].some(key => (meta as any)[key].length > 100)) compact.warnings.push('metadata_limit');
    this.check(input.vaultId, revision);
    return { ...this.provenance(source, note.readAt), path: input.path, hash: note.hash, lineStart: 1, lineEnd: lines(note.text), ...compact, evidenceOnly: true };
  }
  private async scan(vaultId: string | undefined, visitor: (source: Source, path: string, text: string, hash: string, at: string) => any[]) {
    const ids = vaultId ? [vaultId] : [...this.state.vaultIds]; const revision = this.state.revision; const rows: any[] = []; const failures: any[] = []; const warnings = new Set<string>(); let incomplete = false; let count = 0; let bytes = 0; const started = this.clock();
    for (const id of ids) {
      try {
        const { source, revision: rev } = await this.source(id); const listed = await this.files.list(id, rev); incomplete ||= listed.incomplete; listed.warnings.forEach(w => warnings.add(w));
        for (const path of listed.paths) {
          if (++count > LIMITS.scanNotes || bytes > LIMITS.scanBytes || this.clock() - started > LIMITS.scanMs || rows.length >= LIMITS.rows) { incomplete = true; warnings.add('scan_limit'); break; }
          try { const note = await this.files.read(id, rev, path); bytes += Buffer.byteLength(note.text); this.check(id, rev); rows.push(...visitor(source, path, note.text, note.hash, note.readAt)); }
          catch (e) { if (this.state.revision !== revision) throw e; incomplete = true; warnings.add(e instanceof VaultError && e.category === 'parser_limit' ? 'parser_limit' : 'note_unavailable'); this.diagnose('parse', e instanceof VaultError && e.category === 'parser_limit' ? 'limit' : 'unavailable'); }
        }
      } catch (e) { failures.push({ vaultId: id, category: e instanceof VaultError ? e.category : 'unavailable' }); incomplete = true; }
    }
    if (revision !== this.state.revision) throw new VaultError('not_connected');
    return { rows: rows.slice(0, LIMITS.rows), failures, warnings: [...warnings], incomplete };
  }
  private async page(input: { cursor?: string; limit?: number }, create: () => Promise<{ rows: any[]; failures: any[]; warnings: string[]; incomplete: boolean }>) {
    const revision = this.state.revision; const catalog = await this.catalog.snapshot();
    if (revision !== this.state.revision || this.stopped) throw new VaultError('not_connected');
    const source = this.fingerprint(catalog); const limit = Math.max(1, Math.min(input.limit ?? 20, LIMITS.page));
    let cursor = input.cursor; let state = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!state || state.revision !== this.state.revision || state.source !== source || this.clock() - state.at > LIMITS.cursorMs)) throw new VaultError('cursor_expired', 'Start a fresh search; sources or connected vaults changed.');
    if (!state) { const result = await create(); if (revision !== this.state.revision || this.stopped) throw new VaultError('not_connected'); state = { ...result, offset: 0, at: this.clock(), revision, source }; cursor = this.id(); if (this.cursors.size >= LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!); this.cursors.set(cursor, state); }
    const results: any[] = []; let size = 0;
    while (results.length < limit && state.offset < state.rows.length) { const row = state.rows[state.offset]; const length = JSON.stringify(row).length; if (size + length > LIMITS.output) break; results.push(row); size += length; state.offset++; }
    const nextCursor = state.offset < state.rows.length ? cursor : null;
    if (!nextCursor) this.cursors.delete(cursor!);
    return { results, nextCursor, incomplete: state.incomplete, failures: state.failures, warnings: state.warnings, evidenceOnly: true };
  }
  search(input: { vaultId?: string; text?: string; tag?: string; cursor?: string; limit?: number }) {
    if (!input.cursor && !input.text && !input.tag) throw new VaultError('invalid_query');
    return this.page(input, () => this.scan(input.vaultId, (source, path, text, hash, at) => {
      const needle = input.text; const index = needle ? text.toLocaleLowerCase('und').indexOf(needle.toLocaleLowerCase('und')) : 0;
      if (index < 0) return [];
      let line = text.slice(0, index).split('\n').length;
      if (input.tag) { const query = input.tag.replace(/^#/, '').toLocaleLowerCase('und'); const match = this.parser.parse(text).tags.find(t => t.tag === query || t.tag.startsWith(query + '/')); if (!match) return []; if (!needle) line = match.line; }
      return [{ ...this.provenance(source, at), path, lineStart: line, lineEnd: line, snippet: text.split('\n')[line - 1].replace(/\r$/, '').slice(0, 240), hash }];
    }));
  }
  tasks(input: { vaultId?: string; path?: string; folder?: string; complete?: boolean; cursor?: string; limit?: number }) {
    if (input.path) validPath(input.path); if (input.folder && (input.folder.startsWith('/') || input.folder.split('/').some(p => p === '..' || p === '.') || /[\\:\x00-\x1f]/.test(input.folder))) throw new VaultError('invalid_path');
    return this.page(input, () => this.scan(input.vaultId, (source, path, text, hash, at) => {
      if ((input.path && path !== input.path) || (input.folder && !path.startsWith(input.folder.replace(/\/$/, '') + '/'))) return [];
      return this.parser.parse(text).tasks.filter(t => input.complete === undefined || input.complete === t.complete).map(t => ({ ...this.provenance(source, at), path, lineStart: t.line, lineEnd: t.endLine, text: t.text.slice(0, 240), marker: t.marker, complete: t.complete, hash }));
    }));
  }
  async resolve(input: { vaultId: string; path: string; link: string }) {
    await this.note(input.vaultId, input.path); let reference = input.link.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0];
    try { reference = decodeURIComponent(reference); } catch { throw new VaultError('invalid_link'); }
    if (/^[A-Za-z][\w+.-]*:/.test(reference) || reference.startsWith('//') || reference.includes('\\') || reference.includes('\0')) throw new VaultError('external_link', 'External URLs and cross-vault references are not fetched.');
    const separator = reference.indexOf('#'); const target = separator < 0 ? reference : reference.slice(0, separator); const subpath = separator < 0 ? '' : reference.slice(separator + 1);
    const { revision } = await this.source(input.vaultId); const listed = await this.files.list(input.vaultId, revision); let candidates: string[];
    if (!target) candidates = [input.path];
    else if (target.includes('/')) {
      const relative = target.startsWith('./') || target.startsWith('../'); const normalized = posix.normalize(relative ? posix.join(posix.dirname(input.path), target) : target.replace(/^\//, '')); validPath(normalized.endsWith('.md') ? normalized : normalized + '.md');
      const path = normalized.endsWith('.md') ? normalized : normalized + '.md'; candidates = listed.paths.includes(path) ? [path] : [];
    } else { const name = target.replace(/\.md$/, '').toLocaleLowerCase('und'); candidates = listed.paths.filter(path => posix.basename(path, '.md').toLocaleLowerCase('und') === name); }
    this.check(input.vaultId, revision);
    if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : listed.incomplete ? 'incomplete' : 'missing', vaultId: input.vaultId, candidates: candidates.slice(0, 20), incomplete: listed.incomplete, evidenceOnly: true };
    const resolved = await this.read({ vaultId: input.vaultId, path: candidates[0], ...(subpath.startsWith('^') ? { blockId: subpath.slice(1) } : subpath ? { heading: subpath } : {}) });
    return { status: 'resolved', ...resolved };
  }
  private async write(vaultId: string, path: string, expectedHash: string | null, prepare: (text: string) => string, create = false, signal?: AbortSignal) {
    return this.change(async () => {
      if (signal?.aborted) throw new VaultError('cancelled');
      validPath(path); const { revision, source } = await this.source(vaultId, true);
      if (this.state.pending?.some(p => p.vaultId === vaultId && p.path === path)) throw new VaultError('uncertain', 'Inspect recent operation receipts before preparing another edit to this note.');
      let text = '';
      if (!create) {
        const proof = this.proofs.get(this.key(vaultId, path)); if (!proof || proof.hash !== expectedHash || proof.revision !== revision) throw new VaultError('complete_read_required', 'Read the complete note, then prepare a change against its whole-note hash.');
        const current = await this.files.read(vaultId, revision, path); if (current.hash !== expectedHash) { this.proofs.delete(this.key(vaultId, path)); throw new VaultError('conflict', 'The note changed. Reread it and prepare a fresh change.'); } text = current.text;
      }
      const next = prepare(text); const metadata = this.parser.parse(next);
      if (metadata.warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported', 'The proposed note has malformed or unsupported properties. Correct the explicit change before saving.');
      const time = Math.floor(this.clock()).toString(16).padStart(12, '0');
      const operationId = `${time.slice(0, 8)}-${time.slice(8)}-7${this.id().slice(15)}`; this.check(vaultId, revision);
      if (signal?.aborted) throw new VaultError('cancelled');
      if ((this.state.pending?.length ?? 0) >= 100) throw new VaultError('capacity', 'Inspect unresolved operations before preparing more writes.');
      await this.save({ ...this.state, pending: [...(this.state.pending ?? []), { operationId, vaultId, path, at: new Date(this.clock()).toISOString() }] });
      this.invalidate();
      try {
        if (signal?.aborted) throw new VaultError('cancelled');
        // After RPC submission, do not abandon the atomic commit or invent a
        // cancellation result. The durable operation remains inspectable.
        const receipt = await this.files.commit({ mirrorId: vaultId, revision, path, operationId, expectedHash, text: next, kind: create ? 'create' : 'replace' });
        if (receipt.outcome !== 'uncertain') await this.save({ ...this.state, pending: this.state.pending?.filter(p => p.operationId !== operationId) });
        const oldTags = this.parser.parse(text).properties.tags as string[] | undefined; const newTags = this.parser.parse(next).properties.tags as string[] | undefined;
        return { ...this.provenance(source, receipt.at), path, lineStart: 1, lineEnd: lines(next), operationId, receipt, change: { previousHash: expectedHash, hash: receipt.hash, beforeBytes: Buffer.byteLength(text), afterBytes: Buffer.byteLength(next), removedPropertyTags: (oldTags ?? []).filter(t => !newTags?.includes(t)) }, message: receipt.outcome === 'saved_locally_pending_sync' ? 'Saved locally, pending iCloud sync. This does not verify delivery to iCloud or a phone.' : 'The outcome is not a confirmed save. Inspect receipts; do not repeat the edit.' };
      } catch (e) {
        if (e instanceof VaultError && ['busy', 'conflict', 'capacity', 'cancelled', 'invalid_path', 'unsupported', 'not_connected', 'source_unavailable', 'operation_reused'].includes(e.category)) await this.save({ ...this.state, pending: this.state.pending?.filter(p => p.operationId !== operationId) });
        throw e;
      }
    });
  }
  create(input: { vaultId: string; path: string; text: string }, signal?: AbortSignal) { return this.write(input.vaultId, input.path, null, () => input.text, true, signal); }
  edit(input: { vaultId: string; path: string; expectedHash: string; append?: string; replacements?: Array<{ oldText: string; newText: string }>; task?: { line: number; marker: string } }, signal?: AbortSignal) {
    return this.write(input.vaultId, input.path, input.expectedHash, text => {
      if ([input.append !== undefined, !!input.replacements?.length, !!input.task].filter(Boolean).length !== 1) throw new VaultError('ambiguous_edit');
      if (input.task) { const task = this.parser.parse(text).tasks.filter(t => t.line === input.task!.line); if (task.length !== 1 || [...input.task.marker].length !== 1 || /[\]\r\n]/.test(input.task.marker)) throw new VaultError('ambiguous_edit'); return this.parser.edit(text, [{ oldText: text.slice(task[0].start, task[0].end), newText: text.slice(task[0].start, task[0].markerOffset) + input.task.marker + text.slice(task[0].markerOffset + task[0].marker.length, task[0].end) }]); }
      return input.append !== undefined ? this.parser.edit(text, []) + input.append : this.parser.edit(text, input.replacements!);
    }, false, signal);
  }
  properties(input: { vaultId: string; path: string; expectedHash: string; set?: Record<string, unknown>; remove?: string[]; addAliases?: string[] }, signal?: AbortSignal) {
    return this.write(input.vaultId, input.path, input.expectedHash, text => { const set = { ...input.set }; if (input.addAliases?.length) { if ('aliases' in set || input.remove?.includes('aliases')) throw new VaultError('ambiguous_edit'); set.aliases = [...new Set([...this.parser.parse(text).aliases, ...input.addAliases])]; } return this.parser.properties(text, { set, remove: input.remove ?? [] }); }, false, signal);
  }
}
