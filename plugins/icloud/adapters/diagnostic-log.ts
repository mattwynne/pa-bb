import { FAILURES, failureEvidence } from '../core/ports.ts';
import type { Diagnose, DiagnosticContext, Failure, CommandFailureEvidence } from '../core/ports.ts';
const commandProof = (proof: CommandFailureEvidence) => `${proof.kind}${proof.kind === 'command_exit' ? ` exit=${proof.exitCode ?? 'unknown'}${proof.native ? ` native=${proof.native}` : ''}${proof.reason ? ` reason=${proof.reason}` : ''}` : ''}`;
export function diagnosticMessage(stage: string, failure: string, details?: DiagnosticContext): string {
  const safeStage = /^(prerequisite|startup|connect|challenge|browse|disconnect|restore_connection|attention_write|update_pause|maintenance_(write|restore)|restart|schedule|history_read|history_write|history_retention|rclone_log_(read|write)|direct_push|photos_(browse|page|ticket|download)|mirror_directory(?:_grant)?|mirror_(owner|start|configure|list)|file_(apply|application_recovery|maintenance|read|commit|move|receipts|inspect_conflict|resolve_conflict)|(sync|prepare|initial_completion)\/(checking|backing_up_cloud|backing_up_local|saving_recovery|transferring|verifying|persist_start))$/.test(stage) ? stage : 'unknown';
  const safeFailure = FAILURES.includes(failure as Failure) || ['source_unavailable', 'not_connected', 'invalid_path', 'unsupported', 'conflict', 'cancelled', 'uncertain', 'operation_reused', 'operation_expired', 'cursor_expired', 'invalid_query', 'skipped'].includes(failure) ? failure : 'unknown';
  const run = typeof details?.run === 'number' && Number.isSafeInteger(details.run) && details.run > 0 ? ` run=${details.run}` : '';
  const evidence = failureEvidence(details?.evidence);
  const proof = evidence ? ` evidence=${evidence.kind === 'post_run_reconcile' ? `post_run_reconcile reason=${evidence.reason}${evidence.command ? ` command=${commandProof(evidence.command)}` : ''}` : commandProof(evidence)}` : '';
  const application = details?.application;
  const boundary = application ? ` application_stage=${['native_lock', 'reconcile', 'observe', 'conflict_capture', 'stage_write', 'journal_write', 'publish', 'checkpoint', 'checkpoint_complete'].includes(application.stage) ? application.stage : 'unknown'} outcome=${['unapplied', 'applied', 'conflict', 'uncertain'].includes(application.outcome) ? application.outcome : 'uncertain'}` : '';
  return `iCloud ${safeStage} ${safeFailure}${run}${proof}${boundary}`;
}
export function diagnosticLogger(warn: (message: string) => void): Diagnose {
  return (stage, failure, details) => warn(diagnosticMessage(stage, failure, details));
}
