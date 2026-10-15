import { FAILURES, failureEvidence } from '../core/ports.ts';
import type { Diagnose, DiagnosticContext, Failure } from '../core/ports.ts';
export function diagnosticMessage(stage: string, failure: string, details?: DiagnosticContext): string {
  const safeStage = /^(prerequisite|startup|connect|challenge|browse|disconnect|restore_connection|restart|schedule|history_read|history_write|history_retention|note_(owner|start|apply|maintenance|configure|list|read|commit|receipts|inspect_conflict|resolve_conflict)|(sync|prepare)\/(checking|backing_up_cloud|backing_up_local|saving_recovery|transferring|verifying))$/.test(stage) ? stage : 'unknown';
  const safeFailure = FAILURES.includes(failure as Failure) || ['source_unavailable', 'not_connected', 'invalid_path', 'unsupported', 'conflict', 'cancelled', 'uncertain', 'operation_reused', 'operation_expired'].includes(failure) ? failure : 'unknown';
  const run = typeof details?.run === 'number' && Number.isSafeInteger(details.run) && details.run > 0 ? ` run=${details.run}` : '';
  const evidence = failureEvidence(details?.evidence);
  const proof = evidence ? ` evidence=${evidence.kind}${evidence.kind === 'command_exit' ? ` exit=${evidence.exitCode ?? 'unknown'}${evidence.native ? ` native=${evidence.native}` : ''}${evidence.reason ? ` reason=${evidence.reason}` : ''}` : ''}` : '';
  return `iCloud ${safeStage} ${safeFailure}${run}${proof}`;
}
export function diagnosticLogger(warn: (message: string) => void): Diagnose {
  return (stage, failure, details) => warn(diagnosticMessage(stage, failure, details));
}
