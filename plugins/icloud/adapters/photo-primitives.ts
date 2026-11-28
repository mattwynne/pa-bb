import { setImmediate as turn } from 'node:timers/promises';
import { category, CloudError } from '../core/ports.ts';
import type { Diagnose } from '../core/ports.ts';
import type { PhotoVersion } from '../core/photos-contract.ts';
import { allPhotos, isPhotoLibrary, pageSize, photoFailureCategory, tokenExpired } from './cloudkit-photos.ts';
import type { Album, CloudKitPhotos, PhotoOrder, PhotoZone } from './cloudkit-photos.ts';
import { materialize, projectRecords } from './icloud-photo-records.ts';
import type { AssetRecord, MasterRecord, ObjectValue } from './icloud-photo-records.ts';
import type { PhotoIndex } from './photo-index.ts';
import type { PhotoVersions } from './photo-versions.ts';

type Page = { library: string; album: string | null; order: PhotoOrder; offset: number; limit: number };
type BoundLibrary = { scope: string; zone: PhotoZone; signal: AbortSignal };
type IndexedAsset = ReturnType<typeof materialize>;
type CachedAsset = { value: IndexedAsset; asset: AssetRecord; expires: number };
type Catalog<T> = { value: Promise<T>; expires: number };
const retryDelay = 45_000;
const refreshInterval = 60_000;
const catalogTtl = 5 * 60_000;
const reconnect = 'Reconnect Apple in iCloud settings';
const indexError = 'Could not update the iCloud Photos index. Try again shortly.';
const libraryKind = (id: string) => id === 'PrimarySync' ? 'personal' as const : 'shared' as const;
const binding = (account: string, library: string) => JSON.stringify([account, library]);
const albumKey = (scope: string, id: string) => JSON.stringify([scope, id]);

class ScanDrift extends CloudError {
  constructor() { super('source_changed'); }
}

export class PhotoPrimitives {
  private lifetime = new AbortController();
  private catalog: Catalog<Map<string, PhotoZone>> | null = null;
  private albumLists = new Map<string, Catalog<Album[]>>();
  private albumCounts = new Map<string, { total: number; expires: number }>();
  private albumAssets = new Map<string, Map<string, CachedAsset>>();
  private jobs = new Map<string, Promise<void>>();
  private running = new Set<Promise<void>>();
  private failures = new Map<string, { reason: string; retry: number }>();
  private lastBindingFailure: string | null = null;

  constructor(private readonly cloud: CloudKitPhotos, private readonly index: PhotoIndex, readonly versions: PhotoVersions,
    private readonly diagnose: Diagnose, private readonly allowed: () => boolean, private readonly now = Date.now) {}

  get active() { return this.running.size > 0; }

  async cancel(accountChanged = false) {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.versions.invalidate();
    if (accountChanged) {
      this.cloud.invalidate();
      this.failures.clear();
      this.lastBindingFailure = null;
    }
    this.catalog = null;
    this.albumLists.clear();
    this.albumCounts.clear();
    this.albumAssets.clear();
    await Promise.all(this.running);
  }

  private permission(request?: AbortSignal) {
    if (!this.allowed()) throw new CloudError('busy');
    return request ? AbortSignal.any([this.lifetime.signal, request]) : this.lifetime.signal;
  }

  private libraryId(id: string) {
    if (!isPhotoLibrary(id)) throw new CloudError('invalid_selection');
  }

  private zones() {
    const signal = this.permission();
    if (this.catalog && this.catalog.expires > this.now()) return this.catalog.value;
    const value = this.cloud.libraries(signal).catch(error => {
      if (this.catalog?.value === value) this.catalog = null;
      throw error;
    });
    this.catalog = { value, expires: this.now() + catalogTtl };
    return value;
  }

  async libraries(request?: AbortSignal) {
    const signal = this.permission(request);
    const zones = await this.zones();
    signal.throwIfAborted();
    return { libraries: [...zones.keys()].map(id => ({ id,
      name: libraryKind(id) === 'personal' ? 'Personal Library' : 'Shared Library', kind: libraryKind(id),
    })) };
  }

