import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ApplicationError, assessmentSchema, integrationInventorySchema, developmentWorkSchema, applicationSavedSchema, applyInputSchema, reviewSchema, version, localDecision, reviewDecision, selfIntentSchema } from './application-model.ts';
import type { ApplicationSaved as Saved, ApplicationStatus, CheckProgress, DevelopmentWork, Assessment, IntegrationId, IntegrationInventoryRow, FailureCode, SelfIntent } from './application-model.ts';
import { runtimeReviewSchema, runtimeRowSchema } from './runtime-model.ts';
import type { RuntimePorts } from './runtime-model.ts';
export * from './application-model.ts';
export type ApplicationPorts = {
  inspect(onResult?: (row: IntegrationInventoryRow) => void): Promise<Assessment[]>;
  /** Read-only inventory from the same completed inspection; never install authority. */
  inventory?(): IntegrationInventoryRow[];
  /** Canonical source-work facts; never substitute these for installed bytes. */
  development?(): Promise<DevelopmentWork | null>;
  validateMix(installing: IntegrationId[]): Promise<void>;
  update(id: IntegrationId, authorized: { installed: string; fingerprint: string; jobId: string }): Promise<{ actual: string; updated: boolean }>;
  quiesce(ids: IntegrationId[], jobId: string, remember: () => Promise<void>): Promise<void>;
  restore(jobId: string): Promise<void | 'manual_recovery'>;
  load(): Promise<unknown>; save(value: Saved): Promise<void>;
  runtime?: RuntimePorts;
  self?: {
    prepare(authorized: { installed: string; fingerprint: string; jobId: string }): Promise<SelfIntent>;
    apply(intent: SelfIntent): Promise<void>;
    reconcile(intent: SelfIntent, completed?: boolean): Promise<{ state: 'pending' | 'updated' | 'unchanged' | 'uncertain'; actual: string | null }>;
  };
  cancel?(): void | Promise<void>;
  diagnose(stage: 'review' | 'preflight' | 'activate' | 'quiesce' | 'restore' | 'storage', code: FailureCode): void;
};
const category = (error: unknown): FailureCode => error instanceof ApplicationError ? error.category : 'unavailable';

