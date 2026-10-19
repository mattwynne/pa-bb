import { createHash } from 'node:crypto';
import { compare, parseRelease } from './release.ts';
import { CheckError, savedSchema } from './model.ts';
import type { Ports, Saved, Status, Category } from './model.ts';
export const INTERVAL = 6 * 60 * 60 * 1000;
export const COOLDOWN = 60 * 1000;
const empty = (): Saved => ({ observation: null, lastSuccess: null, lastAttempt: null, feedFailure: null, pin: null });
const category = (error: unknown): Category => error instanceof CheckError ? error.category : 'unavailable';
export class Updates {
  private ports: Ports;
  private saved = empty();
  private inflight: Promise<Status> | null = null;
  private abort = new AbortController();
  private storageFailure = false;
  private changed: () => void;
  constructor(ports: Ports, changed: () => void = () => {}) { this.ports = ports; this.changed = changed; }
  async start() {
    try { const saved = await this.ports.load(); if (saved !== undefined) this.saved = savedSchema.parse(saved); }
    catch { this.storageFailure = true; this.ports.diagnose('storage', 'storage'); }
  }
  status(): Status {
    const { pin: _, ...saved } = this.saved;
    return { ...saved, checking: this.inflight !== null, storageFailure: this.storageFailure,
      stale: this.saved.feedFailure !== null || (this.saved.lastSuccess !== null && this.ports.now() - Date.parse(this.saved.lastSuccess) >= INTERVAL),
      nextManualAt: this.saved.lastAttempt ? new Date(Date.parse(this.saved.lastAttempt) + COOLDOWN).toISOString() : null,
      comparison: this.saved.observation ? compare(this.saved.observation.installed, this.saved.observation.release, this.saved.observation.runtime) : 'first' };
  }
  check(manual = true): Promise<Status> {
    if (this.inflight) return this.inflight;
    if (this.abort.signal.aborted) return Promise.resolve(this.status());
    const last = this.saved.lastAttempt ? Date.parse(this.saved.lastAttempt) : -Infinity;
    if (this.ports.now() - last < (manual ? COOLDOWN : INTERVAL)) return Promise.resolve(this.status());
    this.inflight = this.run().finally(() => { this.inflight = null; this.changed(); });
    this.changed();
    return this.inflight.then(() => this.status());
  }
  async stop() { this.abort.abort(); await this.inflight; }
  private async persist() {
    try { await this.ports.save(this.saved); }
    catch { if (!this.storageFailure) this.ports.diagnose('storage', 'storage'); this.storageFailure = true; }
  }
  private async run(): Promise<Status> {
    this.saved.lastAttempt = new Date(this.ports.now()).toISOString();
    // Persist attempts before network work so restart cannot bypass the cooldown.
    await this.persist();
    let release = this.saved.observation?.release ?? null;
    let feedFailure: Category | null = null;
    try {
      if (this.storageFailure) throw new CheckError('storage');
      const result = await this.ports.feed(this.abort.signal);
      if (result) {
        let parsed;
        try { parsed = parseRelease(result.text, result.identity); } catch { throw new CheckError('invalid'); }
        const digest = createHash('sha256').update(result.text).digest('hex');
        if (this.saved.pin?.identity === parsed.identity && this.saved.pin.digest !== digest) throw new CheckError('mutated');
        release = parsed; this.saved.pin = { identity: parsed.identity, digest };
      } else { release = null; }
      this.saved.lastSuccess = new Date(this.ports.now()).toISOString();
    } catch (error) {
      feedFailure = category(error);
      if (!this.abort.signal.aborted) this.ports.diagnose('feed', feedFailure);
    }
    let inventory; let inventoryFailed = false;
    try { inventory = await this.ports.inventory(this.abort.signal); }
    catch (error) { inventoryFailed = true; if (!this.abort.signal.aborted) this.ports.diagnose('inventory', category(error)); }
    let local;
    try { local = await this.ports.local(release?.sourceCommit ?? null, this.abort.signal); }
    catch (error) {
      if (!this.abort.signal.aborted) this.ports.diagnose('local', category(error));
      local = { outcome: 'not_assessed' as const, reason: 'unavailable' as const, at: new Date(this.ports.now()).toISOString() };
    }
    if (!this.abort.signal.aborted) {
      this.saved.observation = { at: new Date(this.ports.now()).toISOString(), release, installed: inventory?.installed, runtime: inventory?.runtime ?? null, inventoryFailed, local };
      this.saved.feedFailure = feedFailure;
      await this.persist();
    }
    return this.status();
  }
}
