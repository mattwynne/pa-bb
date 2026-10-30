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
    return !conflict && claim();
  })();
}

export function claimFilingAccess(db, contextIds, claim) {
  return db.transaction(() => {
    const conflict = db.prepare(`SELECT 1 FROM drive_sharing_operations
      WHERE state IN ('reviewing','writing','uncertain')
      AND file_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(JSON.stringify(contextIds));
    return !conflict && claim();
  })();
}
