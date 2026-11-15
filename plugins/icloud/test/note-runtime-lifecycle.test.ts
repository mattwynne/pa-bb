import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
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
async function fixture(native = false) {
  const root = await mkdtemp('/tmp/icloud-lifecycle-');
  const db = new Database(':memory:');
  const state = emptyState(); state.connected = true;
  state.mirrors.push({ id: 'one', folder: { id: 'Z2VuZXJhdGVk', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null });
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
  const runtime = new NoteRuntime(root, db, worker, new NoteStore(join(root, 'legacy')), () => state);
  await runtime.start();
  return { root, state, runtime, worker, async close() { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

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
