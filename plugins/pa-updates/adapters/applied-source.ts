import { z } from 'zod';
import { ApplicationError, integrationId } from '../core/application-model.ts';
import type { IntegrationId } from '../core/application-model.ts';
const record = z.object({ id: integrationId, path: z.string().min(1).max(4096), source: z.string().regex(/^[a-f0-9]{64}$/), stamp: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const saved = z.object({ version: z.literal(1), records: z.array(record).max(6) }).strict()
  .refine(value => new Set(value.records.map(row => row.id)).size === value.records.length);
type Store = { load(): Promise<unknown>; save(value: z.infer<typeof saved>): Promise<void> };
/** Last confirmed native loads, not baselines guessed from files on disk.
 * Path-mode BB compiles source itself; physical dist/server.js is not its code. */
export class AppliedSources {
  private records = new Map<IntegrationId, z.infer<typeof record>>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> | null = null;
  private store: Store;
  private signal: AbortSignal;
  constructor(store: Store, signal: AbortSignal) { this.store = store; this.signal = signal; }
  private active() { if (this.signal.aborted) throw new ApplicationError('interrupted'); }
  async get(id: IntegrationId, path: string): Promise<string | null> {
    this.loaded ??= (async () => {
      try { const value = await this.store.load(); this.active(); if (value != null) this.records = new Map(saved.parse(value).records.map(row => [row.id, row])); }
      catch { this.active(); throw new ApplicationError('storage'); }
    })();
    await this.loaded; this.active();
    const found = this.records.get(id); return found?.path === path ? found.source : null;
  }
  async confirmed(id: IntegrationId, path: string, stamp: string) {
    await this.get(id, path); this.active();
    const found = this.records.get(id); return found?.path === path && found.stamp === stamp;
  }
  async remember(id: IntegrationId, path: string, source: string, stamp?: string) {
    await this.get(id, path); this.active();
    const records = new Map(this.records); records.set(id, record.parse({ id, path, source, stamp }));
    const value = saved.parse({ version: 1, records: [...records.values()] });
    const writing = Promise.resolve().then(() => { this.active(); return this.store.save(value); }); this.writing = writing;
    try { await writing; this.active(); this.records = records; }
    catch { this.active(); throw new ApplicationError('storage'); }
    finally { if (this.writing === writing) this.writing = null; }
  }
  async drain() { await this.writing?.catch(() => {}); }
}
