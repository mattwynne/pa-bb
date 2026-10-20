import { z } from 'zod';
import { CloudError } from './ports.ts';
import type { ICloudSync } from './service.ts';
const recordSchema = z.object({ jobId: z.string().uuid(), ownedIds: z.array(z.string()).max(20) }).strict();
type Record = z.infer<typeof recordSchema>;
/** One updater-specific Pause reservation, not a general maintenance grant.
 * Actual pause ownership lives with iCloud across its native plugin reload.
 */
export class UpdatePause {
  private record: Record | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private faulted = false;
  private manualRecovery = false;
  private sync: ICloudSync;
  private store: { get(): Promise<unknown>; set(value: Record | null): Promise<void> };
  constructor(sync: ICloudSync, store: { get(): Promise<unknown>; set(value: Record | null): Promise<void> }) { this.sync = sync; this.store = store; }
  async start() {
    try { const saved = await this.store.get(); this.record = saved == null ? null : recordSchema.parse(saved); }
    catch { throw new CloudError('unavailable'); }
  }
  status() { return { version: 1 as const, jobId: this.record?.jobId ?? null, manualRecovery: this.manualRecovery }; }
  get held() { return this.faulted || this.record !== null; }
  private active() { if (this.stopped) throw new CloudError('busy'); if (this.faulted) throw new CloudError('unavailable'); }
  private async save() { this.active(); try { await this.store.set(structuredClone(this.record)); } catch { this.faulted = true; throw new CloudError('unavailable'); } this.active(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(() => { this.active(); return operation(); });
    this.queue = task.catch(() => {}); return task;
  }
  assertUserCanStartSync() { this.active(); if (this.held) throw new CloudError('busy'); }
  async stop() { this.stopped = true; await this.queue; }
  pause(jobId: string) {
    return this.serial(async () => {
      if (this.record && this.record.jobId !== jobId) throw new CloudError('busy');
      if (!this.record) { this.manualRecovery = false; this.record = { jobId, ownedIds: [] }; await this.save(); }
      // Hold admission even if a native run is still draining. The updater may
      // repeat this idempotent Pause, but never retries an installation write.
      if (this.sync.status().mirrors.some(mirror => mirror.phase === 'running')) return;
      for (const mirror of this.sync.status().mirrors) {
        if (!mirror.enabled) continue; // A user's Pause during drain stays theirs.
        if (!this.record.ownedIds.includes(mirror.id)) { this.record.ownedIds.push(mirror.id); await this.save(); }
        this.active(); await this.sync.pause(mirror.id);
      }
    });
  }
  resume(jobId: string) {
    return this.serial(async () => {
      if (!this.record) return; // Lost response after successful release is safe.
      if (this.record.jobId !== jobId) throw new CloudError('busy');
      for (const id of [...this.record.ownedIds]) {
        const mirror = this.sync.status().mirrors.find(mirror => mirror.id === id);
        if (mirror && mirror.phase !== 'retained') {
          // Leave failed folders safely paused, but release our restoration
          // rights so their ordinary Retry/Enable/Rebuild actions are usable.
          if (mirror.failure !== null || mirror.blocker !== null) this.manualRecovery = true;
          else if (!mirror.enabled) { this.active(); await this.sync.enable(id); }
        }
        this.record.ownedIds = this.record.ownedIds.filter(owned => owned !== id); await this.save();
      }
      this.record = null; await this.save();
    });
  }
  userPause(id: string) {
    return this.serial(async () => {
      if (this.record?.ownedIds.includes(id)) { this.record.ownedIds = this.record.ownedIds.filter(owned => owned !== id); await this.save(); }
      await this.sync.pause(id);
    });
  }
  userEnable(id: string) {
    return this.serial(async () => { this.assertUserCanStartSync(); await this.sync.enable(id); });
  }
  disconnect() {
    return this.serial(async () => {
      // Disconnect revokes every updater-owned resume, even across reconnect.
      if (this.record) { this.record.ownedIds = []; await this.save(); }
      await this.sync.disconnect();
    });
  }
}
