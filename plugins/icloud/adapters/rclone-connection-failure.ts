import type { Failure } from '../core/ports.ts';
// Stock rclone v1.75.2 RC wraps native errors in HTTP 500. Examine only
// this operation's bounded response, never trace/history or provider body text.
export function rcConnectionFailure(method: string, body: Record<string, unknown>, status: number | undefined, data: string): Failure {
  if (method !== 'operations/list' || body.fs !== 'icloud:') return 'sync_failed';
  if (status === 421) return 'provider_rejected';
  if (status !== 500 || Buffer.byteLength(data) > 4 * 1024 * 1024) return 'sync_failed';
  try {
    const error: unknown = JSON.parse(data)?.error;
    if (error === 'trust token expired, please reauth') return 'authentication';
    // lib/rest/rest.go's exact native wrapper. Its quoted response body is
    // untrusted and contributes nothing to the diagnosis; 421 is ambiguous.
    // api/session.go also wraps this with the pinned Drive PCS operation.
    if (typeof error === 'string' && /^(?:requestPCS\(iclouddrive\): )?HTTP error 421 \(421(?: Misdirected Request)?\) returned body: "(?:[^"\\]|\\.)*"$/.test(error)) return 'provider_rejected';
  } catch { /* No validated native evidence. */ }
  return 'sync_failed';
}
