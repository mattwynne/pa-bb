// Plugin-owned data only. Tokens never leave this adapter through account lists.
export function createBbStore(db, migrate) {
  migrate(db, [`CREATE TABLE workspace_accounts (subject TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, record TEXT NOT NULL);
    CREATE TABLE workspace_pending (state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL);`]);
  const record = row => row ? JSON.parse(row.record) : undefined;
  return {
    async accounts() { return db.prepare('SELECT record FROM workspace_accounts ORDER BY email').all().map(record); },
    async byEmail(email) { return record(db.prepare('SELECT record FROM workspace_accounts WHERE email = ? COLLATE NOCASE').get(email)); },
    async bySubject(subject) { return record(db.prepare('SELECT record FROM workspace_accounts WHERE subject = ?').get(subject)); },
    async saveAccount(value) {
      db.prepare('INSERT INTO workspace_accounts (subject,email,record) VALUES (?,?,?) ON CONFLICT(subject) DO UPDATE SET email=excluded.email,record=excluded.record')
        .run(value.subject, value.email, JSON.stringify(value));
    },
    async removeAccount(subject) { return db.prepare('DELETE FROM workspace_accounts WHERE subject=?').run(subject).changes > 0; },
    async savePending(value) {
      db.prepare('DELETE FROM workspace_pending WHERE expires_at <= ?').run(value.expiresAt - 300_000);
      db.prepare('INSERT INTO workspace_pending VALUES (?,?,?)').run(value.stateHash, value.expiresAt, JSON.stringify(value));
    },
    async consumePending(hash) {
      return db.transaction(() => {
        const value = record(db.prepare('SELECT record FROM workspace_pending WHERE state_hash=?').get(hash));
        db.prepare('DELETE FROM workspace_pending WHERE state_hash=?').run(hash);
        return value;
      })();
    },
  };
}
