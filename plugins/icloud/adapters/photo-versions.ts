import { randomUUID } from 'node:crypto';
import { CloudError } from '../core/ports.ts';
import type { Diagnose } from '../core/ports.ts';
import type { PhotoVersion } from '../core/photos-contract.ts';
import { appleUrl } from './cloudkit-photos.ts';
import type { CloudKitPhotos, PhotoZone } from './cloudkit-photos.ts';
import { field, mediaMime, object } from './icloud-photo-records.ts';
import type { Resource } from './icloud-photo-records.ts';

type Signed = { url: URL; expires: number };
type Selection = { scope: string; zone: PhotoZone; asset: string; master: string; resource: Resource };
type TicketGroup = { ids: string[]; started: boolean };
type Ticket = Selection & { expires: number; group: TicketGroup };
const ttl = 15 * 60_000;
const minimumLifetime = 10 * 60_000;

export class PhotoVersions {
  private readonly signed = new Map<string, Signed>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly recent = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly batches = new Map<string, { zone: PhotoZone; resources: Map<string, Resource>; task: Promise<void> }>();
  private readonly waiters = new Set<() => void>();
  private active = 0;
  private lifetime = new AbortController();

  constructor(private readonly cloud: CloudKitPhotos, private readonly diagnose: Diagnose,
    private readonly transport: typeof fetch = fetch, private readonly now = Date.now) {}

