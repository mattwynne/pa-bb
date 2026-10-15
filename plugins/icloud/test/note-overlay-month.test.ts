// Opt-in month-equivalent storage workload on generated disposable Linux data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { NoteStore } from '../adapters/note-store.ts';
import { NoteOverlay } from '../adapters/note-overlay.ts';
const enabled = process.platform === 'linux' && process.env.ICLOUD_OVERLAY_MONTH === '1';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const op = (now: number) => { const time = now.toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)];
test('3000 settled edits retain compact identities without a 512-directory cliff and prune after expiry', { skip: !enabled, timeout: 240000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-overlay-month-generated-'); const mirror = join(root, 'mirror'); let db: Database.Database | undefined;
  try {
    await mkdir(mirror); await writeFile(join(mirror, 'Note.md'), 'A');
    db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    let now = Date.now(); const start = now; const store = new NoteOverlay(join(root, 'overlay'), db, new NoteStore(join(root, 'legacy')), () => now);
    await store.start(); await store.indexLegacy('generated', mirror);
    const durations: number[] = []; let previous = 'A'; let earliest = '';
    for (let i = 0; i < 3000; i++) {
      now = start + Math.floor(i * 29 * 86400000 / 3000);
      const next = `Generated-${i}\n`, id = op(now); if (!i) earliest = id;
      const at = performance.now(); const receipt = await store.commit(mirror, { operationId: id, mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: sha(previous), text: next }); durations.push(performance.now() - at);
      assert.equal(receipt.outcome, 'saved_locally_pending_sync');
      assert.equal(await store.apply(mirror, 'generated', 'Note.md'), 'applied');
      assert.equal(await store.afterRun(mirror, 'generated', store.beforeRun('generated'), true), 1);
      previous = next;
    }
    const rows = db.prepare('SELECT receipts, receipt_bytes, recovery_bytes FROM icloud_note_overlay_totals WHERE id = 1').get() as { receipts: number; receipt_bytes: number; recovery_bytes: number };
    assert.equal(rows.receipts, 3000); assert.ok(rows.recovery_bytes < 128000);
    assert.equal((await readdir(join(root, 'legacy'))).length, 0);
    const before = (await readdir(join(root, 'overlay', 'blobs'))).length;
    now = start + 61 * 86400000;
    for (let i = 0; i < 200; i++) {
      const result = await store.maintain(128);
      if (!result.generations && !result.receipts && !result.blobs && i > 50) break;
    }
    const after = db.prepare('SELECT receipts, recovery_bytes FROM icloud_note_overlay_totals WHERE id = 1').get() as { receipts: number; recovery_bytes: number };
    assert.equal(after.receipts, 0); assert.equal(after.recovery_bytes, 0);
    assert.ok((await readdir(join(root, 'overlay', 'blobs'))).length < before);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_generations').get() as { count: number }).count, 0);
    await assert.rejects(store.commit(mirror, { operationId: earliest, mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: sha('A'), text: 'Generated-0\n' }), (error: any) => error.category === 'operation_expired');
    await new NoteOverlay(join(root, 'overlay'), db, new NoteStore(join(root, 'legacy')), () => now).start();
    console.log(JSON.stringify({ fixture: 'month-equivalent', edits: 3000, receiptsBefore: rows.receipts, receiptBytesBefore: rows.receipt_bytes, recoveryBytesBefore: rows.recovery_bytes, blobsBefore: before, blobsAfter: (await readdir(join(root, 'overlay', 'blobs'))).length, p50LocalMs: Math.round(percentile(durations, .5)), p95LocalMs: Math.round(percentile(durations, .95)), maxLocalMs: Math.round(Math.max(...durations)) }));
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});
