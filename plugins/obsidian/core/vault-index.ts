import type { ParsedLinks, VaultLinks } from './vault-links.ts';
import { VaultError, type Metadata } from './ports.ts';

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export type IndexedNote = Frozen<{ path: string; hash: string; readAt: string; properties: Record<string, unknown>; linkData?: ParsedLinks; propertyWarning?: 'properties_unsupported'; metadata?: Omit<Metadata, 'properties'>; metadataWarning?: 'parser_limit' }>;
export type IndexOmission = Readonly<{ path: string; kind: 'note' | 'tree' }>;
export type IndexView = Readonly<{ notes: readonly IndexedNote[]; attachments?: readonly string[]; links?: (root: string) => VaultLinks; directories: readonly string[]; omissions: readonly IndexOmission[] }>;
export type IndexLease = { readonly view: IndexView; check(signal?: AbortSignal): Promise<void>; assertValid(): void; assertUnchanged?(): void; close(): void };
export type IndexGeneration = { view: IndexView; memory?: IndexReservation; published?(): void; release(): void };
type Refresh = (previous: IndexView | undefined, paths: ReadonlySet<string> | null, signal: AbortSignal) => Promise<IndexGeneration>;

export const abortError = (signal: AbortSignal) => signal.reason instanceof VaultError ? signal.reason : new VaultError('cancelled');
export function untilAborted<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError(signal));
    signal.addEventListener('abort', cancel, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** A null scope means reconcile the whole vault. Only this mailbox publishes. */
export class VaultIndex {
  private current?: { generation: IndexGeneration; refs: number };
  private failure?: VaultError;
  private paths = new Set<string>();
  private full = false;
  private observation = 0;
  private active?: Promise<void>;
  private debounce?: ReturnType<typeof setTimeout>;
  private leases = new Set<() => void>();
  private controller = new AbortController();
  constructor(private refresh: Refresh, private authorize: (signal: AbortSignal) => Promise<void>, private failed: (error: VaultError) => VaultError) {}

  hint(path?: string, delay = 0) {
    if (this.controller.signal.aborted) return;
    this.observation++;
    if (!path || this.paths.size >= 1024 || this.failure) { this.full = true; this.paths.clear(); }
    else if (!this.full) this.paths.add(path);
    if (this.active) return;
    if (!delay) { clearTimeout(this.debounce); this.debounce = undefined; this.run(); }
    else if (!this.debounce) {
      this.debounce = setTimeout(() => { this.debounce = undefined; this.run(); }, delay);
      this.debounce.unref();
    }
  }
  private drop(held?: { generation: IndexGeneration; refs: number }) {
    if (held && --held.refs === 0) held.generation.release();
  }
  private run() {
    this.active = Promise.resolve().then(async () => {
      const paths = this.full || !this.current || this.failure ? null : this.paths;
      this.paths = new Set(); this.full = false;
      try {
        const next = await this.refresh(this.current?.generation.view, paths, this.controller.signal);
        if (this.controller.signal.aborted) { next.release(); return; }
        try { next.memory?.publish(this.current?.generation.memory, (this.current?.refs ?? 0) > 1); }
        catch (error) { next.release(); throw error; }
        this.drop(this.current);
        this.current = { generation: next, refs: 1 }; this.failure = undefined;
        const published = next.published; delete next.published;
        published?.();
      } catch (error) {
        if (!this.controller.signal.aborted) this.failure = this.failed(error instanceof VaultError ? error : new VaultError('unavailable'));
      }
    }).finally(() => {
      this.active = undefined;
      if (!this.controller.signal.aborted && (this.paths.size || this.full)) this.run();
    });
  }
  async acquire(signal?: AbortSignal): Promise<IndexLease> {
    const cancellation = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
    if (cancellation.aborted) throw abortError(cancellation);
    if (!this.current && !this.active && !this.failure) this.hint();
    if (!this.current && this.active) await untilAborted(this.active, cancellation);
    if (cancellation.aborted) throw abortError(cancellation);
    if (this.failure) throw this.failure;
    let held = this.current;
    if (!held) throw new VaultError('unavailable');
    const observed = this.observation;
    held.refs++;
    const close = () => { this.drop(held); held = undefined; this.leases.delete(close); };
    const requireHeld = () => { if (!held) throw new VaultError('source_unavailable'); return held; };
    this.leases.add(close);
    try { await this.authorize(cancellation); if (cancellation.aborted) throw abortError(cancellation); requireHeld(); }
    catch (error) { close(); throw error; }
    return {
      get view() { return requireHeld().generation.view; },
      check: async signal => {
        requireHeld();
        const cancellation = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
        await this.authorize(cancellation);
        if (cancellation.aborted) throw abortError(cancellation);
        requireHeld();
      }, assertValid: requireHeld,
      assertUnchanged: () => {
        requireHeld();
        if (observed !== this.observation) throw new VaultError('conflict', 'Vault changes were observed during link discovery. Prepare a fresh move plan.');
      }, close,
    };
  }
  async stop(reason = new VaultError('cancelled')) {
    this.controller.abort(reason); clearTimeout(this.debounce); this.paths.clear();
    for (const close of this.leases) close();
    // A running builder may still be reading the previous view.
    await this.active;
    this.drop(this.current); this.current = undefined;
  }
}

type Bucket = 'building' | 'current' | 'retained';
type IndexReservation = { add(size: number): void; publish(previous: IndexReservation | undefined, retain: boolean): void; release(): void };

/** Current vaults cannot consume builder or cursor-retention headroom. */
export class IndexBudget {
  private used = { building: 0, current: 0, retained: 0 };
  private records = new WeakMap<IndexReservation, { bytes: number; bucket?: Bucket }>();
  constructor(private caps: Record<Bucket, number>, private perView: number) {}
  reservation(): IndexReservation {
    const record: { bytes: number; bucket?: Bucket } = { bytes: 0, bucket: 'building' };
    const transfer = (entry: typeof record, bucket?: Bucket) => {
      if (entry.bucket) this.used[entry.bucket] -= entry.bytes;
      if (bucket) this.used[bucket] += entry.bytes;
      entry.bucket = bucket;
    };
    const ticket: IndexReservation = {
      add: size => {
        if (record.bucket !== 'building' || record.bytes + size > this.perView || this.used.building + size > this.caps.building) throw new VaultError('capacity');
        record.bytes += size; this.used.building += size;
      },
      publish: (previous, retain) => {
        const old = previous && this.records.get(previous);
        if (record.bucket !== 'building' || (previous && old?.bucket !== 'current')) throw new VaultError('unavailable');
        const replaced = old?.bytes ?? 0;
        if (this.used.current - replaced + record.bytes > this.caps.current ||
            (retain && this.used.retained + replaced > this.caps.retained)) throw new VaultError('capacity');
        if (old) transfer(old, retain ? 'retained' : undefined);
        transfer(record, 'current');
      },
      release: () => transfer(record),
    };
    this.records.set(ticket, record);
    return ticket;
  }
}
