// Sharing changes an item's audience; filing relies on the reviewed audience of
// every inspected ancestor. Acquire both workflows' claims in one SQLite
// transaction, not a read/check followed by a separately scheduled claim.
// These local claims cannot exclude changes from other Google clients.
export function claimSharingAccess(db, fileId, claim) {
  return db.transaction(() => {
    const conflict = db.prepare(`SELECT 1 FROM drive_filing_operations AS op,
      json_each(op.receipt, '$.contextIds') AS context
      WHERE op.state IN ('reviewing','writing','uncertain') AND context.value = ?
      LIMIT 1`).get(fileId);
    const creating = db.prepare(`SELECT 1 FROM docs_creations AS op, json_each(op.receipt, '$.contextIds') AS context
      WHERE json_extract(op.receipt, '$.claimState') IN ('reviewing','writing','uncertain') AND context.value = ? LIMIT 1`).get(fileId);
    return !conflict && !creating && claim();
  })();
}

export function claimFilingAccess(db, op, claim) {
  return db.transaction(() => {
    const conflict = db.prepare(`SELECT 1 FROM drive_sharing_operations
      WHERE state IN ('reviewing','writing','uncertain')
      AND file_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(JSON.stringify(op.contextIds));
    // A move mutates its file, not its ancestors. Folder creation has no
    // existing file to mutate. Shared ancestry alone is read/read overlap.
    const fileId = op.resource?.startsWith('file:') ? op.resource.slice(5) : null;
    const creating = fileId && db.prepare(`SELECT 1 FROM docs_creations AS op
      WHERE json_extract(op.receipt, '$.claimState') IN ('reviewing','writing','uncertain')
      AND COALESCE(json_extract(op.receipt, '$.documentId'), json_extract(op.receipt, '$.spreadsheetId'), json_extract(op.receipt, '$.fileId')) = ? LIMIT 1`).get(fileId);
    return !conflict && !creating && claim();
  })();
}

export function claimCreationAccess(db, op, claim) {
  return db.transaction(() => {
    const ids = JSON.stringify(op.contextIds);
    const sharing = db.prepare(`SELECT 1 FROM drive_sharing_operations WHERE state IN ('reviewing','writing','uncertain')
      AND file_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(ids);
    const fileId = op.documentId || op.spreadsheetId || op.fileId;
    const filing = fileId && db.prepare(`SELECT 1 FROM drive_filing_operations
      WHERE state IN ('reviewing','writing','uncertain') AND resource = ? LIMIT 1`).get(`file:${fileId}`);
    const creating = fileId && db.prepare(`SELECT 1 FROM docs_creations AS op
      WHERE json_extract(op.receipt, '$.claimState') IN ('reviewing','writing','uncertain') AND op.operation_id <> ?
      AND COALESCE(json_extract(op.receipt, '$.documentId'), json_extract(op.receipt, '$.spreadsheetId'), json_extract(op.receipt, '$.fileId')) = ? LIMIT 1`).get(op.operationId, fileId);
    const uploading = op.kind === 'upload' && db.prepare(`SELECT 1 FROM docs_creations AS current
      WHERE current.operation_id <> ? AND json_extract(current.receipt, '$.kind') = 'upload'
      AND json_extract(current.receipt, '$.claimState') IN ('reviewing','writing','uncertain')
      AND json_extract(current.receipt, '$.resource') = ? LIMIT 1`).get(op.operationId, op.resource);
    return !sharing && !filing && !creating && !uploading && claim();
  })();
}