  private async scoped(id: string, request?: AbortSignal) {
    this.libraryId(id);
    const signal = this.permission(request);
    const account = await this.cloud.binding();
    signal.throwIfAborted();
    return { scope: binding(account, id), signal };
  }

  private async zoned(id: string, request?: AbortSignal): Promise<BoundLibrary> {
    const { scope, signal } = await this.scoped(id, request);
    const zone = (await this.zones()).get(id);
    signal.throwIfAborted();
    if (!zone) throw new CloudError('invalid_selection');
    return { scope, zone, signal };
  }

  async status(id: string) {
    this.libraryId(id);
    const signal = this.permission();
    let scope: string;
    try { scope = (await this.scoped(id)).scope; this.lastBindingFailure = null; }
    catch (error) {
      signal.throwIfAborted();
      const failure = category(error);
      if (this.lastBindingFailure !== failure) this.diagnose('photo_index_session', failure);
      this.lastBindingFailure = failure;
      return { state: 'error' as const, indexed: 0, total: null, updatedAt: null, error: failure === 'authentication' ? reconnect : indexError };
    }

    const current = this.index.state(scope);
    if (this.cloud.authFailed) return {
      state: 'error' as const, indexed: this.index.indexed(scope, current), total: current?.total ?? null,
      updatedAt: current?.updated ?? null, error: reconnect,
    };
    const fail = this.failures.get(scope);
    const interval = current?.token ? refreshInterval : catalogTtl;
    const due = !current?.updated || this.now() - Date.parse(current.updated) >= interval;
    if (due && (!fail || fail.retry <= this.now()) && !this.jobs.has(scope) && this.jobs.size < 4) {
      const task = this.refresh(id, scope, signal).then(() => { this.failures.delete(scope); }).catch(error => {
        if (signal.aborted || !this.allowed()) return;
        const reason = photoFailureCategory(error);
        this.diagnose('photo_index_refresh', reason);
        const retry = reason === 'source_changed' ? catalogTtl : retryDelay;
        this.failures.set(scope, { reason, retry: reason === 'authentication' ? Infinity : this.now() + retry });
        if (this.failures.size > 32) this.failures.delete(this.failures.keys().next().value!);
      }).finally(() => {
        this.running.delete(task);
        if (this.jobs.get(scope) === task) this.jobs.delete(scope);
      });
      this.jobs.set(scope, task);
      this.running.add(task);
    }
    const state = this.jobs.has(scope) ? 'indexing' : fail ? 'error' : current?.updated ? 'ready' : 'empty';
    return { state: state as 'empty' | 'indexing' | 'ready' | 'error', indexed: this.index.indexed(scope, current),
      total: current?.total ?? null, updatedAt: current?.updated ?? null,
      error: state === 'error' ? (fail?.reason === 'authentication' ? reconnect : indexError) : null,
    };
  }

