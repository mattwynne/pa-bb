import exifr from 'exifr';
import type { useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './contract.ts';

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Entry = { name: string; directory: boolean; size: number | null };

const ICLOUD_DOWNLOAD = '/api/v1/plugins/icloud/http/photo-download';
const HEIC_DECODER = '/api/v1/plugins/photos/http/libheif.mjs';
const PAGE = 100;
// iCloud keeps a listing for ten minutes; reopen a little before that.
const LISTING_LIFETIME = 9 * 60_000;
const MAX_ORIGINAL = 60 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};
export const imageType = (name: string) => IMAGE_TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? ''] ?? null;

export class JournalError extends Error {}

/** One iCloud listing (a library or album), reopened by name when it expires. */
export class Album {
  readonly path: string[];
  listing = '';
  total = 0;
  private entries: (Entry | undefined)[] = [];
  private opened = 0;
  private reopening: Promise<void> | null = null;

  private readonly rpc: Rpc;
  private constructor(rpc: Rpc, path: string[]) { this.rpc = rpc; this.path = path; }

  static async open(rpc: Rpc, path: string[]) {
    const album = new Album(rpc, path);
    await album.reopen();
    return album;
  }

  get name() { return this.path.at(-1) ?? ''; }

  reopen() {
    this.reopening ??= this.browsePath().finally(() => { this.reopening = null; });
    return this.reopening;
  }

  private async browsePath() {
    let reply = await this.rpc.call('browse', { parent: null });
    if (!reply.ok) throw new JournalError(reply.error);
    let view: { listing: string; total: number; entries: Entry[] } = reply;
    for (const name of this.path) {
      let index = view.entries.findIndex(entry => entry.directory && entry.name === name);
      while (index < 0 && view.entries.length < view.total) {
        const page = await this.rpc.call('page', { listing: view.listing, offset: view.entries.length });
        if (!page.ok) throw new JournalError(page.error);
        view = { ...view, entries: [...view.entries, ...page.entries] };
        index = view.entries.findIndex(entry => entry.directory && entry.name === name);
      }
      if (index < 0) throw new JournalError(`“${name}” is no longer in your library.`);
      reply = await this.rpc.call('browse', { parent: { listing: view.listing, index } });
      if (!reply.ok) throw new JournalError(reply.error);
      view = reply;
    }
    this.listing = view.listing;
    this.total = view.total;
    this.entries = Array.from({ length: view.total }, (_, index) => view.entries[index]);
    this.opened = Date.now();
  }

  private async fresh() {
    if (Date.now() - this.opened > LISTING_LIFETIME) await this.reopen();
  }

  private async load(offset: number) {
    const page = await this.rpc.call('page', { listing: this.listing, offset });
    if (!page.ok) throw new JournalError(page.error);
    page.entries.forEach((entry, i) => { this.entries[offset + i] = entry; });
  }

  /** Entries from index `start` down to `end`, loading pages as needed. */
  async range(start: number, end: number) {
    await this.fresh();
    for (let offset = Math.floor(Math.max(0, end) / PAGE) * PAGE; offset <= start; offset += PAGE) {
      if (!this.entries[offset]) await this.load(offset);
    }
    const result: { entry: Entry; index: number }[] = [];
    for (let index = start; index >= Math.max(0, end); index--) {
      const entry = this.entries[index];
      if (entry) result.push({ entry, index });
    }
    return result;
  }

  directories() {
    return this.entries.filter((entry): entry is Entry => Boolean(entry?.directory)).map(entry => entry.name);
  }

  // Indexes shift if the album changed since it was listed, so check the name.
  private async find(name: string, hint: number) {
    if (hint < this.total && !this.entries[hint]) await this.load(Math.floor(hint / PAGE) * PAGE);
    if (this.entries[hint]?.name === name) return hint;
    for (let offset = 0; offset < this.total; offset += PAGE) {
      if (!this.entries[offset]) await this.load(offset);
    }
    const index = this.entries.findIndex(entry => entry?.name === name);
    if (index < 0) throw new JournalError('This photo is no longer in the album.');
    return index;
  }

  async ticket(name: string, hint: number) {
    await this.fresh();
    for (let attempt = 0; ; attempt++) {
      const reply = await this.rpc.call('download', { listing: this.listing, index: await this.find(name, hint), mode: 'download' });
      if (reply.ok) return reply.ticket;
      if (attempt > 0) throw new JournalError(reply.error);
      await this.reopen();
    }
  }
}

/** A photo Journal can show, cached by name and size so thumbnails survive listing changes. */
export type PhotoRef = { key: string; name: string; size: number; index: number; album: Album };
export const photoKey = (name: string, size: number) => `${name}/${size}`;

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Fetch one original from iCloud. iCloud serves one photo at a time, so wait politely when it is busy. */
export async function fetchOriginal(photo: PhotoRef, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const ticket = await photo.album.ticket(photo.name, photo.index);
    const response = await fetch(`${ICLOUD_DOWNLOAD}?ticket=${encodeURIComponent(ticket)}`, {
      credentials: 'same-origin', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
    });
    if (response.ok) {
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_ORIGINAL) { await response.body?.cancel(); throw new JournalError('This photo is too large to show here.'); }
      return response.arrayBuffer();
    }
    await response.body?.cancel().catch(() => {});
    if (response.status !== 502 && response.status !== 503 || attempt >= 4) throw new JournalError('iCloud could not send this photo.');
    await wait(1500 * 2 ** attempt, signal);
  }
}

