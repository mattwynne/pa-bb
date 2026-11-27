import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { CloudError, emptyState } from '../core/ports.ts';
import { ICloudSync } from '../core/service.ts';
import { RcloneCloudProvider } from '../adapters/rclone-cloud-provider.ts';
import { MemoryState } from './fakes.ts';
import { diagnosticMessage } from '../adapters/diagnostic-log.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(native = false, initialized = true) {
  const root = await mkdtemp('/tmp/icloud-lifecycle-');
  const db = new Database(':memory:');
  const state = emptyState(); state.connected = true;
  state.mirrors.push({ id: 'one', folder: { id: 'Z2VuZXJhdGVk', name: 'Generated', ancestors: [] }, initialized, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null });
  await mkdir(join(root, 'mirrors/one'), { recursive: true }); await mkdir(join(root, 'baselines/one'), { recursive: true });
  await writeFile(join(root, 'baselines/one/initialized'), '1', { mode: 0o600 });
  const worker = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY);
  // Generated Linux fixture: real queue/overlay/storage, optional OS ownership, no provider.
  if (native) {
    await worker.ensure();
    await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: root }, opt: { nonInteractive: true } });
  } else {
    worker.ensure = async () => {};
    worker.call = async () => ({ type: 'alias', remote: 'generated' });
    worker.withFiles = async action => action(new AbortController().signal);
  }
  const newRuntime = () => new NoteRuntime(root, db, worker, new NoteStore(join(root, 'legacy')), () => state);
  const runtime = newRuntime();
  await runtime.start();
  return { root, db, state, runtime, worker, newRuntime, async close() { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

test('filesystem handoff waits for acknowledged legacy bytes and conflict recovery, and persists the write fence', async () => {
  const f = await fixture();
  try {
    f.runtime.configure(1, ['one']);
    const directory = join(f.root, 'mirrors/one');
    await f.runtime.call('rc/noop', {});
    f.runtime.wake = () => {};
    const path = 'Note.md';
    await writeFile(join(directory, path), 'A');
    const operationId = () => {
      const time = Date.now().toString(16).padStart(12, '0');
      return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
    };
    const input = { mirrorId: 'one', path, operationId: operationId(), kind: 'replace' as const, expectedHash: createHash('sha256').update('A').digest('hex'), text: 'B' };
    await assert.rejects(f.runtime.mirrorDirectory('one', 0), /invalid_selection/);
    await assert.rejects(f.runtime.mirrorDirectory('other', 1), /invalid_selection/);
    const receipt = await f.runtime.commit(1, input);
    assert.equal(f.runtime.filesystemStatus('one', true), 'legacy_pending');
    await assert.rejects(f.runtime.mirrorDirectory('one', 1), /conflict/);
    await assert.rejects(f.runtime.mirrorDirectoryGrant('one', 1), /conflict/);
    assert.equal((await f.runtime.read('one', 1, path) as { text: string }).text, 'B');

    f.worker.run = async () => { await writeFile(join(directory, path), 'C'); return ''; };
    const args = ['bisync', 'generated:', directory];
    await f.runtime.run(args);
    assert.equal(f.runtime.filesystemStatus('one', true), 'legacy_conflict');
    await assert.rejects(f.runtime.mirrorDirectory('one', 1), /conflict/);
    await assert.rejects(f.runtime.mirrorDirectoryGrant('one', 1), /conflict/);
    const conflict = await f.runtime.overlay.inspect('one', path, directory);
    assert.ok(conflict);
    assert.equal((await f.runtime.read('one', 1, path, conflict.token) as { text: string }).text, 'C');
    await f.runtime.resolve('one', 1, path, { operationId: operationId(), token: conflict.token, expectedLogicalHash: conflict.logicalHash, expectedIncomingHash: conflict.incomingHash, choice: 'keep_local' });
    f.worker.run = async () => '';
    await f.runtime.run(args);

    f.state.connected = false;
    f.state.mirrors[0].enabled = false;
    f.state.mirrors[0].phase = 'paused';
    assert.equal((await f.runtime.mirrorDirectoryGrant('one', 1)).directory, directory);
    assert.equal((await f.runtime.receipts('one', 1, { mirrorId: 'one', operationId: input.operationId, limit: 1 }))[0].hash, receipt.hash);
    await assert.rejects(f.runtime.commit(1, { ...input, operationId: operationId() }), /unsupported/);
    await f.runtime.stop();
    const restarted = f.newRuntime();
    try {
      await restarted.start();
      assert.deepEqual(await restarted.mirrorDirectory('one', 1), { directory });
      await assert.rejects(restarted.commit(1, { ...input, operationId: operationId() }), /unsupported/);
      assert.equal((await restarted.read('one', 1, path) as { text: string }).text, 'B');
      await rename(directory, directory + '-replaced');
      await mkdir(directory);
      await assert.rejects(restarted.mirrorDirectory('one', 1), /source_changed/);
    } finally { await restarted.stop(); }
  } finally { await f.close(); }
});

test('directory grant cannot create a missing binding or fence', async () => {
  const f = await fixture();
  try {
    f.runtime.configure(1, ['one']);
    f.db.prepare('DELETE FROM icloud_note_bindings WHERE mirror_id=?').run('one');
    await assert.rejects(f.runtime.mirrorDirectoryGrant('one', 1), /source_changed/);
    assert.deepEqual(f.db.prepare('SELECT mirror_id FROM icloud_note_bindings').all(), []);
    assert.deepEqual(f.db.prepare('SELECT mirror_id FROM icloud_note_direct').all(), []);
  } finally { await f.close(); }
});

test('grant rejects unsafe legacy IDs even when exact filesystem IDs match stored rounded values', async t => {
  const f = await fixture();
  const directory = join(f.root, 'mirrors/one'), baseline = join(f.root, 'baselines/one');
  const original = 9007199254740993n, rounded = 9007199254740992n;
  const safe = BigInt(Number.MAX_SAFE_INTEGER);
  assert.equal(Number(original), Number(rounded));
  const stat = fs.lstatSync, statAsync = fsPromises.lstat;
  const statInodes = new Map<string, bigint>();
  try {
    f.runtime.configure(1, ['one']);
    // Preserve real directory evidence except the synthetic inode values.
    t.mock.method(fsPromises, 'lstat', async (path: string) => {
      const info = await statAsync(path), ino = statInodes.get(path);
      return ino === undefined ? info : Object.assign(info, { ino: Number(ino) });
    });
    t.mock.method(fs, 'lstatSync', (path: string, options?: { bigint: boolean }) => {
      const info = options?.bigint ? stat(path, { bigint: true }) : stat(path), ino = statInodes.get(path);
      return ino === undefined ? info : Object.assign(info, { ino: options?.bigint ? ino : Number(ino) });
    });
    syncBuiltinESMExports();
    const setRoot = f.db.prepare('UPDATE icloud_note_bindings SET root_ino=? WHERE mirror_id=?');
    const setBaseline = f.db.prepare('UPDATE icloud_note_bindings SET baseline_ino=? WHERE mirror_id=?');
    const grant = () => f.runtime.mirrorDirectoryGrant('one', 1);
    setRoot.run(Number(original), 'one'); // Model legacy Number-valued registration.
    for (const inode of [original, rounded]) {
      statInodes.set(directory, inode);
      assert.equal((await f.runtime.availability('one')).available, true);
      await assert.rejects(grant(), /source_changed/);
    }
    assert.equal(f.db.prepare('SELECT root_ino FROM icloud_note_bindings WHERE mirror_id=?').safeIntegers().pluck().get('one'), rounded);
    // Even a matching high integer represented exactly by SQLite is refused;
    // no provenance distinguishes it from legacy rounded Number input.
    setRoot.run(original, 'one');
    statInodes.set(directory, original);
    await assert.rejects(grant(), /source_changed/);
    setRoot.run(safe, 'one');
    statInodes.set(directory, safe);
    setBaseline.run(rounded, 'one');
    statInodes.set(baseline, rounded);
    assert.equal((await f.runtime.availability('one')).available, true);
    await assert.rejects(grant(), /source_changed/);
    assert.deepEqual(f.db.prepare('SELECT mirror_id FROM icloud_note_direct').all(), []);
    setBaseline.run(safe, 'one');
    statInodes.set(baseline, safe);
    assert.deepEqual(await grant(), { directory, rootDev: stat(directory, { bigint: true }).dev.toString(), rootIno: safe.toString() });
    assert.deepEqual(await f.runtime.mirrorDirectory('one', 1), { directory });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.close();
  }
});

for (const method of ['mirrorDirectoryGrant', 'mirrorDirectory'] as const) test(`${method} rechecks uncertain moves after availability and before the fence`, async () => {
  const f = await fixture();
  const checked = deferred(), release = deferred();
  const directory = join(f.root, 'mirrors/one');
  try {
    f.runtime.configure(1, ['one']);
    await writeFile(join(directory, 'Move.md'), 'generated');
    const availability = f.runtime.availability.bind(f.runtime);
    let delayFirst = true;
    f.runtime.availability = async (id, options) => {
      const delay = delayFirst; delayFirst = false;
      const result = await availability(id, options);
      if (delay) { checked.resolve(); await release.promise; }
      return result;
    };
    const refused = assert.rejects(f.runtime[method]('one', 1), /uncertain/);
    try {
      await checked.promise;
      (f.runtime.moves as any).files.options.fault = (stage: string) => { if (stage === 'after_move_link') throw new Error('synthetic crash'); };
      const outcome = await f.runtime.move(1, { mirrorId: 'one', path: 'Move.md', destination: 'Other.md', expectedHash: createHash('sha256').update('generated').digest('hex'), operationId: randomUUID() });
      assert.equal(outcome.outcome, 'uncertain');
      assert.equal(f.runtime.filesystemStatus('one', true), 'unavailable');
    } finally { release.resolve(); await refused; }
    assert.deepEqual(f.db.prepare('SELECT mirror_id FROM icloud_note_direct').all(), []);
  } finally { await f.close(); }
});

test('move uses native exclusion, refuses outstanding overlays, and blocks sync after uncertainty', async () => {
  const f = await fixture();
  try {
    f.runtime.configure(1, ['one']);
    const root = join(f.root, 'mirrors/one'); await mkdir(join(root, 'Reference'));
    await writeFile(join(root, 'Example.md'), 'A');
    const input = { mirrorId: 'one', path: 'Example.md', destination: 'Reference/New.md', expectedHash: createHash('sha256').update('A').digest('hex'), operationId: randomUUID() };
    const gate = deferred(), entered = deferred(); const files = f.worker.withFiles.bind(f.worker);
    f.worker.withFiles = async action => files(async signal => { entered.resolve(); await gate.promise; return action(signal); });
    const moving = f.runtime.move(1, input); await entered.promise;
    await assert.rejects(f.runtime.read('one', 1, 'Example.md'), /busy/);
    gate.resolve(); assert.equal((await moving).outcome, 'moved_locally_pending_sync');
    await assert.rejects(f.runtime.commit(1, { ...input, kind: 'create', expectedHash: null, text: 'B' }), /operation_reused/);
    // New pending head may never be bypassed by a physical move.
    const time = Date.now().toString(16).padStart(12, '0'); const operationId = `${time.slice(0,8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
    await f.runtime.commit(1, { ...input, path: 'Pending.md', operationId, kind: 'create', expectedHash: null, text: 'B' });
    await assert.rejects(f.runtime.move(1, { ...input, path: 'Pending.md', operationId: randomUUID(), destination: 'Reference/Pending.md' }), /busy/);
    // A synthetic interruption after exclusive destination creation leaves both
    // names; neither ordinary saves nor bisync can proceed through uncertainty.
    await writeFile(join(root, 'Second.md'), 'A');
    (f.runtime.moves as any).files.options.fault = async (s: string) => { if (s === 'after_move_link') throw new Error('PRIVATE_SENTINEL'); };
    const second = { ...input, path: 'Second.md', destination: 'Reference/Second.md', operationId: randomUUID() };
    assert.equal((await f.runtime.move(1, second)).outcome, 'uncertain');
    await assert.rejects(f.runtime.read('one', 1, 'Second.md'), /uncertain/);
    await assert.rejects(f.runtime.run(['bisync', 'generated:', root]), /uncertain/);
    assert.equal((await f.runtime.moveReceipts('one', 1, second.operationId))[0].outcome, 'uncertain');
  } finally { await f.close(); }
});

for (const stage of ['before_move_link', 'after_move_link']) test('native move drain retains flock at '+stage, { skip: !process.env.RCLONE_TEST_BINARY, timeout: 15000 }, async () => {
  const f = await fixture(true); const gate = deferred(), entered = deferred();
  try {
    f.runtime.configure(1, ['one']); const root = join(f.root, 'mirrors/one');
    await writeFile(join(root, 'Example.md'), 'A');
    (f.runtime.moves as any).files.options.fault = async (s: string) => { if (s === stage) { entered.resolve(); await gate.promise; } };
    const moving = f.runtime.move(1, { mirrorId: 'one', path: 'Example.md', destination: 'New.md', expectedHash: createHash('sha256').update('A').digest('hex'), operationId: randomUUID() });
    await entered.promise; let stopped = false; const stopping = f.runtime.stop().then(() => { stopped = true; });
    const contender = new RcloneProcess(f.root, process.env.RCLONE_TEST_BINARY);
    await assert.rejects(contender.ensure(), /busy/); await contender.stop(); assert.equal(stopped, false);
    gate.resolve(); assert.equal((await moving).outcome, stage === 'before_move_link' ? 'not_moved' : 'uncertain'); await stopping;
  } finally { gate.resolve(); await f.close(); }
});

test('registration verifies account outside filesystem exclusion but in the same serialized turn', async () => {
  const f = await fixture(false, false);
  const entered = deferred(), release = deferred();
  let fileWork = false;
  const events: string[] = [];
  f.worker.call = async method => {
    assert.equal(fileWork, false, 'RC must not enter filesystem exclusion');
    events.push(method);
    if (method === 'config/get') { entered.resolve(); await release.promise; }
    return { type: 'alias', remote: 'generated' };
  };
  f.worker.withFiles = async action => {
    assert.equal(fileWork, false); fileWork = true; events.push('files');
    try { return await action(new AbortController().signal); }
    finally { fileWork = false; }
  };
  try {
    const registration = f.runtime.registerMirror(f.state.mirrors[0]);
    await entered.promise;
    const queued = f.runtime.call('rc/noop', {});
    assert.deepEqual(events, ['config/get']);
    release.resolve(); await registration; await queued;
    assert.deepEqual(events, ['config/get', 'files', 'rc/noop']);
    f.state.mirrors[0].initialized = true;
    assert.equal((await f.runtime.availability('one')).available, true);
    // Account mismatch still fails before any filesystem work; private config
    // or exception content must not escape as the domain error.
    f.worker.call = async () => ({ type: 'alias', remote: 'PRIVATE_SENTINEL' });
    events.length = 0;
    await assert.rejects(f.runtime.registerMirror(f.state.mirrors[0]), (error: any) => {
      assert.equal(error.category, 'source_changed');
      assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_SENTINEL/); return true;
    });
    assert.deepEqual(events, []);
  } finally { release.resolve(); await f.close(); }
});

test('native failure plus failed post-run reconciliation preserves both safe boundaries and fails closed', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    f.runtime.configure(1, ['one']);
    f.runtime.wake = () => {};
    const time = Date.now().toString(16).padStart(12, '0');
    const operationId = `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
    await f.runtime.commit(1, { mirrorId: 'one', path: 'PRIVATE_SENTINEL.md', operationId, kind: 'create', expectedHash: null, text: 'PRIVATE_SENTINEL' });
    await f.runtime.call('rc/noop', {}); // real overlay application/checkpoint
    assert.equal(f.runtime.overlay.beforeRun('one').length, 1);
    const receipt = await f.runtime.overlay.receipt(operationId);
    f.worker.run = async () => {
      await rename(join(f.root, 'mirrors/one/PRIVATE_SENTINEL.md'), join(f.root, 'mirrors/one/PRIVATE_SENTINEL.md.bb-conflict1'));
      throw new CloudError('interrupted', { kind: 'command_timeout', message: 'PRIVATE_SENTINEL' } as any);
    };
    const repository = new MemoryState(); repository.value = f.state;
    const provider = new RcloneCloudProvider(f.root, f.runtime.call.bind(f.runtime), f.runtime.run.bind(f.runtime), async () => {}, () => f.runtime.stop());
    const logs: string[] = [];
    const sync: ICloudSync = new ICloudSync(provider, repository, () => new Date().toISOString(), () => 'unused', (stage, failure, details) => logs.push(diagnosticMessage(stage, failure, details)));
    await sync.start(); await sync.tick();
    const run = (await sync.diagnostics()).runs[0];
    assert.equal(run.failure, 'recovery_required');
    assert.deepEqual(run.evidence, { kind: 'post_run_reconcile', reason: 'uncertain', command: { kind: 'command_timeout' } });
    assert.equal(sync.status().mirrors[0].blocker, 'rebuild');
    assert.equal(f.runtime.applicationBlocker('one'), 'application_uncertain');
    assert.equal(f.runtime.overlay.beforeRun('one').length, 1, 'failed reconciliation cannot retire the applied head');
    assert.deepEqual(await f.runtime.overlay.receipt(operationId), receipt);
    assert.match(logs.join(), /post_run_reconcile.*uncertain.*command_timeout/);
    assert.doesNotMatch(JSON.stringify(run) + logs.join(), /PRIVATE_SENTINEL/);
  } finally { await f.close(); }
});

test('runtime stop interrupts before draining and retains the native owner through reconciliation', { skip: process.platform !== 'linux', timeout: 5000 }, async () => {
  const native = !!process.env.RCLONE_TEST_BINARY;
  const f = await fixture(native); const childReady = deferred(), reconcile = deferred(), reconciled = deferred();
  let released = false;
  const stopWorker = f.worker.stop.bind(f.worker);
  f.worker.stop = async () => { await stopWorker(); released = true; };
  f.runtime.overlay.beforeRun = () => [{ path: 'Generated.md', generation: 1 }] as any;
  f.worker.run = async () => (f.worker as any).execute(process.execPath, ['-e', 'process.on("SIGINT", () => process.exit(0)); process.stdout.write("ready"); setInterval(() => {}, 1000)'], true, null);
  f.runtime.overlay.afterRun = async () => { reconcile.resolve(); await reconciled.promise; assert.equal(released, false); return 0; };
  // Observe actual synthetic child readiness, not a sleep before signaling it.
  const execute = (f.worker as any).execute.bind(f.worker);
  (f.worker as any).execute = (...args: any[]) => { const task = execute(...args); const child = [...(f.worker as any).children][0] as any; child.stdout.once('data', () => childReady.resolve()); return task; };
  const active = f.runtime.run(['bisync', 'generated:', join(f.root, 'mirrors/one')]);
  const failed = assert.rejects(active, (error: any) => error.category === 'interrupted' && error.evidence.kind === 'command_stopped');
  try {
    await childReady.promise;
    const queued = assert.rejects(f.runtime.call('rc/noop', {}), /interrupted/);
    let stopped = false;
    const stopping = f.runtime.stop().then(() => { stopped = true; });
    const again = f.runtime.stop().then(() => { assert.equal(released, true); });
    await assert.rejects(f.runtime.run(['lsjson']), /interrupted/);
    await reconcile.promise;
    assert.equal(released, false); assert.equal(stopped, false);
    if (native) {
      assert.equal(spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', join(f.root, 'worker.lock'), 'true']).status, 1, 'flock must still exclude a replacement after the CLI exits');
      await (f.worker as any).rawCall('rc/noop', {}); // entered reconciliation still has its daemon
    }
    reconciled.resolve();
    await Promise.all([failed, queued, stopping, again]);
    if (native) assert.equal(spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', join(f.root, 'worker.lock'), 'true']).status, 0);
  } finally { reconciled.resolve(); (f.worker as any).requestStop?.(); await f.close(); }
});

test('service stop requests interruption before awaiting its active operation and tears down only after drain', { timeout: 2000 }, async () => {
  const entered = deferred(), interrupted = deferred(), drained = deferred();
  const repository = new MemoryState(); repository.value.connected = true;
  repository.value.mirrors = [{ id: 'one', folder: { id: 'Z2VuZXJhdGVk', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null }];
  let stopped = 0;
  const provider: RcloneCloudProvider = new RcloneCloudProvider('/tmp/generated', async () => ({}), async () => '', async () => {}, async () => { assert.equal((await sync.diagnostics()).active, null); stopped++; }, undefined, undefined, undefined, undefined, () => interrupted.resolve());
  provider.synchronize = async () => { entered.resolve(); await interrupted.promise; await drained.promise; throw new CloudError('interrupted'); };
  const sync: ICloudSync = new ICloudSync(provider, repository, () => new Date().toISOString(), () => 'unused', () => {});
  await sync.start(); const active = sync.tick(); await entered.promise;
  const stopping = sync.stop(); const again = sync.stop();
  await assert.rejects(sync.browse(null), /busy/);
  await interrupted.promise; assert.equal(stopped, 0);
  drained.resolve(); await Promise.all([active, stopping, again]); assert.equal(stopped, 1);
});

test('post-run failure after native success stays blocked with bounded unknown-error evidence', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    f.runtime.overlay.beforeRun = () => [{ path: 'PRIVATE_SENTINEL.md', generation: 1 }] as any;
    f.worker.run = async () => '';
    f.runtime.overlay.afterRun = async () => { throw Object.assign(new Error('PRIVATE_SENTINEL provider content'), { code: 'PRIVATE_SENTINEL', cause: 'PRIVATE_SENTINEL' }); };
    await assert.rejects(f.runtime.run(['bisync', 'generated:', join(f.root, 'mirrors/one')]), (error: unknown) => {
      assert.ok(error instanceof CloudError); assert.equal(error.category, 'recovery_required');
      assert.deepEqual(error.evidence, { kind: 'post_run_reconcile', reason: 'unavailable', command: null });
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SENTINEL/); return true;
    });
    assert.equal(f.runtime.applicationBlocker('one'), 'application_uncertain');
  } finally { await f.close(); }
});
