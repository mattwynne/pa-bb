// Generated Linux regressions for recovery after incoming content moves again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NoteStore } from '../adapters/note-store.ts';
import { NoteOverlay } from '../adapters/note-overlay.ts';
const enabled = process.platform === 'linux';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const operationId = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
async function fixture(preservedPair = false) {
  const root = await mkdtemp('/tmp/icloud-conflict-recovery-generated-'), mirror = join(root, 'mirror');
  await mkdir(mirror); await writeFile(join(mirror, 'Note.md'), 'A');
  if (preservedPair) { await writeFile(join(mirror, 'Note.md.icloud-conflict1'), 'Historical remote'); await writeFile(join(mirror, 'Note.md.bb-conflict1'), 'A'); }
  const db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  const store = new NoteOverlay(join(root, 'overlay'), db, new NoteStore(join(root, 'legacy')));
  await store.start(); await store.indexLegacy('generated', mirror);
  await store.commit(mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'Local B' });
  await writeFile(join(mirror, 'Note.md'), 'Incoming C');
  assert.equal(await store.apply(mirror, 'generated', 'Note.md'), 'conflict');
  return { root, mirror, db, store, async close() { db.close(); await rm(root, { recursive: true, force: true }); } };
}
for (const choice of ['keep_local', 'replace'] as const) test(`${choice} retains the captured incoming version in accounted recovery after maintenance and restart`, { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const conflict = (await f.store.inspect('generated', 'Note.md'))!;
    await f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: conflict.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming C'), choice, ...(choice === 'replace' ? { text: 'Chosen D' } : {}) });
    for (let i = 0; i < 4; i++) await f.store.maintain(128);
    const retained = f.db.prepare("SELECT COUNT(*) AS count FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND mirror_id = ? AND hash = ?").get('generated', hash('Incoming C')) as { count: number };
    assert.ok(retained.count > 0, 'choosing local bytes must not discard the captured incoming bytes');
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});
for (const choice of ['keep_local', 'accept_incoming', 'replace'] as const) test(`${choice} rejects incoming content changed during the final awaited publication boundary`, { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const conflict = (await f.store.inspect('generated', 'Note.md'))!;
    const id = operationId();
    (f.store as any).fault = async (stage: string) => { if (stage === 'before_resolution_head') await writeFile(join(f.mirror, 'Note.md'), 'Incoming D'); };
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: id, token: conflict.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming C'), choice, ...(choice === 'replace' ? { text: 'Chosen E' } : {}) }), (error: any) => error.category === 'conflict');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Local B');
    assert.equal(f.db.prepare('SELECT operation_id FROM icloud_note_overlay_resolutions WHERE operation_id = ?').get(id), undefined);
  } finally { await f.close(); }
});
test('fresh conflict inspection can recover after incoming content changes again, without dropping the earlier captured bytes', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const first = (await f.store.inspect('generated', 'Note.md'))!;
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming D');
    // The optional owned root requests a fresh bounded observation. Metadata-only
    // internal inspection remains possible without reading a native path.
    const second = await (f.store.inspect as any)('generated', 'Note.md', f.mirror);
    assert.notEqual(second.token, first.token, 'fresh inspection must not strand the user on an unusable old token');
    assert.equal(second.incomingHash, hash('Incoming D'));
    assert.equal(await f.store.readIncoming('generated', 'Note.md', second.token), 'Incoming D');
    assert.deepEqual(await (f.store.inspect as any)('generated', 'Note.md', f.mirror), second, 'unchanged evidence must not churn tokens or archive references');
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: first.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming C'), choice: 'keep_local' }), (error: any) => error.category === 'conflict');
    const retained = f.db.prepare("SELECT COUNT(*) AS count FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND mirror_id = ? AND hash = ?").get('generated', hash('Incoming C')) as { count: number };
    assert.ok(retained.count > 0);
    const restarted = new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))); await restarted.start();
    assert.equal((await restarted.inspect('generated', 'Note.md'))?.token, second.token);
    assert.deepEqual(await restarted.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: second.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming D'), choice: 'accept_incoming' }), { outcome: 'adopted_content', hash: hash('Incoming D') });
    assert.equal((await restarted.read(f.mirror, 'generated', 'Note.md')).text, 'Incoming D');
  } finally { await f.close(); }
});

