export type Category = 'configuration' | 'disconnected' | 'oauth_state' | 'authorization' | 'scope_required' | 'transport' | 'rate_limit' | 'provider_rejection' | 'provider_result' | 'response_invalid' | 'tenant_required' | 'connection_changed' | 'input' | 'verification' | 'storage' | 'unknown';
export class XeroError extends Error {
  readonly category: Category;
  readonly stage: string;
  readonly uncertain: boolean;
  readonly status?: number;
  constructor(category: Category, stage: string, message: string, uncertain = false, status?: number) {
    super(message); this.category = category; this.stage = stage; this.uncertain = uncertain; this.status = status;
  }
}
export function diagnostic(error: unknown, stage: string) {
  const e = error instanceof XeroError ? error : null;
  return `Xero ${e?.stage ?? stage} ${e?.category ?? 'unknown'}${e?.status ? ` http_${e.status}` : ''}`;
}
export function feedback(error: unknown) {
  return error instanceof XeroError ? error.message : 'Xero request could not be completed. Check the connection before retrying; a requested change may already have been applied.';
}
