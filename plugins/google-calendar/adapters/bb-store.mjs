// A plugin-owned SQLite store. BB owns its persistent data.db and backup lifecycle.
// Only the backend opens it; neither tokens nor pending PKCE verifiers reach RPC/UI.
export function createBbStore(db, migrate) {
  migrate(db, [
    `CREATE TABLE IF NOT EXISTS calendar_accounts (
      subject TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      refresh_token TEXT NOT NULL, access_token TEXT, expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS calendar_pending (
      state_hash TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      client_id TEXT NOT NULL, expires_at INTEGER NOT NULL
    );`,
  ]);
  const row = item => item && ({ subject: item.subject, email: item.email, refreshToken: item.refresh_token, accessToken: item.access_token, expiresAt: item.expires_at });
  return {
    async accounts() { return db.prepare('SELECT * FROM calendar_accounts ORDER BY email').all().map(row); },
    async byEmail(email) { return row(db.prepare('SELECT * FROM calendar_accounts WHERE email = ? COLLATE NOCASE').get(email)); },
    async bySubject(subject) { return row(db.prepare('SELECT * FROM calendar_accounts WHERE subject = ?').get(subject)); },
    async addAccount(record) {
      if (db.prepare('SELECT 1 FROM calendar_accounts WHERE subject = ? OR email = ? COLLATE NOCASE').get(record.subject, record.email)) throw new Error('Google account is already connected');
      db.prepare('INSERT INTO calendar_accounts (subject,email,refresh_token,access_token,expires_at) VALUES (?,?,?,?,?)').run(record.subject, record.email, record.refreshToken, record.accessToken, record.expiresAt || null);
    },
    async removeAccount(subject) { return db.prepare('DELETE FROM calendar_accounts WHERE subject = ?').run(subject).changes > 0; },
    async updateEmail(subject, email) { return db.prepare('UPDATE calendar_accounts SET email = ? WHERE subject = ?').run(email, subject).changes > 0; },
    async mergeToken(subject, oldRefreshToken, update) {
      return db.prepare(`UPDATE calendar_accounts SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token)
        WHERE subject = ? AND refresh_token = ?`).run(update.accessToken, update.expiresAt || null, update.refreshToken || null, subject, oldRefreshToken).changes > 0;
    },
    async savePending(grant) {
      db.prepare('DELETE FROM calendar_pending WHERE expires_at <= ?').run(Date.now());
      db.prepare('INSERT INTO calendar_pending (state_hash,verifier,redirect_uri,client_id,expires_at) VALUES (?,?,?,?,?)').run(grant.stateHash, grant.verifier, grant.redirectUri, grant.clientId, grant.expiresAt);
    },
    async consumePending(hash) {
      return db.transaction(() => {
        const r = db.prepare('SELECT * FROM calendar_pending WHERE state_hash = ?').get(hash);
        if (r) db.prepare('DELETE FROM calendar_pending WHERE state_hash = ?').run(hash);
        return r ? { stateHash: r.state_hash, verifier: r.verifier, redirectUri: r.redirect_uri, clientId: r.client_id, expiresAt: r.expires_at } : null;
      })();
    },
  };
}
