import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { captureSummary, storedCaptureSchema, type CaptureStore, type StoredCapture } from './bank-rec.ts';
import { XeroError } from './diagnostic.ts';
function safe<T>(action: () => T): T {
  try { return action(); } catch { throw new XeroError('storage', 'bank_rec_store', 'Could not confirm local snapshot storage. No recovery data was cleared automatically. Refresh the list before retrying.'); }
}
export function createCaptureStore(db: ReturnType<BbPluginApi['storage']['database']>): CaptureStore {
  const get = (tenantId: string, id: string) => safe(() => {
    const row = db.prepare('SELECT value FROM xero_bank_rec_captures WHERE tenant_id=? AND id=?').get(tenantId, id) as { value: string } | undefined;
    return row ? storedCaptureSchema.parse(JSON.parse(row.value)) : null;
  });
  return {
    get,
    put(value: StoredCapture) { return safe(() => {
      const s = value.summary;
      db.prepare('INSERT OR IGNORE INTO xero_bank_rec_captures (id,tenant_id,account_id,captured_at,imported_at,summary,value) VALUES (?,?,?,?,?,?,?)')
        .run(s.id, s.tenantId, s.accountId, s.capturedAt, s.importedAt, JSON.stringify(s), JSON.stringify(value));
      return get(s.tenantId, s.id)!;
    }); },
    list(tenantId, accountId, page = 1) { return safe(() => {
      const where = accountId ? 'tenant_id=? AND account_id=?' : 'tenant_id=?', args = accountId ? [tenantId, accountId] : [tenantId];
      return db.transaction(() => {
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM xero_bank_rec_captures WHERE ${where}`).get(...args) as { n: number }).n;
        const rows = db.prepare(`SELECT summary FROM xero_bank_rec_captures WHERE ${where} ORDER BY captured_at DESC,imported_at DESC,id LIMIT 20 OFFSET ?`).all(...args, (page - 1) * 20) as { summary: string }[];
        return { total, captures: rows.map(row => captureSummary.parse(JSON.parse(row.summary))) };
      })();
    }); },
    remove(tenantId, id) { return safe(() => db.prepare('DELETE FROM xero_bank_rec_captures WHERE tenant_id=? AND id=?').run(tenantId, id).changes > 0); },
  };
}
