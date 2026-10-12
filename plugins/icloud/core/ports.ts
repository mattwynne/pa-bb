// Domain ports: no command flags, config keys, remote syntax or raw errors.
export const FAILURES = ['unavailable', 'authentication', 'capacity', 'interrupted', 'sync_failed', 'source_changed', 'busy', 'invalid_selection', 'recovery_required', 'unknown'] as const;
export type Failure = typeof FAILURES[number];
export type FailureEvidence = { kind: 'command_exit'; exitCode: number | null } | { kind: 'command_timeout' | 'command_output_limit' | 'command_signal' | 'command_start' | 'command_stopped' };
export function failureEvidence(value: unknown): FailureEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (input.kind === 'command_exit') return { kind: 'command_exit', exitCode: typeof input.exitCode === 'number' && Number.isInteger(input.exitCode) && input.exitCode >= 1 && input.exitCode <= 10 ? input.exitCode : null };
  if (['command_timeout', 'command_output_limit', 'command_signal', 'command_start', 'command_stopped'].includes(input.kind as string)) return { kind: input.kind as Exclude<FailureEvidence['kind'], 'command_exit'> };
  return null;
}
export class CloudError extends Error {
  readonly category: Failure;
  readonly evidence: FailureEvidence | null;
  constructor(category: Failure, evidence?: FailureEvidence) { super(category); this.name = 'CloudError'; this.category = category; this.evidence = failureEvidence(evidence); }
}
export type Challenge = 'verification_code' | 'trusted_device';
export type Connection = { connected: true } | { connected: false; challenge: Challenge };
export type CloudFolder = { id: string; name: string; ancestors: string[] };
export type Mirror = { id: string; folder: CloudFolder; initialized: boolean; enabled: boolean; phase: 'paused' | 'ready' | 'running' | 'failed' | 'retained'; lastSuccess: string | null; failure: Failure | null };
export type SyncStage = 'checking' | 'backing_up_cloud' | 'backing_up_local' | 'saving_recovery' | 'transferring' | 'verifying';
export type TransferProgress = { bytes: number; totalBytes: number | null; files: number; totalFiles: number | null };
export type SyncProgress = TransferProgress & { stage: SyncStage; reusedFiles?: number };
export type ProgressReporter = (progress: SyncProgress) => void;
export const activity = (stage: SyncStage): SyncProgress => ({ stage, bytes: 0, totalBytes: null, files: 0, totalFiles: null });
export type State = { connected: boolean; challenge: Challenge | null; mirrors: Mirror[] };
export interface CloudProvider {
  checkAvailability(): Promise<void>;
  verifyConnection(): Promise<void>;
  connect(credentials: { account: string; password: string }): Promise<Connection>;
  answerChallenge(answer: string): Promise<Connection>;
  listFolders(parent: string | null): Promise<CloudFolder[]>;
  prepareMirror(mirror: Mirror, report?: ProgressReporter): Promise<void>;
  synchronize(mirror: Mirror, report?: ProgressReporter): Promise<void>;
  disconnect(): Promise<void>;
  stop(): Promise<void>;
  // Explicit consuming-integration boundary, never settings path selection.
  localFolder(mirror: Mirror): string;
}
export interface StateRepository { load(): Promise<State | undefined>; save(state: State): Promise<void> }
export const emptyState = (): State => ({ connected: false, challenge: null, mirrors: [] });
export function category(error: unknown): Failure { return error instanceof CloudError && FAILURES.includes(error.category) ? error.category : 'unknown'; }
export function evidence(error: unknown): FailureEvidence | null { return error instanceof CloudError ? failureEvidence(error.evidence) : null; }
export type DiagnosticContext = { run?: number; evidence: FailureEvidence | null };
export type Diagnose = (stage: string, failure: string, details?: DiagnosticContext) => void;
