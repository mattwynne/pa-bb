import type { AttentionState } from './attention.ts';
// Domain ports: no command flags, config keys, remote syntax or raw errors.
export const FAILURES = ['unavailable', 'authentication', 'provider_rejected', 'configuration', 'capacity', 'interrupted', 'sync_failed', 'source_changed', 'busy', 'invalid_selection', 'recovery_required', 'unknown'] as const;
export type Failure = typeof FAILURES[number];
export type CommandFailureEvidence = { kind: 'command_exit'; exitCode: number | null; native?: 'retryable_abort' | 'resync_required_abort' | 'unknown_fatal'; reason?: 'listing_failure' } | { kind: 'command_timeout' | 'command_output_limit' | 'command_signal' | 'command_start' | 'command_stopped' };
export type FailureEvidence = CommandFailureEvidence | { kind: 'post_run_reconcile'; reason: 'uncertain' | 'unavailable'; command: CommandFailureEvidence | null };
function commandFailureEvidence(value: unknown): CommandFailureEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.kind === 'command_exit') return { kind: 'command_exit', exitCode: typeof input.exitCode === 'number' && Number.isInteger(input.exitCode) && input.exitCode >= 1 && input.exitCode <= 10 ? input.exitCode : null,
    ...(['retryable_abort', 'resync_required_abort', 'unknown_fatal'].includes(input.native as string) ? { native: input.native as 'retryable_abort' | 'resync_required_abort' | 'unknown_fatal' } : {}),
    ...(input.reason === 'listing_failure' ? { reason: 'listing_failure' as const } : {}) };
  if (['command_timeout', 'command_output_limit', 'command_signal', 'command_start', 'command_stopped'].includes(input.kind as string)) return { kind: input.kind as Exclude<CommandFailureEvidence['kind'], 'command_exit'> };
  return null;
}
export function failureEvidence(value: unknown): FailureEvidence | null {
  if (value && typeof value === 'object' && (value as Record<string, unknown>).kind === 'post_run_reconcile') {
    const input = value as Record<string, unknown>;
    return { kind: 'post_run_reconcile', reason: input.reason === 'uncertain' ? 'uncertain' : 'unavailable', command: commandFailureEvidence(input.command) };
  }
  return commandFailureEvidence(value);
}
export class CloudError extends Error {
  readonly category: Failure;
  readonly evidence: FailureEvidence | null;
  constructor(category: Failure, evidence?: FailureEvidence) { super(category); this.name = 'CloudError'; this.category = category; this.evidence = failureEvidence(evidence); }
}
export type Challenge = 'verification_code' | 'trusted_device';
// Connected means the protected authentication flow and verification read succeeded.
export type Connection = { connected: true } | { connected: false; challenge: Challenge };
export type CloudFolder = { id: string; name: string; ancestors: string[] };
export const BLOCKERS = ['reconnect', 'configuration', 'capacity', 'initialization', 'rebuild'] as const;
export type Blocker = typeof BLOCKERS[number];
export type Mirror = { initialCompletionAttempted?: boolean; id: string; folder: CloudFolder; initialized: boolean; enabled: boolean; phase: 'paused' | 'ready' | 'running' | 'failed' | 'retained'; lastSuccess: string | null; failure: Failure | null; blocker: Blocker | null };
export type MirrorStatus = Mirror & { retryPending: boolean; recovering: boolean };
export type SyncStage = 'checking' | 'backing_up_cloud' | 'backing_up_local' | 'saving_recovery' | 'transferring' | 'verifying';
export type TransferProgress = { bytes: number; totalBytes: number | null; files: number; totalFiles: number | null };
export type SyncProgress = TransferProgress & { stage: SyncStage; reusedFiles?: number };
export type ProgressReporter = (progress: SyncProgress) => void;
export const activity = (stage: SyncStage): SyncProgress => ({ stage, bytes: 0, totalBytes: null, files: 0, totalFiles: null });
export type State = { connected: boolean; challenge: Challenge | null; mirrors: Mirror[]; lastSignInCompletedAt?: string | null; attentionState?: AttentionState };
export interface CloudProvider {
  checkAvailability(): Promise<void>;
  verifyConnection(): Promise<void>;
  connect(credentials: { account: string; password: string }): Promise<Connection>;
  answerChallenge(answer: string): Promise<Connection>;
  listFolders(parent: string | null): Promise<CloudFolder[]>;
  prepareMirror(mirror: Mirror, report?: ProgressReporter): Promise<void>;
  synchronize(mirror: Mirror, report?: ProgressReporter): Promise<void>;
  // Explicit assessment plus one ordinary native continuation; never Retry.
  continueInterrupted?(mirror: Mirror, report?: ProgressReporter): Promise<void>;
  // One explicit completion of an already-downloaded, registration-failed mirror.
  completeInitialRegistration?(mirror: Mirror, report?: ProgressReporter): Promise<void>;
  disconnect(): Promise<void>;
  // Close admission and interrupt work without releasing its native owner.
  requestStop?(): void;
  stop(): Promise<void>;
  // Explicit consuming-integration boundary, never settings path selection.
  localFolder(mirror: Mirror): string;
  // Executes under the existing native generation's inherited worker flock.
  withMirrorFiles?<T>(mirror: Mirror, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export interface StateRepository { load(): Promise<State | undefined>; save(state: State): Promise<void> }
export const emptyState = (): State => ({ connected: false, challenge: null, mirrors: [] });
export function category(error: unknown): Failure { return error instanceof CloudError && FAILURES.includes(error.category) ? error.category : 'unknown'; }
export function evidence(error: unknown): FailureEvidence | null { return error instanceof CloudError ? failureEvidence(error.evidence) : null; }
export type DiagnosticContext = { run?: number; evidence: FailureEvidence | null };
export type Diagnose = (stage: string, failure: string, details?: DiagnosticContext) => void;
