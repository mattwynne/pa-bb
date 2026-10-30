import { claimFilingAccess } from './access-claims.mjs';
// Plugin-owned receipts; append the migration after every already-applied entry.
export const FILING_MIGRATION = `CREATE TABLE drive_filing_operations (
  operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, resource TEXT NOT NULL,
  state TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE UNIQUE INDEX drive_filing_active_resource ON drive_filing_operations(resource)
  WHERE state IN ('reviewing','writing','uncertain');`;
export function createFilingStore(db) {
  return {
    async get(id) {
      const row = db.prepare('SELECT state,receipt FROM drive_filing_operations WHERE operation_id = ?').get(id);
      return row ? { ...JSON.parse(row.receipt), state: row.state } : null;
    },
    async reserve(op) {
      return db.prepare('INSERT OR IGNORE INTO drive_filing_operations (operation_id,subject,resource,state,receipt) VALUES (?,?,?,?,?)')
        .run(op.operationId, op.subject, op.resource, op.state, JSON.stringify(op)).changes === 1;
    },
    async claim(op) {
      return claimFilingAccess(db, op.contextIds, () =>
        db.prepare("UPDATE OR IGNORE drive_filing_operations SET state = 'reviewing' WHERE operation_id = ? AND subject = ? AND state = 'proposed'")
          .run(op.operationId, op.subject).changes === 1);
    },
    async start(op) {
      return db.prepare("UPDATE drive_filing_operations SET state = 'writing',receipt = ? WHERE operation_id = ? AND subject = ? AND state = 'reviewing'")
        .run(JSON.stringify({ ...op, state: 'writing', writeAttempted: true }), op.operationId, op.subject).changes === 1;
    },
    async save(op) {
      if (db.prepare('UPDATE drive_filing_operations SET state = ?,receipt = ? WHERE operation_id = ? AND subject = ?')
        .run(op.state, JSON.stringify(op), op.operationId, op.subject).changes !== 1) throw new Error('Filing receipt unavailable');
    },
    async cancelReview(id) {
      db.prepare("UPDATE drive_filing_operations SET state = 'cancelled' WHERE operation_id = ? AND state = 'reviewing'").run(id);
    },
  };
}
