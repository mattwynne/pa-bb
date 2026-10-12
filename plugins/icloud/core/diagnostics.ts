import { z } from 'zod';
import { FAILURES, failureEvidence } from './ports.ts';
import type { Diagnose, Failure, FailureEvidence, SyncProgress, SyncStage } from './ports.ts';
export const HISTORY_LIMIT = 20; // Default page size, not a retention limit.
export const HISTORY_DAYS = 7;
export const ERROR_HISTORY_DAYS = 30;
export const HISTORY_CAPACITY = { successRows: 20_000, errorRows: 5_000, successBytes: 16 * 1024 * 1024, errorBytes: 8 * 1024 * 1024 } as const;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stages = z.enum(['checking', 'backing_up_cloud', 'backing_up_local', 'saving_recovery', 'transferring', 'verifying']);
const timestamp = z.iso.datetime().max(40).refine(value => Number.isFinite(Date.parse(value)));
const evidenceSchema = z.union([
  z.object({ kind: z.literal('command_exit'), exitCode: z.number().int().min(1).max(10).nullable() }).strict(),
  z.object({ kind: z.enum(['command_timeout', 'command_output_limit', 'command_signal', 'command_start', 'command_stopped']) }).strict(),
]);
const stageSchema = z.object({ stage: stages, durationMs: integer, bytes: integer, totalBytes: integer.positive().nullable(), files: integer, totalFiles: integer.positive().nullable(), reusedFiles: integer.nullable() }).strict();
export const pendingRunSchema = z.object({ sequence: integer.positive(), kind: z.enum(['initial', 'sync']), startedAt: timestamp }).strict();
export const runSchema = pendingRunSchema.extend({ finishedAt: timestamp, durationMs: integer.nullable(), outcome: z.enum(['succeeded', 'failed', 'interrupted']), failure: z.enum(FAILURES).nullable(), failureStage: stages.nullable(), evidence: evidenceSchema.nullable(), stages: z.array(stageSchema).max(6).refine(values => new Set(values.map(v => v.stage)).size === values.length) }).strict().refine(value => value.outcome === 'succeeded' ? value.failure === null && value.failureStage === null && value.evidence === null : value.failure !== null);
export const historyStateSchema = z.object({ schema: z.literal(2), sequence: integer, active: pendingRunSchema.nullable() }).strict().refine(v => !v.active || v.active.sequence === v.sequence);
export const legacyJournalSchema = z.object({ schema: z.literal(1), sequence: integer, active: pendingRunSchema.nullable(), runs: z.array(runSchema).max(20) }).strict().refine(value => {
  const sequences = value.runs.map(r => r.sequence);
  return new Set(sequences).size === sequences.length && sequences.every((s, i) => s <= value.sequence && (i === 0 || s > sequences[i - 1])) && (!value.active || value.active.sequence === value.sequence && sequences.every(s => s < value.active!.sequence));
});
export const historyQuerySchema = z.object({ limit: z.number().int().min(1).max(100).default(HISTORY_LIMIT), before: integer.positive().optional(), outcome: z.enum(['all', 'errors', 'succeeded']).default('all') }).strict();
const countsSchema = z.object({ successes: integer, errors: integer }).strict();
const pageSchema = z.object({ runs: z.array(runSchema).max(100), nextBefore: integer.positive().nullable(), retained: countsSchema, trimmed: countsSchema }).strict();
export const diagnosticsSchema = pageSchema.extend({ persistent: z.boolean(), pageSize: z.number().int().min(1).max(100), retentionDays: z.literal(HISTORY_DAYS), errorRetentionDays: z.literal(ERROR_HISTORY_DAYS), active: pendingRunSchema.nullable(), capacity: z.object({ successRows: z.literal(HISTORY_CAPACITY.successRows), errorRows: z.literal(HISTORY_CAPACITY.errorRows), successBytes: z.literal(HISTORY_CAPACITY.successBytes), errorBytes: z.literal(HISTORY_CAPACITY.errorBytes) }).strict() }).strict();
export type RunSummary = z.infer<typeof runSchema>;
export type PendingRun = z.infer<typeof pendingRunSchema>;
export type HistoryState = z.infer<typeof historyStateSchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type HistoryInput = z.input<typeof historyQuerySchema>;
export type HistoryCounts = z.infer<typeof countsSchema>;
export type HistoryPage = z.infer<typeof pageSchema>;
export interface RunHistoryRepository {
  load(): Promise<unknown>;
  begin(run: PendingRun): Promise<void>;
  finish(run: RunSummary): Promise<void>;
  prune(now: string): Promise<HistoryCounts>;
  read(query: HistoryQuery, now: string): Promise<HistoryPage>;
}
export function visibleRun(run: RunSummary, now: string) { return Date.parse(now) - Date.parse(run.finishedAt) <= (run.outcome === 'succeeded' ? HISTORY_DAYS : ERROR_HISTORY_DAYS) * 86400_000; }
function page(runs: RunSummary[], query: HistoryQuery, now: string, trimmed: HistoryCounts): HistoryPage {
  const visible = runs.filter(r => visibleRun(r, now));
  const selected = visible.filter(r => (query.before === undefined || r.sequence < query.before) && (query.outcome === 'all' || (query.outcome === 'errors' ? r.outcome !== 'succeeded' : r.outcome === 'succeeded'))).sort((a, b) => b.sequence - a.sequence);
  const result = selected.slice(0, query.limit).reverse();
  return { runs: structuredClone(result), nextBefore: selected.length > query.limit ? result[0].sequence : null, retained: { successes: visible.filter(r => r.outcome === 'succeeded').length, errors: visible.filter(r => r.outcome !== 'succeeded').length }, trimmed: structuredClone(trimmed) };
}
// Pure in-memory port for tests; production uses indexed SQLite rows.
export class MemoryRunHistory implements RunHistoryRepository {
  private state: HistoryState = { schema: 2, sequence: 0, active: null };
  private runs = new Map<number, RunSummary>();
  private trimmed: HistoryCounts = { successes: 0, errors: 0 };
  inspect() { return { ...structuredClone(this.state), runs: structuredClone([...this.runs.values()]) }; }
  async load() { return structuredClone(this.state); }
  async begin(value: PendingRun) { const run = pendingRunSchema.parse(value); if (this.state.active || run.sequence !== this.state.sequence + 1) throw new Error('history state unavailable'); this.state.sequence = run.sequence; this.state.active = run; }
  async finish(value: RunSummary) { const run = runSchema.parse(value); if (this.runs.has(run.sequence)) return; if (this.state.active?.sequence !== run.sequence) throw new Error('history state unavailable'); this.runs.set(run.sequence, run); this.state.active = null; }
  async prune(now: string) {
    for (const [id, run] of this.runs) if (!visibleRun(run, now)) this.runs.delete(id);
    const delta = { successes: 0, errors: 0 };
    for (const error of [false, true]) {
      const values = [...this.runs.values()].filter(r => (r.outcome !== 'succeeded') === error).sort((a, b) => b.sequence - a.sequence); let bytes = 0;
      for (let i = 0; i < values.length; i++) {
        bytes += new TextEncoder().encode(JSON.stringify(values[i])).length;
        if (i >= (error ? HISTORY_CAPACITY.errorRows : HISTORY_CAPACITY.successRows) || bytes > (error ? HISTORY_CAPACITY.errorBytes : HISTORY_CAPACITY.successBytes)) { this.runs.delete(values[i].sequence); delta[error ? 'errors' : 'successes']++; }
      }
    }
    this.trimmed.successes += delta.successes; this.trimmed.errors += delta.errors; return delta;
  }
  async read(query: HistoryQuery, now: string) { return page([...this.runs.values()], historyQuerySchema.parse(query), now, this.trimmed); }
}
export class SyncDiagnostics {
  private state: HistoryState = { schema: 2, sequence: 0, active: null };
  private repository: RunHistoryRepository;
  private persistent = false;
  private disabled = false;
  private unknownSequence = false;
  private capacityWarning = false;
  private cached: RunSummary[] = [];
  private started = 0;
  private stageStarted = 0;
  private currentStage: SyncStage | null = null;
  private measured = new Map<SyncStage, z.infer<typeof stageSchema>>();
  constructor(repository: RunHistoryRepository | undefined, private clock: () => string, private elapsed: () => number, private diagnose: Diagnose) { this.repository = repository ?? new MemoryRunHistory(); this.persistent = repository !== undefined; }
  private fail(stage: 'history_read' | 'history_write') { if (!this.disabled) this.diagnose(stage, 'unavailable'); this.disabled = true; this.persistent = false; }
  private async write(task: () => Promise<unknown>) { if (this.disabled) return; try { await task(); } catch { this.fail('history_write'); } }
  private async prune() {
    await this.write(async () => { const removed = countsSchema.parse(await this.repository.prune(this.clock())); if ((removed.successes || removed.errors) && !this.capacityWarning) { this.capacityWarning = true; this.diagnose('history_retention', 'capacity'); } });
  }
  private remember(run: RunSummary) {
    if (!this.cached.some(r => r.sequence === run.sequence)) this.cached.push(structuredClone(run));
    this.cached.sort((a, b) => a.sequence - b.sequence);
    this.cached = [...this.cached.filter(r => r.outcome === 'succeeded').slice(-HISTORY_LIMIT), ...this.cached.filter(r => r.outcome !== 'succeeded').slice(-HISTORY_LIMIT)].sort((a, b) => a.sequence - b.sequence);
  }
  async start() {
    try { this.state = historyStateSchema.parse(await this.repository.load()); }
    catch { this.unknownSequence = true; this.fail('history_read'); return; }
    await this.prune();
    if (this.state.active) {
      const run: RunSummary = { ...this.state.active, finishedAt: this.clock(), durationMs: null, outcome: 'interrupted', failure: 'interrupted', failureStage: null, evidence: null, stages: [] };
      this.remember(run); this.state.active = null; await this.write(() => this.repository.finish(run)); await this.prune();
    }
  }
  async snapshot(input: HistoryInput = {}) {
    const query = historyQuerySchema.parse(input); let result: HistoryPage;
    if (!this.disabled) {
      try {
        result = pageSchema.parse(await this.repository.read(query, this.clock()));
        if (query.before === undefined && query.outcome === 'all') for (const run of result.runs) this.remember(run);
      } catch { this.fail('history_read'); result = page(this.cached, query, this.clock(), { successes: 0, errors: 0 }); }
    } else result = page(this.cached, query, this.clock(), { successes: 0, errors: 0 });
    return diagnosticsSchema.parse({ ...result, persistent: this.persistent, pageSize: query.limit, retentionDays: HISTORY_DAYS, errorRetentionDays: ERROR_HISTORY_DAYS, active: this.state.active, capacity: HISTORY_CAPACITY });
  }
  context(evidence: FailureEvidence | null) { return { ...(this.state.active ? { run: this.state.active.sequence } : {}), evidence: failureEvidence(evidence) }; }
  async begin(kind: 'initial' | 'sync') {
    if (this.unknownSequence) return;
    if (this.state.sequence === Number.MAX_SAFE_INTEGER) { this.unknownSequence = true; this.fail('history_write'); return; }
    try { this.state.active = pendingRunSchema.parse({ sequence: this.state.sequence + 1, kind, startedAt: this.clock() }); }
    catch { this.unknownSequence = true; this.fail('history_write'); return; }
    this.state.sequence++; this.started = this.elapsed(); this.stageStarted = this.started; this.currentStage = null; this.measured.clear();
    await this.write(() => this.repository.begin(this.state.active!));
  }
  private milliseconds(start: number) { const n = Math.round(this.elapsed() - start); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
  private closeStage() { if (this.currentStage) { const entry = this.measured.get(this.currentStage)!; entry.durationMs = Math.min(Number.MAX_SAFE_INTEGER, entry.durationMs + this.milliseconds(this.stageStarted)); } }
  update(progress: SyncProgress) {
    if (!this.state.active) return;
    if (progress.stage !== this.currentStage) { this.closeStage(); this.currentStage = progress.stage; this.stageStarted = this.elapsed(); }
    const prior = this.measured.get(progress.stage); const maximum = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
    this.measured.set(progress.stage, { stage: progress.stage, durationMs: prior?.durationMs ?? 0, bytes: Math.max(prior?.bytes ?? 0, progress.bytes), totalBytes: maximum(prior?.totalBytes ?? null, progress.totalBytes), files: Math.max(prior?.files ?? 0, progress.files), totalFiles: maximum(prior?.totalFiles ?? null, progress.totalFiles), reusedFiles: maximum(prior?.reusedFiles ?? null, progress.reusedFiles ?? null) });
  }
  async finish(outcome: 'succeeded' | 'failed', failure: Failure | null, evidence: FailureEvidence | null, failureStage: SyncStage | null) {
    if (!this.state.active) return;
    this.closeStage();
    let run: RunSummary;
    try { run = runSchema.parse({ ...this.state.active, finishedAt: this.clock(), durationMs: this.milliseconds(this.started), outcome, failure, failureStage, evidence: failureEvidence(evidence), stages: [...this.measured.values()] }); }
    catch { this.state.active = null; this.currentStage = null; this.measured.clear(); this.fail('history_write'); return; }
    this.state.active = null; this.currentStage = null; this.measured.clear(); this.remember(run);
    await this.write(() => this.repository.finish(run)); await this.prune();
  }
}
