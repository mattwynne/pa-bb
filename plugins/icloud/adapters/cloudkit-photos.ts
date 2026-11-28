import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { category, CloudError } from '../core/ports.ts';
import { decodedName, field, flag, object, photoKeys, recordId, whole } from './icloud-photo-records.ts';
import type { ObjectValue } from './icloud-photo-records.ts';

type Area = 'private' | 'shared';
export type PhotoZone = { area: Area; zoneID: { zoneName: string; ownerRecordName?: string; zoneType?: string } };
export type Session = { account: string; endpoint: URL; cookies: string; pcsRequired: boolean };
export type PhotoOrder = 'newest' | 'oldest';
type Filters = ReturnType<typeof filter>[];
export type PhotoCollection = { list: string; count: string; filters: Filters };
export type Album = { id: string; name: string; kind: 'smart' | 'album' | 'folder'; parent: string | null; collection: PhotoCollection | null };
export const pageSize = 100;

export async function readPhotoSession(root: string, readConfig: () => Promise<{ account: string; cookies: string }>): Promise<Session> {
  const remote = await readConfig();
  let service: ObjectValue;
  try {
    // The base Drive remote writes this same cache after a successful session setup.
    const data = await readFile(join(root, 'cache', 'iclouddrive-photos', 'icloud', 'webservices.json'), 'utf8');
    service = object(object(JSON.parse(data)).ckdatabasews);
  } catch { throw new CloudError('configuration'); }
  const endpoint = appleUrl(service.url);
  if (!endpoint || !/(^|\.)icloud\.com(?:\.cn)?$/.test(endpoint.hostname)) throw new CloudError('configuration');
  return { account: createHash('sha256').update(remote.account.trim().toLowerCase()).digest('hex'),
    endpoint, cookies: remote.cookies, pcsRequired: service.pcsRequired === true };
}

// Signed asset requests use an Apple host, no credentials and no redirects.
export function appleUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(^|\.)(icloud\.com(?:\.cn)?|icloud-content\.com|apple\.com)$/.test(url.hostname)) return url;
  } catch { /* Invalid signed link. Its value is private. */ }
  return null;
}

function filter(fieldName: string, type: string, value: string | number | string[], comparator = 'EQUALS') {
  return { fieldName, comparator, fieldValue: { type, value } };
}

export const allPhotos: PhotoCollection = {
  list: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted', count: 'CPLAssetByAssetDateWithoutHiddenOrDeleted', filters: [],
};
const smartAlbums: Album[] = [
  { id: 'smart:all', name: 'All Photos', kind: 'smart', parent: null, collection: allPhotos },
  { id: 'smart:bursts', name: 'Bursts', kind: 'smart', parent: null,
    collection: { list: 'CPLBurstStackAssetAndMasterByAssetDate', count: 'CPLAssetBurstStackAssetByAssetDate', filters: [] } },
  ...[
    ['Videos', 'Video', 'VIDEO'], ['Time-lapse', 'Timelapse', 'TIMELAPSE'], ['Slo-mo', 'Slomo', 'SLOMO'],
    ['Favorites', 'Favorite', 'FAVORITE'], ['Panoramas', 'Panorama', 'PANORAMA'], ['Screenshots', 'Screenshot', 'SCREENSHOT'],
    ['Live', 'Live', 'LIVE'], ['Portrait', 'Depth', 'DEPTH'], ['Long Exposure', 'Exposure', 'EXPOSURE'], ['Animated', 'Animated', 'ANIMATED'],
  ].map(([name, suffix, tag]): Album => ({
    id: `smart:${tag.toLowerCase()}`, name, kind: 'smart', parent: null,
    collection: { list: 'CPLAssetAndMasterInSmartAlbumByAssetDate', count: `CPLAssetInSmartAlbumByAssetDate:${suffix}`,
      filters: [filter('smartAlbum', 'STRING', tag)] },
  })),
];
const rootFolders = new Set(['----Root-Folder----', '----Project-Root-Folder----']);
export const isPhotoLibrary = (id: string) => id === 'PrimarySync' || /^SharedSync(?:-[\s\S]+)?$/.test(id);

class CloudKitFailure extends CloudError {
  constructor(readonly reason: 'auth' | 'zone_missing' | 'album_index' | 'sync_token' | 'bad_request' | 'limited' | 'http') {
    super(reason === 'auth' ? 'authentication' : reason === 'limited' ? 'unavailable' : 'provider_rejected');
  }
}
export const tokenExpired = (error: unknown) => error instanceof CloudKitFailure && error.reason === 'sync_token';
export const photoFailureCategory = (error: unknown) =>
  error instanceof CloudKitFailure && error.reason === 'limited' ? 'rate_limited' : category(error);
