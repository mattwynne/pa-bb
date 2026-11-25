export type HistoricalMove = {
  operationId: string; vaultId: string; path: string; destination: string;
  expectedHash?: string; root?: string; project?: 'standalone' | 'paired'; refused?: boolean;
  verifyLinks?: true; verification?: { state: string }; repairs: { outcome: string }[];
};
export type PendingOperation = { operationId: string; vaultId: string; path: string; at: string; kind?: 'save' | 'resolution' };
export type Configuration = { moves?: HistoricalMove[]; revision: number; vaultIds: string[]; names?: Record<string, string>; pending?: PendingOperation[]; unconfirmedRevision?: number };
export type LocalCapability = { available: boolean; reason: 'ownership' | 'recovery_required' | 'source_changed' | null; pendingAgeMs: number | null; applicationBlocker: 'application_uncertain' | 'native_recovery' | null };
export type Source = { id: string; name: string; initialized: boolean; enabled: boolean; cloudConnected: boolean; phase: string; lastSuccess: string | null; failure: string | null; local: LocalCapability };
export type SearchCapability = { version: 1; available: boolean; reason: 'missing_executable' | 'unsupported_version' | 'unavailable' | null };
export type SearchQuery = { vaultId?: string; text?: string; tag?: string; pathGlob?: string; folders?: string[]; excludeFolders?: string[]; properties?: Array<{ key: string; equals: string | number | boolean | null }>; mode?: 'results' | 'count'; selectProperties?: string[]; cursor?: string; limit?: number };
export type Catalog = { mirrorDirectoryGrantVersion?: 1; mirrorDirectoryGrantUnconfirmed?: true; filesystem?: Record<string, 'ready' | 'legacy_pending' | 'legacy_conflict' | 'unavailable'>; search?: SearchCapability; setup: string; nextAction: string | null; sources: Source[]; connected: boolean; compatible: boolean };
export interface MirrorCatalog {
  snapshot(options?: { fresh: true; signal?: AbortSignal }): Promise<Catalog>;
  desktopSnapshot?(signal?: AbortSignal): Promise<Catalog>;
}
export type CompleteNote = { text: string; hash: string; readAt: string; complete: true };
// The iCloud note store applies this UTF-8 byte limit to whole reads and saves.
export const MAX_NOTE_BYTES = 1024 * 1024;
export type IncomingRead = { absent: true } | (CompleteNote & { absent: false });
export type ConflictInspection = { token: string; logicalHash: string; incomingHash: string | null; incomingAbsent: boolean };
export type SaveReceipt = { kind: 'save'; operationId: string; mirrorId: string; path: string; at: string; outcome: 'saved_locally_pending_sync' | 'not_saved' | 'uncertain'; hash: string; previousHash: string | null };
export type ResolutionReceipt = { kind: 'resolution'; operationId: string; mirrorId: string; path: string; at: string; outcome: 'saved_locally_pending_sync' | 'adopted_content' | 'adopted_absence'; hash: string | null };
export type Receipt = SaveReceipt | ResolutionReceipt;
export type Resolution = { mirrorId: string; revision: number; path: string; operationId: string; token: string; expectedLogicalHash: string; expectedIncomingHash: string | null; choice: 'keep_local' | 'accept_incoming' | 'replace'; text?: string };
export type DesktopLinkOperation =
  | { kind: 'start' }
  | { kind: 'eval' | 'write'; code: string }
  | { kind: 'backlinks'; path: string }
  | { kind: 'search'; query: string }
  | { kind: 'tasks'; path?: string }
  | { kind: 'move'; path: string; destination: string };
export type DesktopLinkResult = { kind: 'start' } | { kind: Exclude<DesktopLinkOperation['kind'], 'start'>; value: unknown };
export type InventoryInput = { vaultId: string; root: string; folders?: string[]; metadataFolders?: string[]; metadataDepth?: number; fields: string[]; tags?: boolean };
export type Inventory = { notes: { path: string; properties: Record<string, unknown>; malformed: boolean; tags?: string[] }[]; folders: string[]; incomplete: boolean };
export type PathMove = { vaultId: string; path: string; destination: string; operationId: string; expectedHash?: string; kind: 'note' | 'folder' };
export type PathMoveReceipt = Pick<PathMove, 'vaultId' | 'path' | 'destination' | 'operationId'> & {
  outcome: 'moved_locally_pending_sync' | 'not_moved' | 'uncertain';
};

