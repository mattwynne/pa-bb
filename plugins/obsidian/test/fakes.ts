import { createHash } from 'node:crypto';
import { VaultError } from '../core/ports.ts';
import type { Configuration, MirrorCatalog, Catalog, VaultFiles, StateRepository, Receipt } from '../core/ports.ts';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class MemoryState implements StateRepository { value: Configuration = { revision: 0, vaultIds: [] }; async load() { return structuredClone(this.value); } async save(value: Configuration) { this.value = structuredClone(value); } }
export class CatalogFake implements MirrorCatalog {
  value: Catalog = { setup: 'ready', nextAction: null, connected: true, sources: ['one', 'two'].map(id => ({ id, name: 'Launch', initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00Z', failure: null })) };
  async snapshot() { return structuredClone(this.value); }
}
export class FilesFake implements VaultFiles {
  configuration: Configuration = { revision: -1, vaultIds: [] }; notes = new Map<string, string>(); saved: Receipt[] = [];
  constructor() { for (const id of ['one', 'two']) this.notes.set(`${id}/Launch.md`, '# Launch\r\n- [ ] Ship\r\n[[Other]]\r\n'); this.notes.set('one/Other.md', '# Other\nSource evidence\n'); }
  async configure(value: Configuration) { this.configuration = structuredClone(value); }
  private admit(id: string, revision: number) { if (this.configuration.revision !== revision || !this.configuration.vaultIds.includes(id)) throw new VaultError('not_connected'); }
  async list(id: string, revision: number) { this.admit(id, revision); return { paths: [...this.notes.keys()].filter(k => k.startsWith(id + '/')).map(k => k.slice(id.length + 1)), incomplete: false, warnings: [] }; }
  async read(id: string, revision: number, path: string) { this.admit(id, revision); const text = this.notes.get(`${id}/${path}`); if (text === undefined) throw new VaultError('unavailable'); return { text, hash: hash(text), readAt: '2026-01-01T00:00:01Z', complete: true as const }; }
  async commit(input: Parameters<VaultFiles['commit']>[0]) {
    this.admit(input.mirrorId, input.revision); const existing = this.saved.find(r => r.operationId === input.operationId); if (existing) return existing;
    const key = input.mirrorId + '/' + input.path; const old = this.notes.get(key);
    if (input.kind === 'create' ? old !== undefined : old === undefined || hash(old) !== input.expectedHash) throw new VaultError('conflict');
    this.notes.set(key, input.text); const result: Receipt = { operationId: input.operationId, mirrorId: input.mirrorId, path: input.path, at: '2026-01-01T00:00:02Z', outcome: 'saved_locally_pending_sync', hash: hash(input.text), previousHash: old === undefined ? null : hash(old) }; this.saved.push(result); return result;
  }
  async receipts(input: Parameters<VaultFiles['receipts']>[0]) { this.admit(input.mirrorId, input.revision); return this.saved.filter(r => r.mirrorId === input.mirrorId && (!input.operationId || r.operationId === input.operationId) && (!input.path || r.path === input.path)).slice(-input.limit); }
}
