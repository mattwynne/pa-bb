import { isDeepStrictEqual } from 'node:util';
import { attentionSnapshot, emptyAttention, loadAttention, verifiedDate, DAY } from './attention.ts';
import { CloudError, category, evidence, emptyState, activity } from './ports.ts';
import type { CloudProvider, StateRepository, State, CloudFolder, Mirror, SyncProgress, ProgressReporter, Diagnose, Failure, FailureEvidence, Blocker } from './ports.ts';
import { progressSnapshot } from './progress.ts';
import { SyncDiagnostics } from './diagnostics.ts';
import type { RunHistoryRepository, HistoryInput } from './diagnostics.ts';
import { maintenanceRecord } from './maintenance.ts';
import type { MaintenanceRecord } from './maintenance.ts';

class RunStartError extends CloudError {
  constructor() { super('unavailable'); }
}

export class ICloudSync {
  private state: State = emptyState();
  private connectionCheck: 'unknown' | 'verified' | 'unavailable' = 'unknown';
  private progress = new Map<string, SyncProgress>();
  private busy = false;
  private syncing = false;
  private controls: Promise<unknown> = Promise.resolve();
  private controlsPending = 0;
  private saving: Promise<void> = Promise.resolve();
  private attentionWrites: Promise<unknown> = Promise.resolve();
  private inlineWindows = new Map<string, number>();
  private stopped = false;
  private completingInitial: string | null = null;
  private stopping: Promise<void> | null = null;
  private current: Promise<unknown> | null = null;
  private discovered = new Map<string, CloudFolder>();
  private history: SyncDiagnostics;
  private maintenanceWriting = false;
  private maintenanceUncertain = false;
  private connectionRestorePending = false;
  // Called after each successful ordinary scan, so consumers can act on what it brought in.
  onSynced: (mirrorId: string) => void = () => {};
  constructor(private provider: CloudProvider, private repository: StateRepository,
    private clock: () => string, private id: () => string,
    private diagnose: Diagnose, history?: RunHistoryRepository, elapsed = () => performance.now()) {
    this.history = new SyncDiagnostics(history, clock, elapsed, diagnose);
  }
  async start() {
    this.state = await this.repository.load() ?? emptyState();
    if (this.state.maintenance !== undefined) {
      const parsed = maintenanceRecord.safeParse(this.state.maintenance);
      if (!parsed.success) throw new CloudError('unavailable');
      this.state.maintenance = parsed.data;
    }
    this.state.lastSignInCompletedAt = verifiedDate(this.state.lastSignInCompletedAt, Date.parse(this.clock()));
    this.state.attentionState = loadAttention(this.state.attentionState, Date.parse(this.clock()));
    await this.history.start();
    // Authentication continuations live only inside the provider instance.
    this.state.challenge = null;
    for (const mirror of this.state.mirrors) {
      // The field is deliberately additive: old records are accepted without a
      // migration framework, but their prior failure is never silently cleared.
      if ((mirror as Partial<Mirror>).blocker === undefined) mirror.blocker = this.blockerFor(mirror.failure, !mirror.initialized);
      if (mirror.phase === 'running') {
        mirror.phase = 'failed'; if (mirror.blocker !== 'rebuild' || mirror.failure === null) mirror.failure = 'interrupted';
        mirror.blocker = mirror.initialized ? mirror.blocker : 'initialization';
        if (!mirror.initialized) mirror.enabled = false;
        this.diagnose('restart', 'interrupted');
      }
    }
    await this.save();
    // Remote Apple listing must not hold startup or ordinary local note admission.
  }
  restoreConnection() {
    if (!this.state.connected) return;
    this.connectionRestorePending = true;
    setImmediate(() => {
      this.connectionRestorePending = false;
      if (this.stopped) return;
      void this.exclusive(async () => {
        try { await this.provider.verifyConnection(); this.connectionCheck = 'verified'; }
        catch (error) {
          const failure = category(error);
          this.connectionCheck = 'unavailable'; this.connectionFailure(failure); await this.save();
          this.diagnose('restore_connection', failure, { evidence: evidence(error) });
        }
      }).catch(error => this.diagnose('restore_connection', category(error), { evidence: evidence(error) }));
    });
  }
  status() { return { connected: this.state.connected, challenge: this.state.challenge, connectionCheck: this.connectionCheck, lastSignInCompletedAt: verifiedDate(this.state.lastSignInCompletedAt, Date.parse(this.clock())), attention: this.attention(), mirrors: this.state.mirrors.map(mirror => ({ ...structuredClone(mirror), completingInitial: this.completingInitial === mirror.id, retryPending: !this.maintenanceHeld && this.state.connected && mirror.enabled && mirror.initialized && mirror.phase === 'failed' && mirror.blocker === null, recovering: mirror.phase === 'running' && mirror.failure !== null, progress: mirror.phase === 'running' || this.completingInitial === mirror.id ? structuredClone(this.progress.get(mirror.id) ?? activity('checking')) : null })) }; }
  activity() { return { busy: this.stopped || this.busy || this.controlsPending > 0 || this.maintenanceWriting || this.connectionRestorePending, admissionPaused: this.maintenanceHeld || this.state.mirrors.every(m => !m.enabled || m.phase === 'retained') }; }
  get maintenanceHeld() { return this.maintenanceWriting || this.maintenanceUncertain || !!this.state.maintenance?.hold; }
  maintenanceStatus() {
    const hold = this.state.maintenance?.hold;
    return {
      runId: hold?.runId ?? null,
      previouslyEnabled: hold?.enabledIds.length ?? 0,
      lastRestore: this.state.maintenance?.lastRestore ?? null,
      persistence: this.maintenanceUncertain ? 'unconfirmed' as const : this.maintenanceWriting ? 'writing' as const : 'confirmed' as const,
    };
  }
  pauseMaintenance(runId: string) {
    const previous = this.state.maintenance;
    if (this.maintenanceUncertain) throw new CloudError('unavailable');
    if (previous?.hold?.runId === runId) return;
    if (this.maintenanceHeld || previous?.lastRestore?.runId === runId) throw new CloudError('busy');
    const enabledIds = this.state.mirrors.filter(mirror => mirror.enabled && mirror.phase !== 'retained').map(mirror => mirror.id);
    return this.saveMaintenance({ hold: { runId, enabledIds }, lastRestore: previous?.lastRestore ?? null });
  }
  restoreMaintenance(runId: string, canRestore: (mirror: Mirror) => boolean) {
    const previous = this.state.maintenance;
    if (this.maintenanceUncertain) throw new CloudError('unavailable');
    if (!previous?.hold && previous?.lastRestore?.runId === runId) return;
    if (previous?.hold?.runId !== runId || this.activity().busy) throw new CloudError('busy');
    const ownedIds = new Set(previous.hold.enabledIds);
    const restored = this.state.mirrors.filter(mirror => ownedIds.has(mirror.id) && mirror.enabled &&
      mirror.phase !== 'retained' && mirror.phase !== 'failed' && mirror.failure === null && mirror.blocker === null &&
      this.state.connected && canRestore(mirror));
    const restoredIds = new Set(restored.map(mirror => mirror.id));
    // The hold overrides scheduling without erasing the user's enablement or
    // hiding an in-flight failure. Close ineligible folders before lifting it.
    const close = (state: State) => {
      for (const mirror of state.mirrors) {
        if (mirror.phase === 'retained' || restoredIds.has(mirror.id) || !mirror.enabled) continue;
        this.pauseMirror(mirror);
      }
    };
    return this.saveMaintenance({ hold: null, lastRestore: { runId, restored: restored.length, leftPaused: ownedIds.size - restored.length } }, close);
  }
  private async saveMaintenance(record: MaintenanceRecord, apply: (state: State) => void = () => {}) {
    if (!maintenanceRecord.safeParse(record).success) throw new CloudError('unavailable');
    this.maintenanceWriting = true;
    const task = this.saving.catch(() => {}).then(async () => {
      const previous = this.state.maintenance;
      const next = structuredClone(this.state);
      next.maintenance = record;
      apply(next);
      try { await this.repository.save(next); }
      catch {
        // The write may have committed before the error. Read back within the
        // same save queue before allowing any other state snapshot to persist.
        this.diagnose('maintenance_write', 'unavailable');
        const persisted = await this.repository.load().then(state => state ? state.maintenance : null, () => null);
        if (!isDeepStrictEqual(persisted, record)) {
          this.maintenanceUncertain = persisted === null || !isDeepStrictEqual(persisted, previous);
          throw new CloudError('unavailable');
        }
      }
      this.state.maintenance = record;
      apply(this.state);
    });
    this.saving = task;
    try { await task; } finally { this.maintenanceWriting = false; }
  }
  diagnostics(query: HistoryInput = {}) { return this.history.snapshot(query); }
  private save() {
    const task = this.saving.catch(() => {}).then(() => {
      if (this.maintenanceUncertain) throw new CloudError('unavailable');
      return this.repository.save(structuredClone(this.state));
    });
    this.saving = task; return task;
  }
  private saveRunStart(mirror: Mirror) {
    // Publish running only after its durable checkpoint. Other queued state
    // writes take their snapshots after this step, so a failed preflight cannot
    // leak a phantom running phase into a Pause or attention save.
    const task = this.saving.catch(() => {}).then(async () => {
      if (this.maintenanceUncertain) throw new CloudError('unavailable');
      const snapshot = structuredClone(this.state);
      snapshot.mirrors.find(item => item.id === mirror.id)!.phase = 'running';
      await this.repository.save(snapshot);
      if (mirror.blocker !== 'reconnect') mirror.phase = 'running';
    });
    this.saving = task; return task;
  }
  private attention() {
    const now = Date.parse(this.clock());
    const item = attentionSnapshot(this.state.attentionState ?? emptyAttention(), this.state.lastSignInCompletedAt, now);
    return item ? { ...item, inlineVisible: [...this.inlineWindows.values()].some(until => until > now) } : null;
  }
  attentionPresence(windowId: string, visible: boolean) {
    if (this.stopped) return;
    const now = Date.parse(this.clock());
    for (const [id, until] of this.inlineWindows) if (until <= now) this.inlineWindows.delete(id);
    if (!visible) this.inlineWindows.delete(windowId);
    else if (this.inlineWindows.size < 32 || this.inlineWindows.has(windowId)) this.inlineWindows.set(windowId, now + 45_000);
  }
  // Attention writes deliberately do not acquire the native-operation mutex.
  attentionAction(generation: string, action: 'claim' | 'snooze'): Promise<boolean> {
    if (this.stopped) return Promise.reject(new CloudError('busy'));
    const task = this.attentionWrites.catch(() => {}).then(async () => {
      const current = this.attention();
      if (!current || current.generation !== generation || current.snoozedUntil) return false;
      const state = this.state.attentionState!;
      const now = Date.parse(this.clock());
      const deliveredAt = verifiedDate(state.deliveredAt, now);
      // Same-stage delivery is at most daily, even across reminder-generation
      // rollover. Unknown legacy delivery times cannot suppress indefinitely.
      const deliveredRecently = state.deliveredGeneration?.startsWith(`${current.stage}:`) && deliveredAt && now - Date.parse(deliveredAt) < DAY;
      if (action === 'claim' && (deliveredRecently || [...this.inlineWindows.values()].some(until => until > now))) return false;
      const before = structuredClone(state);
      if (action === 'snooze') { state.snoozedUntil = new Date(now + DAY).toISOString(); state.snoozedStage = current.stage; state.deliveredGeneration = null; }
      else { state.deliveredGeneration = generation; state.deliveredAt = new Date(now).toISOString(); }
      try { await this.save(); return true; }
      catch {
        // Connection rejection can advance this same object while persistence waits.
        if (this.state.attentionState === state && state.issue === before.issue && state.revision === before.revision) this.state.attentionState = before;
        this.diagnose('attention_write', 'unavailable'); throw new CloudError('unavailable');
      }
    });
    this.attentionWrites = task; return task;
  }
  private connectionFailure(failure: Failure) {
    if (failure !== 'authentication' && failure !== 'provider_rejected') return;
    const state = this.state.attentionState!;
    if (state.issue !== failure && state.issue !== 'authentication') { state.issue = failure; state.revision = (state.revision + 1) % Number.MAX_SAFE_INTEGER; }
    if (failure === 'authentication') this.state.connected = false;
    this.requireResume(failure);
  }
  private folder(id: string) {
    const folder = this.state.mirrors.find(item => item.id === id);
    if (!folder) throw new CloudError('invalid_selection');
    return folder;
  }
  private exclusive<T>(operation: () => Promise<T>, syncing = false): Promise<T> {
    if (this.busy || this.controlsPending || this.stopped) return Promise.reject(new CloudError('busy'));
    this.busy = true; this.syncing = syncing;
    const task = operation().finally(() => { this.busy = false; this.syncing = false; this.current = null; });
    this.current = task; return task;
  }
  // Folder metadata and directory-only reads do not own a native sync turn.
  // Account/config changes remain exclusive; state snapshots still save in order.
  private control<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped || (this.busy && !this.syncing) || this.controlsPending >= 32) return Promise.reject(new CloudError('busy'));
    this.controlsPending++;
    const task = this.controls.catch(() => {}).then(() => {
      if (this.stopped) throw new CloudError('busy');
      return operation();
    }).finally(() => { this.controlsPending--; });
    this.controls = task; return task;
  }
  async checkAvailability() { return this.provider.checkAvailability(); }
  private requireResume(failure: Failure = 'authentication') {
    // Authorization belongs to the account, not just the first folder that
    // encountered expiry. Preserve Pause/Disconnect and stronger safety stops.
    for (const mirror of this.state.mirrors) {
      if (!mirror.enabled || !mirror.initialized || mirror.phase === 'retained' || mirror.blocker !== null) continue;
      mirror.phase = 'failed'; mirror.failure = failure; mirror.blocker = 'reconnect';
    }
  }
  connect(credentials: { account: string; password: string }) {
    return this.exclusive(async () => {
      this.requireResume();
      this.connectionCheck = 'unknown'; this.state.connected = false; this.state.challenge = null; this.discovered.clear();
      await this.save();
      try { return await this.applyConnection(await this.provider.connect(credentials)); }
      catch (error) { this.connectionFailure(category(error)); await this.save(); this.diagnose('connect', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
    });
  }
  answerChallenge(answer: string) {
    return this.exclusive(async () => {
      if (!this.state.challenge) throw new CloudError('authentication');
      try { return await this.applyConnection(await this.provider.answerChallenge(answer)); }
      catch (error) { this.connectionFailure(category(error)); await this.save(); this.diagnose('challenge', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
    });
  }
  private async applyConnection(result: Awaited<ReturnType<CloudProvider['connect']>>) {
    this.state.connected = result.connected; this.state.challenge = result.connected ? null : result.challenge;
    this.connectionCheck = result.connected ? 'verified' : 'unknown';
    if (result.connected) {
      // Provider returns connected only after the protected flow's verification read.
      this.state.lastSignInCompletedAt = verifiedDate(this.clock(), Date.parse(this.clock()));
      this.state.attentionState = emptyAttention();
    }
    await this.save(); return this.status();
  }
  browse(parent: string | null) {
    return this.control(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      if (parent !== null && !this.discovered.has(parent)) throw new CloudError('invalid_selection');
      try {
        const folders = await this.provider.listFolders(parent); this.connectionCheck = 'verified';
        for (const folder of folders) this.discovered.set(folder.id, folder);
        return folders;
      } catch (error) { this.connectionCheck = 'unavailable'; this.connectionFailure(category(error)); await this.save(); this.diagnose('browse', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
    });
  }
  select(folderId: string) {
    return this.control(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const folder = this.discovered.get(folderId);
      if (!folder || this.state.mirrors.length >= 20 || this.state.mirrors.some(m => m.phase !== 'retained' && (m.folder.id === folder.id || m.folder.ancestors.includes(folder.id) || folder.ancestors.includes(m.folder.id)))) throw new CloudError('invalid_selection');
      const mirror: Mirror = { id: this.id(), folder, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null, blocker: null };
      this.state.mirrors.push(mirror); await this.save(); return this.status();
    });
  }
  enable(id: string) {
    // Admit the user's intent now; the existing worker performs preparation or
    // retry on its next turn, never a second concurrent native command.
    if (this.busy && this.syncing) return this.control(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const mirror = this.folder(id);
      if (mirror.phase === 'retained' || this.progress.has(id) || (mirror.blocker !== null && mirror.blocker !== 'reconnect')) throw new CloudError('recovery_required');
      mirror.enabled = true; mirror.blocker = null;
      if (mirror.failure === null) mirror.phase = 'ready';
      await this.save(); return this.status();
    });
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const mirror = this.folder(id);
      if (mirror.phase === 'retained' || (mirror.blocker !== null && mirror.blocker !== 'reconnect')) throw new CloudError('recovery_required');
      if (!mirror.initialized) {
        mirror.enabled = true;
        mirror.phase = 'ready';
        await this.run(mirror, true);
      }
      else {
        mirror.enabled = true; mirror.blocker = null; await this.save();
        if (mirror.failure !== null) await this.run(mirror, false);
        else { mirror.phase = 'ready'; await this.save(); }
      }
      return this.status();
    }, true);
  }
  retry(id: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const mirror = this.folder(id);
      if (!mirror.initialized || mirror.phase !== 'failed' || ![null, 'capacity', 'configuration'].includes(mirror.blocker)) throw new CloudError('recovery_required');
      // Explicit retry is also the conservative upgrade path for a legacy
      // failed initialized mirror. It always takes the ordinary native
      // bisync path; it never resyncs or clears the old outcome in advance.
      mirror.enabled = true; mirror.blocker = null; await this.save();
      await this.run(mirror, false);
      return this.status();
    }, true);
  }
  continueInterrupted(id: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const mirror = this.folder(id);
      if (!mirror.initialized || mirror.phase !== 'failed' || mirror.blocker !== 'rebuild' || !this.provider.continueInterrupted) throw new CloudError('recovery_required');
      // Keep enabled exactly as the user left it. This is not Resume, Retry,
      // conflict resolution or permission to clear the durable recovery fence.
      await this.run(mirror, false, true);
      return this.status();
    }, true);
  }
  completeInitialRegistration(id: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const mirror = this.folder(id);
      if (mirror.initialized || mirror.enabled || mirror.phase !== 'failed' || mirror.failure !== 'source_changed' || mirror.blocker !== 'initialization' || mirror.initialCompletionAttempted || !this.provider.completeInitialRegistration) throw new CloudError('recovery_required');
      // Consume this explicit request durably BEFORE any possibly-applied native
      // work. A lost response/restart cannot blindly repeat it. Preserve the
      // original failure and disabled state until every check and save succeeds.
      mirror.initialCompletionAttempted = true;
      try { await this.save(); }
      catch (error) { this.diagnose('initial_completion/checking', category(error)); throw new CloudError('unavailable'); }
      this.completingInitial = id; this.progress.set(id, activity('checking'));
      let failure: Failure | null = null, proof: FailureEvidence | null = null;
      try {
        await this.history.begin('sync');
        await this.provider.completeInitialRegistration(structuredClone(mirror), value => {
          const safe = progressSnapshot(value);
          if (safe) { this.progress.set(id, safe); this.history.update(safe); }
        });
        if (this.stopped || !this.state.connected) throw new CloudError('interrupted');
        const previous = structuredClone(mirror);
        Object.assign(mirror, { initialized: true, enabled: false, phase: 'paused', failure: null, blocker: null, lastSuccess: this.clock() });
        try { await this.save(); }
        catch (error) { Object.assign(mirror, previous); throw error; }
      } catch (error) {
        failure = category(error); proof = evidence(error);
        this.diagnose(`initial_completion/${this.progress.get(id)?.stage ?? 'checking'}`, failure, this.history.context(proof));
        // Do not turn a possibly-applied command into an automatic retry or
        // replace the incident's original failure. History records this attempt.
      } finally {
        await this.history.finish(failure ? 'failed' : 'succeeded', failure, proof, failure ? this.progress.get(id)?.stage ?? 'checking' : null);
        this.progress.delete(id); this.completingInitial = null;
      }
      return this.status();
    });
  }
  pause(id: string) {
    return this.control(async () => {
      if (this.maintenanceUncertain) throw new CloudError('unavailable');
      this.pauseMirror(this.folder(id));
      await this.save(); return this.status();
    });
  }
  private pauseMirror(mirror: Mirror) {
    mirror.enabled = false;
    if (!['running', 'failed', 'retained'].includes(mirror.phase)) mirror.phase = 'paused';
  }
  rebuild(id: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const previous = this.folder(id);
      if (previous.phase !== 'failed' || this.state.mirrors.length >= 20) throw new CloudError('recovery_required');
      const next: Mirror = { ...structuredClone(previous), id: this.id(), initialized: false, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null };
      previous.phase = 'retained'; previous.enabled = false;
      this.state.mirrors.push(next); await this.save();
      await this.run(next, true);
      return this.status();
    }, true);
  }
  async tick(targets?: ReadonlySet<string>, allowed = () => true) {
    const admitted = () => !this.maintenanceHeld && allowed();
    if (this.stopped || !this.state.connected || !admitted()) return true;
    // A change hint can wait for a turn already in flight. The minute poll
    // always returns immediately when another operation owns the service.
    if (targets && (this.busy || this.controlsPending)) await Promise.allSettled([this.current, this.controls]);
    if (this.stopped || !this.state.connected || !admitted()) return true;
    if (this.busy || this.controlsPending) return false;
    return this.exclusive(async () => {
      for (const mirror of this.state.mirrors) {
        if (!this.state.connected || this.stopped || !admitted()) break;
        if (targets && !targets.has(mirror.id)) continue;
        if (targets && (!mirror.initialized || mirror.phase !== 'ready')) continue;
        if (mirror.enabled && mirror.blocker === null && (mirror.phase === 'ready' || mirror.phase === 'failed')) {
          try { await this.run(mirror, !mirror.initialized); }
          catch (error) { if (!(error instanceof RunStartError)) throw error; }
        }
      }
      return true;
    }, true);
  }
  private blockerFor(failure: Failure | null, initial: boolean): Blocker | null {
    if (initial) return failure === null ? null : 'initialization';
    if (failure === 'authentication' || failure === 'provider_rejected') return 'reconnect';
    if (failure === 'configuration') return 'configuration';
    if (failure === 'capacity') return 'capacity';
    if (failure === 'invalid_selection') return 'configuration';
    if (failure === 'recovery_required' || failure === 'unknown') return 'rebuild';
    return null;
  }
  private assertRunConnection(mirror: Mirror) {
    if (mirror.blocker === 'reconnect') throw new CloudError(mirror.failure ?? 'authentication');
  }
  private async run(mirror: Mirror, initial: boolean, interrupted = false) {
    try { await this.saveRunStart(mirror); }
    catch (error) {
      this.diagnose(`${initial ? 'prepare' : 'sync'}/persist_start`, category(error));
      throw new RunStartError();
    }
    await this.history.begin(initial ? 'initial' : 'sync'); this.history.update(activity('checking'));
    this.progress.set(mirror.id, activity('checking'));
    let reporting = true; let completed = false; let failure: Failure | null = null; let proof: FailureEvidence | null = null;
    const report: ProgressReporter = value => {
      if (!reporting || mirror.phase !== 'running') return;
      const safe = progressSnapshot(value); if (safe) { this.progress.set(mirror.id, safe); this.history.update(safe); }
    };
    try {
      try {
        if (this.stopped) throw new CloudError('interrupted');
        this.assertRunConnection(mirror);
        if (interrupted) await this.provider.continueInterrupted!(structuredClone(mirror), report);
        else if (initial) await this.provider.prepareMirror(structuredClone(mirror), report);
        else await this.provider.synchronize(structuredClone(mirror), report);
        if (this.stopped) throw new CloudError('interrupted');
        // A concurrent directory read may have proved account authorization
        // invalid. A finishing child cannot silently clear that stronger stop.
        this.assertRunConnection(mirror);
        // Recorded after the provider operation returns, not proof of delivery to another device.
        mirror.initialized = true; mirror.lastSuccess = this.clock(); mirror.failure = null; mirror.blocker = null; mirror.phase = mirror.enabled ? 'ready' : 'paused';
        if (!initial && !interrupted) { try { this.onSynced(mirror.id); } catch { /* A consumer cannot fail the scan. */ } }
      } catch (error) {
        mirror.phase = 'failed'; mirror.failure = category(error); mirror.blocker = interrupted ? 'rebuild' : this.blockerFor(mirror.failure, initial); failure = mirror.failure; proof = evidence(error);
        if (initial) mirror.enabled = false;
        this.connectionFailure(mirror.failure);
        this.diagnose(`${initial ? 'prepare' : 'sync'}/${this.progress.get(mirror.id)?.stage ?? 'checking'}`, mirror.failure, this.history.context(proof));
      }
      await this.save(); completed = true;
    } catch (error) { failure = category(error); proof = evidence(error); throw error; }
    finally {
      reporting = false;
      const failed = !completed || failure !== null;
      await this.history.finish(failed ? 'failed' : 'succeeded', failed ? failure ?? 'unknown' : null, proof, failed ? this.progress.get(mirror.id)?.stage ?? 'checking' : null);
      this.progress.delete(mirror.id);
    }
  }
  disconnect() {
    return this.exclusive(async () => {
      this.connectionCheck = 'unknown'; this.state.connected = false; this.state.challenge = null; this.discovered.clear();
      for (const mirror of this.state.mirrors) { mirror.enabled = false; if (mirror.blocker === null && mirror.phase !== 'retained') mirror.phase = 'paused'; }
      await this.save();
      try { await this.provider.disconnect(); } catch (error) { this.diagnose('disconnect', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
      return this.status();
    });
  }
  inventory() { return this.state.mirrors.filter(m => m.initialized || m.phase === 'retained').map(m => ({ id: m.id, name: m.folder.name, phase: m.phase, lastSuccess: m.lastSuccess })); }
  stop(): Promise<void> {
    this.stopped = true;
    return this.stopping ??= (async () => {
      this.provider.requestStop?.();
      await this.current?.catch(() => {});
      await this.controls.catch(() => {});
      await this.attentionWrites.catch(() => {});
      await this.saving.catch(() => {});
      await this.provider.stop();
    })();
  }
}