export type DesktopLinkTarget = { status: 'resolved' | 'ambiguous' | 'missing' | 'incomplete'; target?: string; candidates?: string[] };

export type DesktopStatus = { mode: 'managed' | 'manual'; state: 'pending' | 'installing' | 'starting' | 'ready' | 'start_failed' | 'unsupported_host' | 'configuration_needed' | 'download_failed' | 'checksum_failed' | 'extract_failed' | 'storage_failed' };
export interface VaultFiles {
  desktopStatus?(): DesktopStatus;
  desktopConfiguration?(configuration: Configuration): void;
  // The direct adapter checks its identity-bound iCloud grant on both sides of the read.
  readonly desktopNoteReauthorizes?: true;
  desktopNote?(vaultId: string, revision: number, path: string, signal?: AbortSignal): Promise<string>;
  desktopCommit?(input: Parameters<VaultFiles['commit']>[0], previous: string, signal?: AbortSignal): Promise<Omit<SaveReceipt, 'kind'>>;
  desktopTargets?(vaultId: string, revision: number, path: string, links: string[], signal?: AbortSignal): Promise<DesktopLinkTarget[]>;
  desktop?(vaultId: string, revision: number, operation: DesktopLinkOperation, signal?: AbortSignal): Promise<unknown>;
  vaultInventory?(input: InventoryInput, revision: number, signal?: AbortSignal): Promise<Inventory>;
  inventoryRevision?(vaultId: string, folders: string[], revision: number, signal?: AbortSignal): Promise<string | null>;
  movePath?(input: PathMove, revision: number, signal?: AbortSignal): Promise<PathMoveReceipt>;
  moveReceipt?(vaultId: string, revision: number, operationId: string): Promise<PathMoveReceipt | null>;
  configure(configuration: Configuration): Promise<void>;
  children?(vaultId: string, revision: number, folder: string): Promise<{ entries: Array<{ name: string; kind: 'directory' | 'markdown' }>; incomplete: boolean }>;
  vaultRoots(vaultId: string, revision: number): Promise<{ roots: string[]; incomplete: boolean; warnings?: string[] }>;
  read(vaultId: string, revision: number, path: string): Promise<CompleteNote>;
  readIncoming(vaultId: string, revision: number, path: string, token: string): Promise<IncomingRead>;
  inspect(vaultId: string, revision: number, path: string): Promise<ConflictInspection | null>;
  commit(input: { mirrorId: string; revision: number; operationId: string; path: string; kind: 'create' | 'replace'; expectedHash: string | null; text: string }): Promise<Omit<SaveReceipt, 'kind'>>;
  resolve(input: Resolution): Promise<Pick<ResolutionReceipt, 'outcome' | 'hash'>>;
  receipts(input: { mirrorId: string; revision: number; operationId?: string; path?: string; since?: string; limit: number }): Promise<Receipt[]>;
}
export interface StateRepository { load(): Promise<Configuration | undefined>; save(configuration: Configuration): Promise<void> }
export type Location = { line: number; endLine: number; start: number; end: number };
export type Metadata = { properties: Record<string, unknown>; aliases: string[]; tags: Array<Location & { tag: string }>; headings: Array<Location & { title: string; depth: number }>; blocks: Array<Location & { id: string }>; links: Array<Location & { target: string; embed: boolean; syntax?: 'frontmatter' | 'markdown' | 'wiki' | 'definition'; destination?: { start: number; end: number } }>; tasks: Array<Location & { text: string; marker: string; markerOffset: number; complete: boolean }>; warnings: string[]; unclosedHtmlOffset?: number; htmlLinkOffset?: number; unparsedReferenceOffset?: number };
export interface NoteParser {
  frontmatter(text: string): { properties: Record<string, unknown>; warnings: string[] };
  parse(text: string, purpose?: 'move' | 'section'): Metadata;
  edit(text: string, replacements: Array<{ oldText: string; newText: string }>): string;
  properties(text: string, input: { set: Record<string, unknown>; remove: string[] }): string;
}
export class VaultError extends Error { constructor(readonly category: string, readonly nextAction = 'Check source status and reread the note before preparing a change.', readonly diagnosticReported = false) { super(category); this.name = 'VaultError'; } }
export type Diagnose = (stage: 'catalog' | 'rpc' | 'state' | 'parse' | 'tool' | 'filesystem' | 'desktop_install' | 'desktop_setup' | 'desktop_start' | 'desktop_command' | 'desktop_cleanup', category: string) => void;
