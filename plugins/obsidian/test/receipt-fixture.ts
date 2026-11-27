import Database from 'better-sqlite3';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { FilesystemVault } from '../adapters/filesystem-vault.ts';
import { LocalReceipts, type LocalReceipt } from '../adapters/local-receipts.ts';

const legacyKey = 'filesystem-note-receipts';
export function receiptsFixture(root: string, dbPath: string, legacy?: unknown, applied?: (row: LocalReceipt) => void) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const storage: BbPluginApi['storage'] = {
    kv: {
      async get(key) { if (key === legacyKey) return legacy as never; },
      async set() { throw new Error('Unexpected legacy write'); },
      async delete() { throw new Error('Unexpected legacy delete'); },
      async list() { return []; },
    },
    database: () => db,
    migrate(db, statements) {
      // The host owns schema migrations. This fixture just reopens the same DB
      // after SIGKILL, including when its child is the first process to open it.
      db.transaction(() => {
        if (db.pragma('user_version', { simple: true }) === 1) return;
        statements.forEach(statement => db.exec(statement));
        db.pragma('user_version = 1');
      }).immediate();
    },
  };
  const ledger = new LocalReceipts(storage);
  const fs = new FilesystemVault(async () => root, async () => { throw new Error('Unexpected Desktop grant'); }, ledger, () => {}, applied);
  return { db, ledger, fs };
}
