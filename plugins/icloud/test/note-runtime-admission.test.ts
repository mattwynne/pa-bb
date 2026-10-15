// Opt-in local generated Linux fixtures. These exercise the actual flock/RC
// arbiter and scoped SQLite, not a mock overlay with imaginary ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
import type { State } from '../core/ports.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_RUNTIME_NATIVE === '1';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const op = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(count = 2) {
  const root = await mkdtemp('/tmp/icloud-runtime-admission-generated-'), workerRoot = join(root, 'sync'), remote = join(root, 'alias');
  const db = new Database(join(root, 'data.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  const state: State = { connected: true, challenge: null, mirrors: [] };
  let preparer: RcloneProcess | undefined, runtime: NoteRuntime | undefined;
  const worker = () => new RcloneProcess(workerRoot, process.env.RCLONE_TEST_BINARY!);
  const create = () => new NoteRuntime(workerRoot, db, worker(), new NoteStore(join(workerRoot, 'legacy')), () => state);
  try {
    await mkdir(remote); preparer = worker(); await preparer.ensure();
    await preparer.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote }, opt: { nonInteractive: true } });
    for (let i = 0; i < count; i++) {
      const id = `mirror-${i}`, folder = `generated-${i}`;
      const source = join(remote, folder), local = join(workerRoot, 'mirrors', id), baseline = join(workerRoot, 'baselines', id);
      await mkdir(source); await writeFile(join(source, 'Note.md'), 'A'); await mkdir(local); await mkdir(baseline);
      await preparer.run(syncArguments(`icloud:${folder}`, local, baseline, true));
      await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
      state.mirrors.push({ id, folder: { id: Buffer.from(folder).toString('base64url'), name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: new Date().toISOString(), failure: null, blocker: null });
    }
    await preparer.stop(); preparer = undefined;
    runtime = create(); await runtime.start(); runtime.configure(1, state.mirrors.map(m => m.id));
    return { root, workerRoot, remote, state, db, get runtime() { return runtime!; }, create,
      replace(next: NoteRuntime) { runtime = next; },
      async close() { await runtime?.stop(); db.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await runtime?.stop(); await preparer?.stop(); db.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
test('durable admission revokes a save inside its pointer transaction after fsync; restart keeps revision', { skip: !enabled, timeout: 25000 }, async () => {
  const f = await fixture(2); let release = () => {};
  try {
    const gate = deferred(); release = gate.release; let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    (f.runtime.overlay as any).fault = async (stage: string) => { if (stage === 'before_head') { enter(); await gate.promise; } };
    const input = { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const pending = f.runtime.commit(1, input); await entered;
    assert.deepEqual(f.runtime.configure(2, ['mirror-1']), { revision: 2 });
    await assert.rejects(f.runtime.receipts('mirror-0', 1, { mirrorId: 'mirror-0', operationId: input.operationId, limit: 20 }), (e: any) => e.category === 'invalid_selection');
    release(); await assert.rejects(pending, (e: any) => e.category === 'invalid_selection');
    assert.equal(await f.runtime.overlay.receipt(input.operationId), null);
    assert.equal((await readFile(join(f.workerRoot, 'mirrors/mirror-0/Note.md'), 'utf8')), 'A');
    assert.deepEqual(f.runtime.configure(3, ['mirror-0', 'mirror-1']), { revision: 3 });
    (f.runtime.overlay as any).fault = undefined;
    const saved = await f.runtime.commit(3, input); assert.equal(saved.hash, hash('B'));
    assert.deepEqual((await f.runtime.access('mirror-1', 3, () => f.runtime.overlay.receipts({ mirrorId: 'mirror-1', operationId: input.operationId, limit: 20 }))), []);
    assert.equal((await f.runtime.access('mirror-0', 3, () => f.runtime.overlay.receipts({ mirrorId: 'mirror-0', operationId: input.operationId, limit: 20 })))[0].hash, hash('B'));
    await f.runtime.stop(); const restarted = f.create(); await restarted.start(); f.replace(restarted);
    assert.throws(() => restarted.configure(2, ['mirror-0']), (e: any) => e.category === 'invalid_selection');
    assert.throws(() => restarted.configure(3, ['mirror-0']), (e: any) => e.category === 'invalid_selection');
    assert.equal((await restarted.read('mirror-0', 3, 'Note.md') as any).text, 'B');
  } finally { release(); await f.close(); }
});
for (const stage of ['before_head', 'after_head'] as const) test(`dispose fences ${stage} and takeover preserves the precise logical result`, { skip: !enabled, timeout: 25000 }, async () => {
  const f = await fixture(1); let release = () => {};
  try {
    const gate = deferred(); release = gate.release; let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    (f.runtime.overlay as any).fault = async (point: string) => { if (point === stage) { enter(); await gate.promise; } };
    const input = { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const pending = f.runtime.commit(1, input); await entered;
    let stopped = false; const stopping = f.runtime.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false, 'owner keeps flock until entered publication settles');
    const challenger = new RcloneProcess(f.workerRoot, process.env.RCLONE_TEST_BINARY!);
    await assert.rejects(challenger.ensure(), (e: any) => e.category === 'busy'); await challenger.stop();
    release();
    if (stage === 'before_head') await assert.rejects(pending, (e: any) => e.category === 'invalid_selection');
    else assert.equal((await pending).hash, hash('B'));
    await stopping;
    const next = f.create(); await next.start(); f.replace(next);
    assert.equal((await next.read('mirror-0', 1, 'Note.md') as any).text, stage === 'after_head' ? 'B' : 'A');
    assert.equal((await next.receipts('mirror-0', 1, { mirrorId: 'mirror-0', operationId: input.operationId, limit: 20 })).length, stage === 'after_head' ? 1 : 0);
  } finally { release(); await f.close(); }
});
test('failed durable configuration transaction does not advance in-memory admission', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(1);
  try {
    f.db.exec("CREATE TRIGGER fail_configuration BEFORE UPDATE ON icloud_note_admission BEGIN SELECT RAISE(FAIL, 'sentinel-private-config'); END");
    assert.throws(() => f.runtime.configure(2, []));
    assert.equal((await f.runtime.availability('mirror-0')).available, true);
    assert.equal((await f.runtime.read('mirror-0', 1, 'Note.md') as any).text, 'A');
    f.db.exec('DROP TRIGGER fail_configuration');
    assert.deepEqual(f.runtime.configure(2, []), { revision: 2 });
    await assert.rejects(f.runtime.read('mirror-0', 1, 'Note.md'), (e: any) => e.category === 'invalid_selection');
  } finally { await f.close(); }
});
test('root inode replacement during awaited fsync cannot publish to a rebuilt same ID', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(1); let release = () => {};
  try {
    const gate = deferred(); release = gate.release; let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    (f.runtime.overlay as any).fault = async (stage: string) => { if (stage === 'before_head') { enter(); await gate.promise; } };
    const input = { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    const pending = f.runtime.commit(1, input); await entered;
    const local = join(f.workerRoot, 'mirrors', 'mirror-0');
    await rename(local, join(f.workerRoot, 'mirrors', 'old-mirror-0')); await mkdir(local);
    release(); await assert.rejects(pending, (e: any) => e.category === 'source_changed');
    assert.equal(await f.runtime.overlay.receipt(input.operationId), null);
    assert.equal((await f.runtime.availability('mirror-0')).available, false);
    assert.equal(await readFile(join(f.workerRoot, 'mirrors', 'old-mirror-0', 'Note.md'), 'utf8'), 'A');
  } finally { release(); await f.close(); }
});
test('resolution rechecks durable membership after awaited incoming proof and fsync', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(1); let release = () => {};
  try {
    const wake = f.runtime.wake.bind(f.runtime); (f.runtime as any).wake = () => {};
    const id = 'mirror-0', path = 'Note.md';
    await f.runtime.commit(1, { mirrorId: id, path, operationId: op(), kind: 'replace', expectedHash: hash('A'), text: 'Local B' });
    await writeFile(join(f.workerRoot, 'mirrors', id, path), 'Incoming C');
    await f.runtime.call('rc/noop', {});
    const conflict = await f.runtime.overlay.inspect(id, path); assert.equal(conflict?.incomingHash, hash('Incoming C'));
    (f.runtime as any).wake = wake;
    const gate = deferred(); release = gate.release; let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    (f.runtime.overlay as any).fault = async (stage: string) => { if (stage === 'before_resolution_head') { enter(); await gate.promise; } };
    const input = { operationId: op(), token: conflict!.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: hash('Incoming C'), choice: 'replace' as const, text: 'Resolved D' };
    const pending = f.runtime.resolve(id, 1, path, input); await entered;
    f.runtime.configure(2, []); release();
    await assert.rejects(pending, (e: any) => e.category === 'invalid_selection');
    assert.equal(await f.runtime.overlay.inspect(id, path).then(c => c?.token), conflict!.token);
    f.runtime.configure(3, [id]); (f.runtime.overlay as any).fault = undefined;
    assert.deepEqual(await f.runtime.resolve(id, 3, path, { ...input, version: 2, revision: 3, mirrorId: id, path } as any), { outcome: 'saved_locally_pending_sync', hash: hash('Resolved D') });
    f.runtime.configure(4, [id]);
    assert.deepEqual(await f.runtime.resolve(id, 4, path, { ...input, version: 2, revision: 4, mirrorId: id, path } as any), { outcome: 'saved_locally_pending_sync', hash: hash('Resolved D') });
    const receipts = await f.runtime.access(id, 4, () => f.runtime.overlay.receipts({ mirrorId: id, operationId: input.operationId, limit: 20 }));
    assert.equal(receipts.length, 1); assert.equal(receipts[0].kind, 'resolution');
    assert.equal(receipts[0].hash, hash('Resolved D'));
  } finally { release(); await f.close(); }
});
test('incoming absence has a distinct durable resolution receipt without a fabricated hash', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(1);
  try {
    const id = 'mirror-0', path = 'Note.md';
    (f.runtime as any).wake = () => {};
    await f.runtime.commit(1, { mirrorId: id, path, operationId: op(), kind: 'replace', expectedHash: hash('A'), text: 'Local B' });
    await (await import('node:fs/promises')).unlink(join(f.workerRoot, 'mirrors', id, path));
    await f.runtime.call('rc/noop', {});
    const conflict = await f.runtime.overlay.inspect(id, path); assert.equal(conflict?.incomingAbsent, true);
    const incoming = await f.runtime.read(id, 1, path, conflict!.token); assert.deepEqual(incoming, { absent: true });
    const input = { operationId: op(), token: conflict!.token, expectedLogicalHash: hash('Local B'), expectedIncomingHash: null, choice: 'accept_incoming' as const };
    assert.deepEqual(await f.runtime.resolve(id, 1, path, input), { outcome: 'adopted_absence', hash: null });
    const receipts = await f.runtime.access(id, 1, () => f.runtime.overlay.receipts({ mirrorId: id, operationId: input.operationId, limit: 20 }));
    assert.equal(receipts.length, 1); assert.equal(receipts[0].kind, 'resolution'); assert.equal(receipts[0].hash, null); assert.equal(receipts[0].outcome, 'adopted_absence');
    assert.deepEqual(await f.runtime.resolve(id, 1, path, input), { outcome: 'adopted_absence', hash: null });
  } finally { await f.close(); }
});
test('pause/disconnect preserve local saves; retained and changed source binding refuse access', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(2);
  try {
    const mirror = f.state.mirrors[0]; f.state.connected = false; mirror.enabled = false; mirror.phase = 'paused';
    assert.equal((await f.runtime.availability(mirror.id)).available, true);
    const savedId = op();
    await f.runtime.commit(1, { mirrorId: mirror.id, path: 'Note.md', operationId: savedId, kind: 'replace', expectedHash: hash('A'), text: 'Offline B' });
    assert.equal((await f.runtime.read(mirror.id, 1, 'Note.md') as any).text, 'Offline B');
    mirror.phase = 'retained'; assert.equal((await f.runtime.availability(mirror.id)).available, false);
    assert.equal((await f.runtime.receipts(mirror.id, 1, { mirrorId: mirror.id, operationId: savedId, limit: 20 }))[0].hash, hash('Offline B'));
    await assert.rejects(f.runtime.read(mirror.id, 1, 'Note.md'), (e: any) => e.category === 'source_changed');
    mirror.phase = 'paused'; mirror.folder.id = 'rebuilt-different-binding';
    await assert.rejects(f.runtime.commit(1, { mirrorId: mirror.id, path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('Offline B'), text: 'Bad retarget' }), (e: any) => e.category === 'source_changed');
    assert.equal((await readFile(join(f.workerRoot, 'mirrors/mirror-0/Note.md'), 'utf8')), 'A');
  } finally { await f.close(); }
});
test('changed local encrypted account binding refuses restart without touching acknowledged bytes', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(1); let editor: RcloneProcess | undefined;
  try {
    const input = { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await f.runtime.commit(1, input); await f.runtime.stop();
    const alternate = join(f.root, 'alternate-generated'); await mkdir(alternate);
    editor = new RcloneProcess(f.workerRoot, process.env.RCLONE_TEST_BINARY!); await editor.ensure();
    await editor.call('config/update', { name: 'icloud', parameters: { remote: alternate }, opt: { nonInteractive: true } });
    await editor.stop(); editor = undefined;
    const replacement = f.create();
    await assert.rejects(replacement.start(), (e: any) => e.category === 'source_changed');
    assert.ok(await f.runtime.overlay.receipt(input.operationId));
  } finally { await editor?.stop(); await f.close(); }
});
test('private bounded orphan maintenance progresses while a genuine native CLI is active', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(1);
  try {
    (f.runtime.overlay as any).fault = (stage: string) => { if (stage === 'before_head') throw new Error('sentinel-private-orphan'); };
    await assert.rejects(f.runtime.access('mirror-0', 1, root => f.runtime.overlay.commit(root, { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('A'), text: 'Unpublished orphan' })));
    (f.runtime.overlay as any).fault = undefined;
    await f.runtime.access('mirror-0', 1, root => f.runtime.overlay.commit(root, { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('A'), text: 'Pending B' }));
    const orphan = hash('Unpublished orphan');
    assert.ok(f.db.prepare('SELECT hash FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(orphan));
    const from = join(f.root, 'generated-copy-source'), to = join(f.root, 'generated-copy-target');
    await mkdir(from); await mkdir(to); await writeFile(join(from, 'data.bin'), Buffer.alloc(24 * 1024 * 1024, 65));
    const command = f.runtime.run(['copy', from, to]);
    for (let i = 0; i < 100 && (f.runtime.worker as any).children.size === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok((f.runtime.worker as any).children.size > 0, 'actual native CLI is active');
    let rcFinished = false;
    const rc = f.runtime.call('rc/noop', {}).then(() => { rcFinished = true; });
    f.runtime.wake();
    for (let i = 0; i < 100 && f.db.prepare('SELECT hash FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(orphan); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.db.prepare('SELECT hash FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(orphan), undefined);
    assert.ok((f.runtime.worker as any).children.size > 0, 'maintenance did not await the native command');
    assert.equal(rcFinished, false, 'RC cannot overlap the CLI turn');
    assert.equal(await readFile(join(f.workerRoot, 'mirrors/mirror-0/Note.md'), 'utf8'), 'A');
    assert.equal((await f.runtime.read('mirror-0', 1, 'Note.md') as any).text, 'Pending B');
    await command; await rc;
    assert.equal(await readFile(join(f.workerRoot, 'mirrors/mirror-0/Note.md'), 'utf8'), 'Pending B');
  } finally { await f.close(); }
});
test('a freshly dirty successor queues behind older work but coalescing keeps its place', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(2);
  try {
    (f.runtime as any).wake = () => {};
    const local0 = join(f.workerRoot, 'mirrors/mirror-0');
    await f.runtime.access('mirror-0', 1, root => f.runtime.overlay.commit(root, { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('A'), text: 'B' }));
    await f.runtime.call('rc/noop', {}); assert.equal(await readFile(join(local0, 'Note.md'), 'utf8'), 'B');
    await f.runtime.access('mirror-1', 1, root => f.runtime.overlay.commit(root, { mirrorId: 'mirror-1', path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('A'), text: 'Other B' }));
    await f.runtime.access('mirror-0', 1, root => f.runtime.overlay.commit(root, { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('B'), text: 'C' }));
    assert.deepEqual(f.runtime.overlay.pending().map(p => p.mirrorId), ['mirror-1', 'mirror-0']);
    await f.runtime.access('mirror-0', 1, root => f.runtime.overlay.commit(root, { mirrorId: 'mirror-0', path: 'Note.md', operationId: op(), kind: 'replace', expectedHash: hash('C'), text: 'D' }));
    assert.deepEqual(f.runtime.overlay.pending().map(p => p.mirrorId), ['mirror-1', 'mirror-0']);
  } finally { await f.close(); }
});
test('idle quantum drains 16 ordinary paths within one second and cycles 20 mirrors without starvation', { skip: !enabled, timeout: 45000 }, async () => {
  const f = await fixture(20);
  try {
    // Publish without a wake to measure one arbiter turn, not twenty separate
    // turns that happen to complete over the course of publishing.
    for (let i = 0; i < 20; i++) {
      const id = `mirror-${i}`;
      await f.runtime.access(id, 1, root => f.runtime.overlay.commit(root, { mirrorId: id, path: 'Queued.md', operationId: op(), kind: 'create', expectedHash: null, text: 'Generated' }));
    }
    const start = performance.now(); await f.runtime.call('rc/noop', {});
    const first = performance.now() - start;
    const firstApplied = await Promise.all(f.state.mirrors.map(async m => readFile(join(f.workerRoot, 'mirrors', m.id, 'Queued.md'), 'utf8').then(() => true, () => false)));
    assert.ok(first <= 1000, `one command/application quantum took ${first}ms`);
    assert.ok(firstApplied.filter(Boolean).length >= 16, 'one quantum applied at least 16 distinct mirrors');
    for (let i = 0; i < 100 && firstApplied.some((_, index) => !firstApplied[index] && !f.runtime.overlay.pending().some(p => p.mirrorId === `mirror-${index}`)); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await f.runtime.call('rc/noop', {});
    assert.equal(f.runtime.overlay.pending().length, 0);
    console.log(JSON.stringify({ fixture: '20-mirror-native-arbiter', firstQuantumMs: Math.round(first), firstApplied: firstApplied.filter(Boolean).length, mirrors: 20 }));
  } finally { await f.close(); }
});