  invalidate() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.tickets.clear();
    this.recent.clear();
    this.signed.clear();
    this.pending.clear();
    this.batches.clear();
  }

  private key(scope: string, record: string, field: string) { return JSON.stringify([scope, record, field]); }

  remember(scope: string, record: string, key: string, value: unknown) {
    const cacheKey = this.key(scope, record, key);
    const url = appleUrl(value);
    this.signed.delete(cacheKey);
    if (!url) return;
    this.signed.set(cacheKey, { url, expires: this.now() + ttl });
    if (this.signed.size > 4_000) this.signed.delete(this.signed.keys().next().value!);
  }

  forget(scope: string, assetIds: string[], masterIds: string[]) {
    if (!assetIds.length && !masterIds.length) return;
    const assets = new Set(assetIds), masters = new Set(masterIds);
    for (const [id, ticket] of this.tickets) {
      if (ticket.scope === scope && (assets.has(ticket.asset) || masters.has(ticket.master))) this.tickets.delete(id);
    }
  }

  mint(selections: Map<string, Selection | null>, version: PhotoVersion) {
    const now = this.now();
    for (const [id, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(id);
    for (const [key, id] of this.recent) if (!this.tickets.has(id)) this.recent.delete(key);
    const result: [string, string | null][] = [];
    const provisional: { key: string; id: string; selection: Selection }[] = [];
    for (const [asset, selection] of selections) {
      if (!selection) { result.push([asset, null]); continue; }
      const key = this.key(selection.scope, asset, version);
      const recent = this.recent.get(key);
      const existing = recent ? this.tickets.get(recent) : undefined;
      if (recent && existing && existing.expires >= now + minimumLifetime &&
        existing.resource.record === selection.resource.record && existing.resource.key === selection.resource.key) {
        result.push([asset, recent]);
        continue;
      }
      const id = randomUUID();
      provisional.push({ key, id, selection });
      result.push([asset, id]);
    }
    if (this.tickets.size + provisional.length > 30_000) throw new CloudError('capacity');
    const group = { ids: provisional.map(entry => entry.id), started: false };
    for (const { key, id, selection } of provisional) {
      this.tickets.set(id, { ...selection, expires: now + ttl, group });
      this.recent.set(key, id);
    }
    return Object.fromEntries(result);
  }

  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < 6) { this.active++; return; }
    if (this.waiters.size >= 256) throw new CloudError('busy');
    // Transfer the slot directly to the oldest live waiter when a stream closes.
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { this.waiters.delete(wake); reject(signal.reason); };
      this.waiters.add(wake);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  private release() {
    const next = this.waiters.values().next().value;
    if (!next) { this.active--; return; }
    this.waiters.delete(next);
    next();
  }

  private lookup(ticket: Ticket, key: string) {
    const current = this.pending.get(key);
    if (current) return current;
    const signal = this.lifetime.signal;
    let batch = this.batches.get(ticket.scope);
    if (!batch) {
      const resources = new Map<string, Resource>();
      const task = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        if (this.batches.get(ticket.scope)?.resources === resources) this.batches.delete(ticket.scope);
        signal.throwIfAborted();
        const ids = [...new Set([...resources.values()].map(r => r.record))];
        const fields = [...new Set([...resources.values()].map(r => r.key))];
        const rows = await this.cloud.lookup(ticket.zone, ids, signal, fields);
        signal.throwIfAborted();
        const byId = new Map(rows.map(row => [row.recordName, row]));
        for (const resource of resources.values()) {
          const row = byId.get(resource.record);
          this.remember(ticket.scope, resource.record, resource.key, row ? object(field(row, resource.key)).downloadURL : undefined);
        }
      }).finally(() => {
        for (const key of resources.keys()) if (this.pending.get(key) === task) this.pending.delete(key);
      });
      batch = { zone: ticket.zone, resources, task };
      this.batches.set(ticket.scope, batch);
    }
    batch.resources.set(key, ticket.resource);
    this.pending.set(key, batch.task);
    return batch.task;
  }

  private async get(ticket: Ticket, signal: AbortSignal) {
    const key = this.key(ticket.scope, ticket.resource.record, ticket.resource.key);
    let cached = this.signed.get(key);
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      if (!cached || cached.expires <= this.now()) {
        // A cold grid can request hundreds of draws. The first draw primes
        // the rest of its ticket batch in at most two CloudKit lookups.
        if (!ticket.group.started) {
          ticket.group.started = true;
          for (const id of ticket.group.ids) {
            const other = this.tickets.get(id);
            if (!other || other.expires <= this.now()) continue;
            const otherKey = this.key(other.scope, other.resource.record, other.resource.key);
            const saved = this.signed.get(otherKey);
            if (!saved || saved.expires <= this.now()) void this.lookup(other, otherKey).catch(() => {});
          }
        }
        await this.lookup(ticket, key);
        signal.throwIfAborted();
        cached = this.signed.get(key);
        if (!cached) throw new CloudError('invalid_selection');
      }
      const response = await this.transport(cached.url, { credentials: 'omit', redirect: 'error', signal, headers: { 'Accept-Encoding': 'identity' } });
      if (response.status === 200 && response.body) return response;
      await response.body?.cancel().catch(() => {});
      if (attempt > 0 || ![401, 403, 404, 410].includes(response.status)) throw new CloudError('unavailable');
      // Another stream may already have replaced the same rejected URL.
      if (this.signed.get(key) === cached) this.signed.delete(key);
      cached = this.signed.get(key);
    }
    throw new CloudError('unavailable');
  }

  async download(id: string, request: AbortSignal, closed: () => void) {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.expires <= this.now()) throw new CloudError('invalid_selection');
    if (this.cloud.authFailed) throw new CloudError('authentication');
    const signal = AbortSignal.any([request, this.lifetime.signal, AbortSignal.timeout(60 * 60_000)]);
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      if (this.tickets.get(id) !== ticket || ticket.expires <= this.now()) throw new CloudError('invalid_selection');
      const upstream = await this.get(ticket, signal);
      const reader = upstream.body!.getReader();
      const headers = new Headers({
        'Content-Type': mediaMime(upstream.headers.get('content-type')?.split(';', 1)[0].trim())
          ?? mediaMime(ticket.resource.metadata.type) ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      const length = upstream.headers.get('content-length');
      const encoding = upstream.headers.get('content-encoding');
      if (length && /^\d{1,16}$/.test(length) && (!encoding || encoding === 'identity')) headers.set('Content-Length', length);
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        signal.removeEventListener('abort', abort);
        this.release();
        closed();
      };
      const abort = () => { void reader.cancel().catch(() => {}); finish(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const body = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            const { done, value } = await reader.read();
            if (!done) controller.enqueue(value);
            else { controller.close(); finish(); }
          } catch {
            if (!signal.aborted) this.diagnose('photo_version_stream', 'unavailable');
            controller.error(new CloudError('unavailable'));
            finish();
          }
        },
        cancel: async () => { try { await reader.cancel(); } finally { finish(); } },
      });
      return new Response(body, { headers });
    } catch (error) {
      this.release();
      signal.throwIfAborted();
      throw error instanceof CloudError ? error : new CloudError('unavailable');
    }
  }
}
