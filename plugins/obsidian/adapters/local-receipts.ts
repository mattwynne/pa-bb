import { z } from 'zod';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { VaultError } from '../core/ports.ts';

const identity = z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = {
  operationId: z.string().uuid(),
  mirrorId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  path: z.string().min(1).max(1024),
  at: z.string().datetime(),
  hash,
  root: identity,
  inode: identity,
};
const versionIdentity = identity.extend({ birthtime: z.number().finite() });
const record = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('save'), previousHash: hash.nullable(), previousIdentity: versionIdentity.optional(), birthtime: z.number().finite().optional(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']) }).strict(),
  z.object({ ...base, kind: z.literal('move'), destination: base.path, birthtime: z.number().finite().optional(),
    directory: z.literal(true).optional(),
    tree: z.object({ from: base.path, to: base.path, inode: identity, fingerprint: hash }).strict().optional(), outcome: z.enum(['moved_locally_pending_sync', 'not_moved', 'uncertain']) }).strict(),
  z.object({ ...base, kind: z.literal('resolution'), choice: z.enum(['keep_local', 'accept_incoming', 'replace']), outcome: z.enum(['saved_locally_pending_sync', 'adopted_content', 'not_saved', 'uncertain']) }).strict(),
]);
export type LocalReceipt = z.infer<typeof record>;
export type FileIdentity = z.infer<typeof identity>;
export const fileIdentity = ({ dev, ino }: FileIdentity): FileIdentity => ({ dev, ino });

const ledger = z.array(record).max(512);
const retention = 30 * 86400_000;
const maxBytes = 256 * 1024;

// Only operation metadata lives here. The mirror directory owns all note bytes.
export class LocalReceipts {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private kv: BbPluginApi['storage']['kv']) {}

  run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new VaultError('cancelled'));
    let cancel = () => {};
    const task = this.queue.then(() => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) throw new VaultError('cancelled');
      return action();
    });
    this.queue = task.catch(() => {});
    if (!signal) return task;
    // Once admitted, the writer owns cancellation and its outcome.
    return new Promise<T>((resolve, reject) => {
      cancel = () => reject(new VaultError('cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      task.then(resolve, reject);
    });
  }

  async load(): Promise<LocalReceipt[]> {
    try {
      return ledger.parse(await this.kv.get('filesystem-note-receipts') ?? []);
    } catch { throw new VaultError('unavailable', 'Check Obsidian operation receipt storage.'); }
  }

  private async save(rows: LocalReceipt[]) {
    try {
      await this.kv.set('filesystem-note-receipts', ledger.parse(rows));
    } catch { throw new VaultError('uncertain', 'Inspect the exact operation receipt before making another change.'); }
  }

  async begin(row: LocalReceipt, paths: string[]) {
    const rows = await this.load();
    if (rows.some(r => r.operationId === row.operationId)) throw new VaultError('operation_reused');
    this.assertNoOverlap(rows, row.mirrorId, paths);
    const retained = rows.filter(r => r.outcome === 'uncertain' || Date.now() - Date.parse(r.at) < retention);
    const next = [...retained, row];
    if (next.length > 512 || Buffer.byteLength(JSON.stringify(next)) > maxBytes - 1024) {
      throw new VaultError('capacity', 'Local operation receipt storage is full. Inspect unresolved operations.');
    }
    await this.save(next);
  }

  assertNoOverlap(rows: LocalReceipt[], mirrorId: string, paths: string[]) {
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    if (rows.some(r => r.mirrorId === mirrorId && r.outcome === 'uncertain' &&
      [r.path, ...(r.kind === 'move' ? [r.destination, ...(r.tree ? [r.tree.from, r.tree.to] : [])] : [])]
        .some(previous => paths.some(path => overlaps(path, previous))))) {
      throw new VaultError('uncertain', 'Inspect the unresolved local operation before changing these notes.');
    }
  }

  async finish(row: LocalReceipt) {
    const rows = await this.load();
    if (!rows.some(r => r.operationId === row.operationId)) throw new VaultError('uncertain');
    await this.save(rows.map(r => r.operationId === row.operationId ? row : r));
  }
}
