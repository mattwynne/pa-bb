export type PendingOperation = { operationId: string; vaultId: string; path: string; at: string; kind?: 'save' | 'resolution' };
export type Configuration = { moves?: import('./move.ts').MoveRecord[]; revision: number; vaultIds: string[]; names?: Record<string, string>; pending?: PendingOperation[]; unconfirmedRevision?: number };
export type LocalCapability = { available: boolean; reason: 'ownership' | 'recovery_required' | 'source_changed' | null; pendingAgeMs: number | null; applicationBlocker: 'application_uncertain' | 'native_recovery' | null };
export type Source = { id: string; name: string; initialized: boolean; enabled: boolean; cloudConnected: boolean; phase: string; lastSuccess: string | null; failure: string | null; local: LocalCapability };
export type SearchCapability = { version: 1; available: boolean; reason: 'missing_executable' | 'unsupported_version' | 'unavailable' | null };
export type SearchQuery = { vaultId?: string; text?: string; tag?: string; pathGlob?: string; folders?: string[]; excludeFolders?: string[]; properties?: Array<{ key: string; equals: string | number | boolean | null }>; mode?: 'results' | 'count'; selectProperties?: string[]; cursor?: string; limit?: number };
export type SearchRequest = { mirrorId: string; revision: number; text?: string; projection: 'hits' | 'frontmatter' | 'markdown'; folders?: string[]; excludeFolders?: string[]; cursor?: string; startOnly?: boolean };
export type SearchBatch = { candidates: Array<{ path: string; hash: string; readAt: string; line: number; snippet: string; content?: string; limited?: boolean }>; nextCursor: string | null; visited: number; warnings: Array<'note_unavailable' | 'unsupported' | 'source_changed' | 'capacity'> };
export type Catalog = { mirrorDirectoryGrantVersion?: 1; mirrorDirectoryGrantUnconfirmed?: true; filesystem?: Record<string, 'ready' | 'legacy_pending' | 'legacy_conflict' | 'unavailable'>; search?: SearchCapability; setup: string; nextAction: string | null; sources: Source[]; connected: boolean; compatible: boolean };
export interface MirrorCatalog { snapshot(options?: { fresh: true; signal?: AbortSignal }): Promise<Catalog> }
export const projectAreaRoutes = ['index', 'direct', 'legacy_pending', 'legacy_conflict', 'legacy'] as const;
export type ProjectAreaRoute = typeof projectAreaRoutes[number];
export type ProjectAreaAuthority = { revision: number; route: ProjectAreaRoute; epoch: string };
export type ProjectAreaSelection = ProjectAreaAuthority & { vaultId: string; signal?: AbortSignal };
export type LiveProjectAreaAccess = { route: Exclude<ProjectAreaRoute, 'index'>; epoch: string; signal?: AbortSignal };
export const projectAreaSourceRefusal = (category: string) => ['source_unavailable', 'not_connected', 'incompatible', 'busy', 'uncertain'].includes(category);
export function projectAreaRoute(catalog: Catalog, id: string): ProjectAreaRoute {
  if (!catalog.compatible || !catalog.sources.some(source => source.id === id && source.local.available)) throw new VaultError('source_unavailable');
  const filesystem = catalog.filesystem?.[id];
  if (filesystem === 'unavailable' || (filesystem === 'ready' && catalog.mirrorDirectoryGrantUnconfirmed)) throw new VaultError('source_unavailable');
  return filesystem === 'ready' ? catalog.mirrorDirectoryGrantVersion === 1 ? 'index' : 'direct' : filesystem ?? 'legacy';
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
export interface VaultFiles {
  children?(vaultId: string, revision: number, folder: string, access?: LiveProjectAreaAccess): Promise<{ entries: Array<{ name: string; kind: 'directory' | 'markdown' }>; incomplete: boolean }>;
  listProjectMove?(input: import('./project-move.ts').MoveEndpoints & { mirrorId: string; revision: number; afterMove?: boolean; operationId?: string }): Promise<{ paths: string[]; attachments: string[]; incomplete: boolean; warnings: string[]; folderEvidence?: string }>;
  listLinkTargets?(vaultId: string, revision: number, root: string): Promise<{ paths: string[]; attachments: string[]; incomplete: boolean; warnings: string[] }>;
  readonly checksLinkPlanAtWrite?: true;
  move?(input: import('./project-move.ts').MoveEndpoints & { mirrorId: string; revision: number; expectedHash: string; operationId: string; movedNotes?: ReadonlyMap<string, string>; checkLinkPlan?: () => Promise<() => void> }): Promise<{ outcome: import('./project-move.ts').PhysicalMove }>;
  moveReceipts?(input: { mirrorId: string; revision: number; operationId: string; project?: import('./project-move.ts').ProjectMove; directory?: true }): Promise<Array<{ outcome: import('./project-move.ts').PhysicalMove; components?: { landing: string; folder: string } }>>;
  // An indexed inventory can supply the catalog observation used to select its route.
  configure(configuration: Configuration, projectAreas?: ProjectAreaSelection, observedCatalog?: Catalog): Promise<void>;
  // Optional native read model; legacy logical vaults still use search().
  index?(vaultId: string, revision: number, signal?: AbortSignal): Promise<import('./vault-index.ts').IndexLease>;
  indexConfiguration?(configuration: Configuration): void;
  search(input: SearchRequest, signal?: AbortSignal): Promise<SearchBatch>;
  closeSearch(revision: number, cursor: string): Promise<void>;
  vaultRoots(vaultId: string, revision: number): Promise<{ roots: string[]; incomplete: boolean }>;
  list(vaultId: string, revision: number, access?: LiveProjectAreaAccess): Promise<{ paths: string[]; incomplete: boolean; warnings: string[] }>;
  read(vaultId: string, revision: number, path: string, access?: LiveProjectAreaAccess): Promise<CompleteNote>;
  checkLiveProjectAreaAccess?(vaultId: string, revision: number, access: LiveProjectAreaAccess): Promise<void>;
  /** Adapter-owned identity of uninterrupted observed access, not of note contents. */
  projectAreaEpoch(vaultId: string, revision: number, route: ProjectAreaRoute): string;
  readForMove?(vaultId: string, revision: number, path: string, signal: AbortSignal): Promise<CompleteNote>;
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
  parse(text: string, purpose?: 'move'): Metadata;
  edit(text: string, replacements: Array<{ oldText: string; newText: string }>): string;
  properties(text: string, input: { set: Record<string, unknown>; remove: string[] }): string;
}
export class VaultError extends Error { constructor(readonly category: string, readonly nextAction = 'Check source status and reread the note before preparing a change.', readonly diagnosticReported = false) { super(category); this.name = 'VaultError'; } }
export type Diagnose = (stage: 'catalog' | 'rpc' | 'state' | 'parse' | 'tool' | 'move_preflight' | 'move_verification' | 'filesystem' | 'index_refresh' | 'index_watch' | 'index_access' | 'defer_move' | 'defer_save' | 'reactivation_move' | 'reactivation_cleanup', category: string) => void;
