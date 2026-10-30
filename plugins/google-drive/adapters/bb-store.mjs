// A plugin-owned SQLite store. BB owns its persistent data.db and backup lifecycle.
// Only the backend opens it; neither tokens nor pending PKCE verifiers reach RPC/UI.
import { createSheetsEditStore, SHEETS_EDIT_MIGRATION } from './sheets-edit-store.mjs';
import { createFilingStore, FILING_MIGRATION } from './filing-store.mjs';
export function createBbStore(db, migrate) {
  migrate(db, [
    `CREATE TABLE IF NOT EXISTS drive_accounts (
      subject TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS drive_pending (
      state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      client_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );`,
    'ALTER TABLE drive_pending ADD COLUMN reconnect TEXT;',
    `CREATE TABLE IF NOT EXISTS docs_creations (
      operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, receipt TEXT NOT NULL
    );`,
    `CREATE TABLE drive_sharing_operations (
      operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, file_id TEXT NOT NULL,
      state TEXT NOT NULL, receipt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX drive_sharing_active_file ON drive_sharing_operations(file_id)
      WHERE state IN ('reviewing','writing','uncertain');`,
    `CREATE TABLE drive_formatting_operations (
      operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, document_id TEXT NOT NULL,
      state TEXT NOT NULL, receipt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX drive_formatting_active_document ON drive_formatting_operations(document_id)
      WHERE state IN ('reviewing','writing','uncertain');`,
    SHEETS_EDIT_MIGRATION,
    FILING_MIGRATION,
  ]);
  const row = item => item && ({ subject: item.subject, email: item.email, refreshToken: item.refresh_token, accessToken: item.access_token, expiresAt: item.expires_at });
  return {
    sheetsEdits: createSheetsEditStore(db),
    filing: createFilingStore(db),
    async getFormatting(operationId) {
      const r = db.prepare('SELECT state,receipt FROM drive_formatting_operations WHERE operation_id = ?').get(operationId);
      return r ? { ...JSON.parse(r.receipt), state: r.state } : null;
    },
    async reserveFormatting(op) {
      return db.prepare('INSERT OR IGNORE INTO drive_formatting_operations (operation_id,subject,document_id,state,receipt) VALUES (?,?,?,?,?)')
        .run(op.operationId, op.subject, op.documentId, op.state, JSON.stringify(op)).changes === 1;
    },
    async activeFormatting(documentId) {
      return db.prepare("SELECT operation_id FROM drive_formatting_operations WHERE document_id = ? AND state IN ('reviewing','writing','uncertain')").get(documentId)?.operation_id || null;
    },
    async claimFormatting(operationId, documentId) {
      return db.prepare("UPDATE OR IGNORE drive_formatting_operations SET state = 'reviewing' WHERE operation_id = ? AND document_id = ? AND state = 'proposed'")
        .run(operationId, documentId).changes === 1;
    },
    async startFormattingWrite(op) {
      return db.prepare("UPDATE drive_formatting_operations SET state = 'writing',receipt = ? WHERE operation_id = ? AND subject = ? AND state = 'reviewing'")
        .run(JSON.stringify({ ...op, state: 'writing' }), op.operationId, op.subject).changes === 1;
    },
    async updateFormatting(op) {
      if (db.prepare('UPDATE drive_formatting_operations SET state = ?,receipt = ? WHERE operation_id = ? AND subject = ?')
        .run(op.state, JSON.stringify(op), op.operationId, op.subject).changes !== 1) throw new Error('Formatting receipt unavailable');
    },
    async getSharing(operationId) {
      const row = db.prepare('SELECT state,receipt FROM drive_sharing_operations WHERE operation_id = ?').get(operationId);
      return row ? { ...JSON.parse(row.receipt), state: row.state } : null;
    },
    async reserveSharing(op) {
      return db.prepare('INSERT OR IGNORE INTO drive_sharing_operations (operation_id,subject,file_id,state,receipt) VALUES (?,?,?,?,?)')
        .run(op.operationId, op.subject, op.fileId, op.state, JSON.stringify(op)).changes === 1;
    },
    async activeSharing(fileId) {
      return db.prepare("SELECT operation_id FROM drive_sharing_operations WHERE file_id = ? AND state IN ('reviewing','writing','uncertain')").get(fileId)?.operation_id || null;
    },
    async claimSharing(operationId, fileId) {
      return db.prepare("UPDATE OR IGNORE drive_sharing_operations SET state = 'reviewing' WHERE operation_id = ? AND file_id = ? AND state = 'proposed'")
        .run(operationId, fileId).changes === 1;
    },
    async startSharingWrite(op) {
      return db.prepare("UPDATE drive_sharing_operations SET state = 'writing', receipt = ? WHERE operation_id = ? AND subject = ? AND state = 'reviewing'")
        .run(JSON.stringify({ ...op, state: 'writing' }), op.operationId, op.subject).changes === 1;
    },
    async cancelSharingReview(operationId) {
      return db.prepare("UPDATE drive_sharing_operations SET state = 'cancelled' WHERE operation_id = ? AND state = 'reviewing'").run(operationId).changes === 1;
    },
    async updateSharing(op) {
      if (db.prepare('UPDATE drive_sharing_operations SET state = ?,receipt = ? WHERE operation_id = ? AND subject = ?')
        .run(op.state, JSON.stringify(op), op.operationId, op.subject).changes !== 1) throw new Error('Sharing receipt unavailable');
    },
    async getCreation(operationId) {
      const item = db.prepare('SELECT receipt FROM docs_creations WHERE operation_id = ?').get(operationId);
      return item ? JSON.parse(item.receipt) : null;
    },
    async reserveCreation(op) {
      return db.prepare('INSERT OR IGNORE INTO docs_creations (operation_id,subject,receipt) VALUES (?,?,?)')
        .run(op.operationId, op.subject, JSON.stringify(op)).changes === 1;
    },
    async updateCreation(op) {
      if (db.prepare('UPDATE docs_creations SET receipt = ? WHERE operation_id = ? AND subject = ?')
        .run(JSON.stringify(op), op.operationId, op.subject).changes !== 1) throw new Error('Creation receipt unavailable');
    },
    async accounts() { return db.prepare('SELECT * FROM drive_accounts ORDER BY email').all().map(row); },
    async byEmail(email) { return row(db.prepare('SELECT * FROM drive_accounts WHERE email = ? COLLATE NOCASE').get(email)); },
    async bySubject(subject) { return row(db.prepare('SELECT * FROM drive_accounts WHERE subject = ?').get(subject)); },
    async addAccount(record) {
      if (db.prepare('SELECT 1 FROM drive_accounts WHERE subject = ? OR email = ? COLLATE NOCASE').get(record.subject, record.email)) throw new Error('Google account is already connected');
      db.prepare('INSERT INTO drive_accounts (subject,email,refresh_token,access_token,expires_at) VALUES (?,?,?,?,?)').run(record.subject, record.email, record.refreshToken, record.accessToken, record.expiresAt || null);
    },
    async replaceAccount(record, previousRefreshToken) {
      return db.prepare(`UPDATE drive_accounts SET email = ?, refresh_token = ?, access_token = ?, expires_at = ?
        WHERE subject = ? AND refresh_token = ?`).run(record.email, record.refreshToken, record.accessToken,
          record.expiresAt || null, record.subject, previousRefreshToken).changes > 0;
    },
    async removeAccount(subject) { return db.prepare('DELETE FROM drive_accounts WHERE subject = ?').run(subject).changes > 0; },
    async updateEmail(subject, email) { return db.prepare('UPDATE drive_accounts SET email = ? WHERE subject = ?').run(email, subject).changes > 0; },
    async mergeToken(subject, oldRefreshToken, update) {
      return db.prepare(`UPDATE drive_accounts SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token)
        WHERE subject = ? AND refresh_token = ?`).run(update.accessToken, update.expiresAt || null, update.refreshToken || null, subject, oldRefreshToken).changes > 0;
    },
    async savePending(grant) {
      db.prepare('DELETE FROM drive_pending WHERE expires_at <= ?').run(Date.now());
      db.prepare('INSERT INTO drive_pending (state_hash,verifier,redirect_uri,client_id,expires_at,reconnect) VALUES (?,?,?,?,?,?)').run(grant.stateHash, grant.verifier, grant.redirectUri, grant.clientId, grant.expiresAt, grant.reconnect ? JSON.stringify(grant.reconnect) : null);
    },
    async consumePending(hash) {
      return db.transaction(() => {
        const r = db.prepare('SELECT * FROM drive_pending WHERE state_hash = ?').get(hash);
        if (r) db.prepare('DELETE FROM drive_pending WHERE state_hash = ?').run(hash);
        return r ? { stateHash: r.state_hash, verifier: r.verifier, redirectUri: r.redirect_uri, clientId: r.client_id, expiresAt: r.expires_at, reconnect: r.reconnect ? JSON.parse(r.reconnect) : null } : null;
      })();
    },
  };
}
