import { CloudError, category, evidence, emptyState, activity } from './ports.ts';
import type { CloudProvider, StateRepository, State, CloudFolder, Mirror, SyncProgress, ProgressReporter, Diagnose, Failure, FailureEvidence, Blocker } from './ports.ts';
import { progressSnapshot } from './progress.ts';
import { SyncDiagnostics } from './diagnostics.ts';
import type { RunHistoryRepository, HistoryInput } from './diagnostics.ts';

export class ICloudSync {
  private state: State = emptyState();
  private progress = new Map<string, SyncProgress>();
  private busy = false;
  private stopped = false;
  private current: Promise<unknown> | null = null;
  private discovered = new Map<string, CloudFolder>();
  private history: SyncDiagnostics;
  constructor(private provider: CloudProvider, private repository: StateRepository,
    private clock: () => string, private id: () => string,
    private diagnose: Diagnose, history?: RunHistoryRepository, elapsed = () => performance.now()) {
    this.history = new SyncDiagnostics(history, clock, elapsed, diagnose);
  }
  async start() {
    this.state = await this.repository.load() ?? emptyState();
    await this.history.start();
    // Authentication continuations live only inside the provider instance.
    this.state.challenge = null;
    for (const mirror of this.state.mirrors) {
      // The field is deliberately additive: old records are accepted without a
      // migration framework, but their prior failure is never silently cleared.
      if ((mirror as Partial<Mirror>).blocker === undefined) mirror.blocker = this.blockerFor(mirror.failure, !mirror.initialized);
      if (mirror.phase === 'running') {
        mirror.phase = 'failed'; mirror.failure = 'interrupted';
        mirror.blocker = mirror.initialized ? null : 'initialization';
        if (!mirror.initialized) mirror.enabled = false;
        this.diagnose('restart', 'interrupted');
      }
    }
    await this.save();
    // Remote Apple listing must not hold startup or ordinary local note admission.
  }
  restoreConnection() {
    if (this.state.connected) setImmediate(() => {
      if (this.stopped) return;
      void this.exclusive(async () => {
        try { await this.provider.verifyConnection(); }
        catch (error) {
          const failure = category(error);
          if (failure === 'authentication') {
            this.state.connected = false; this.requireResume(); await this.save();
          }
          this.diagnose('restore_connection', failure, { evidence: evidence(error) });
        }
      }).catch(error => this.diagnose('restore_connection', category(error), { evidence: evidence(error) }));
    });
  }
  status() { return { ...structuredClone(this.state), mirrors: this.state.mirrors.map(mirror => ({ ...structuredClone(mirror), retryPending: this.state.connected && mirror.enabled && mirror.initialized && mirror.phase === 'failed' && mirror.blocker === null, recovering: mirror.phase === 'running' && mirror.failure !== null, progress: mirror.phase === 'running' ? structuredClone(this.progress.get(mirror.id) ?? activity('checking')) : null })) }; }
  diagnostics(query: HistoryInput = {}) { return this.history.snapshot(query); }
  private save() { return this.repository.save(structuredClone(this.state)); }
  private folder(id: string) {
    const folder = this.state.mirrors.find(item => item.id === id);
    if (!folder) throw new CloudError('invalid_selection');
    return folder;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy || this.stopped) return Promise.reject(new CloudError('busy'));
    this.busy = true;
    const task = operation().finally(() => { this.busy = false; this.current = null; });
    this.current = task; return task;
  }
  async checkAvailability() { return this.provider.checkAvailability(); }
  private requireResume() {
    // Authorization belongs to the account, not just the first folder that
    // encountered expiry. Preserve Pause/Disconnect and stronger safety stops.
    for (const mirror of this.state.mirrors) {
      if (!mirror.enabled || !mirror.initialized || mirror.phase === 'retained' || mirror.blocker !== null) continue;
      mirror.phase = 'failed'; mirror.failure = 'authentication'; mirror.blocker = 'reconnect';
    }
  }
  connect(credentials: { account: string; password: string }) {
    return this.exclusive(async () => {
      this.requireResume();
      this.state.connected = false; this.state.challenge = null; this.discovered.clear();
      await this.save();
      try { return await this.applyConnection(await this.provider.connect(credentials)); }
      catch (error) { this.diagnose('connect', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
    });
  }
  answerChallenge(answer: string) {
    return this.exclusive(async () => {
      if (!this.state.challenge) throw new CloudError('authentication');
      try { return await this.applyConnection(await this.provider.answerChallenge(answer)); }
      catch (error) { this.diagnose('challenge', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
    });
  }
  private async applyConnection(result: Awaited<ReturnType<CloudProvider['connect']>>) {
    this.state.connected = result.connected; this.state.challenge = result.connected ? null : result.challenge;
    await this.save(); return this.status();
  }
  browse(parent: string | null) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      if (parent !== null && !this.discovered.has(parent)) throw new CloudError('invalid_selection');
      try {
        const folders = await this.provider.listFolders(parent);
        for (const folder of folders) this.discovered.set(folder.id, folder);
        return folders;
      } catch (error) { this.diagnose('browse', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
    });
  }
  select(folderId: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const folder = this.discovered.get(folderId);
      if (!folder || this.state.mirrors.length >= 20 || this.state.mirrors.some(m => m.phase !== 'retained' && (m.folder.id === folder.id || m.folder.ancestors.includes(folder.id) || folder.ancestors.includes(m.folder.id)))) throw new CloudError('invalid_selection');
      const mirror: Mirror = { id: this.id(), folder, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null, blocker: null };
      this.state.mirrors.push(mirror); await this.save(); return this.status();
    });
  }
  enable(id: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const mirror = this.folder(id);
      if (mirror.phase === 'retained' || (mirror.blocker !== null && mirror.blocker !== 'reconnect')) throw new CloudError('recovery_required');
      if (!mirror.initialized) await this.run(mirror, true);
      else {
        mirror.enabled = true; mirror.blocker = null; await this.save();
        if (mirror.failure !== null) await this.run(mirror, false);
        else { mirror.phase = 'ready'; await this.save(); }
      }
      if (mirror.initialized && mirror.failure === null && !mirror.enabled) { mirror.enabled = true; mirror.phase = 'ready'; mirror.blocker = null; await this.save(); }
      return this.status();
    });
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
    });
  }
  pause(id: string) {
    return this.exclusive(async () => {
      const mirror = this.folder(id); mirror.enabled = false;
      if (mirror.phase !== 'failed' && mirror.phase !== 'retained') mirror.phase = 'paused';
      await this.save(); return this.status();
    });
  }
  rebuild(id: string) {
    return this.exclusive(async () => {
      if (!this.state.connected) throw new CloudError('authentication');
      const previous = this.folder(id);
      if (previous.phase !== 'failed' || this.state.mirrors.length >= 20) throw new CloudError('recovery_required');
      const next: Mirror = { ...structuredClone(previous), id: this.id(), initialized: false, enabled: false, phase: 'paused', failure: null, blocker: null, lastSuccess: null };
      previous.phase = 'retained'; previous.enabled = false;
      this.state.mirrors.push(next); await this.save();
      await this.run(next, true);
      if (next.initialized && next.failure === null) { next.enabled = true; next.phase = 'ready'; await this.save(); }
      return this.status();
    });
  }
  async tick() {
    if (this.busy || this.stopped || !this.state.connected) return;
    return this.exclusive(async () => {
      for (const mirror of this.state.mirrors) {
        if (!this.state.connected || this.stopped) break;
        if (mirror.enabled && mirror.initialized && mirror.blocker === null && (mirror.phase === 'ready' || mirror.phase === 'failed')) await this.run(mirror, false);
      }
    });
  }
  private blockerFor(failure: Failure | null, initial: boolean): Blocker | null {
    if (initial) return failure === null ? null : 'initialization';
    if (failure === 'authentication') return 'reconnect';
    if (failure === 'configuration') return 'configuration';
    if (failure === 'capacity') return 'capacity';
    if (failure === 'invalid_selection') return 'configuration';
    if (failure === 'recovery_required' || failure === 'unknown') return 'rebuild';
    return null;
  }
  private async run(mirror: Mirror, initial: boolean) {
    mirror.phase = 'running'; this.progress.set(mirror.id, activity('checking'));
    await this.history.begin(initial ? 'initial' : 'sync'); this.history.update(activity('checking'));
    let reporting = true; let completed = false; let failure: Failure | null = null; let proof: FailureEvidence | null = null;
    const report: ProgressReporter = value => {
      if (!reporting || mirror.phase !== 'running') return;
      const safe = progressSnapshot(value); if (safe) { this.progress.set(mirror.id, safe); this.history.update(safe); }
    };
    try {
      await this.save();
      try {
        if (initial) await this.provider.prepareMirror(structuredClone(mirror), report);
        else await this.provider.synchronize(structuredClone(mirror), report);
        if (this.stopped) throw new CloudError('interrupted');
        // Recorded after the provider operation returns, not proof of delivery to another device.
        mirror.initialized = true; mirror.lastSuccess = this.clock(); mirror.failure = null; mirror.blocker = null; mirror.phase = 'ready';
      } catch (error) {
        mirror.phase = 'failed'; mirror.failure = category(error); mirror.blocker = this.blockerFor(mirror.failure, initial); failure = mirror.failure; proof = evidence(error);
        if (initial) mirror.enabled = false;
        if (mirror.failure === 'authentication') { this.state.connected = false; this.requireResume(); }
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
      this.state.connected = false; this.state.challenge = null; this.discovered.clear();
      for (const mirror of this.state.mirrors) { mirror.enabled = false; mirror.blocker = null; if (mirror.phase !== 'retained') mirror.phase = 'paused'; }
      await this.save();
      try { await this.provider.disconnect(); } catch (error) { this.diagnose('disconnect', category(error), { evidence: evidence(error) }); throw new CloudError(category(error)); }
      return this.status();
    });
  }
  inventory() { return this.state.mirrors.filter(m => m.initialized || m.phase === 'retained').map(m => ({ id: m.id, name: m.folder.name, phase: m.phase, lastSuccess: m.lastSuccess })); }
  async stop() { this.stopped = true; await this.current?.catch(() => {}); await this.provider.stop(); }
}
