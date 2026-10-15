import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NoteStore } from '../adapters/note-store.ts';
import { NoteOverlay } from '../adapters/note-overlay.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const operationId = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
const enabled = process.platform === 'linux';
async function fixture(clock = Date.now) {
  const root = await mkdtemp('/tmp/icloud-overlay-generated-');
  const mirror = join(root, 'mirror'); await mkdir(mirror);
  await writeFile(join(mirror, 'Note.md'), 'A');
  const db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  const files = new NoteStore(join(root, 'legacy'));
  const store = new NoteOverlay(join(root, 'overlay'), db, files, clock);
  await store.start(); await store.indexLegacy('generated', mirror);
  return { root, mirror, db, store, async close() { db.close(); await rm(root, { recursive: true, force: true }); } };
}
test('indexed legacy operation IDs deduplicate before current CAS after later edits', { skip: !enabled }, async () => {
  const root = await mkdtemp('/tmp/icloud-overlay-legacy-generated-'), mirror = join(root, 'mirror');
  let db: Database.Database | undefined;
  try {
    await mkdir(mirror); await writeFile(join(mirror, 'Note.md'), 'A');
    const legacy = new NoteStore(join(root, 'legacy'));
    const old = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const receipt = await legacy.commit(mirror, old, new AbortController().signal);
    db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    const store = new NoteOverlay(join(root, 'overlay'), db, legacy); await store.start();
    await assert.rejects(store.commit(mirror, { ...old, operationId: operationId(), expectedHash: hash('B'), text: 'C' }), (error: any) => error.category === 'uncertain');
    await store.indexLegacy('generated', mirror);
    assert.equal((db.prepare('SELECT recovery_bytes AS bytes FROM icloud_note_overlay_totals WHERE id = 1').get() as { bytes: number }).bytes, Buffer.byteLength('A'));
    await store.commit(mirror, { ...old, operationId: operationId(), expectedHash: hash('B'), text: 'C' });
    assert.deepEqual(await store.commit(mirror, old), receipt);
    await assert.rejects(store.commit(mirror, { ...old, text: 'changed' }), (error: any) => error.category === 'operation_reused');
    assert.equal((await store.read(mirror, 'generated', 'Note.md')).text, 'C');
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});
test('generation IDs never reset and superseded bytes have an explicit historical state', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const first = operationId(), second = operationId(), third = operationId();
    await f.store.commit(f.mirror, { operationId: first, mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.commit(f.mirror, { operationId: second, mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('B'), text: 'C' });
    const before = f.db.prepare('SELECT generation_id, parent_generation, state, superseded_by FROM icloud_note_overlay_generations ORDER BY generation_id').all() as any[];
    assert.equal(before.length, 2); assert.equal(before[0].state, 'superseded'); assert.equal(before[0].superseded_by, before[1].generation_id);
    assert.equal(before[1].parent_generation, before[0].generation_id);
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    await f.store.afterRun(f.mirror, 'generated', f.store.beforeRun('generated'), true);
    await f.store.commit(f.mirror, { operationId: third, mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('C'), text: 'D' });
    const after = f.db.prepare('SELECT generation_id, parent_generation, state FROM icloud_note_overlay_generations ORDER BY generation_id').all() as any[];
    assert.ok(after[2].generation_id > after[1].generation_id); assert.equal(after[2].parent_generation, null); assert.equal(after[1].state, 'retired');
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
  } finally { await f.close(); }
});
test('cancellation after immutable publication leaves no receipt and bounded GC never removes a newly reserved hash', { skip: !enabled }, async () => {
  const f = await fixture(); const signal = new AbortController();
  try {
    const cancelling = new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy')), Date.now, async stage => { if (stage === 'after_blob_parent_fsync') signal.abort(); });
    const first = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await assert.rejects(cancelling.commit(f.mirror, first, signal.signal), (e: any) => e.category === 'cancelled');
    assert.equal(await f.store.receipt(first.operationId), null);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'A');
    assert.equal((f.db.prepare('SELECT recovery_bytes AS bytes FROM icloud_note_overlay_totals WHERE id = 1').get() as { bytes: number }).bytes, 0);
    const second = { ...first, operationId: operationId() };
    const saved = await f.store.commit(f.mirror, second);
    await f.store.maintain();
    assert.deepEqual(await f.store.receipt(second.operationId), saved);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(hash('B')) as { count: number }).count, 1);
  } finally { await f.close(); }
});
test('expired intermediate history does not grow indefinitely behind a protected checkpoint and pending successor', { skip: !enabled }, async () => {
  let now = Date.now(); const f = await fixture(() => now);
  try {
    const b = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await f.store.commit(f.mirror, b); await f.store.apply(f.mirror, 'generated', 'Note.md');
    const c = { ...b, operationId: operationId(), expectedHash: hash('B'), text: 'C' };
    await f.store.commit(f.mirror, c);
    const d = { ...b, operationId: operationId(), expectedHash: hash('C'), text: 'D' };
    const pending = await f.store.commit(f.mirror, d);
    now += 31 * 86400000;
    for (let i = 0; i < 8; i++) await f.store.maintain(128);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_generations').get() as { count: number }).count, 2);
    assert.equal(await f.store.receipt(c.operationId), null);
    assert.ok(await f.store.receipt(b.operationId));
    assert.deepEqual(await f.store.receipt(d.operationId), pending);
    const restarted = new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy')), () => now);
    await restarted.start();
    assert.equal((await restarted.read(f.mirror, 'generated', 'Note.md')).text, 'D');
    await assert.rejects(restarted.commit(f.mirror, c), (error: any) => error.category === 'operation_expired');
    assert.equal(await restarted.apply(f.mirror, 'generated', 'Note.md'), 'applied');
    assert.equal(await restarted.afterRun(f.mirror, 'generated', restarted.beforeRun('generated'), true), 1);
    now += 60001;
    for (let i = 0; i < 8; i++) await restarted.maintain(128);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_generations').get() as { count: number }).count, 0);
    assert.equal((await restarted.read(f.mirror, 'generated', 'Note.md')).text, 'D');
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy')), () => now).start();
  } finally { await f.close(); }
});
test('bounded maintenance keeps pending IDs and prunes only expired definite retired generations', { skip: !enabled }, async () => {
  let now = Date.now(); const f = await fixture(() => now);
  try {
    const first = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const receipt = await f.store.commit(f.mirror, first);
    await f.store.apply(f.mirror, 'generated', 'Note.md'); await f.store.afterRun(f.mirror, 'generated', f.store.beforeRun('generated'), true);
    const second = { ...first, operationId: operationId(), expectedHash: hash('B'), text: 'C' };
    const pending = await f.store.commit(f.mirror, second);
    now += 31 * 86400000;
    for (let i = 0; i < 12; i++) await f.store.maintain(128);
    assert.equal(await f.store.receipt(first.operationId), null);
    assert.deepEqual(await f.store.commit(f.mirror, second), pending);
    assert.deepEqual(await f.store.receipt(second.operationId), pending);
    await assert.rejects(f.store.commit(f.mirror, first), (e: any) => e.category === 'operation_expired');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'C');
    const restarted = new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy')), () => now);
    await restarted.start(); assert.equal((await restarted.read(f.mirror, 'generated', 'Note.md')).text, 'C');
    assert.ok((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_generations').get() as { count: number }).count >= 1);
    assert.notDeepEqual(receipt.operationId, pending.operationId);
  } finally { await f.close(); }
});
test('A → B → C uses the owned B checkpoint, and a following run retires C', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const b = await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    assert.equal(b.outcome, 'saved_locally_pending_sync');
    assert.equal(await readFile(join(f.mirror, 'Note.md'), 'utf8'), 'A');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    assert.equal(await readFile(join(f.mirror, 'Note.md'), 'utf8'), 'B');
    const c = await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('B'), text: 'C' });
    assert.equal(c.previousHash, hash('B'));
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const run = f.store.beforeRun('generated');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', run, true), 1);
    await writeFile(join(f.mirror, 'Note.md'), 'Remote D');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Remote D');
    assert.equal((await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('Remote D'), text: 'E' })).previousHash, hash('Remote D'));
    assert.deepEqual(await f.store.receipt(b.operationId), b);
  } finally { await f.close(); }
});
test('a successor committed during the eligible native run cannot borrow its retirement', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md'); const run = f.store.beforeRun('generated');
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('B'), text: 'C' });
    assert.equal(await f.store.afterRun(f.mirror, 'generated', run, true), 0);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'C');
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', f.store.beforeRun('generated'), true), 1);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'C');
  } finally { await f.close(); }
});
test('collision retains incoming and sound local head; duplicate before CAS is immutable', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const receipt = await f.store.commit(f.mirror, input);
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming');
    assert.equal(await f.store.apply(f.mirror, 'generated', 'Note.md'), 'conflict');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
    const collision = await f.store.inspect('generated', 'Note.md');
    assert.equal(collision?.incomingHash, hash('Incoming'));
    assert.equal(await f.store.readIncoming('generated', 'Note.md', collision!.token), 'Incoming');
    assert.deepEqual(await f.store.commit(f.mirror, input), receipt);
    await assert.rejects(f.store.commit(f.mirror, { ...input, text: 'Changed' }), (e: any) => e.category === 'operation_reused');
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { token: 'stale', expectedLogicalHash: hash('B'), expectedIncomingHash: hash('Incoming'), choice: 'keep_local', operationId: operationId() }), (e: any) => e.category === 'conflict');
    await f.store.resolve(f.mirror, 'generated', 'Note.md', { token: collision!.token, expectedLogicalHash: hash('B'), expectedIncomingHash: hash('Incoming'), choice: 'keep_local', operationId: operationId() });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    assert.equal(await readFile(join(f.mirror, 'Note.md'), 'utf8'), 'B');
  } finally { await f.close(); }
});
async function killed(f: Awaited<ReturnType<typeof fixture>>, stage: string, command: string) {
  const module = new URL('../adapters/note-overlay.ts', import.meta.url).href;
  const notes = new URL('../adapters/note-store.ts', import.meta.url).href;
  const code = `import Database from 'better-sqlite3'; import { NoteOverlay } from ${JSON.stringify(module)}; import { NoteStore } from ${JSON.stringify(notes)};
    const db = new Database(${JSON.stringify(join(f.root, 'index.db'))}); db.pragma('synchronous = FULL');
    const fault = at => { if (at === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL'); };
    const store = new NoteOverlay(${JSON.stringify(join(f.root, 'overlay'))}, db, new NoteStore(${JSON.stringify(join(f.root, 'legacy'))}, { fault }), () => Date.now(), fault);
    await store.start(); ${command}`;
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  const result = await new Promise<string | null>((resolve, reject) => { child.on('error', reject); child.on('exit', (_code, signal) => resolve(signal)); });
  assert.equal(result, 'SIGKILL');
}
for (const stage of ['before_blob_fsync', 'after_blob_fsync', 'after_blob_parent_fsync', 'before_head', 'after_head']) test(`SIGKILL ${stage}: pointer and immutable receipt agree`, { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await killed(f, stage, `await store.commit(${JSON.stringify(f.mirror)}, ${JSON.stringify(input)});`);
    await f.store.start();
    const prior = await f.store.receipt(input.operationId);
    assert.equal(prior === null, stage !== 'after_head');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, prior ? 'B' : 'A');
    const replay = await f.store.commit(f.mirror, input);
    assert.equal(replay.outcome, 'saved_locally_pending_sync');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
  } finally { await f.close(); }
});
for (const stage of ['before_apply_stage_fsync', 'after_apply_stage_fsync', 'after_apply_journal', 'before_mirror_publish', 'after_mirror_rename', 'before_destination_dirsync', 'after_destination_dirsync', 'after_mirror_publish', 'after_apply_checkpoint']) test(`SIGKILL ${stage}: independent blob and apply journal recover`, { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await f.store.commit(f.mirror, input);
    await killed(f, stage, `await store.apply(${JSON.stringify(f.mirror)}, 'generated', 'Note.md');`);
    await f.store.start();
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
    assert.deepEqual(await f.store.receipt(input.operationId), await f.store.commit(f.mirror, input));
    const result = await f.store.apply(f.mirror, 'generated', 'Note.md');
    assert.ok(['applied', 'idle'].includes(result));
    assert.equal(await readFile(join(f.mirror, 'Note.md'), 'utf8'), 'B');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
  } finally { await f.close(); }
});
for (const stage of ['before_retirement', 'after_retirement']) test(`SIGKILL ${stage}: no stale overlay after eligible run`, { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const receipt = await f.store.commit(f.mirror, input); await f.store.apply(f.mirror, 'generated', 'Note.md');
    const eligible = f.store.beforeRun('generated');
    await killed(f, stage, `await store.afterRun(${JSON.stringify(f.mirror)}, 'generated', ${JSON.stringify(eligible)}, true);`);
    await f.store.start();
    assert.deepEqual(await f.store.receipt(input.operationId), receipt);
    if (stage === 'before_retirement') assert.equal(await f.store.afterRun(f.mirror, 'generated', eligible, true), 1);
    await writeFile(join(f.mirror, 'Note.md'), 'Remote C');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Remote C');
  } finally { await f.close(); }
});
test('incoming absence can be explicitly adopted without a cloud delete', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await f.store.commit(f.mirror, input); await (await import('node:fs/promises')).unlink(join(f.mirror, 'Note.md'));
    assert.equal(await f.store.apply(f.mirror, 'generated', 'Note.md'), 'conflict');
    const collision = (await f.store.inspect('generated', 'Note.md'))!;
    assert.equal(collision.incomingAbsent, true);
    assert.equal(await f.store.readIncoming('generated', 'Note.md', collision.token), null);
    const resolution = { token: collision.token, expectedLogicalHash: hash('B'), expectedIncomingHash: null, choice: 'accept_incoming' as const, operationId: operationId() };
    assert.deepEqual(await f.store.resolve(f.mirror, 'generated', 'Note.md', resolution), { outcome: 'adopted_absence', hash: null });
    assert.deepEqual(await f.store.resolve(f.mirror, 'generated', 'Note.md', resolution), { outcome: 'adopted_absence', hash: null });
    await assert.rejects(f.store.read(f.mirror, 'generated', 'Note.md'), (e: any) => e.category === 'unavailable');
    assert.deepEqual(await f.store.receipt(input.operationId), await f.store.commit(f.mirror, input));
  } finally { await f.close(); }
});
test('independent immutable blob survives mirror inode application', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const logical = await f.store.read(f.mirror, 'generated', 'Note.md');
    assert.equal(logical.text, 'B');
    await writeFile(join(f.mirror, 'Note.md'), 'Mutated mirror');
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
    assert.notEqual((await stat(join(f.mirror, 'Note.md'))).ino, (await stat(join(f.root, 'overlay', 'blobs', logical.hash))).ino);
  } finally { await f.close(); }
});
test('same-content simultaneous publications cannot mistake the temporary hard-link for corrupt immutable content', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    let entered!: () => void, release!: () => void;
    const atParent = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const db = f.db;
    const store = new NoteOverlay(join(f.root, 'overlay'), db, new NoteStore(join(f.root, 'legacy')), Date.now, async stage => { if (stage === 'after_blob_parent_fsync') { entered(); await blocked; } });
    await store.start();
    const first = store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'First.md', kind: 'create', expectedHash: null, text: 'same content' });
    await atParent;
    const second = store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Second.md', kind: 'create', expectedHash: null, text: 'same content' });
    release();
    assert.deepEqual((await Promise.all([first, second])).map(r => r.outcome), ['saved_locally_pending_sync', 'saved_locally_pending_sync']);
  } finally { await f.close(); }
});
test('failed native run with changed canonical bytes retains a guarded conflict instead of retirement', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const run = f.store.beforeRun('generated'); await writeFile(join(f.mirror, 'Note.md'), 'Remote C');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', run, false), 0);
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.incomingHash, hash('Remote C'));
  } finally { await f.close(); }
});
test('startup refuses a missing head reference or mismatched durable quota counter', { skip: !enabled }, async () => {
  for (const corruption of ['head_reference', 'quota_counter']) {
    const f = await fixture();
    try {
      await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
      if (corruption === 'head_reference') f.db.prepare("DELETE FROM icloud_note_overlay_blob_refs WHERE kind = 'head'").run();
      else f.db.prepare("UPDATE icloud_note_overlay_usage SET bytes = bytes + 1 WHERE scope = '*'").run();
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start(), (error: any) => error.category === 'uncertain');
    } finally { await f.close(); }
  }
});
test('corrupt persisted proof is uncertain before new admission', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    f.db.prepare('UPDATE icloud_note_overlay_heads SET base = ?').run(JSON.stringify({ hash: hash('A'), info: { dev: 'not-a-number' } }));
    await assert.rejects(new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start(), (error: any) => error.category === 'uncertain');
  } finally { await f.close(); }
});
test('a following run that changes the canonical file exposes a resolvable conflict', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const eligible = f.store.beforeRun('generated');
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming C');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', eligible, true), 0);
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.incomingHash, hash('Incoming C'));
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'B');
  } finally { await f.close(); }
});
test('post-run collision detection also applies when a successor was saved during the run', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const eligible = f.store.beforeRun('generated');
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('B'), text: 'Local C' });
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming D');
    await f.store.afterRun(f.mirror, 'generated', eligible, true);
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.incomingHash, hash('Incoming D'));
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Local C');
  } finally { await f.close(); }
});
test('native renamed conflict copies cannot be reported as incoming absence', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const eligible = f.store.beforeRun('generated');
    await (await import('node:fs/promises')).rename(join(f.mirror, 'Note.md'), join(f.mirror, 'Note.md.bb-conflict1'));
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict1'), 'Remote C');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', eligible, true), 0);
    const collision = (await f.store.inspect('generated', 'Note.md'))!;
    assert.equal(collision.incomingAbsent, false);
    assert.equal(collision.incomingHash, hash('Remote C'));
    assert.equal(await f.store.readIncoming('generated', 'Note.md', collision.token), 'Remote C');
  } finally { await f.close(); }
});
test('historical conflict copies do not hide the new incoming version from a later run', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.mirror, 'Note.md.bb-conflict1'), 'Historical local');
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict1'), 'Historical remote');
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const eligible = f.store.beforeRun('generated');
    await (await import('node:fs/promises')).rename(join(f.mirror, 'Note.md'), join(f.mirror, 'Note.md.bb-conflict2'));
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict2'), 'Incoming C');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', eligible, true), 0);
    const collision = (await f.store.inspect('generated', 'Note.md'))!;
    assert.equal(collision.incomingHash, hash('Incoming C'));
    assert.equal(await f.store.readIncoming('generated', 'Note.md', collision.token), 'Incoming C');
    assert.equal(await readFile(join(f.mirror, 'Note.md.icloud-conflict1'), 'utf8'), 'Historical remote');
  } finally { await f.close(); }
});
test('adopt a captured renamed remote copy without silently handing off to an absent canonical path', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md'); const run = f.store.beforeRun('generated');
    await (await import('node:fs/promises')).rename(join(f.mirror, 'Note.md'), join(f.mirror, 'Note.md.bb-conflict1'));
    await writeFile(join(f.mirror, 'Note.md.icloud-conflict1'), 'Remote C');
    await f.store.afterRun(f.mirror, 'generated', run, true);
    const collision = (await f.store.inspect('generated', 'Note.md'))!;
    assert.deepEqual(await f.store.resolve(f.mirror, 'generated', 'Note.md', { token: collision.token, expectedLogicalHash: hash('B'), expectedIncomingHash: hash('Remote C'), choice: 'accept_incoming', operationId: operationId() }), { outcome: 'adopted_content', hash: hash('Remote C') });
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Remote C');
    assert.equal(await f.store.apply(f.mirror, 'generated', 'Note.md'), 'applied');
    assert.equal(await readFile(join(f.mirror, 'Note.md'), 'utf8'), 'Remote C');
  } finally { await f.close(); }
});
test('a save operation ID cannot be reused for conflict resolution', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const input = { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await f.store.commit(f.mirror, input);
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming');
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const collision = (await f.store.inspect('generated', 'Note.md'))!;
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: input.operationId, token: collision.token, expectedLogicalHash: hash('B'), expectedIncomingHash: hash('Incoming'), choice: 'keep_local' }), (error: any) => error.category === 'operation_reused');
  } finally { await f.close(); }
});
test('a previously unseen expired resolution ID cannot admit a new change', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming');
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const collision = (await f.store.inspect('generated', 'Note.md'))!;
    const time = (Date.now() - 31 * 86400000).toString(16).padStart(12, '0');
    const expired = `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
    await assert.rejects(f.store.resolve(f.mirror, 'generated', 'Note.md', { operationId: expired, token: collision.token, expectedLogicalHash: hash('B'), expectedIncomingHash: hash('Incoming'), choice: 'keep_local' }), (error: any) => error.category === 'operation_expired');
  } finally { await f.close(); }
});
test('UTF-8 paths keep exact receipt-byte accounting across restart', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Café.md', kind: 'create', expectedHash: null, text: 'generated' });
    await new NoteOverlay(join(f.root, 'overlay'), f.db, new NoteStore(join(f.root, 'legacy'))).start();
    assert.equal((await f.store.read(f.mirror, 'generated', 'Café.md')).text, 'generated');
  } finally { await f.close(); }
});
test('shared immutable bytes count once globally and once per vault in pending and recovery quotas', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const second = join(f.root, 'other'); await mkdir(second); await f.store.indexLegacy('other', second);
    const content = 'x'.repeat(1024 * 1024);
    for (const [mirrorId, root, path] of [['generated', f.mirror, 'First.md'], ['generated', f.mirror, 'Second.md'], ['other', second, 'Third.md']] as const) {
      await f.store.commit(root, { operationId: operationId(), mirrorId, path, kind: 'create', expectedHash: null, text: content });
    }
    const usage = f.db.prepare('SELECT scope, bytes FROM icloud_note_overlay_usage ORDER BY scope').all() as Array<{ scope: string; bytes: number }>;
    assert.deepEqual(usage.map(row => row.bytes), [content.length, content.length, content.length]);
    const recovery = f.db.prepare('SELECT recovery_bytes AS bytes FROM icloud_note_overlay_totals WHERE id = 1').get() as { bytes: number };
    assert.equal(recovery.bytes, content.length);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM icloud_note_overlay_blob_refs WHERE class = 'recovery'").get() as { count: number }).count, 3);
  } finally { await f.close(); }
});
test('a successor saved before native invocation cannot retire on its predecessor checkpoint', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    const bRun = f.store.beforeRun('generated');
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('B'), text: 'Unapplied local C' });
    const nextRun = f.store.beforeRun('generated');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', nextRun, true), 0);
    assert.equal(nextRun[0].generation, bRun[0].generation);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Unapplied local C');
    assert.equal(await readFile(join(f.mirror, 'Note.md'), 'utf8'), 'B');
    assert.equal(await f.store.apply(f.mirror, 'generated', 'Note.md'), 'applied');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', f.store.beforeRun('generated'), true), 1);
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Unapplied local C');
  } finally { await f.close(); }
});
test('an applied checkpoint remains observable when its successor predates the next native run', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    await f.store.apply(f.mirror, 'generated', 'Note.md');
    await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('B'), text: 'Local C' });
    const eligible = f.store.beforeRun('generated');
    assert.equal(eligible.length, 1);
    await writeFile(join(f.mirror, 'Note.md'), 'Incoming D');
    assert.equal(await f.store.afterRun(f.mirror, 'generated', eligible, true), 0);
    assert.equal((await f.store.inspect('generated', 'Note.md'))?.incomingHash, hash('Incoming D'));
    assert.equal((await f.store.read(f.mirror, 'generated', 'Note.md')).text, 'Local C');
  } finally { await f.close(); }
});
test('concurrent reuse of an operation ID for different paths is operation_reused, not a storage failure', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    const id = operationId();
    const results = await Promise.allSettled(['One', 'Two'].map(name => f.store.commit(f.mirror, { operationId: id, mirrorId: 'generated', path: `${name}.md`, kind: 'create', expectedHash: null, text: name })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.category, 'operation_reused');
    const accepted = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<NoteOverlay['commit']>>>;
    assert.deepEqual(await f.store.receipt(id), accepted.value);
  } finally { await f.close(); }
});
test('concurrent different-path saves cannot oversubscribe the per-vault path limit', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 127; i++) await f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: `Existing-${i}.md`, kind: 'create', expectedHash: null, text: 'B' });
    const results = await Promise.allSettled(['One', 'Two'].map(name => f.store.commit(f.mirror, { operationId: operationId(), mirrorId: 'generated', path: `${name}.md`, kind: 'create', expectedHash: null, text: name })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.category, 'capacity');
  } finally { await f.close(); }
});
