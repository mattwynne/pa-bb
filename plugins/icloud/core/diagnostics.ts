import { z } from 'zod';
import { FAILURES, failureEvidence } from './ports.ts';
import type { Diagnose, Failure, FailureEvidence, SyncProgress, SyncStage } from './ports.ts';
export const HISTORY_LIMIT = 20;
export const HISTORY_DAYS = 7;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stages = z.enum(['checking', 'backing_up_cloud', 'backing_up_local', 'saving_recovery', 'transferring', 'verifying']);
const timestamp = z.iso.datetime();
const evidenceSchema = z.union([
  z.object({ kind: z.literal('command_exit'), exitCode: z.number().int().min(1).max(10).nullable() }).strict(),
  z.object({ kind: z.enum(['command_timeout', 'command_output_limit', 'command_signal', 'command_start', 'command_stopped']) }).strict(),
]);
const stageSchema = z.object({ stage: stages, durationMs: integer, bytes: integer, totalBytes: integer.positive().nullable(), files: integer, totalFiles: integer.positive().nullable(), reusedFiles: integer.nullable() }).strict();
const pendingSchema = z.object({ sequence: integer.positive(), kind: z.enum(['initial', 'sync']), startedAt: timestamp }).strict();
const runSchema = pendingSchema.extend({ finishedAt: timestamp, durationMs: integer.nullable(), outcome: z.enum(['succeeded', 'failed', 'interrupted']), failure: z.enum(FAILURES).nullable(), failureStage: stages.nullable(), evidence: evidenceSchema.nullable(), stages: z.array(stageSchema).max(6).refine(values => new Set(values.map(v => v.stage)).size === values.length) }).strict().refine(value => value.outcome === 'succeeded' ? value.failure === null && value.failureStage === null && value.evidence === null : value.failure !== null);
const journalSchema = z.object({ schema: z.literal(1), sequence: integer, active: pendingSchema.nullable(), runs: z.array(runSchema).max(HISTORY_LIMIT) }).strict().refine(value => {
  const sequences = value.runs.map(r => r.sequence);
  return new Set(sequences).size === sequences.length && sequences.every((s, i) => s <= value.sequence && (i === 0 || s > sequences[i - 1])) && (!value.active || value.active.sequence === value.sequence && sequences.every(s => s < value.active!.sequence));
});
export const diagnosticsSchema = z.object({ persistent: z.boolean(), maxRuns: z.literal(HISTORY_LIMIT), retentionDays: z.literal(HISTORY_DAYS), active: pendingSchema.nullable(), runs: z.array(runSchema).max(HISTORY_LIMIT) }).strict();
export type JournalState = z.infer<typeof journalSchema>;
export type RunSummary = z.infer<typeof runSchema>;
export interface RunHistoryRepository { load(): Promise<unknown>; save(value: JournalState): Promise<void> }
export class SyncDiagnostics {
  private state: JournalState = { schema: 1, sequence: 0, active: null, runs: [] };
  private persistent = false;
  private disabled = false;
  private started = 0;
  private stageStarted = 0;
  private currentStage: SyncStage | null = null;
  private measured = new Map<SyncStage, z.infer<typeof stageSchema>>();
  constructor(private repository: RunHistoryRepository | undefined, private clock: () => string, private elapsed: () => number, private diagnose: Diagnose) {}
  private prune() {
    const now = Date.parse(this.clock());
    this.state.runs = this.state.runs.filter(r => now - Date.parse(r.finishedAt) <= HISTORY_DAYS * 86400_000).slice(-HISTORY_LIMIT);
  }
  private async save() {
    if (!this.repository || this.disabled) return;
    try { await this.repository.save(structuredClone(this.state)); }
    catch { this.disabled = true; this.persistent = false; this.diagnose('history_write', 'unavailable'); }
  }
  async start() {
    if (this.repository) {
      try { const value = await this.repository.load(); if (value !== undefined && value !== null) this.state = journalSchema.parse(value); this.persistent = true; }
      catch { this.disabled = true; this.diagnose('history_read', 'unavailable'); return; }
    }
    const retained = this.state.runs.length; this.prune();
    if (this.state.active) {
      this.state.runs.push({ ...this.state.active, finishedAt: this.clock(), durationMs: null, outcome: 'interrupted', failure: 'interrupted', failureStage: null, evidence: null, stages: [] });
      this.state.active = null; this.prune(); await this.save();
    } else if (retained !== this.state.runs.length) await this.save();
  }
  snapshot() { this.prune(); return diagnosticsSchema.parse({ persistent: this.persistent, maxRuns: HISTORY_LIMIT, retentionDays: HISTORY_DAYS, active: this.state.active, runs: structuredClone(this.state.runs) }); }
  context(evidence: FailureEvidence | null) { return { ...(this.state.active ? { run: this.state.active.sequence } : {}), evidence: failureEvidence(evidence) }; }
  async begin(kind: 'initial' | 'sync') {
    // If persisted history could not be read, do not replace it or fabricate its sequence.
    if (this.disabled && this.state.sequence === 0) return;
    if (this.state.sequence === Number.MAX_SAFE_INTEGER) { this.disabled = true; this.persistent = false; this.diagnose('history_write', 'unavailable'); return; }
    this.prune(); this.state.sequence++;
    this.state.active = { sequence: this.state.sequence, kind, startedAt: this.clock() };
    this.started = this.elapsed(); this.stageStarted = this.started; this.currentStage = null; this.measured.clear();
    await this.save();
  }
  private milliseconds(start: number) { const n = Math.round(this.elapsed() - start); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
  private closeStage() {
    if (this.currentStage) {
      const entry = this.measured.get(this.currentStage)!;
      entry.durationMs = Math.min(Number.MAX_SAFE_INTEGER, entry.durationMs + this.milliseconds(this.stageStarted));
    }
  }
  update(progress: SyncProgress) {
    if (!this.state.active) return;
    if (progress.stage !== this.currentStage) { this.closeStage(); this.currentStage = progress.stage; this.stageStarted = this.elapsed(); }
    const prior = this.measured.get(progress.stage);
    const maximum = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
    this.measured.set(progress.stage, { stage: progress.stage, durationMs: prior?.durationMs ?? 0, bytes: Math.max(prior?.bytes ?? 0, progress.bytes), totalBytes: maximum(prior?.totalBytes ?? null, progress.totalBytes), files: Math.max(prior?.files ?? 0, progress.files), totalFiles: maximum(prior?.totalFiles ?? null, progress.totalFiles), reusedFiles: maximum(prior?.reusedFiles ?? null, progress.reusedFiles ?? null) });
  }
  async finish(outcome: 'succeeded' | 'failed', failure: Failure | null, evidence: FailureEvidence | null, failureStage: SyncStage | null) {
    if (!this.state.active) return;
    this.closeStage();
    this.state.runs.push({ ...this.state.active, finishedAt: this.clock(), durationMs: this.milliseconds(this.started), outcome, failure, failureStage, evidence: failureEvidence(evidence), stages: [...this.measured.values()] });
    this.state.active = null; this.currentStage = null; this.measured.clear(); this.prune(); await this.save();
  }
}