const authFailure = (error: unknown) => error instanceof CloudError && error.category === 'authentication';
const token = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 16_384 ? value : null;
function resultRows(value: unknown[], max: number) {
  if (value.length > max || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new CloudError('provider_rejected');
  return value.map(object);
}
function rows(value: unknown, max = 400) {
  if (!Array.isArray(value)) throw new CloudError('provider_rejected');
  return resultRows(value, max);
}

const isAuthCode = (code: unknown) => typeof code === 'string' &&
  ['AUTHENTICATION_FAILED', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_ERROR', 'PCS_REQUIRED',
    'ACCESS_DENIED', 'PERMISSION_DENIED', 'NOT_AUTHENTICATED', 'USER_SESSION_EXPIRED'].includes(code);

function checkErrors(row: ObjectValue, status: number) {
  if ([401, 421, 423].includes(status) || isAuthCode(row.serverErrorCode)) throw new CloudKitFailure('auth');
  if (row.serverErrorCode === 'ZONE_NOT_FOUND') throw new CloudKitFailure('zone_missing');
  if (row.serverErrorCode === 'BAD_REQUEST' && row.reason === 'Index has invalid data') throw new CloudKitFailure('album_index');
  if (status === 400 && row.serverErrorCode === 'BAD_REQUEST') throw new CloudKitFailure('bad_request');
  if (['CHANGE_TOKEN_EXPIRED', 'SYNC_TOKEN_EXPIRED'].includes(String(row.serverErrorCode))) throw new CloudKitFailure('sync_token');
  if (row.serverErrorCode || row.error || status < 200 || status >= 300) throw new CloudKitFailure('http');
}

function checkRecordAuth(value: unknown) {
  if (Array.isArray(value) && value.some(item => isAuthCode(object(item).serverErrorCode))) throw new CloudKitFailure('auth');
}

async function responseJson(response: Response) {
  if (!response.body) throw new CloudError('provider_rejected');
  // Limit decompressed bytes as well as record count.
  const maxBytes = 8 * 1024 * 1024;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let contents = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new CloudError('capacity');
      contents += decoder.decode(value, { stream: true });
    }
    return object(JSON.parse(contents + decoder.decode()));
  } finally { await reader.cancel().catch(() => {}); }
}

const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15';
type Operation = 'changes/database' | 'changes/zone' | 'internal/records/query/batch' | 'records/query' | 'records/lookup';
type Transport = typeof fetch;

export class CloudKitPhotos {
  private session: Promise<Session> | null = null;
  private authBlocked = false;
  private lifetime = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private nextRequest = 0;