  private async refresh(library: string, scope: string, signal: AbortSignal) {
    const zone = (await this.zones()).get(library);
    signal.throwIfAborted();
    if (!zone) throw new CloudError('invalid_selection');
    let state = this.index.state(scope);
    for (let attempt = 0; ; attempt++) {
      try {
        if (!state || (state.rank === null && !state.token)) {
          const total = await this.cloud.count(zone, signal);
          signal.throwIfAborted();
          state = this.index.begin(scope, total);
        }
        while (state.rank !== null && state.rank >= 0) {
          if (!this.allowed()) return;
          const limit: number = Math.min(state.rank + 1, pageSize);
          const page = await this.cloud.page(zone, state.rank, 'newest', limit, signal);
          signal.throwIfAborted();
          const projection = this.project(scope, page.records);
          const ids = [...new Set(projection.assets.map(asset => asset.id))];
          const prior = state.anchor ? JSON.parse(state.anchor) as string[] : null;
          const previous = new Set(prior);
          if (ids.length > limit || (prior && !ids.some(id => previous.has(id)))) throw new ScanDrift();
          // Apple ranks are live. Overlap by eight items and checkpoint the
          // previous page's membership so a resumed scan can detect rank drift.
          const finished = state.rank < ids.length || (state.total === 0 && ids.length === 0);
          if (!finished && ids.length <= 8) throw new ScanDrift();
          const nextRank: number = finished ? -1 : state.rank - (ids.length - 8);
          state = this.index.apply(scope, state, projection, {
            rank: nextRank, token: prior ? state.token : page.token, anchor: JSON.stringify(ids),
          });
        }

        const rebuilding = state.rank === -1;
        if (state.token) {
          for (;;) {
            if (!this.allowed()) return;
            const delta = await this.cloud.changes(zone, state.token!, signal);
            signal.throwIfAborted();
            const projection = this.project(scope, delta.records);
            const present = new Set(projection.masters.map(master => master.id));
            const missing = [...new Set(projection.assets.map(asset => asset.master))]
              .filter(master => !present.has(master) && !this.index.hasMaster(scope, master));
            if (missing.length) {
              const records = await this.cloud.lookup(zone, missing, signal);
              signal.throwIfAborted();
              projection.masters.push(...this.project(scope, records).masters);
            }
            state = this.index.apply(scope, state, projection, { rank: state.rank, token: delta.token, anchor: null });
            this.versions.forget(scope, [...projection.deletedAssets, ...projection.deletedUnknown], [...projection.deletedMasters, ...projection.deletedUnknown]);
            if (delta.records.length) this.albumAssets.delete(scope);
            if (delta.records.some(row => row.recordType === 'CPLAlbum' || row.recordType === 'CPLContainerRelation' || row.deleted)) {
              this.albumLists.delete(scope);
              this.albumCounts.clear();
            }
            if (!delta.more) break;
          }
        }
        const indexed = this.index.indexed(scope, state);
        if (rebuilding) {
          const expected = await this.cloud.count(zone, signal);
          signal.throwIfAborted();
          if (expected !== indexed) throw new ScanDrift();
        }
        this.index.finish(scope, state, new Date(this.now()).toISOString(), indexed);
        if (rebuilding && state.generation > 1) {
          while (!signal.aborted && this.allowed() && this.index.prune(scope, state.generation)) await turn();
          let after: string | null = '';
          while (after !== null && !signal.aborted && this.allowed()) {
            after = this.index.pruneMasters(scope, after);
            if (after !== null) await turn();
          }
        }
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ScanDrift) && !tokenExpired(error)) throw error;
        const total = await this.cloud.count(zone, signal);
        signal.throwIfAborted();
        state = this.index.begin(scope, total);
        if (attempt >= 1) throw error;
      }
    }
  }

  private project(scope: string, records: ObjectValue[]) {
    return projectRecords(records, (record, key, url) => this.versions.remember(scope, record, key, url),
      id => this.index.masterFor(scope, id));
  }

  private async getAlbums({ scope, zone, signal }: BoundLibrary) {
    let catalog = this.albumLists.get(scope);
    if (!catalog || catalog.expires <= this.now()) {
      const value = this.cloud.albums(zone, this.permission()).catch(error => {
        if (this.albumLists.get(scope)?.value === value) this.albumLists.delete(scope);
        throw error;
      });
      catalog = { value, expires: this.now() + catalogTtl };
      this.albumLists.set(scope, catalog);
    }
    const value = await catalog.value;
    signal.throwIfAborted();
    return value;
  }

  async albums(id: string, request?: AbortSignal) {
    const bound = await this.zoned(id, request);
    const rows = await this.getAlbums(bound);
    return { albums: rows.map(({ collection, ...row }) => ({ ...row, count: collection === allPhotos
      ? this.index.state(bound.scope)?.total ?? null
      : this.albumCounts.get(albumKey(bound.scope, row.id))?.total ?? null })) };
  }

  async assets(input: Page, request?: AbortSignal) {
    if (input.album === null || input.album === 'smart:all') {
      const { scope } = await this.indexScope(input.library, request);
      return this.index.page(scope, input.order, input.offset, input.limit);
    }
    const { scope, signal, zone } = await this.zoned(input.library, request);
    const album = (await this.getAlbums({ scope, signal, zone })).find(row => row.id === input.album);
    if (!album?.collection) throw new CloudError('invalid_selection');
    const key = albumKey(scope, album.id);
    const cached = this.albumCounts.get(key);
    const total = cached && cached.expires > this.now() ? cached.total : await this.cloud.count(zone, signal, album.collection);
    if (!cached || cached.expires <= this.now()) this.albumCounts.set(key, { total, expires: this.now() + refreshInterval });
    if (this.albumCounts.size > 2_000) this.albumCounts.delete(this.albumCounts.keys().next().value!);
    const remaining = Math.min(input.limit, Math.max(0, total - input.offset));
    const assets = [];
    for (let step = 0; step < remaining; step += pageSize) {
      const offset = input.offset + step;
      const rank = input.order === 'newest' ? total - 1 - offset : offset;
      const page = await this.cloud.page(zone, rank, input.order, Math.min(pageSize, remaining - step), signal, album.collection);
      signal.throwIfAborted();
      const projection = this.project(scope, page.records);
      assets.push(...this.cacheAssets(scope, projection.assets, projection.masters).map(entry => entry.value.value));
    }
    const direction = input.order === 'oldest' ? 1 : -1;
    assets.sort((a, b) => direction * ((a.created ?? '').localeCompare(b.created ?? '') || a.id.localeCompare(b.id)));
    return { total, assets };
  }

  async months(input: Pick<Page, 'library' | 'album' | 'order'>, request?: AbortSignal) {
    const { scope } = await this.indexScope(input.library, request);
    return { months: input.album === null || input.album === 'smart:all' ? this.index.months(scope, input.order) : [] };
  }

  private indexScope(library: string, request?: AbortSignal) {
    return library === 'PrimarySync' ? this.scoped(library, request) : this.zoned(library, request);
  }

  private cacheAssets(scope: string, assets: AssetRecord[], masters: MasterRecord[]) {
    const byId = new Map(masters.map(master => [master.id, master]));
    const cache = this.albumAssets.get(scope) ?? new Map<string, CachedAsset>();
    this.albumAssets.set(scope, cache);
    return assets.map(asset => {
      const entry = { asset, value: materialize(asset, byId.get(asset.master) ?? null), expires: this.now() + refreshInterval };
      cache.delete(asset.id);
      cache.set(asset.id, entry);
      if (cache.size > 2_000) cache.delete(cache.keys().next().value!);
      return entry;
    });
  }

  async tickets(library: string, ids: string[], version: PhotoVersion, request?: AbortSignal) {
    const { scope, zone, signal } = await this.zoned(library, request);
    const assets = new Map<string, { value: IndexedAsset; master: string }>();
    const cache = this.albumAssets.get(scope);
    for (const id of new Set(ids)) {
      const indexed = this.index.get(scope, id);
      const master = indexed ? this.index.masterFor(scope, id) : null;
      if (indexed && master) { assets.set(id, { value: indexed, master }); continue; }
      const cached = cache?.get(id);
      if (cached && cached.expires > this.now()) assets.set(id, { value: cached.value, master: cached.asset.master });
    }
    const missing = [...new Set(ids)].filter(id => !assets.has(id));
    if (missing.length) {
      const records = await this.cloud.lookup(zone, missing, signal);
      signal.throwIfAborted();
      const page = this.project(scope, records);
      const masters = await this.cloud.lookup(zone, page.assets.map(asset => asset.master), signal);
      signal.throwIfAborted();
      for (const entry of this.cacheAssets(scope, page.assets, this.project(scope, masters).masters)) {
        assets.set(entry.asset.id, { value: entry.value, master: entry.asset.master });
      }
    }
    return { tickets: this.versions.mint(new Map(ids.map(id => {
      const entry = assets.get(id);
      const resource = entry?.value.versions[version];
      return [id, entry && resource ? { scope, zone, asset: id, master: entry.master, resource } : null];
    })), version) };
  }
}
