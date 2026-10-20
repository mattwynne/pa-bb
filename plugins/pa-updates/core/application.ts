import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ApplicationError, assessmentSchema, applicationSavedSchema, applyInputSchema, reviewSchema, version } from './application-model.ts';
import type { ApplicationSaved as Saved, ApplicationStatus, Assessment, IntegrationId, FailureCode } from './application-model.ts';
import { runtimeReviewSchema } from './runtime-model.ts';
import type { RuntimePorts } from './runtime-model.ts';
export * from './application-model.ts';
export type ApplicationPorts = {
  inspect(): Promise<Assessment[]>;
  validateMix(installing: IntegrationId[]): Promise<void>;
  update(id: IntegrationId, authorized: { installed: string; fingerprint: string; jobId: string }): Promise<{ actual: string; updated: boolean }>;
  quiesce(ids: IntegrationId[], jobId: string, remember: () => Promise<void>): Promise<void>;
  restore(jobId: string): Promise<void | 'manual_recovery'>;
  load(): Promise<unknown>; save(value: Saved): Promise<void>;
  runtime?: RuntimePorts;
  cancel?(): void | Promise<void>;
  diagnose(stage: 'review' | 'preflight' | 'activate' | 'quiesce' | 'restore' | 'storage', code: FailureCode): void;
};
const category = (error: unknown): FailureCode => error instanceof ApplicationError ? error.category : 'unavailable';