  constructor(private readonly load: (signal: AbortSignal) => Promise<Session>, private readonly transport: Transport = fetch,
    private readonly interval = 150, private readonly now = Date.now,
    private readonly delay = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal })) {}

  get authFailed() { return this.authBlocked; }

  invalidate() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.session = null;
    this.authBlocked = false;
  }

  private loadSession(signal: AbortSignal) {
    return this.load(signal).then(value => {
      signal.throwIfAborted();
      if (!value.cookies || value.cookies.length > 32_768 || /[\r\n]/.test(value.cookies) ||
        (value.pcsRequired && !/(?:^|;\s*)X-APPLE-WEBAUTH-PCS-Photos=[^;\s]+/i.test(value.cookies))) throw new CloudKitFailure('auth');
      return value;
    });
  }

  async binding() {
    const signal = this.lifetime.signal;
    this.session ??= this.readSavedSession(signal);
    const promise = this.session;
    try { return (await promise).account; }
    catch (error) {
      if (!authFailure(error) && this.session === promise) this.session = null;
      throw error;
    }
  }

  private async readSavedSession(signal: AbortSignal) {
    try { return await this.loadSession(signal); }
    catch (error) {
      if (!authFailure(error)) throw error;
      // One read-only retry, even when the first saved snapshot lacked PCS.
      return this.loadSession(signal);
    }
  }

  private async send(session: Session, area: Area, operation: Operation, body: object, signal: AbortSignal) {
    const url = new URL(`/database/1/com.apple.photos.cloud/production/${area}/${operation}?remapEnums=true&getCurrentSyncToken=true`, session.endpoint);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const wait = this.nextRequest - this.now();
      if (wait > 10_000) throw new CloudKitFailure('limited');
      if (wait > 0) await this.delay(wait, signal);
      this.nextRequest = this.now() + this.interval;
      try {
        const response = await this.transport(url, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers: { 'Content-Type': 'text/plain', Origin: 'https://www.icloud.com', Referer: 'https://www.icloud.com/',
            'User-Agent': userAgent, Cookie: session.cookies },
          body: JSON.stringify(body),
        });
        if (response.status === 429 || response.status === 503) {
          const value = response.headers.get('Retry-After')?.trim() ?? '';
          const fromHeader = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - this.now();
          this.nextRequest = Math.max(this.nextRequest, this.now() + (Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : 1_000 * 2 ** attempt));
          await response.body?.cancel().catch(() => {});
          if (attempt >= 2) throw new CloudKitFailure('limited');
          continue;
        }
        if ([401, 421, 423].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          throw new CloudKitFailure('auth');
        }
        let data: ObjectValue;
        try { data = await responseJson(response); }
        catch (error) {
          if (response.status === 404) throw new CloudKitFailure('zone_missing');
          throw error;
        }
        if (operation === 'changes/database' && response.status === 404 && !data.serverErrorCode) throw new CloudKitFailure('zone_missing');
        checkErrors(data, response.status);
        checkRecordAuth(data.records);
        for (const key of ['zones', 'batch']) {
          const entries = data[key];
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            checkErrors(object(entry), 200);
            checkRecordAuth(object(entry).records);
          }
        }
        return data;
      } catch (error) {
        signal.throwIfAborted();
        throw error instanceof CloudError ? error : new CloudError('unavailable');
      }
    }
  }

  private async request(area: Area, operation: Operation, body: object, request: AbortSignal) {
    const generation = this.lifetime.signal;
    const signal = AbortSignal.any([request, generation]);
    signal.throwIfAborted();
    if (this.queued >= 32) throw new CloudError('busy');
    this.queued++;
    const task = this.tail.then(async () => {
      signal.throwIfAborted();
      if (this.authBlocked) throw new CloudKitFailure('auth');
      await this.binding();
      const session = (await this.session)!;
      signal.throwIfAborted();
      try { return await this.send(session, area, operation, body, signal); }
      catch (error) {
        if (!authFailure(error)) throw error;
        // Re-read the saved config once. A native Photos call could validate,
        // sign in or request PCS, even when invoked only to list the root.
        try {
          const fresh = await this.loadSession(generation);
          signal.throwIfAborted();
          if (fresh.account !== session.account || (fresh.cookies === session.cookies && fresh.endpoint.href === session.endpoint.href)) throw error;
          this.session = Promise.resolve(fresh);
          return await this.send(fresh, area, operation, body, signal);
        } catch (second) {
          if (authFailure(second) && !generation.aborted) this.authBlocked = true;
          throw second;
        }
      }
    });
    this.tail = task.catch(() => {});
    try { return await task; } finally { this.queued--; }
  }

  async libraries(signal: AbortSignal) {
    const libraries = new Map<string, PhotoZone>();
    for (const area of ['private', 'shared'] as const) {
      try {
        let marker: string | null = null;
        for (let page = 0; ; page++) {
          if (page >= 20) throw new CloudError('capacity');
          const data = await this.request(area, 'changes/database', marker ? { syncToken: marker } : {}, signal);
          for (const row of rows(data.zones)) {
            const wire = object(row.zoneID);
            const zoneName = recordId(wire.zoneName);
            if (!zoneName || !isPhotoLibrary(zoneName) || flag(row.deleted) || libraries.has(zoneName)) continue;
            const owner = recordId(wire.ownerRecordName), type = recordId(wire.zoneType);
            libraries.set(zoneName, { area, zoneID: { zoneName, ...(owner ? { ownerRecordName: owner } : {}), ...(type ? { zoneType: type } : {}) } });
          }
          if (!flag(data.moreComing)) break;
          const next = token(data.syncToken);
          if (!next || next === marker) throw new CloudError('provider_rejected');
          marker = next;
        }
      } catch (error) {
        if (area !== 'shared' || !(error instanceof CloudKitFailure) || error.reason !== 'zone_missing') throw error;
      }
    }
    return libraries;
  }

  async count(zone: PhotoZone, signal: AbortSignal, collection = allPhotos) {
    const data = await this.request(zone.area, 'internal/records/query/batch', { batch: [{
      resultsLimit: 1, zoneWide: true, zoneID: zone.zoneID,
      query: { recordType: 'HyperionIndexCountLookup', filterBy: filter('indexCountID', 'STRING_LIST', [collection.count], 'IN') },
    }] }, signal);
    const batch = rows(data.batch, 1);
    if (batch.length !== 1) throw new CloudError('provider_rejected');
    const counts = rows(batch[0].records, 1);
    if (!counts.length) return 0;
    checkErrors(counts[0], 200);
    const total = whole(field(counts[0], 'itemCount'));
    if (total === null) throw new CloudError('provider_rejected');
    return total;
  }

  async page(zone: PhotoZone, rank: number, order: PhotoOrder, limit: number, signal: AbortSignal,
    collection = allPhotos, continuation: string | null = null) {
    let data: ObjectValue;
    try {
      data = await this.request(zone.area, 'records/query', { zoneID: zone.zoneID, desiredKeys: photoKeys, resultsLimit: limit * 2,
        query: { recordType: collection.list, filterBy: [
          filter('startRank', 'INT64', rank), filter('direction', 'STRING', order === 'newest' ? 'DESCENDING' : 'ASCENDING'), ...collection.filters,
        ] },
        ...(continuation ? { continuationMarker: continuation } : {}),
      }, signal);
    } catch (error) {
      // CloudKit rejects an invalid continuation with a generic HTTP 400 BAD_REQUEST.
      if (continuation && error instanceof CloudKitFailure && error.reason === 'bad_request') throw new CloudError('source_changed');
      throw error;
    }
    const records = rows(data.records, 400);
    for (const row of records) checkErrors(row, 200);
    const marker = token(data.continuationMarker);
    if (data.continuationMarker != null && !marker) throw new CloudError('provider_rejected');
    return { records, token: token(data.syncToken), marker };
  }

  async changes(zone: PhotoZone, since: string, signal: AbortSignal) {
    const data = await this.request(zone.area, 'changes/zone', { zones: [{
      zoneID: zone.zoneID, syncToken: since, desiredKeys: photoKeys, resultsLimit: 200,
    }] }, signal);
    const zones = rows(data.zones, 1);
    if (zones.length !== 1) throw new CloudError('provider_rejected');
    const result = zones[0], next = token(result.syncToken), more = flag(result.moreComing);
    if (!next || (more && next === since)) throw new CloudError('provider_rejected');
    const records = rows(result.records, 1_000);
    for (const row of records) checkErrors(row, 200);
    return { records, token: next, more };
  }

  async lookup(zone: PhotoZone, ids: string[], signal: AbortSignal, desiredKeys = photoKeys) {
    const records: ObjectValue[] = [];
    const requested = [...new Set(ids)];
    for (let i = 0; i < requested.length; i += 100) {
      const batch = requested.slice(i, i + 100), allowed = new Set(batch);
      const data = await this.request(zone.area, 'records/lookup', {
        zoneID: zone.zoneID, records: batch.map(recordName => ({ recordName })), desiredKeys,
      }, signal);
      for (const row of rows(data.records, 100)) {
        if (row.serverErrorCode === 'NOT_FOUND' || row.serverErrorCode === 'UNKNOWN_ITEM') continue;
        checkErrors(row, 200);
        if (typeof row.recordName !== 'string' || !allowed.delete(row.recordName)) throw new CloudError('provider_rejected');
        records.push(row);
      }
    }
    return records;
  }

  async albums(zone: PhotoZone, signal: AbortSignal) {
    const albums = new Map(smartAlbums.map(album => [album.id, album]));
    const folders: (string | null)[] = [null];
    let requests = 0;
    for (const folderId of folders) {
      let marker: string | null = null;
      for (;;) {
        if (++requests > 100) throw new CloudError('capacity');
        let data: ObjectValue;
        try {
          data = await this.request(zone.area, 'records/query', {
            zoneID: zone.zoneID, query: { recordType: 'CPLAlbumByPositionLive',
              ...(folderId ? { filterBy: [filter('parentId', 'STRING', folderId)] } : {}) },
            resultsLimit: 200, desiredKeys: ['albumNameEnc', 'albumType', 'parentId', 'isDeleted'],
            ...(marker ? { continuationMarker: marker } : {}),
          }, signal);
        } catch (error) {
          if (zone.zoneID.zoneName !== 'PrimarySync' && error instanceof CloudKitFailure && error.reason === 'album_index') return [...albums.values()];
          throw error;
        }
        for (const row of rows(data.records, 200)) {
          checkErrors(row, 200);
          const id = recordId(row.recordName), name = decodedName(field(row, 'albumNameEnc'));
          if (!id || !name || id === folderId || rootFolders.has(id) || flag(row.deleted) || flag(field(row, 'isDeleted'))) continue;
          const parentValue = field(row, 'parentId');
          const parent = recordId(parentValue) ?? recordId(object(parentValue).recordName) ?? folderId;
          const folder = field(row, 'albumType') === 3;
          if (folder && !albums.has(id)) folders.push(id);
          if (albums.has(id) && !folderId) continue;
          albums.set(id, { id, name, parent: parent && parent !== id && !rootFolders.has(parent) ? parent : null,
            kind: folder ? 'folder' : 'album', collection: folder ? null : {
              list: 'CPLContainerRelationLiveByAssetDate', count: `CPLContainerRelationNotDeletedByAssetDate:${id}`,
              filters: [filter('parentId', 'STRING', id)],
            },
          });
        }
        const next = token(data.continuationMarker);
        if (!next) break;
        if (next === marker) throw new CloudError('provider_rejected');
        marker = next;
      }
    }
    return [...albums.values()];
  }
}
