import { VaultError } from './ports.ts';
import { provenance } from './provenance.js';
import { compilePathGlob, type PathGlob } from './path-glob.ts';
import type { IndexLease, IndexOmission } from './vault-index.ts';
import type { Catalog, Diagnose, NoteParser, SearchBatch, SearchQuery, SearchRequest, Source, VaultFiles } from './ports.ts';

type Context = { revision: number; ids: string[]; catalog: Catalog };
type Route = 'index' | 'index_unavailable' | 'live' | 'unsupported';
const indexRoute = (route: Route) => route === 'index' || route === 'index_unavailable';
type Scalar = string | number | boolean | null;
type Projection = Record<string, Scalar | Scalar[]>;
type PropertyRow = { path: string; properties: Projection };
type Hit = ReturnType<typeof provenance> & { path: string; lineStart: number; lineEnd: number; snippet: string; hash: string };
type Row = PropertyRow | Hit;
const isScalar = (v: unknown): v is Scalar => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
type Session = {
  query: SearchQuery; glob?: PathGlob; revision: number; ids: string[]; routes: Route[]; fingerprint: string;
  index: number; offset: number; omissionOffset: number; producer?: string; leases: Map<string, IndexLease>; rows: Row[];
  matched: number; visited: number; warnings: Set<string>; failures: Array<{vaultId: string; category: string}>;
  created: number; at: number; busy: boolean;
};
const MAX_SESSIONS = 4, IDLE_MS = 300_000, LIFETIME_MS = 1_800_000;
const unique = (values?: string[]) => values ? [...new Set(values)].sort() : undefined;
const normalized = (q: SearchQuery) => ({ vaultId: q.vaultId, text: q.text, tag: q.tag?.replace(/^#/, '').toLocaleLowerCase('und'),
  pathGlob: q.pathGlob, folders: unique(q.folders), excludeFolders: unique(q.excludeFolders),
  properties: q.properties?.map(p => ({ ...p })).sort((a,b) => a.key.localeCompare(b.key) || JSON.stringify(a.equals).localeCompare(JSON.stringify(b.equals))),
  mode: q.mode ?? 'results', selectProperties: unique(q.selectProperties) });
const fingerprint = (c: Catalog, ids: string[]) => JSON.stringify(ids.map(id => {
  const s = c.sources.find(s => s.id === id); return [id, s?.local.available, s?.local.reason, c.filesystem?.[id]];
}));
const prefix = (value: string) => !!value && value.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(p => !!p && p !== '.' && p !== '..');
const inside = (path: string, folder: string) => path.startsWith(folder + '/');
const inFolders = (q: SearchQuery, path: string) => (!q.folders || q.folders.some(folder => inside(path, folder))) && !q.excludeFolders?.some(folder => inside(path, folder));
const omittedInQuery = ({ path, kind }: IndexOmission, q: SearchQuery, glob?: PathGlob) => {
  if (path.endsWith('.md') && inFolders(q, path) && (!glob || glob(path))) return true;
  if (kind === 'note') return false;
  // A skipped tree can matter only where it intersects an included subtree.
  const under = (child: string, parent: string) => !parent || child === parent || inside(child, parent);
  const intersections = q.folders ? q.folders.flatMap(folder =>
    under(folder, path) ? [folder] : under(path, folder) ? [path] : []) : [path];
  return intersections.some(root => {
    const fixed = glob?.fixedDirectory;
    if (fixed) {
      if (under(fixed, root)) root = fixed;
      else if (!under(root, fixed)) return false;
    }
    return !q.excludeFolders?.some(folder => under(root, folder)) && (!glob || glob.mayMatchBelow(root));
  });
};

export class VaultSearch {
  private sessions = new Map<string, Session>();
  private stopped = false;
  private calls = new Set<string>();
  private expiry?: ReturnType<typeof setInterval>;
  constructor(private files: VaultFiles, private parser: NoteParser, private id: () => string, private clock: () => number,
    private diagnose: Diagnose, private authorize: (vaultId?: string) => Promise<Context>, private check: (revision: number) => void) {}

  private async closeProducer(s: Session, explicit = false) {
    const producer = s.producer; s.producer = undefined;
    if (producer) {
      const close = this.files.closeSearch(s.revision, producer);
      await (explicit ? close : close.catch(() => {}));
    }
  }
  private close(s: Session, explicit = false) {
    for (const lease of s.leases.values()) lease.close();
    s.leases.clear(); s.rows.length = 0;
    return this.closeProducer(s, explicit);
  }
  private expired(s: Session) { return this.clock() - s.at > IDLE_MS || this.clock() - s.created > LIFETIME_MS; }
  private sweep() {
    for (const [id, s] of this.sessions) if (!s.busy && this.expired(s)) { this.sessions.delete(id); void this.close(s); }
    if (!this.sessions.size) { clearInterval(this.expiry); this.expiry = undefined; }
  }
  invalidate() {
    clearInterval(this.expiry); this.expiry = undefined;
    const old = [...this.sessions.values()]; this.sessions.clear();
    for (const s of old) void this.close(s);
  }
  async cancel(cursor: string, explicit = false) {
    const s = this.sessions.get(cursor);
    if (s && (!explicit || s.query.selectProperties)) { this.sessions.delete(cursor); await this.close(s, explicit); }
  }
  async stop() {
    this.stopped = true; clearInterval(this.expiry);
    const old = [...this.sessions.values()]; this.sessions.clear(); await Promise.all(old.map(s => this.close(s)));
  }
  async search(input: SearchQuery, signal?: AbortSignal) {
    const page = await this.next(input, signal);
    return { ...page, results: page.results.filter((row): row is Hit => 'hash' in row) };
  }
  async listProperties(input: SearchQuery & { selectProperties: string[] }, signal?: AbortSignal) {
    const page = await this.next(input, signal);
    return { ...page, results: page.results.filter((row): row is PropertyRow => 'properties' in row) };
  }
  private async next(input: SearchQuery, signal?: AbortSignal) {
    const key = input.cursor ?? this.id();
    if (this.calls.has(key)) throw new VaultError('busy');
    if (this.calls.size >= MAX_SESSIONS) throw new VaultError('capacity');
    this.calls.add(key);
    try { return await this.work(input, signal); }
    finally { this.calls.delete(key); }
  }
  private routes(query: SearchQuery, context: Context): Route[] {
    return context.ids.map(id => {
      const direct = context.catalog.filesystem?.[id] === 'ready';
      const metadataOnly = !query.text && !query.tag;
      if (direct && this.files.index && metadataOnly && (query.pathGlob || query.properties?.length || query.selectProperties)) {
        if (context.catalog.mirrorDirectoryGrantUnconfirmed) return 'index_unavailable';
        if (context.catalog.mirrorDirectoryGrantVersion === 1) return 'index';
      }
      // An older producer can still serve existing live queries (including
      // property filters/listProperties), but cannot back a metadata glob.
      return query.pathGlob && (!direct || metadataOnly) ? 'unsupported' : 'live';
    });
  }
  private assertActive(token: string, state: Session, signal?: AbortSignal) {
    this.check(state.revision);
    if (this.stopped || signal?.aborted) throw new VaultError('cancelled');
    if (this.sessions.get(token) !== state) throw new VaultError('cursor_expired');
  }
  private async work(input: SearchQuery, signal?: AbortSignal) {
    if (this.stopped || signal?.aborted) throw new VaultError('cancelled');
    if (JSON.stringify(input).length > 16384) throw new VaultError('invalid_query');
    for (const values of [input.folders, input.excludeFolders]) if (values && (values.length > 16 || values.some(v => !prefix(v)))) throw new VaultError('invalid_path');
    if (input.folders?.length === 0) throw new VaultError('invalid_query');
    if (input.selectProperties && (input.selectProperties.length < 1 || input.selectProperties.length > 8 || input.selectProperties.some(key => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)))) throw new VaultError('invalid_query');
    if (!input.cursor && !input.text && !input.tag && !input.pathGlob && !input.properties?.length && !input.folders?.length && input.mode !== 'count') throw new VaultError('invalid_query');
    let token = input.cursor, state = token ? this.sessions.get(token) : undefined;
    if (token && (!state || this.expired(state))) {
      await this.cancel(token);
      throw new VaultError('cursor_expired', 'The search expired. Start a new search; its earlier matches are not a total.');
    }
    if (state?.busy) throw new VaultError('busy');
    if (state) {
      if (!!state.query.selectProperties !== !!input.selectProperties) throw new VaultError('invalid_query');
      for (const key of ['vaultId', 'text', 'tag', 'pathGlob', 'folders', 'excludeFolders', 'properties', 'mode', 'selectProperties'] as const)
        if (input[key] !== undefined && JSON.stringify(normalized({ ...state.query, [key]: input[key] })[key]) !== JSON.stringify(state.query[key]))
          throw new VaultError('invalid_query', 'Continue the original query, or omit the cursor to start another search.');
    }
    const query = state?.query ?? normalized(input);
    const glob = state?.glob ?? (query.pathGlob !== undefined ? compilePathGlob(query.pathGlob) : undefined);
    let context: Context;
    try { context = await this.authorize(query.vaultId); }
    catch (error) { if (token) await this.cancel(token); throw error; }
    if (state) this.assertActive(token!, state, signal);
    const routes = this.routes(query, context);
    if (state && (state.revision !== context.revision || state.fingerprint !== fingerprint(context.catalog, state.ids) || routes.join() !== state.routes.join())) {
      await this.cancel(token!); throw new VaultError('cursor_expired', 'Local source access changed. Start a new search.');
    }
    if (!context.catalog.search?.available && !query.pathGlob && !routes.some(indexRoute)) {
      if (token) await this.cancel(token);
      throw new VaultError('unsupported', 'Vault search is unavailable. Update both plugins if needed and ask the host operator to check the ripgrep requirements.');
    }
    if (!state) {
      this.sweep();
      if (this.sessions.size >= MAX_SESSIONS) throw new VaultError('capacity');
      token = this.id(); state = { query, glob, revision: context.revision, ids: context.ids, routes, fingerprint: fingerprint(context.catalog, context.ids),
        index: 0, offset: 0, omissionOffset: 0, leases: new Map(), rows: [], matched: 0, visited: 0, warnings: new Set(), failures: [], created: this.clock(), at: this.clock(), busy: false };
      this.sessions.set(token, state);
      if (!this.expiry) { this.expiry = setInterval(() => this.sweep(), 30_000); this.expiry.unref(); }
    }
    const cursor = token!, s = state;
    s.busy = true;
    const cancel = () => { void this.cancel(cursor); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.assertActive(cursor, s, signal);
      const limit = Math.max(1, Math.min(input.limit ?? 20, s.query.selectProperties ? 200 : 50));
      const sliceStarted = this.clock(); let batches = 0;
      while ((s.query.mode === 'count' || s.rows.length < limit) && s.index < s.ids.length && batches++ < 32 && this.clock() - sliceStarted < 2000) {
        const id = s.ids[s.index], route = s.routes[s.index], source = context.catalog.sources.find(v => v.id === id);
        if (!source?.local.available || route === 'index_unavailable') {
          s.failures.push({ vaultId: id, category: 'source_unavailable' }); s.index++; continue;
        }
        if (route === 'unsupported' || (route === 'live' && !context.catalog.search?.available)) {
          s.failures.push({ vaultId: id, category: 'unsupported' }); s.index++; continue;
        }
        try {
          if (route === 'index') {
            let lease = s.leases.get(id);
            if (!lease) {
              lease = await this.files.index!(id, s.revision, signal);
              try { this.assertActive(cursor, s, signal); }
              catch (error) { lease.close(); throw error; }
              s.leases.set(id, lease);
            }
            this.indexBatch(s, source, lease);
          } else {
            const request: SearchRequest = { mirrorId: id, revision: s.revision, text: s.query.text,
              projection: s.query.tag ? 'markdown' : s.query.properties?.length || s.query.selectProperties ? 'frontmatter' : 'hits',
              folders: s.query.folders, excludeFolders: s.query.excludeFolders, cursor: s.producer };
            if (!s.producer) {
              // Acquire the handle before executing rg so cancellation can close even the first batch.
              const opened = await this.files.search({ ...request, startOnly: true }); s.producer = opened.nextCursor ?? undefined;
              this.assertActive(cursor, s, signal);
              if (!s.producer) throw new VaultError('unavailable');
            }
            const batch = await this.files.search({ ...request, cursor: s.producer }, signal); s.producer = batch.nextCursor ?? undefined;
            this.assertActive(cursor, s, signal); this.liveBatch(s, source, batch);
            if (!s.producer) s.index++;
          }
        } catch (error) {
          this.assertActive(cursor, s, signal);
          if (error instanceof VaultError && ['cancelled', 'cursor_expired', 'not_connected', 'invalid_query'].includes(error.category)) throw error;
          if (route === 'live' && error instanceof VaultError && (error.category === 'capacity' ||
              (error.category === 'unsupported' && !s.routes.some(indexRoute)))) throw error;
          const category = error instanceof VaultError ? error.category : 'unavailable';
          s.failures.push({ vaultId: id, category });
          if (!(error instanceof VaultError && error.diagnosticReported)) this.diagnose('rpc', category);
          await this.closeProducer(s); s.index++; s.offset = 0; s.omissionOffset = 0;
        }
      }
      this.assertActive(cursor, s, signal);
      const finished = s.index === s.ids.length, partial = s.warnings.size > 0 || s.failures.length > 0;
      const indexed = s.routes.includes('index'), live = s.routes.includes('live');
      const response = { results: [] as Row[], nextCursor: cursor as string | null, incomplete: !finished || partial,
        coverage: { state: finished ? partial ? 'partial' : 'complete' : 'running', visitedNotes: s.visited, omissionKinds: s.warnings.size,
          failedSources: s.failures.length, consistency: indexed
            ? live ? 'Pinned local index generations and live per-note observations; no common observation time.' : 'One pinned local index generation per vault; not an atomic filesystem observation.'
            : 'Per-note local observations during this search, not an atomic vault snapshot.',
          startedAt: new Date(s.created).toISOString(), observedAt: new Date(this.clock()).toISOString() },
        matchedNotesSoFar: s.matched, totalMatches: finished && !partial ? s.matched : null,
        scope: { vaultIds: s.ids, folders: s.query.folders ?? null, excludeFolders: s.query.excludeFolders ?? [], ...(s.query.pathGlob ? { pathGlob: s.query.pathGlob } : {}) },
        failures: s.failures, warnings: [...s.warnings], evidenceOnly: true as const };
      while (response.results.length < limit && s.rows.length) {
        const row = s.rows[0];
        if (JSON.stringify({ ...response, results: [...response.results, row] }).length > 48000) break;
        response.results.push(s.rows.shift()!);
      }
      // Reauthorize even a page entirely from a cached row buffer. All pinned
      // vaults are checked, including lanes already drained by this cursor.
      const final = await this.authorize(s.query.vaultId);
      this.assertActive(cursor, s, signal);
      if (fingerprint(final.catalog, s.ids) !== s.fingerprint || this.routes(s.query, final).join() !== s.routes.join())
        throw new VaultError('cursor_expired', 'Local source access changed. Start a new search.');
      for (const lease of s.leases.values()) await lease.check(signal);
      this.assertActive(cursor, s, signal);
      if (this.clock() - s.created > LIFETIME_MS) throw new VaultError('cursor_expired');
      // A checked lease can be revoked while another vault is authorizing.
      // No await between this all-lease check and returning the response.
      for (const lease of s.leases.values()) lease.assertValid();
      if (finished && !s.rows.length) { response.nextCursor = null; void this.cancel(cursor); }
      s.at = this.clock();
      return response;
    } catch (error) { this.sessions.delete(cursor); await this.close(s); throw error; }
    finally { signal?.removeEventListener('abort', cancel); s.busy = false; }
  }

  private project(s: Session, properties: Record<string, unknown>) {
    if (!s.query.selectProperties) return undefined;
    const selected: Projection = Object.create(null);
    for (const key of s.query.selectProperties) if (Object.hasOwn(properties, key)) {
      const value = properties[key];
      if (isScalar(value)) selected[key] = value;
      else if (Array.isArray(value) && value.every(isScalar)) selected[key] = value;
      else throw new VaultError('properties_unsupported');
    }
    if (JSON.stringify(selected).length > 4096) throw new VaultError('parser_limit');
    return selected;
  }
  private matches(s: Session, properties: Record<string, unknown>) {
    return !s.query.properties || s.query.properties.every(p => Object.hasOwn(properties, p.key) && properties[p.key] === p.equals);
  }
  private row(s: Session, source: Source, candidate: SearchBatch['candidates'][number], selected?: Projection) {
    s.matched++;
    if (s.query.mode !== 'count') s.rows.push(selected ? { path: candidate.path, properties: selected } : {
      ...provenance(source, candidate.readAt), path: candidate.path, hash: candidate.hash,
      lineStart: candidate.line, lineEnd: candidate.line + (s.query.text?.match(/\n/g)?.length ?? 0), snippet: candidate.snippet,
    });
  }
  private indexBatch(s: Session, source: Source, lease: IndexLease) {
    const view = lease.view;
    const omissionEnd = Math.min(view.omissions.length, s.omissionOffset + 128);
    for (; s.omissionOffset < omissionEnd && !s.warnings.has('unsupported'); s.omissionOffset++) {
      if (omittedInQuery(view.omissions[s.omissionOffset], s.query, s.glob)) s.warnings.add('unsupported');
    }
    if (s.warnings.has('unsupported')) s.omissionOffset = view.omissions.length;
    const end = Math.min(view.notes.length, s.offset + 128);
    for (; s.offset < end; s.offset++) {
      const note = view.notes[s.offset];
      if (!inFolders(s.query, note.path) || (s.glob && !s.glob(note.path))) continue;
      s.visited++;
      if ((s.query.selectProperties || s.query.properties?.length) && note.propertyWarning) { s.warnings.add(note.propertyWarning); continue; }
      if (!this.matches(s, note.properties)) continue;
      try { this.row(s, source, { ...note, line: 1, snippet: '' }, this.project(s, note.properties)); }
      catch { if (!s.warnings.has('parser_limit')) this.diagnose('parse', 'limit'); s.warnings.add('parser_limit'); }
    }
    if (s.offset === view.notes.length && s.omissionOffset === view.omissions.length) { s.index++; s.offset = 0; s.omissionOffset = 0; }
  }
  private liveBatch(s: Session, source: Source, batch: SearchBatch) {
    s.visited += batch.visited;
    batch.warnings.forEach(w => s.warnings.add(w));
    if (batch.warnings.length) this.diagnose('parse', batch.warnings.includes('unsupported') ? 'unsupported' : 'unavailable');
    for (const candidate of batch.candidates) {
      if (s.glob && !s.glob(candidate.path)) continue;
      try {
        if (candidate.limited) throw new VaultError('parser_limit');
        let selected: Projection | undefined;
        if (s.query.selectProperties || s.query.properties?.length) {
          const parsed = this.parser.frontmatter(candidate.content ?? '');
          if (parsed.warnings.length) throw new VaultError('properties_unsupported');
          selected = this.project(s, parsed.properties);
          if (!this.matches(s, parsed.properties)) continue;
        }
        let line = candidate.line, snippet = candidate.snippet;
        if (s.query.tag) {
          const tag = s.query.tag, meta = this.parser.parse(candidate.content ?? '');
          if (meta.warnings.includes('properties_unsupported')) throw new VaultError('properties_unsupported');
          const match = meta.tags.find(t => t.tag === tag || t.tag.startsWith(tag + '/'));
          if (!match) continue;
          if (!s.query.text) { line = match.line; snippet = (candidate.content ?? '').split('\n')[line - 1]?.replace(/\r$/, '').slice(0, 240) ?? ''; }
        }
        this.row(s, source, { ...candidate, line, snippet }, selected);
      } catch (error) {
        const unsupported = error instanceof VaultError && error.category === 'properties_unsupported';
        s.warnings.add(unsupported ? 'properties_unsupported' : 'parser_limit');
        this.diagnose('parse', unsupported ? 'unsupported' : 'limit');
      }
    }
  }
}