test('numbered incoming copy changes at the last boundary; preserved pairs remain distinct from a new pair', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const copy = join(f.mirror, 'Note.md.icloud-conflict1');
    await writeFile(copy, 'Numbered C'); await writeFile(join(f.mirror, 'Note.md.bb-conflict1'), 'A');
    const first = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    assert.equal(first.incomingHash, hash('Numbered C'));
    const id = operationId();
    (f.store as any).fault = async (stage: string) => { if (stage === 'before_resolution_head') await writeFile(copy, 'Numbered D'); };
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: id, token: first.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Numbered C'), choice: 'accept_incoming' }), (error: any) => error.category === 'conflict');
    assert.equal(f.db.prepare('SELECT 1 FROM icloud_note_overlay_resolutions WHERE operation_id = ?').get(id), undefined);
    (f.store as any).fault = undefined;
    const second = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    assert.equal(second.incomingHash, hash('Numbered D'));
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict2'), 'Numbered E');
    await writeFile(join(f.mirror, 'Note.md.bb-conflict2'), 'A');
    const third = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    assert.equal(third.incomingHash, hash('Numbered E'));
    assert.notEqual(third.token, second.token);
    const restarted = new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))); await restarted.start();
    assert.deepEqual(await restarted.inspect('generated', 'Note.md', f.mirror), third);
    await restarted.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: third.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Numbered E'), choice: 'accept_incoming' });
    assert.equal((await restarted.read(f.mirror, 'generated', 'Note.md')).text, 'Numbered E');
  } finally { await f.close(); }
});

test('a recreated canonical note supersedes a preserved numbered incoming copy without discarding either version', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await (await import('node:fs/promises')).unlink(join(f.mirror, 'Note.md'));
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict1'), 'Numbered C');
    await writeFile(join(f.mirror, 'Note.md.bb-conflict1'), 'A');
    const numbered = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    assert.equal(numbered.incomingHash, hash('Numbered C'));
    await writeFile(join(f.mirror, 'Note.md'), 'Later canonical D');
    const current = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    assert.notEqual(current.token, numbered.token);
    assert.equal(current.incomingHash, hash('Later canonical D'), 'a historical numbered copy must not hide a new canonical edit');
    assert.equal(await f.store.readIncoming('generated', 'Note.md', current.token), 'Later canonical D');
    assert.ok(f.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class='recovery' AND hash=?").get(hash('Numbered C')));
    await f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: current.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Later canonical D'), choice: 'accept_incoming' });
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Later canonical D');
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});

test('simultaneous new canonical and numbered incoming versions do not silently choose one', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await (await import('node:fs/promises')).unlink(join(f.mirror, 'Note.md'));
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict1'), 'Numbered C');
    await writeFile(join(f.mirror, 'Note.md.bb-conflict1'), 'A');
    const before = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    await writeFile(join(f.mirror, 'Note.md'), 'New canonical D');
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict2'), 'New numbered E');
    await writeFile(join(f.mirror, 'Note.md.bb-conflict2'), 'A');
    await assert.rejects(f.store.inspect('generated', 'Note.md', f.mirror), (error: any) => error.category === 'uncertain');
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.token, before.token);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Local B');
  } finally { await f.close(); }
});

test('incoming archives share one recovery charge per hash, including repeated captures and resolution', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    for (const content of ['Incoming D', 'Incoming C', 'Incoming D', 'Incoming C']) {
      await writeFile(join(f.mirror, 'Note.md'), content);
      await f.store.inspect('generated', 'Note.md', f.mirror);
    }
    const archived = f.db.prepare('SELECT hash FROM icloud_note_overlay_incoming_archive WHERE mirror_id = ?').all('generated') as Array<{ hash: string }>;
    assert.equal(archived.length, 4);
    const conflict = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    await f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: conflict.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming C'), choice: 'keep_local' });
    const actual = (f.db.prepare('SELECT recovery_bytes AS bytes FROM icloud_note_overlay_totals WHERE id=1').get() as { bytes: number }).bytes;
    const distinct = f.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (SELECT MAX(bytes) AS bytes FROM icloud_note_overlay_blob_refs WHERE class='recovery' GROUP BY hash)").get() as { bytes: number };
    assert.equal(actual, distinct.bytes);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number }).count, 5);
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});