/** One review and one persisted application job, not a generic workflow engine. */
export class Application {
  private saved: Saved = { review: null, job: null };
  private checking: Promise<ApplicationStatus> | null = null;
  private reviewRequested = false;
  private offers: ApplicationStatus['offers'] = null;
  private applying = false;
  private reconciling: Promise<ApplicationStatus> | null = null;
  private inFlight() { return this.applying || this.saved.job?.phase === 'restarting'; }
  private running: Promise<void> | null = null;
  private failure: FailureCode | null = null;
  private disposed = false;
  private writing: Promise<void> | null = null;
  private active() { if (this.disposed) throw new ApplicationError('interrupted'); }
  private ports: ApplicationPorts;
  private notify: () => void;
  constructor(ports: ApplicationPorts, notify: () => void = () => {}) { this.ports = ports; this.notify = notify; }
  async start() {
    try {
      const value = await this.ports.load(); this.active();
      if (value != null) this.saved = applicationSavedSchema.parse(value);
      const job = this.saved.job;
      if (job?.phase === 'restarting' && job.bbIntent && this.ports.runtime) {
        await this.refresh();
      } else if (job && !['complete', 'attention'].includes(job.phase)) {
        // Never retry an uncertain plugin write after restart. Retain receipts
        // and pause state for inspection rather than pretending it rolled back.
        job.phase = 'attention'; job.failure = 'interrupted';
        for (const row of [...job.receipts, ...job.runtimeReceipts]) if (row.outcome === 'activating') row.outcome = 'uncertain';
        await this.persist();
      }
    } catch { if (!this.disposed) { this.failure = 'storage'; this.ports.diagnose('storage', 'storage'); } }
  }
  status(): ApplicationStatus { return structuredClone({ ...this.saved, checking: this.checking !== null, applying: this.inFlight(), failure: this.failure, offers: this.offers }); }
  refresh(): Promise<ApplicationStatus> {
    if (this.reconciling) return this.reconciling;
    const job = this.saved.job;
    const eligible = job?.bbIntent && (job.phase === 'restarting' || (job.phase === 'attention' && job.runtimeReceipts.some(row => row.id === 'bb' && row.outcome === 'uncertain')));
    if (this.disposed || this.applying || !eligible || this.failure === 'storage') return Promise.resolve(this.status());
    this.reconciling = (async () => {
      try { await this.reconcileBb(); }
      catch (error) { if (!this.disposed) this.ports.diagnose('activate', category(error)); }
      finally { this.reconciling = null; }
      return this.status();
    })();
    return this.reconciling;
  }
  private async reconcileBb() {
    const job = this.saved.job, receipt = job?.runtimeReceipts.find(row => row.id === 'bb');
    if (!job?.bbIntent || !receipt || !this.ports.runtime) throw new ApplicationError('interrupted');
    const result = await this.ports.runtime.reconcileBb(job.bbIntent); this.active();
    if (result.state === 'pending') return;
    receipt.actual = result.actual === null ? null : version.parse(result.actual);
    receipt.outcome = result.state === 'updated' ? 'updated' : result.state === 'failed' ? 'failed' : 'uncertain';
    job.failure = result.state === 'updated' ? null : result.state === 'failed' ? 'unavailable' : 'interrupted';
    job.phase = job.failure ? 'attention' : 'complete';
    await this.persist();
  }
  private async restoreSync() {
    const job = this.saved.job!;
    const result = await this.ports.restore(job.id); this.active(); job.syncReserved = false; await this.persist();
    if (result === 'manual_recovery') throw new ApplicationError('sync_recovery');
  }
  private async persist() {
    this.active();
    const writing = this.ports.save(structuredClone(this.saved)); this.writing = writing;
    try { await writing; this.active(); this.notify(); }
    catch {
      this.active(); this.failure = 'storage'; this.ports.diagnose('storage', 'storage'); throw new ApplicationError('storage');
    } finally { if (this.writing === writing) this.writing = null; }
  }
  async dispose() {
    this.disposed = true; const stopping = this.ports.cancel?.();
    // BB may hold its registration lock while disposing us. Never await a job
    // that could need that lock. Drain ONLY already-issued KV writes so a
    // replacement instance cannot be overwritten by this instance later.
    await this.writing?.catch(() => {});
    await stopping;
  }
  review({ automatic = false } = {}): Promise<ApplicationStatus> {
    if (this.disposed || this.inFlight() || this.failure === 'storage') return Promise.resolve(this.status());
    if (!automatic && this.saved.job?.syncReserved) { this.failure = 'interrupted'; return Promise.resolve(this.status()); }
    // An explicit caller joining automatic discovery still asks for a new
    // review. Both callers share the same bounded inspection, not a second job.
    if (this.checking) { if (!automatic) this.reviewRequested = true; return this.checking; }
    if (this.reconciling) return Promise.resolve(this.status());
    this.reviewRequested = !automatic;
    this.checking = (async () => {
      try {
        const rows = z.array(assessmentSchema).max(5).parse(await this.ports.inspect()); this.active();
        if (new Set(rows.map(row => row.id)).size !== rows.length) throw new ApplicationError('unavailable');
        const runtime = this.ports.runtime ? runtimeReviewSchema.parse(await this.ports.runtime.inspect()) : null; this.active();
        if (runtime && new Set(runtime.rows.map(row => row.id)).size !== runtime.rows.length) throw new ApplicationError('unavailable');
        const previous = this.saved.review, preserve = !this.reviewRequested && this.saved.job && this.saved.job.reviewId === previous?.id;
        const checkedAt = new Date().toISOString();
        // A kept/skipped/uncertain old offer is not a newly discovered release.
        // The native inspections already omit current integration versions and
        // distinguish ready runtime offers from installed/current versions.
        // After a successful runtime update, trust a new native offer even if
        // source-channel BB commits share the same displayed version.
        this.offers = { checkedAt, available: rows.some(row => row.local !== 'unknown' && !row.prerequisite &&
          (!preserve || row.available !== previous?.rows.find(old => old.id === row.id)?.available)) ||
          !!runtime?.rows.some(row => row.state === 'ready' && row.available &&
            (!preserve || this.saved.job?.runtimeReceipts.some(receipt => receipt.id === row.id && receipt.outcome === 'updated') ||
              row.available !== previous?.runtime?.rows.find(old => old.id === row.id)?.available)) };
        this.failure = null;
        if (!preserve) { this.saved.review = { id: randomUUID(), at: checkedAt, rows, runtime }; await this.persist(); }
      } catch (error) { if (!this.disposed) { this.offers = null; this.failure = category(error); this.ports.diagnose('review', this.failure); } }
      finally { this.checking = null; this.reviewRequested = false; if (!this.disposed) this.notify(); }
      return this.status();
    })();
    return this.checking;
  }
  async apply(input: z.infer<typeof applyInputSchema>): Promise<ApplicationStatus> {
    this.active();
    if (this.inFlight() || this.reconciling) return this.status();
    if (this.checking || this.failure === 'storage') return this.status();
    const parsed = applyInputSchema.parse(input), review = this.saved.review;
    if (!review || review.id !== parsed.reviewId || this.saved.job?.reviewId === review.id || this.saved.job?.syncReserved) throw new ApplicationError('changed');
    const choices = new Map(parsed.choices.map(row => [row.id, row.choice]));
    if (choices.size !== parsed.choices.length || parsed.choices.some(choice => !review.rows.some(row => row.id === choice.id && row.local === 'custom'))) throw new ApplicationError('changed');
    const receipts = review.rows.map(row => ({ id: row.id, before: row.installed, preview: row.available, actual: null,
      choice: row.local === 'stock' ? 'install' as const : choices.get(row.id) ?? 'keep' as const,
      outcome: 'pending' as const }));
    const runtimeReceipts = (review.runtime?.rows ?? []).filter(row => row.state === 'ready' && row.available).map(row => ({ id: row.id, before: row.installed, preview: row.available!, actual: null, source: row.source, outcome: 'pending' as const }));
    if (!receipts.some(row => row.choice === 'install') && !runtimeReceipts.length) return this.status();
    if (review.rows.some(row => receipts.find(receipt => receipt.id === row.id)?.choice === 'install' && (row.local === 'unknown' || row.prerequisite))) throw new ApplicationError('baseline_unknown');
    this.applying = true; this.failure = null; this.offers = null;
    this.saved.job = { id: randomUUID(), reviewId: review.id, phase: 'preflight', receipts, syncReserved: false, failure: null,
      runtimeReceipts, bbIntent: null, confirmInterruptingThreads: parsed.confirmInterruptingThreads ?? false };
    try { await this.persist(); }
    catch { this.applying = false; return this.status(); }
    this.running = this.execute(review).finally(() => { this.applying = false; this.running = null; if (!this.disposed) this.notify(); });
    return this.status();
  }
  private async execute(review: z.infer<typeof reviewSchema>) {
    const job = this.saved.job!;
    let stage: Parameters<ApplicationPorts['diagnose']>[0] = 'preflight';
    try {
      const installs = job.receipts.filter(row => row.choice === 'install');
      const preflight = async () => {
        this.active(); const current = await this.ports.inspect(); this.active();
        for (const receipt of installs) {
          const before = review.rows.find(row => row.id === receipt.id)!, now = current.find(row => row.id === receipt.id);
          // Available version may advance. Local overwrite authority may not.
          if (!now || now.fingerprint !== before.fingerprint || now.installed !== before.installed || now.local !== before.local) throw new ApplicationError('changed');
          if (now.prerequisite) throw new ApplicationError(now.prerequisite);
        }
        await this.ports.validateMix(installs.map(row => row.id)); this.active();
      };
      await preflight();
      if (job.runtimeReceipts.length && review.runtime && this.ports.runtime) {
        const current = await this.ports.runtime.inspect(); this.active();
        if (!current.target || current.target.id !== review.runtime.target?.id) throw new ApplicationError('changed');
        for (const receipt of job.runtimeReceipts) {
          const before = review.runtime.rows.find(row => row.id === receipt.id)!, now = current.rows.find(row => row.id === receipt.id);
          if (!now || now.fingerprint !== before.fingerprint) throw new ApplicationError('changed');
          if (now.state === 'unavailable') throw new ApplicationError(now.reason ?? 'unavailable');
        }
        if (job.runtimeReceipts.some(row => row.id === 'bb') && current.runningThreadCount > 0 && !job.confirmInterruptingThreads) throw new ApplicationError('busy');
      }
      stage = 'quiesce'; job.phase = 'quiescing'; await this.persist();
      await this.ports.quiesce(installs.map(row => row.id), job.id, async () => { job.syncReserved = true; await this.persist(); });
      stage = 'preflight'; await preflight();
      job.phase = 'applying'; await this.persist();
      // Existing iCloud note interface requires provider before consumer.
      const ordered = [...job.receipts].sort((a, b) => Number(a.id === 'obsidian') - Number(b.id === 'obsidian'));
      for (const receipt of ordered) {
        if (receipt.choice === 'keep') { receipt.outcome = review.rows.find(row => row.id === receipt.id)?.local === 'unknown' ? 'skipped' : 'kept'; receipt.actual = receipt.before; await this.persist(); continue; }
        this.active(); stage = 'activate'; receipt.outcome = 'activating'; await this.persist();
        const authorized = review.rows.find(row => row.id === receipt.id)!;
        this.active();
        const result = await this.ports.update(receipt.id, { installed: authorized.installed, fingerprint: authorized.fingerprint, jobId: job.id }); this.active();
        receipt.actual = version.parse(result.actual); receipt.outcome = result.updated ? 'updated' : 'unchanged'; await this.persist();
      }
      // Restore integration scheduling before runtime work; BB's launcher may
      // replace this process and must not strand a successful sync reservation.
      if (job.syncReserved) {
        stage = 'restore'; job.phase = 'restoring'; await this.persist();
        await this.restoreSync();
      }
      if (review.runtime && this.ports.runtime) {
        job.phase = 'applying'; await this.persist();
        for (const receipt of job.runtimeReceipts.filter(row => row.id !== 'bb')) {
          stage = 'activate'; receipt.outcome = 'activating'; await this.persist(); this.active();
          const result = await this.ports.runtime.updateCli(receipt.id as 'pi' | 'codex', review.runtime); this.active();
          receipt.actual = version.parse(result.actual); receipt.source = result.source;
          receipt.outcome = result.actual === receipt.before ? 'unchanged' : 'updated'; await this.persist();
        }
        const bb = job.runtimeReceipts.find(row => row.id === 'bb');
        if (bb) {
          stage = 'preflight'; job.bbIntent = await this.ports.runtime.prepareBb(review.runtime, job.confirmInterruptingThreads); this.active();
          job.phase = 'restarting'; bb.outcome = 'activating'; await this.persist();
          stage = 'activate'; this.active();
          try { await this.ports.runtime.applyBb(job.bbIntent, job.confirmInterruptingThreads); }
          catch (error) {
            this.active();
            if (error instanceof ApplicationError && ['busy', 'changed', 'unsupported_install'].includes(error.category)) { bb.outcome = 'failed'; throw error; }
            // A lost response is not permission to retry a restart. Read native status.
          }
          this.active(); await this.reconcileBb();
        }
      }
    } catch (error) {
      if (this.disposed) return;
      job.failure = category(error); this.ports.diagnose(stage, job.failure);
      for (const receipt of [...job.receipts, ...job.runtimeReceipts]) if (receipt.outcome === 'activating') receipt.outcome = 'uncertain';
    } finally {
      if (this.disposed || (job.phase === 'restarting' && !job.failure)) return;
      if (job.syncReserved && this.failure !== 'storage' && !job.receipts.some(row => row.outcome === 'uncertain')) {
        try { job.phase = 'restoring'; await this.persist(); this.active(); await this.restoreSync(); }
        catch (error) { if (this.disposed) return; job.failure = category(error); this.ports.diagnose('restore', job.failure); }
      }
      job.phase = job.failure || this.failure === 'storage' ? 'attention' : 'complete';
      try { await this.persist(); } catch { /* persist already diagnosed; never retry writes */ }
    }
  }
  async resumeSync(): Promise<ApplicationStatus> {
    this.active();
    const job = this.saved.job;
    if (this.inFlight() || this.reconciling || this.checking || this.failure === 'storage' || !job?.syncReserved) return this.status();
    this.applying = true;
    try { await this.restoreSync(); this.failure = null; await this.persist(); }
    catch (error) { if (!this.disposed) { job.failure = category(error); this.ports.diagnose('restore', job.failure); try { await this.persist(); } catch { /* already diagnosed */ } } }
    finally { this.applying = false; if (!this.disposed) this.notify(); }
    return this.status();
  }
  async join() { await this.running; }
}
