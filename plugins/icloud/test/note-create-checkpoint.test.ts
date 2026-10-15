// Linux-only regression: exclusive create links an independent apply stage.
// Dropping that stage link must precede capture of the exact inode checkpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { NoteOverlay } from '../adapters/note-overlay.ts';
import { NoteStore } from '../adapters/note-store.ts';
const enabled = process.platform === 'linux';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const operationId = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
async function fixture() {
  const root = await mkdtemp('/tmp/icloud-create-checkpoint-generated-');
  const mirror = join(root, 'mirror'); await mkdir(mirror);
  const db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  const files = new NoteStore(join(root, 'legacy'));
  const overlay = new NoteOverlay(join(root, 'overlay'), db, files);
  await overlay.start(); await overlay.indexLegacy('generated', mirror);
  await overlay.commit(mirror, { operationId: operationId(), mirrorId: 'generated', path: 'New.md', kind: 'create', expectedHash: null, text: 'B' });
  assert.equal(await overlay.apply(mirror, 'generated', 'New.md'), 'applied');
  return { root, mirror, db, files, overlay, async close() { db.close(); await rm(root, { recursive: true, force: true }); } };
}
test('created note checkpoint matches its final inode before any native command', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const row = f.db.prepare('SELECT applied FROM icloud_note_overlay_heads').get() as { applied: string };
    const applied = JSON.parse(row.applied);
    const observed = (await f.files.observe(f.mirror, 'New.md'))!;
    assert.equal(observed.hash, applied.hash);
    assert.equal(observed.info.ino, applied.info.ino);
    assert.equal(observed.info.mtimeMs, applied.info.mtimeMs);
    assert.equal(observed.info.ctimeMs, applied.info.ctimeMs, 'stage cleanup must not invalidate the persisted checkpoint');
    assert.equal(await f.overlay.apply(f.mirror, 'generated', 'New.md'), 'idle');
  } finally { await f.close(); }
});
test('a successor to a newly created note applies without a fabricated conflict', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.overlay.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'New.md', kind: 'replace', expectedHash: sha('B'), text: 'C' });
    assert.equal(await f.overlay.apply(f.mirror, 'generated', 'New.md'), 'applied');
    assert.equal(await f.overlay.inspect('generated', 'New.md'), null);
    assert.equal((await f.files.observe(f.mirror, 'New.md'))!.hash, sha('C'));
  } finally { await f.close(); }
});
test('a created-note checkpoint can retire after eligible following-run evidence', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const eligible = f.overlay.beforeRun('generated');
    assert.equal(eligible.length, 1);
    assert.equal(await f.overlay.afterRun(f.mirror, 'generated', eligible, true), 1);
    assert.equal(await f.overlay.inspect('generated', 'New.md'), null);
  } finally { await f.close(); }
});
