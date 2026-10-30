// Append this migration to the existing plugin migration list at integration.
// Do not call BB migrate independently with a second migration history.
export const SHEETS_EDIT_MIGRATION = `CREATE TABLE drive_sheets_edits (
  operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, spreadsheet_id TEXT NOT NULL,
  state TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE UNIQUE INDEX drive_sheets_edit_active ON drive_sheets_edits(spreadsheet_id)
  WHERE state IN ('reviewing','writing','uncertain');`;
export function createSheetsEditStore(db) {
  return {
    async get(id) {
      const r = db.prepare('SELECT state,receipt FROM drive_sheets_edits WHERE operation_id=?').get(id);
      return r ? { ...JSON.parse(r.receipt), state: r.state } : null;
    },
    async reserve(op) {
      return db.prepare('INSERT OR IGNORE INTO drive_sheets_edits (operation_id,subject,spreadsheet_id,state,receipt) VALUES (?,?,?,?,?)')
        .run(op.operationId, op.subject, op.spreadsheetId, op.state, JSON.stringify(op)).changes === 1;
    },
    async active(spreadsheetId) {
      return db.prepare("SELECT operation_id FROM drive_sheets_edits WHERE spreadsheet_id=? AND state IN ('reviewing','writing','uncertain')").get(spreadsheetId)?.operation_id || null;
    },
    async claim(id, spreadsheetId) {
      return db.prepare("UPDATE OR IGNORE drive_sheets_edits SET state='reviewing' WHERE operation_id=? AND spreadsheet_id=? AND state='proposed'").run(id, spreadsheetId).changes === 1;
    },
    async start(op) {
      return db.prepare("UPDATE drive_sheets_edits SET state='writing',receipt=? WHERE operation_id=? AND subject=? AND state='reviewing'")
        .run(JSON.stringify(op), op.operationId, op.subject).changes === 1;
    },
    async save(op) {
      if (db.prepare('UPDATE drive_sheets_edits SET state=?,receipt=? WHERE operation_id=? AND subject=?')
        .run(op.state, JSON.stringify(op), op.operationId, op.subject).changes !== 1) throw new Error('Sheets receipt unavailable');
    },
  };
}
