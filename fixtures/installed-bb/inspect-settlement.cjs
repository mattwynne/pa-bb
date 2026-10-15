// Read-only diagnostic of an EXPLICIT disposable scoped SQLite database.
// Requires BB_FIXTURE_DATABASE and BB_FIXTURE_SQLITE from the generated fixture.
const assert = require('node:assert/strict');
const { realpathSync } = require('node:fs');
const dbPath = process.env.BB_FIXTURE_DATABASE;
assert.ok(dbPath?.startsWith('/tmp/') && dbPath.endsWith('.db'));
const Database = require(realpathSync(process.env.BB_FIXTURE_SQLITE));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT mirror_id, path, hash, applied, conflict FROM icloud_note_overlay_heads ORDER BY mirror_id, path').all();
const result = rows.map(row => {
  const applied = row.applied && JSON.parse(row.applied);
  const conflict = row.conflict && JSON.parse(row.conflict);
  const a = applied?.info, b = conflict?.canonical?.info;
  return { mirror: row.mirror_id, path: row.path, conflict: Boolean(conflict), sameAppliedIncomingHash: applied?.hash === conflict?.incomingHash, activeHeadMatchesApplied: row.hash === applied?.hash,
    sameInode: Boolean(a && b && a.dev === b.dev && a.ino === b.ino), sameSizeAndMtime: Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs),
    ctimeChanged: Boolean(a && b && a.ctimeMs !== b.ctimeMs), numberedCopies: conflict?.incomingCopyNumber !== null && conflict?.incomingCopyNumber !== undefined };
});
const runs = db.prepare('SELECT body FROM icloud_sync_runs ORDER BY sequence').all().map(({ body }) => {
  const { sequence, startedAt, finishedAt, durationMs, outcome } = JSON.parse(body);
  return { sequence, startedAt, finishedAt, durationMs, outcome };
});
console.log(JSON.stringify({ count: rows.length, spurious: result.filter(row => row.conflict && row.sameAppliedIncomingHash && row.sameInode && row.sameSizeAndMtime && row.ctimeChanged && !row.numberedCopies).length, runs, rows: result }, null, 2));
