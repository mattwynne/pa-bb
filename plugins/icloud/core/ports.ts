// Domain ports: no command flags, config keys, remote syntax or raw errors.
export type Failure = 'unavailable' | 'authentication' | 'capacity' | 'interrupted' | 'sync_failed' | 'busy' | 'invalid_selection' | 'recovery_required' | 'unknown';
export class CloudError extends Error {
  readonly category: Failure;
  constructor(category: Failure) { super(category); this.name = 'CloudError'; this.category = category; }
}
export type Challenge = 'verification_code' | 'trusted_device';
export type Connection = { connected: true } | { connected: false; challenge: Challenge };
export type CloudFolder = { id: string; name: string; ancestors: string[] };
export type Mirror = { id: string; folder: CloudFolder; initialized: boolean; enabled: boolean; phase: 'paused' | 'ready' | 'running' | 'failed' | 'retained'; lastSuccess: string | null; failure: Failure | null };
export type State = { connected: boolean; challenge: Challenge | null; mirrors: Mirror[] };
export interface CloudProvider {
  checkAvailability(): Promise<void>;
  verifyConnection(): Promise<void>;
  connect(credentials: { account: string; password: string }): Promise<Connection>;
  answerChallenge(answer: string): Promise<Connection>;
  listFolders(parent: string | null): Promise<CloudFolder[]>;
  prepareMirror(mirror: Mirror): Promise<void>;
  synchronize(mirror: Mirror): Promise<void>;
  disconnect(): Promise<void>;
  stop(): Promise<void>;
  // Explicit consuming-integration boundary, never settings path selection.
  localFolder(mirror: Mirror): string;
}
export interface StateRepository { load(): Promise<State | undefined>; save(state: State): Promise<void> }
export const emptyState = (): State => ({ connected: false, challenge: null, mirrors: [] });
export function category(error: unknown): Failure { return error instanceof CloudError ? error.category : 'unknown'; }
