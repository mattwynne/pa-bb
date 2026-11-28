import type { useRpc } from '@get-bb/plugin-sdk/app';
import type { Asset, PhotoVersion, rpcContract } from './contract.ts';

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export type PhotoRef = { library: string; asset: Asset };
export type ThumbnailVersion = 'thumb' | 'medium' | 'large';
export type ThumbnailRequest = PhotoRef & { key: string; version: ThumbnailVersion };

export class JournalError extends Error {}
export function unwrap<T>(reply: ({ ok: true } & T) | { ok: false; error: string }): T {
  if (!reply.ok) throw new JournalError(reply.error);
  return reply;
}

export function gridThumbnail(photo: PhotoRef, pixels: number): ThumbnailRequest | null {
  const { thumb, medium, large } = photo.asset.versions;
  // Apple's medium and large video resources contain the movie. A grid tile
  // only needs its poster. Photo libraries may expose JPEG Large without Medium.
  const larger = photo.asset.kind === 'video' ? null : medium ? 'medium' : large ? 'large' : null;
  // For square crops the shorter edge is the useful resolution. Unknown
  // dimensions favor the thumb; never fall back to downloading an original.
  const thumbEdge = Math.min(thumb?.width ?? Infinity, thumb?.height ?? Infinity);
  const version = thumb && (thumbEdge >= pixels || !larger) ? 'thumb' : larger;
  if (!version) return null;
  const { width, height, bytes, type } = photo.asset.versions[version]!;
  const key = JSON.stringify([photo.library, photo.asset.id, version, width, height, bytes, type]);
  return { ...photo, key, version };
}

export function ticketBatches(requests: ThumbnailRequest[]) {
  const groups = new Map<ThumbnailVersion, ThumbnailRequest[]>();
  for (const request of requests) {
    const group = groups.get(request.version);
    if (group) group.push(request);
    else groups.set(request.version, [request]);
  }
  return Array.from(groups.values()).flatMap(group =>
    Array.from({ length: Math.ceil(group.length / 200) }, (_, part) => group.slice(part * 200, (part + 1) * 200)));
}

export async function fetchPhotoVersion(ticket: string, signal?: AbortSignal, priority: RequestPriority = 'high') {
  const response = await fetch(`/api/v1/plugins/icloud/http/photo-version?ticket=${encodeURIComponent(ticket)}`, {
    credentials: 'same-origin', referrerPolicy: 'no-referrer', signal, priority,
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
    await response.body?.cancel().catch(() => {});
    throw new JournalError('iCloud could not send this preview.');
  }
  return response.blob();
}

const STORE = 'apple-versions';
const CACHE_INFO = 'cache-info';
const CACHE_BYTES = 256 * 1024 * 1024;
type StoredThumbnail = { blob: Blob; savedAt: number };
let database: Promise<IDBDatabase> | undefined;
function thumbnails() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pa-photos-journal', 2);
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains('thumbnails')) request.result.deleteObjectStore('thumbnails');
      request.result.createObjectStore(STORE).createIndex('savedAt', 'savedAt');
      request.result.createObjectStore(CACHE_INFO);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('thumbnail cache blocked')); };
  });
  return database;
}

async function readCache(keys: string[]) {
  try {
    const db = await thumbnails();
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    return await Promise.all(keys.map(key => new Promise<Blob | undefined>((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve((request.result as StoredThumbnail | undefined)?.blob);
      request.onerror = () => reject(request.error);
    })));
  } catch { return keys.map(() => undefined); }
}

async function writeCache(key: string, blob: Blob) {
  try {
    if (blob.size > CACHE_BYTES) return;
    const db = await thumbnails();
    const transaction = db.transaction([STORE, CACHE_INFO], 'readwrite');
    const store = transaction.objectStore(STORE);
    const info = transaction.objectStore(CACHE_INFO);
    // Update usage and evict the oldest writes in the same transaction, so
    // two Journal tabs share the same limit. A cache failure never blocks paint.
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      const older = store.get(key);
      const usage = info.get('bytes');
      usage.onsuccess = () => {
        const replaced = (older.result as StoredThumbnail | undefined)?.blob.size ?? 0;
        let bytes = (usage.result ?? 0) + blob.size - replaced;
        store.put({ blob, savedAt: Date.now() } satisfies StoredThumbnail, key);
        if (bytes <= CACHE_BYTES) { info.put(bytes, 'bytes'); return; }
        const cursor = store.index('savedAt').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (bytes <= CACHE_BYTES || !row) { info.put(bytes, 'bytes'); return; }
          if (row.primaryKey !== key) {
            bytes -= (row.value as StoredThumbnail).blob.size;
            row.delete();
          }
          row.continue();
        };
      };
    });
  } catch { /* optional browser cache */ }
}

type Thumbnail = { blob: Blob; url: string };
type ImageDependencies = {
  read(keys: string[]): Promise<(Blob | undefined)[]>;
  write(key: string, blob: Blob): Promise<void>;
  tickets(requests: ThumbnailRequest[]): Promise<Record<string, string | null>>;
  download(ticket: string, signal: AbortSignal, priority: RequestPriority): Promise<Blob>;
};

export function thumbnailQueue(rpc: Rpc, publish: () => void) {
  return new ThumbnailQueue({
    read: readCache, write: writeCache, download: fetchPhotoVersion,
    async tickets(requests) {
      const { library, version } = requests[0];
      return unwrap(await rpc.call('photoVersionTickets', { library, version, ids: requests.map(item => item.asset.id) })).tickets;
    },
  }, publish);
}

