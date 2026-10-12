import { FAILURES, failureEvidence } from '../core/ports.ts';
import type { Diagnose, DiagnosticContext, Failure } from '../core/ports.ts';
export function diagnosticMessage(stage: string, failure: string, details?: DiagnosticContext): string {
  const safeStage = /^(prerequisite|connect|challenge|browse|disconnect|restore_connection|restart|schedule|history_read|history_write|history_retention|(sync|prepare)\/(checking|backing_up_cloud|backing_up_local|saving_recovery|transferring|verifying))$/.test(stage) ? stage : 'unknown';
  const safeFailure = FAILURES.includes(failure as Failure) ? failure : 'unknown';
  const run = typeof details?.run === 'number' && Number.isSafeInteger(details.run) && details.run > 0 ? ` run=${details.run}` : '';
  const evidence = failureEvidence(details?.evidence);
  const proof = evidence ? ` evidence=${evidence.kind}${evidence.kind === 'command_exit' ? ` exit=${evidence.exitCode ?? 'unknown'}` : ''}` : '';
  return `iCloud ${safeStage} ${safeFailure}${run}${proof}`;
}
export function diagnosticLogger(warn: (message: string) => void): Diagnose {
  return (stage, failure, details) => warn(diagnosticMessage(stage, failure, details));
}