// When the photo was taken, as the camera's own wall-clock time ("2024-02-15T11:28:52").
export async function takenAt(bytes: ArrayBuffer, name: string) {
  try {
    const exif = await exifr.parse(bytes, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    const value = String(exif?.DateTimeOriginal ?? exif?.CreateDate ?? '');
    const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (match && match[1] !== '0000') return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  } catch { /* fall back to the file name */ }
  const named = /^(\d{4})-(\d{2})-(\d{2})[ _](\d{2})\.(\d{2})\.(\d{2})/.exec(name);
  return named ? `${named[1]}-${named[2]}-${named[3]}T${named[4]}:${named[5]}:${named[6]}` : null;
}

// Decoding and JPEG encoding happen in a worker so scrolling stays smooth. Safari
// decodes HEIC itself; other browsers load the libheif decoder the first time.
const workerSource = (decoderUrl: string) => `
let heif, decoder;
async function heic(bytes) {
  heif ??= import(${JSON.stringify(decoderUrl)}).then(module => module.default());
  const lib = await heif;
  decoder ??= new lib.HeifDecoder();
  const images = decoder.decode(new Uint8Array(bytes));
  try {
    const image = images.find(item => item.is_primary()) ?? images[0];
    if (!image) throw new Error('decode');
    const width = image.get_width(), height = image.get_height();
    const data = await new Promise((resolve, reject) => image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, out => out ? resolve(out) : reject(new Error('decode'))));
    return createImageBitmap(new ImageData(data.data, width, height));
  } finally { for (const item of images) item.free(); }
}
self.onmessage = async ({ data: { id, bytes, type, maxEdge, quality, minQuality, maxBytes } }) => {
  try {
    let bitmap;
    try { bitmap = await createImageBitmap(new Blob([bytes], { type })); }
    catch (error) { if (!/hei[cf]/.test(type)) throw error; bitmap = await heic(bytes); }
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    let blob;
    for (let q = quality; ; q = Math.round((q - 0.1) * 10) / 10) {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
      if (blob.size <= maxBytes || q - 0.1 < minQuality - 1e-9) break;
    }
    if (blob.size > maxBytes) throw new Error('size');
    self.postMessage({ id, ok: true, blob, width, height });
  } catch { self.postMessage({ id, ok: false }); }
};`;

let worker: Worker | null = null;
let nextJob = 0;
const jobs = new Map<number, (value: { ok: true; blob: Blob; width: number; height: number } | { ok: false }) => void>();
function imageWorker() {
  if (!worker) {
    const url = URL.createObjectURL(new Blob([workerSource(new URL(HEIC_DECODER, location.origin).href)], { type: 'text/javascript' }));
    worker = new Worker(url, { type: 'module', name: 'photos-journal' });
    URL.revokeObjectURL(url);
    worker.onmessage = ({ data }) => { jobs.get(data.id)?.(data); jobs.delete(data.id); };
    worker.onerror = () => { for (const done of jobs.values()) done({ ok: false }); jobs.clear(); worker?.terminate(); worker = null; };
  }
  return worker;
}

export type JpegOptions = { maxEdge: number; quality: number; minQuality: number; maxBytes: number };
/** Re-encode an original as a JPEG within the size limits, trying lower qualities if needed. */
export function encodeJpeg(bytes: ArrayBuffer, type: string, options: JpegOptions) {
  const id = nextJob++;
  return new Promise<{ blob: Blob; width: number; height: number }>((resolve, reject) => {
    jobs.set(id, result => result.ok ? resolve(result) : reject(new JournalError('This photo could not be decoded.')));
    imageWorker().postMessage({ id, bytes, type, ...options }, [bytes]);
  });
}

export const THUMBNAIL: JpegOptions = { maxEdge: 1024, quality: 0.8, minQuality: 0.6, maxBytes: 400_000 };
// Grain accepts photos up to 1,000,000 bytes and shows them at up to 2000 px.
export const GRAIN_RENDITION: JpegOptions = { maxEdge: 2000, quality: 0.9, minQuality: 0.5, maxBytes: 1_000_000 };

/** A JPEG of the original for sharing. Not used until posting is connected. */
export async function photoRendition(photo: PhotoRef, options = GRAIN_RENDITION, signal?: AbortSignal) {
  const bytes = await fetchOriginal(photo, signal);
  return encodeJpeg(bytes, imageType(photo.name) ?? 'application/octet-stream', options);
}

// Thumbnails stay in this browser so later visits are instant.
export type Thumbnail = { blob: Blob; date: string | null; width: number; height: number };
let database: Promise<IDBDatabase> | null = null;
function thumbnails() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pa-photos-journal', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('thumbnails');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
async function store<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await thumbnails();
  return new Promise<T>((resolve, reject) => {
    const request = action(db.transaction('thumbnails', mode).objectStore('thumbnails'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function cachedThumbnail(key: string) {
  try { return await store<Thumbnail | undefined>('readonly', s => s.get(key)); } catch { return undefined; }
}

/** Load a thumbnail from the cache or, failing that, from iCloud. */
export async function thumbnail(photo: PhotoRef, signal?: AbortSignal): Promise<Thumbnail> {
  const cached = await cachedThumbnail(photo.key);
  if (cached) return cached;
  const bytes = await fetchOriginal(photo, signal);
  const date = await takenAt(bytes, photo.name);
  const { blob, width, height } = await encodeJpeg(bytes, imageType(photo.name)!, THUMBNAIL);
  const value = { blob, date, width, height };
  await store('readwrite', s => s.put(value, photo.key)).catch(() => {});
  return value;
}