/** One pool per grid. Decode is left to the browser's async img decoder. */
export class ThumbnailQueue {
  private visible = new Map<string, ThumbnailRequest>();
  private ahead = new Map<string, ThumbnailRequest>();
  private results = new Map<string, Thumbnail | null>();
  private active = new Map<string, AbortController>();
  private running = false;
  private disposed = false;

  private readonly images: ImageDependencies;
  private readonly publish: () => void;

  constructor(images: ImageDependencies, publish: () => void) {
    this.images = images;
    this.publish = publish;
  }

  get(key: string) { return this.results.get(key); }

  setTargets(visible: ThumbnailRequest[], ahead: ThumbnailRequest[]) {
    this.visible = new Map(visible.map(item => [item.key, item]));
    this.ahead = new Map(ahead.filter(item => !this.visible.has(item.key)).map(item => [item.key, item]));
    for (const [key, controller] of this.active) if (!this.wanted(key)) controller.abort();
    // A small recent window lets short reverse scrolls keep their painted tiles.
    const spare = [...this.results.keys()].filter(key => !this.wanted(key));
    for (const key of spare.slice(0, Math.max(0, spare.length - 96))) this.drop(key);
    if (!this.running && !this.disposed) {
      this.running = true;
      void this.pump().finally(() => { this.running = false; });
    }
  }

  retry() {
    for (const [key, value] of this.results) if (!value) this.results.delete(key);
    this.setTargets([...this.visible.values()], [...this.ahead.values()]);
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
    for (const key of this.results.keys()) this.drop(key);
  }

  private wanted(key: string) { return !this.disposed && (this.visible.has(key) || this.ahead.has(key)); }

  private drop(key: string) {
    const value = this.results.get(key);
    if (value) URL.revokeObjectURL(value.url);
    this.results.delete(key);
  }

  private finish(key: string, blob: Blob | null) {
    if (!this.wanted(key)) return;
    this.results.set(key, blob ? { blob, url: URL.createObjectURL(blob) } : null);
    this.publish();
  }

  private async pump() {
    while (!this.disposed) {
      const urgent = [...this.visible.values()].filter(item => !this.results.has(item.key));
      const requests = (urgent.length ? urgent : [...this.ahead.values()].filter(item => !this.results.has(item.key))).slice(0, 200);
      if (!requests.length) return;
      const cached = await this.images.read(requests.map(item => item.key));
      const missing = requests.filter((item, index) => {
        if (cached[index]) this.finish(item.key, cached[index]!);
        return !cached[index] && this.wanted(item.key);
      });
      for (const batch of ticketBatches(missing)) {
        const wanted = batch.filter(item => this.wanted(item.key));
        if (!wanted.length) continue;
        let tickets: Record<string, string | null> = {};
        try { tickets = await this.images.tickets(wanted); } catch { /* show a retryable placeholder */ }
        let next = 0;
        const worker = async () => {
          while (next < wanted.length) {
            const { key, asset } = wanted[next++];
            if (!this.wanted(key)) continue;
            const ticket = Object.hasOwn(tickets, asset.id) ? tickets[asset.id] : null;
            if (!ticket) { this.finish(key, null); continue; }
            const controller = new AbortController();
            this.active.set(key, controller);
            try {
              const blob = await this.images.download(ticket, controller.signal, this.visible.has(key) ? 'high' : 'low');
              if (controller.signal.aborted) continue;
              this.finish(key, blob);
              void this.images.write(key, blob);
            } catch {
              if (!controller.signal.aborted) this.finish(key, null);
            } finally { this.active.delete(key); }
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));
      }
    }
  }
}

export const GRAIN_RENDITION = { maxEdge: 2000, maxBytes: 1_000_000 };

export async function fitJpeg(
  width: number, height: number,
  enc: (width: number, height: number, quality: number) => Promise<Blob>,
) {
  let scale = Math.min(1, GRAIN_RENDITION.maxEdge / Math.max(width, height));
  for (;;) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    for (const quality of [0.9, 0.78, 0.65, 0.52]) {
      const blob = await enc(w, h, quality);
      if (blob.size <= GRAIN_RENDITION.maxBytes) return { blob, width: w, height: h };
    }
    if (w === 1 && h === 1) throw new JournalError('This photo could not be made small enough.');
    scale *= 0.75;
  }
}

/** Posting can use this once connected. Source bytes are Apple's JPEG preview. */
export async function photoRendition(rpc: Rpc, { library, asset }: PhotoRef, signal?: AbortSignal) {
  let ticket: string | null = null;
  for (const version of ['large', 'medium'] satisfies PhotoVersion[]) {
    if (!asset.versions[version]) continue;
    signal?.throwIfAborted();
    const reply = unwrap(await rpc.call('photoVersionTickets', { library, ids: [asset.id], version }));
    ticket = Object.hasOwn(reply.tickets, asset.id) ? reply.tickets[asset.id] : null;
    if (ticket) break;
  }
  if (!ticket) throw new JournalError('This photo has no JPEG preview.');
  const blob = await fetchPhotoVersion(ticket, signal);
  if (blob.type !== 'image/jpeg') throw new JournalError('This photo has no JPEG preview.');
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(1, 1);
    return await fitJpeg(bitmap.width, bitmap.height, (width, height, quality) => {
      signal?.throwIfAborted();
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
      } else if (width === 1 && height === 1) {
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
      }
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    });
  } finally { bitmap.close(); }
}