test('archive capacity refuses refresh and resolution atomically before dropping live incoming', { skip: !enabled, timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    // Generated immutable, distinct <=1 MiB content; use the real reference
    // ledger rather than overwriting a quota counter.
    const payload = (i: number) => `${i.toString().padStart(6, '0')}${'x'.repeat(1024 * 1024 - 6)}`;
    for (let i = 0; i < 64; i++) {
      await writeFile(join(f.mirror, 'Note.md'), payload(i));
      await f.store.inspect('generated', 'Note.md', f.mirror);
    }
    const before = (await f.store.inspect('generated', 'Note.md'))!;
    const archiveCount = (f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number }).count;
    const resolutionId = operationId();
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: resolutionId, token: before.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: before.incomingHash, choice: 'keep_local' }), (error: any) => error.category === 'capacity');
    assert.equal(f.db.prepare('SELECT 1 FROM icloud_note_overlay_resolutions WHERE operation_id=?').get(resolutionId), undefined);
    await writeFile(join(f.mirror, 'Note.md'), payload(66));
    await assert.rejects(f.store.inspect('generated', 'Note.md', f.mirror), (error: any) => error.category === 'capacity');
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.token, before.token);
    assert.equal(await f.store.readIncoming('generated', 'Note.md', before.token), payload(63));
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number }).count, archiveCount);
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});

test('expired captured incoming references prune in bounded turns, while active incoming survives', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const first = (await f.store.inspect('generated', 'Note.md'))!;
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming D');
    const active = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    f.db.prepare('UPDATE icloud_note_overlay_incoming_archive SET captured_at = ? WHERE token = ?').run(Date.now() - 31 * 86400000, first.token);
    await f.store.maintain(128);
    assert.equal(f.db.prepare('SELECT 1 FROM icloud_note_overlay_incoming_archive WHERE token = ?').get(first.token), undefined);
    assert.equal((await f.store.inspect('generated', 'Note.md', f.mirror))?.token, active.token);
    assert.equal(await f.store.readIncoming('generated', 'Note.md', active.token), 'Incoming D');
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});

test('startup rejects corrupt archived evidence and refresh failure keeps safe diagnostics and original token', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const first = (await f.store.inspect('generated', 'Note.md'))!;
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming D');
    (f.store as any).fault = (stage: string) => { if (stage === 'before_blob_fsync') throw new Error('PRIVATE_SENTINEL_CREDENTIAL'); };
    await assert.rejects(f.store.inspect('generated', 'Note.md', f.mirror), (error: any) => error.category === 'unavailable' && !JSON.stringify(error).includes('PRIVATE_SENTINEL'));
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.token, first.token);
    (f.store as any).fault = undefined;
    await f.store.inspect('generated', 'Note.md', f.mirror);
    f.db.prepare('UPDATE icloud_note_overlay_incoming_archive SET bytes=bytes+1 WHERE token=?').run(first.token);
    await assert.rejects(new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start(), (error: any) => error.category === 'uncertain' && !JSON.stringify(error).includes('PRIVATE_SENTINEL'));
  } finally { await f.close(); }
});

test('expiring an archived identity cannot delete identical active head content', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const first = (await f.store.inspect('generated', 'Note.md'))!;
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming D');
    const next = (await f.store.inspect('generated', 'Note.md', f.mirror))!;
    await f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: operationId(), token: next.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming D'), choice: 'replace', text: 'Incoming C' });
    f.db.prepare('UPDATE icloud_note_overlay_incoming_archive SET captured_at = ? WHERE token = ?').run(Date.now() - 31 * 86400000, first.token);
    await f.store.maintain(128); await f.store.maintain(128);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Incoming C');
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});

test('historical remote copy prevents false incoming absence after canonical disappears', { skip: !enabled }, async () => {
  const f = await fixture(true);
  try {
    const original = (await f.store.inspect('generated', 'Note.md'))!;
    assert.equal(original.incomingHash, hash('Incoming C'));
    await (await import('node:fs/promises')).unlink(join(f.mirror, 'Note.md'));
    await assert.rejects(f.store.inspect('generated', 'Note.md', f.mirror), (error: any) => error.category === 'uncertain');
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.token, original.token);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number }).count, 0);
  } finally { await f.close(); }
});

test('archive-index failure cannot leak its private cause or partly resolve the conflict', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const conflict = (await f.store.inspect('generated', 'Note.md'))!;
    const id = operationId();
    const request = { operationId: id, token: conflict.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming C'), choice: 'keep_local' as const };
    f.db.exec("CREATE TRIGGER refuse_incoming_archive BEFORE INSERT ON icloud_note_overlay_incoming_archive BEGIN SELECT RAISE(FAIL, 'PRIVATE_SENTINEL_ARCHIVE'); END");
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', request), (error: any) => error.category === 'unavailable' && !JSON.stringify(error).includes('PRIVATE_SENTINEL'));
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.token, conflict.token);
    assert.equal(f.db.prepare('SELECT 1 FROM icloud_note_overlay_resolutions WHERE operation_id=?').get(id), undefined);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number }).count, 0);
    f.db.exec('DROP TRIGGER refuse_incoming_archive');
    await f.store.resolve(f.mirror, 'generated', 'Note.md', request);
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});
