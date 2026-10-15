// Read-only exact-hash comparison after this disposable host and native
// children have fully exited. The caller supplies explicit generated paths.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const base = process.env.BB_FIXTURE_ROOT, dbPath = process.env.BB_FIXTURE_DATABASE;
assert.ok(base?.startsWith('/tmp/pa-installed-bb-') && dbPath?.startsWith(base + '/'));
const Database = require(process.env.BB_FIXTURE_SQLITE);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const sha = path => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const results = [];
for (const row of db.prepare("select mirror_id,path,hash from icloud_note_overlay_heads where path like 'Work-%.md' order by mirror_id,path").all()) {
  const alias = sha(join(base, 'alias', row.mirror_id === 'one' ? 'generated' : 'other', row.path));
  const mirror = sha(join(dirname(dbPath), 'sync/mirrors', row.mirror_id, row.path));
  results.push({ mirror: row.mirror_id, path: row.path, logicalEqualsAlias: row.hash === alias, logicalEqualsMirror: row.hash === mirror, aliasPresent: alias !== null, mirrorPresent: mirror !== null });
}
console.log(JSON.stringify({ paths: results.length, logicalEqualsAlias: results.filter(row => row.logicalEqualsAlias).length, logicalEqualsMirror: results.filter(row => row.logicalEqualsMirror).length, rows: results }, null, 2));
