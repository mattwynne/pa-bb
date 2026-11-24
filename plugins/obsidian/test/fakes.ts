import { createHash } from 'node:crypto';
import { VaultError, type DesktopLinkOperation, type DesktopLinkTarget, type InventoryInput } from '../core/ports.ts';
import type { Configuration, MirrorCatalog, Catalog, VaultFiles, StateRepository, Receipt, SaveReceipt, ConflictInspection, Resolution } from '../core/ports.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class MemoryState implements StateRepository { value: Configuration = { revision: 0, vaultIds: [] }; async load() { return structuredClone(this.value); } async save(value: Configuration) { this.value = structuredClone(value); } }
export class CatalogFake implements MirrorCatalog {
  value: Catalog = { search: { version: 1, available: true, reason: null }, setup: 'ready', nextAction: null, connected: true, compatible: true, sources: ['one', 'two'].map(id => ({ id, name: 'Launch', initialized: true, enabled: true, cloudConnected: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00Z', failure: null, local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } })) };
  async snapshot() { const value = structuredClone(this.value); value.sources.forEach(source => { source.cloudConnected = value.connected; }); return value; }
}
export class FilesFake implements VaultFiles {
  configuration: Configuration = { revision: -1, vaultIds: [] }; notes = new Map<string, string>(); saved: Receipt[] = []; conflicts = new Map<string, { inspection: ConflictInspection; incoming: string | null }>();
  constructor() { for (const id of ['one', 'two']) this.notes.set(`${id}/Launch.md`, '# Launch\r\n- [ ] Ship\r\n[[Other]]\r\n'); this.notes.set('one/Other.md', '# Other\nSource evidence\n'); }
  async configure(value: Configuration) { this.configuration = structuredClone(value); }
  async desktopCommit(input: Parameters<VaultFiles['commit']>[0]) { return this.commit(input); }
  async desktopNote(id: string, revision: number, path: string) {
    const note = await this.read(id, revision, path);
    if (!note.complete || hash(note.text) !== note.hash) throw new VaultError('unsupported');
    return note.text;
  }
  async vaultInventory(input: InventoryInput, revision: number) {
    this.admit(input.vaultId, revision);
    const list = await this.list(input.vaultId, revision);
    const parser = new MarkdownNotes();
    const within = (path: string, folder: string) => !folder || path === folder || path.startsWith(folder + '/');
    const paths = list.paths.filter(path => within(path, input.root) && (!input.folders || input.folders.some(folder => within(path, folder))));
    const folders = [...new Set(paths.flatMap(path => path.split('/').slice(1).map((_, i) => path.split('/').slice(0, i + 1).join('/'))))];
    return { folders, notes: paths.map(path => {
      const text = this.notes.get(input.vaultId + '/' + path)!;
      const { properties, warnings } = parser.frontmatter(text);
      return { path, properties: Object.fromEntries(input.fields.filter(field => Object.hasOwn(properties, field)).map(field => [field, properties[field]])),
        malformed: warnings.length > 0, tags: input.tags ? parser.parse(text).tags.map(tag => tag.tag) : [] };
    }), incomplete: false };
  }
  async desktop(id: string, rev: number, operation: DesktopLinkOperation) {
    const paths = (await this.list(id, rev)).paths;
    switch (operation.kind) {
      case 'start': return;
      case 'backlinks': return [];
      case 'search': {
        const query = String(JSON.parse(operation.query)).toLowerCase();
        return paths.flatMap(file => {
          const matches = this.notes.get(id + '/' + file)!.split(/\r?\n/).flatMap((text, i) =>
            text.toLowerCase().includes(query) ? [{ line: i + 1, text }] : []);
          return matches.length ? [{ file, matches }] : [];
        });
      }
      case 'tasks': return paths.filter(path => !operation.path || path === operation.path).flatMap(file =>
        new MarkdownNotes().parse(this.notes.get(id + '/' + file)!).tasks.map(task => ({ line: task.line, status: task.marker, text: task.text, file })));
      default: throw new VaultError('unsupported');
    }
  }
  async desktopTargets(id: string, rev: number, _path: string, links: string[]): Promise<DesktopLinkTarget[]> {
    const paths = (await this.list(id, rev)).paths;
    return links.map(link => {
      const pattern = link.replace(/^\//, '') + (link.endsWith('.md') ? '' : '.md');
      const exact = paths.filter(path => path === pattern);
      const matches = exact.length ? exact : paths.filter(path => path.endsWith('/' + pattern));
      return matches.length === 1 ? { status: 'resolved', target: matches[0] } :
        matches.length > 1 ? { status: 'ambiguous', candidates: matches } : { status: 'missing' };
    });
  }
  private admit(id: string, revision: number) { if (this.configuration.revision !== revision || !this.configuration.vaultIds.includes(id)) throw new VaultError('not_connected'); }
  async vaultRoots(id: string, revision: number) { this.admit(id, revision); return { roots: [''], incomplete: false }; }
  async list(id: string, revision: number) { this.admit(id, revision); return { paths: [...this.notes.keys()].filter(k => k.startsWith(id + '/')).map(k => k.slice(id.length + 1)), incomplete: false, warnings: [] }; }
  async read(id: string, revision: number, path: string) { this.admit(id, revision); const text = this.notes.get(`${id}/${path}`); if (text === undefined) throw new VaultError('unavailable'); return { text, hash: hash(text), readAt: '2026-01-01T00:00:01Z', complete: true as const }; }
  async inspect(id: string, revision: number, path: string) { this.admit(id, revision); return this.conflicts.get(`${id}/${path}`)?.inspection ?? null; }
  async readIncoming(id: string, revision: number, path: string, token: string) { this.admit(id, revision); const record = this.conflicts.get(`${id}/${path}`); if (!record || record.inspection.token !== token) throw new VaultError('conflict'); return record.incoming === null ? { absent: true as const } : { absent: false as const, text: record.incoming, hash: hash(record.incoming), readAt: '2026-01-01T00:00:01Z', complete: true as const }; }
  async resolve(input: Resolution) { this.admit(input.mirrorId, input.revision); const key = `${input.mirrorId}/${input.path}`; const record = this.conflicts.get(key); if (!record || record.inspection.token !== input.token || record.inspection.logicalHash !== input.expectedLogicalHash || record.inspection.incomingHash !== input.expectedIncomingHash) throw new VaultError('conflict');
    const text = input.choice === 'keep_local' ? this.notes.get(key)! : input.choice === 'replace' ? input.text! : record.incoming; if (text === null) this.notes.delete(key); else this.notes.set(key, text); this.conflicts.delete(key);
    const outcome = text === null ? 'adopted_absence' as const : input.choice === 'accept_incoming' ? 'adopted_content' as const : 'saved_locally_pending_sync' as const; this.saved.push({ kind: 'resolution', operationId: input.operationId, mirrorId: input.mirrorId, path: input.path, at: '2026-01-01T00:00:02Z', outcome, hash: text === null ? null : hash(text) }); return { outcome, hash: text === null ? null : hash(text) }; }
  async commit(input: Parameters<VaultFiles['commit']>[0]) {
    this.admit(input.mirrorId, input.revision); const existing = this.saved.find(r => r.operationId === input.operationId); if (existing) { if (existing.kind !== 'save') throw new VaultError('operation_reused'); const { kind, ...value } = existing; return value; }
    const key = input.mirrorId + '/' + input.path; const old = this.notes.get(key);
    if (input.kind === 'create' ? old !== undefined : old === undefined || hash(old) !== input.expectedHash) throw new VaultError('conflict');
    this.notes.set(key, input.text); const result: SaveReceipt = { kind: 'save', operationId: input.operationId, mirrorId: input.mirrorId, path: input.path, at: '2026-01-01T00:00:02Z', outcome: 'saved_locally_pending_sync', hash: hash(input.text), previousHash: old === undefined ? null : hash(old) }; this.saved.push(result); const { kind, ...value } = result; return value;
  }
  async receipts(input: Parameters<VaultFiles['receipts']>[0]) { this.admit(input.mirrorId, input.revision); return this.saved.filter(r => r.mirrorId === input.mirrorId && (!input.operationId || r.operationId === input.operationId) && (!input.path || r.path === input.path)).slice(-input.limit); }
}