/** One review and one persisted application job, not a generic workflow engine. */
export class Application {
  private saved: Saved = { review: null, job: null };
  private checking: Promise<ApplicationStatus> | null = null;
  private reviewRequested = false;
  private progress: CheckProgress | null = null;
  private offers: ApplicationStatus['offers'] = null;
  private applying = false;
  private reconciling: Promise<ApplicationStatus> | null = null;
  private inFlight() { return this.applying || this.saved.job?.phase === 'restarting' || this.saved.job?.phase === 'self-updating'; }
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
      if (this.saved.review) this.saved.review.rows = this.saved.review.rows.map(row => {
        const development = row.development ?? this.saved.review!.inventory?.find(item => item.id === row.id)?.development;
        return { ...row, ...(development ? { development } : {}), decision: localDecision({ ...row, development }) };
      });
      const job = this.saved.job;
      // Factory/start runs under BB registration. Loading KV is safe, but
      // native reconciliation and any final self admission must happen later.
      const deferred = job && (job.phase === 'restarting' && job.bbIntent && this.ports.runtime || job.phase === 'self-updating' && this.ports.self && (job.selfIntent || this.pendingSelf()));
      if (job && !deferred && !['complete', 'attention'].includes(job.phase)) {
        // Never retry an uncertain plugin write after restart. Retain receipts
        // and pause state for inspection rather than pretending it rolled back.
        job.phase = 'attention'; job.failure = 'interrupted';
        for (const row of [...job.receipts, ...job.runtimeReceipts]) if (row.outcome === 'activating') row.outcome = 'uncertain';
        await this.persist();
      }
    } catch { if (!this.disposed) { this.failure = 'storage'; this.ports.diagnose('storage', 'storage'); } }
  }
  status(): ApplicationStatus { return structuredClone({ ...this.saved, checking: this.checking !== null, applying: this.inFlight(), failure: this.failure, offers: this.offers, progress: this.progress }); }
  refresh(): Promise<ApplicationStatus> {
    if (this.reconciling) return this.reconciling;
    const job = this.saved.job;
    const eligibleBb = job?.bbIntent && (job.phase === 'restarting' || (job.phase === 'attention' && job.runtimeReceipts.some(row => row.id === 'bb' && row.outcome === 'uncertain')));
    const self = job?.receipts.find(row => row.id === 'pa-updates');
    const eligibleSelf = job?.selfIntent && (self?.outcome === 'activating' || self?.outcome === 'uncertain' && Date.now() - Date.parse(job.selfIntent.requestedAt) < 15 * 60_000);
    const continuation = job?.phase === 'self-updating' && this.pendingSelf();
    if (this.disposed || this.applying || this.checking || !(eligibleBb || eligibleSelf || continuation) || this.failure === 'storage') return Promise.resolve(this.status());
    this.reconciling = Promise.resolve().then(async () => {
      try {
        if (eligibleSelf) await this.reconcileSelf();
        else if (eligibleBb) await this.reconcileBb();
        if (this.saved.job?.phase === 'self-updating' && this.pendingSelf()) this.continueSelf();
      }
      catch (error) { if (!this.disposed) { const code = category(error); if (code === 'storage') this.failure = code; this.ports.diagnose(code === 'storage' ? 'storage' : 'activate', code); } }
      finally { this.reconciling = null; }
      return this.status();
    });
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
    job.phase = job.failure ? 'attention' : this.pendingSelf() ? 'self-updating' : 'complete';
    await this.persist();
  }
  private pendingSelf() {
    const job = this.saved.job;
    return !!job && !job.selfIntent && job.receipts.some(row => row.id === 'pa-updates' && row.choice === 'install' && row.outcome === 'pending');
  }
  private async reconcileSelf(completed = false) {
    const job = this.saved.job!, receipt = job.receipts.find(row => row.id === 'pa-updates');
    if (!job.selfIntent || !receipt || !this.ports.self) throw new ApplicationError('interrupted');
    const result = await this.ports.self.reconcile(job.selfIntent, completed); this.active();
    if (result.state === 'pending') return;
    const actual = result.actual === null ? null : version.parse(result.actual);
    const failure = result.state === 'uncertain' ? 'interrupted' : null;
    if (receipt.actual === actual && receipt.outcome === result.state && job.failure === failure) return;
    receipt.actual = actual; receipt.outcome = result.state;
    job.failure = failure; job.phase = failure ? 'attention' : 'complete';
    await this.persist();
  }
  /** Resume only the final, not-yet-admitted self step, never an earlier write. */
  private continueSelf() {
    this.applying = true;
    this.running = (async () => {
      try { await this.selfStep(); }
      catch (error) {
        if (this.disposed) return;
        const job = this.saved.job!; job.failure = category(error); job.phase = 'attention';
        const receipt = job.receipts.find(row => row.id === 'pa-updates');
        if (receipt?.outcome === 'activating') receipt.outcome = 'uncertain';
        this.ports.diagnose(job.selfIntent ? 'activate' : 'preflight', job.failure);
        try { await this.persist(); } catch { /* already diagnosed; no native retry */ }
      }
    })().finally(() => { this.applying = false; this.running = null; if (!this.disposed) this.notify(); });
  }
  private async selfStep() {
    if (!this.pendingSelf()) return;
    const job = this.saved.job!, review = this.saved.review, receipt = job.receipts.find(row => row.id === 'pa-updates')!;
    if (!this.ports.self || !review || review.id !== job.reviewId || job.failure || job.syncReserved ||
      job.receipts.some(row => row.id !== 'pa-updates' && !['updated', 'unchanged', 'kept', 'skipped'].includes(row.outcome)) ||
      job.runtimeReceipts.some(row => !['updated', 'unchanged'].includes(row.outcome))) throw new ApplicationError('interrupted');
    const authorized = review.rows.find(row => row.id === 'pa-updates');
    if (!authorized) throw new ApplicationError('changed');
    // BB may have restarted since the first preflight. Recheck both facts,
    // without granting new choice authority or resuming any earlier step.
    const development = this.ports.development ? developmentWorkSchema.nullable().parse(await this.ports.development()) : null; this.active();
    const current = (await this.ports.inspect()).find(row => row.id === 'pa-updates'); this.active();
    if (!current || current.fingerprint !== authorized.fingerprint || current.installed !== authorized.installed || current.local !== authorized.local || current.prerequisite) throw new ApplicationError('changed');
    const decision = localDecision({ ...current, ...(development ? { development: development['pa-updates'] } : {}) });
    if (decision === 'unverified' || decision === 'choose' && reviewDecision(authorized) !== 'choose') throw new ApplicationError('changed');
    job.selfIntent = selfIntentSchema.parse(await this.ports.self.prepare({ installed: authorized.installed, fingerprint: authorized.fingerprint, jobId: job.id })); this.active();
    job.phase = 'self-updating'; receipt.outcome = 'activating'; await this.persist(); this.active();
    // Native replacement disposes this instance. Once this intent is durable,
    // every replacement instance can only observe, never replay the admission.
    await this.ports.self.apply(job.selfIntent); this.active();
    await this.reconcileSelf(true);
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
    this.disposed = true; this.progress = null; const stopping = this.ports.cancel?.();
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
    if (this.checking) {
      if (!automatic) { this.reviewRequested = true; if (this.progress) this.progress.requested = true; this.notify(); }
      return this.checking;
    }
    if (this.reconciling) return Promise.resolve(this.status());
    this.reviewRequested = !automatic;
    const progress: CheckProgress = { id: randomUUID(), requested: !automatic, integrations: [], integrationsDone: false, runtime: [], runtimeDone: !this.ports.runtime, target: null };
    this.progress = progress;
    // Assign checking before any callback can publish: even synchronous ports
    // must never expose a partial check with apply admission still open.
    this.checking = Promise.resolve().then(async () => {
      try {
        this.active();
        const development = this.ports.development ? developmentWorkSchema.nullable().parse(await this.ports.development()) : null; this.active();
        const displayRow = (row: IntegrationInventoryRow) => integrationInventorySchema.parse({ ...row, ...(development ? { development: development[row.id] } : {}) });
        const rows = z.array(assessmentSchema).max(6).parse(await this.ports.inspect(row => {
          if (this.disposed || this.progress !== progress) return;
          const result = displayRow(row);
          progress.integrations = [...progress.integrations.filter(old => old.id !== result.id), result]; this.notify();
        })).map(row => {
          const facts = { ...row, ...(development ? { development: development[row.id] } : {}) };
          return { ...facts, decision: localDecision(facts) };
        }); this.active();
        if (new Set(rows.map(row => row.id)).size !== rows.length) throw new ApplicationError('unavailable');
        const inventory = z.array(integrationInventorySchema).max(6).parse(this.ports.inventory?.() ?? []).map(displayRow);
        if (new Set(inventory.map(row => row.id)).size !== inventory.length) throw new ApplicationError('unavailable');
        progress.integrations = inventory; progress.integrationsDone = true; this.notify();
        const runtime = this.ports.runtime ? runtimeReviewSchema.parse(await this.ports.runtime.inspect((row, target) => {
          if (this.disposed || this.progress !== progress) return;
          const result = runtimeRowSchema.parse(row);
          progress.runtime = [...progress.runtime.filter(old => old.id !== result.id), result];
          progress.target = runtimeReviewSchema.shape.target.parse(target); this.notify();
        })) : null; this.active();
        if (runtime && new Set(runtime.rows.map(row => row.id)).size !== runtime.rows.length) throw new ApplicationError('unavailable');
        progress.runtime = runtime?.rows ?? []; progress.runtimeDone = true; progress.target = runtime?.target ?? null;
        const previous = this.saved.review, preserve = !this.reviewRequested && this.saved.job && this.saved.job.reviewId === previous?.id;
        const checkedAt = new Date().toISOString();
        // A kept/skipped/uncertain old offer is not a newly discovered release.
        // The native inspections already omit current integration versions and
        // distinguish ready runtime offers from installed/current versions.
        // After a successful runtime update, trust a new native offer even if
        // source-channel BB commits share the same displayed version.
        this.offers = { checkedAt, available: rows.some(row => reviewDecision(row) !== 'unverified' && !row.prerequisite &&
          (!preserve || row.available !== previous?.rows.find(old => old.id === row.id)?.available)) ||
          !!runtime?.rows.some(row => row.state === 'ready' && row.available &&
            (!preserve || this.saved.job?.runtimeReceipts.some(receipt => receipt.id === row.id && receipt.outcome === 'updated') ||
              row.available !== previous?.runtime?.rows.find(old => old.id === row.id)?.available)) };
        this.failure = null;
        if (!preserve) { this.saved.review = { id: randomUUID(), at: checkedAt, rows, runtime, inventory }; await this.persist(); }
      } catch (error) { if (!this.disposed) { this.offers = null; this.failure = category(error); this.ports.diagnose('review', this.failure); } }
      finally { this.checking = null; this.progress = null; this.reviewRequested = false; if (!this.disposed) this.notify(); }
      return this.status();
    });
    this.notify();
    return this.checking;
  }
  async apply(input: z.infer<typeof applyInputSchema>): Promise<ApplicationStatus> {
    this.active();
    if (this.inFlight() || this.reconciling) return this.status();
    if (this.checking || this.failure === 'storage') return this.status();
    const parsed = applyInputSchema.parse(input), review = this.saved.review;
    if (!review || review.id !== parsed.reviewId || this.saved.job?.reviewId === review.id || this.saved.job?.syncReserved) throw new ApplicationError('changed');
    const choices = new Map(parsed.choices.map(row => [row.id, row.choice]));
    if (choices.size !== parsed.choices.length || parsed.choices.some(choice => !review.rows.some(row => row.id === choice.id && reviewDecision(row) === 'choose'))) throw new ApplicationError('changed');
    const receipts = review.rows.map(row => ({ id: row.id, before: row.installed, preview: row.available, actual: null,
      choice: reviewDecision(row) === 'automatic' ? 'install' as const : choices.get(row.id) ?? 'keep' as const,
      outcome: 'pending' as const }));
    const runtimeReceipts = (review.runtime?.rows ?? []).filter(row => row.state === 'ready' && row.available).map(row => ({ id: row.id, before: row.installed, preview: row.available!, actual: null, source: row.source, outcome: 'pending' as const }));
    if (!receipts.some(row => row.choice === 'install') && !runtimeReceipts.length) return this.status();
    if (review.rows.some(row => receipts.find(receipt => receipt.id === row.id)?.choice === 'install' && (reviewDecision(row) === 'unverified' || row.prerequisite))) throw new ApplicationError('baseline_unknown');
    // Self is never admitted through the ordinary integration loop. Its final
    // native replacement has a separate durable lifecycle below.
    if (!this.ports.self && receipts.some(row => row.id === 'pa-updates' && row.choice === 'install')) throw new ApplicationError('unsupported_install');
    this.applying = true; this.failure = null; this.offers = null;
    this.saved.job = { id: randomUUID(), reviewId: review.id, phase: 'preflight', receipts, syncReserved: false, failure: null,
      runtimeReceipts, bbIntent: null, selfIntent: null, confirmInterruptingThreads: parsed.confirmInterruptingThreads ?? false };
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
      const integrations = installs.filter(row => row.id !== 'pa-updates');
      const preflight = async () => {
        this.active(); const development = this.ports.development ? developmentWorkSchema.nullable().parse(await this.ports.development()) : null; this.active();
        const current = await this.ports.inspect(); this.active();
        for (const receipt of installs) {
          const before = review.rows.find(row => row.id === receipt.id)!, now = current.find(row => row.id === receipt.id);
          // Available version may advance. Local overwrite authority may not.
          if (!now || now.fingerprint !== before.fingerprint || now.installed !== before.installed || now.local !== before.local) throw new ApplicationError('changed');
          if (now.prerequisite) throw new ApplicationError(now.prerequisite);
          const decision = localDecision({ ...now, ...(development ? { development: development[now.id] } : {}) });
          if (decision === 'unverified' || decision === 'choose' && reviewDecision(before) !== 'choose') throw new ApplicationError('changed');
        }
        await this.ports.validateMix(integrations.map(row => row.id)); this.active();
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
      await this.ports.quiesce(integrations.map(row => row.id), job.id, async () => { job.syncReserved = true; await this.persist(); });
      stage = 'preflight'; await preflight();
      job.phase = 'applying'; await this.persist();
      // Existing iCloud note interface requires provider before consumer.
      const ordered = job.receipts.filter(row => row.id !== 'pa-updates' || row.choice === 'keep').sort((a, b) => Number(a.id === 'obsidian') - Number(b.id === 'obsidian'));
      for (const receipt of ordered) {
        if (receipt.choice === 'keep') { receipt.outcome = reviewDecision(review.rows.find(row => row.id === receipt.id)!) === 'unverified' ? 'skipped' : 'kept'; receipt.actual = receipt.before; await this.persist(); continue; }
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
      if (!job.failure && job.phase !== 'restarting') { stage = 'activate'; await this.selfStep(); }
    } catch (error) {
      if (this.disposed) return;
      job.failure = category(error); this.ports.diagnose(stage, job.failure);
      for (const receipt of [...job.receipts, ...job.runtimeReceipts]) if (receipt.outcome === 'activating') receipt.outcome = 'uncertain';
    } finally {
      if (this.disposed || (['restarting', 'self-updating'].includes(job.phase) && !job.failure)) return;
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
