export type Configuration = { revision: number; vaultIds: string[]; pending?: Array<{ operationId: string; vaultId: string; path: string; at: string }> };
export type Source = { id: string; name: string; initialized: boolean; enabled: boolean; phase: string; lastSuccess: string | null; failure: string | null };
export type Catalog = { setup: string; nextAction: string | null; sources: Source[]; connected: boolean };
export interface MirrorCatalog { snapshot(): Promise<Catalog> }
export type CompleteNote = { text: string; hash: string; readAt: string; complete: true };
export type Receipt = { operationId: string; mirrorId: string; path: string; at: string; outcome: 'saved_locally_pending_sync' | 'not_saved' | 'uncertain'; hash: string; previousHash: string | null };
export interface VaultFiles {
  configure(configuration: Configuration): Promise<void>;
  list(vaultId: string, revision: number): Promise<{ paths: string[]; incomplete: boolean; warnings: string[] }>;
  read(vaultId: string, revision: number, path: string): Promise<CompleteNote>;
  commit(input: { mirrorId: string; revision: number; operationId: string; path: string; kind: 'create' | 'replace'; expectedHash: string | null; text: string }): Promise<Receipt>;
  receipts(input: { mirrorId: string; revision: number; operationId?: string; path?: string; since?: string; limit: number }): Promise<Receipt[]>;
}
export interface StateRepository { load(): Promise<Configuration | undefined>; save(configuration: Configuration): Promise<void> }
export type Location = { line: number; endLine: number; start: number; end: number };
export type Metadata = { properties: Record<string, unknown>; aliases: string[]; tags: Array<Location & { tag: string }>; headings: Array<Location & { title: string; depth: number }>; blocks: Array<Location & { id: string }>; links: Array<Location & { target: string; embed: boolean }>; tasks: Array<Location & { text: string; marker: string; markerOffset: number; complete: boolean }>; warnings: string[] };
export interface NoteParser {
  parse(text: string): Metadata;
  edit(text: string, replacements: Array<{ oldText: string; newText: string }>): string;
  properties(text: string, input: { set: Record<string, unknown>; remove: string[] }): string;
}
export class VaultError extends Error { constructor(readonly category: string, readonly nextAction = 'Check source status and reread the note before preparing a change.', readonly diagnosticReported = false) { super(category); this.name = 'VaultError'; } }
export type Diagnose = (stage: 'catalog' | 'rpc' | 'state' | 'parse' | 'tool', category: string) => void;
