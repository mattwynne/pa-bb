// Append-only plugin migration. Active claims survive reload/crash; no unlock API.
export const DOCS_IMAGE_MIGRATION = `CREATE TABLE docs_image_operations (
  operation_id TEXT PRIMARY KEY, subject TEXT NOT NULL, document_id TEXT NOT NULL,
  state TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE UNIQUE INDEX docs_image_active_document ON docs_image_operations(document_id)
  WHERE state IN ('reviewing','writing','uncertain');`;
export function createDocsImageStore(db) {
  return {
    async get(id) { const r = db.prepare('SELECT state,receipt FROM docs_image_operations WHERE operation_id = ?').get(id); return r ? { ...JSON.parse(r.receipt), state: r.state } : null; },
    async active(documentId) { return db.prepare("SELECT operation_id FROM docs_image_operations WHERE document_id = ? AND state IN ('reviewing','writing','uncertain')").get(documentId)?.operation_id || null; },
    async reserve(op) { return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM drive_formatting_operations WHERE operation_id = ?').get(op.operationId)) return false;
      return db.prepare('INSERT OR IGNORE INTO docs_image_operations(operation_id,subject,document_id,state,receipt) VALUES (?,?,?,?,?)').run(op.operationId, op.subject, op.documentId, op.state, JSON.stringify(op)).changes === 1;
    })(); },
    async claim(op) { return db.transaction(() => {
      if (db.prepare("SELECT 1 FROM drive_formatting_operations WHERE document_id = ? AND state IN ('reviewing','writing','uncertain')").get(op.documentId)) return false;
      return db.prepare("UPDATE OR IGNORE docs_image_operations SET state='reviewing' WHERE operation_id=? AND subject=? AND document_id=? AND state='proposed'").run(op.operationId, op.subject, op.documentId).changes === 1;
    })(); },
    async writing(op) { return !!db.prepare("SELECT 1 FROM docs_image_operations WHERE operation_id=? AND subject=? AND document_id=? AND state='writing'").get(op.operationId, op.subject, op.documentId); },
    async start(op) { return db.prepare("UPDATE docs_image_operations SET state='writing',receipt=? WHERE operation_id=? AND subject=? AND state='reviewing'").run(JSON.stringify({ ...op, state: 'writing' }), op.operationId, op.subject).changes === 1; },
    async update(op) { if (db.prepare('UPDATE docs_image_operations SET state=?,receipt=? WHERE operation_id=? AND subject=?').run(op.state, JSON.stringify(op), op.operationId, op.subject).changes !== 1) throw new Error('Image receipt unavailable'); },
  };
}
