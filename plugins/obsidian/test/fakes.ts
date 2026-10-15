import { createHash } from 'node:crypto';
import { VaultError } from '../core/ports.ts';
import type { Configuration, MirrorCatalog, Catalog, VaultFiles, StateRepository, Receipt, SaveReceipt, ConflictInspection, Resolution } from '../core/ports.ts';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class MemoryState implements StateRepository { value: Configuration = { revision: 0, vaultIds: [] }; async load() { return structuredClone(this.value); } async save(value: Configuration) { this.value = structuredClone(value); } }
export class CatalogFake implements MirrorCatalog {
  value: Catalog = { setup: 'ready', nextAction: null, connected: true, compatible: true, sources: ['one', 'two'].map(id => ({ id, name: 'Launch', initialized: true, enabled: true, cloudConnected: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00Z', failure: null, local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } })) };
  async snapshot() { const value = structuredClone(this.value); value.sources.forEach(source => { source.cloudConnected = value.connected; }); return value; }
}
export class FilesFake implements VaultFiles {
  configuration: Configuration = { revision: -1, vaultIds: [] }; notes = new Map<string, string>(); saved: Receipt[] = []; conflicts = new Map<string, { inspection: ConflictInspection; incoming: string | null }>();
  constructor() { for (const id of ['one', 'two']) this.notes.set(`${id}/Launch.md`, '# Launch\r\n- [ ] Ship\r\n[[Other]]\r\n'); this.notes.set('one/Other.md', '# Other\nSource evidence\n'); }
  async configure(value: Configuration) { this.configuration = structuredClone(value); }
  private admit(id: string, revision: number) { if (this.configuration.revision !== revision || !this.configuration.vaultIds.includes(id)) throw new VaultError('not_connected'); }
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
