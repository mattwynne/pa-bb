import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MirrorRuntime } from '../adapters/mirror-runtime.ts';
import { FileStore } from '../adapters/file-store.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { ICloudSync } from '../core/service.ts';
import { CloudError, emptyState } from '../core/ports.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
const linux = process.platform === 'linux';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const op = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture() {
  const root = await mkdtemp('/tmp/icloud-interrupted-generated-'), db = new Database(':memory:');
  const state = emptyState(); state.connected = true;
  state.mirrors.push({ id: 'one', folder: { id: 'Z2VuZXJhdGVk', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null });
  const local = join(root, 'mirrors/one'), baseline = join(root, 'baselines/one');
  await mkdir(local, { recursive: true }); await mkdir(baseline, { recursive: true });
  await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
  const create = () => {
    const worker = new RcloneProcess(root); worker.ensure = async () => {};
    worker.call = async () => ({ type: 'alias', remote: 'generated' });
    worker.withFiles = async action => action(new AbortController().signal);
    const runtime = new MirrorRuntime(root, db, worker, new FileStore(join(root, 'legacy')), () => state);
    runtime.wake = () => {};
    return runtime;
  };
  let runtime = create(); await runtime.start(); runtime.configure(1, ['one']);
  const save = async (path: string, text = 'Checkpoint B') => {
    await runtime.commit(1, { mirrorId: 'one', path, operationId: op(), kind: 'create', expectedHash: null, bytes: Buffer.from(text) });
    await runtime.call('rc/noop', {});
  };
  const fence = () => { state.mirrors[0].blocker = 'rebuild'; state.mirrors[0].failure = 'recovery_required'; state.mirrors[0].phase = 'running'; };
  return { root, local, baseline, db, state, save, fence, get runtime() { return runtime; },
    args: ['bisync', 'icloud:generated', local, '--recover', '--resilient'],
    async restart() { await runtime.stop(); runtime = create(); await runtime.start(); },
    async close() { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

test('verified sole BB copy stays held and fenced until a complete pair is captured; receipts survive', { skip: !linux }, async () => {
  const f = await fixture(); const entered = gate(), released = gate();
  try {
    await f.save('Note.md'); await f.save('Unchanged.md');
    const before = f.runtime.overlay.beforeRun('one');
    const receipts = await f.runtime.overlay.receipts({ mirrorId: 'one', limit: 20 });
    await rename(join(f.local, 'Note.md'), join(f.local, 'Note.md.bb-conflict1')); f.fence();
    f.runtime.worker.run = async () => {
      entered.release(); await released.promise;
      assert.equal(f.runtime.overlay.beforeRun('one').length, 2);
      await assert.rejects(f.runtime.read('one', 1, 'Note.md'));
      await assert.rejects(readFile(join(f.local, 'Note.md')));
      await writeFile(join(f.local, 'Note.md.icloud-conflict1'), 'Incoming C'); return '';
    };
    const pending = f.runtime.continueInterrupted(f.args); await entered.promise;
    assert.equal((await f.runtime.availability('one')).reason, 'recovery_required');
    assert.equal(f.state.mirrors[0].blocker, 'rebuild');
    released.release(); await pending;
    const conflict = await f.runtime.overlay.inspect('one', 'Note.md');
    assert.equal(conflict?.incomingHash, hash('Incoming C'));
    assert.equal(f.runtime.overlay.beforeRun('one').length, 0);
    assert.deepEqual(await f.runtime.overlay.receipts({ mirrorId: 'one', limit: 20 }), receipts);
    assert.equal(before.length, 2);
    assert.equal((await f.runtime.availability('one')).available, false, 'only the service may clear its persisted fence');
    f.state.mirrors[0].blocker = null;
    assert.equal((await f.runtime.read('one', 1, 'Note.md') as any).bytes.toString(), 'Checkpoint B');
    assert.equal(((await f.runtime.overlay.readIncoming('one', 'Note.md', conflict!.token))?.toString()), 'Incoming C');
    await assert.rejects(readFile(join(f.local, 'Note.md')), 'application must not recreate canonical B');
  } finally { released.release(); await f.close(); }
});

for (const variant of ['changed_bytes', 'ambiguous_copies', 'missing_pair', 'canonical_D', 'late_canonical_D', 'journal', 'binding', 'checkpoint_history', 'marker', 'account', 'retained', 'uninitialized', 'stronger_blocker'] as const) test(`interrupted continuation rejects ${variant} without retiring any head or fabricating deletion`, { skip: !linux }, async () => {
  const f = await fixture(); let invoked = 0;
  try {
    if (variant === 'changed_bytes') (f.runtime.overlay as any).fault = async (stage: string) => {
      if (stage === 'after_apply_stage_cleanup') {
        const exact = new Date('2026-01-01T00:00:00.000Z');
        await utimes(join(f.local, 'Note.md'), exact, exact); // before checkpoint capture
      }
    };
    await f.save('Note.md'); (f.runtime.overlay as any).fault = undefined; await f.save('Unchanged.md');
    await rename(join(f.local, 'Note.md'), join(f.local, 'Note.md.bb-conflict1')); f.fence();
    const savedHeads = f.runtime.overlay.beforeRun('one');
    if (variant === 'changed_bytes') {
      const path = join(f.local, 'Note.md.bb-conflict1'), info = await stat(path);
      await writeFile(path, 'Checkpoint X'); await utimes(path, info.atime, info.mtime);
      const spoofed = await stat(path); assert.equal(spoofed.size, info.size); assert.equal(spoofed.mtimeMs, info.mtimeMs);
    }
    if (variant === 'ambiguous_copies') await writeFile(join(f.local, 'Note.md.bb-conflict2'), 'Checkpoint B');
    if (variant === 'journal') f.db.prepare("UPDATE icloud_note_overlay_heads SET journal = '{}' WHERE path = 'Note.md'").run();
    if (variant === 'binding') f.db.prepare('UPDATE icloud_note_bindings SET root_ino = root_ino + 1').run();
    if (variant === 'marker') await writeFile(join(f.baseline, 'initialized'), '0', { mode: 0o600 });
    if (variant === 'account') f.runtime.worker.call = async () => ({ type: 'alias', remote: 'different-generated' });
    if (variant === 'retained') f.state.mirrors[0].phase = 'retained';
    if (variant === 'uninitialized') f.state.mirrors[0].initialized = false;
    if (variant === 'stronger_blocker') f.state.mirrors[0].blocker = 'configuration';
    if (variant === 'checkpoint_history') f.db.prepare("UPDATE icloud_note_overlay_generations SET state = 'retired' WHERE path = 'Note.md'").run();
    if (variant === 'late_canonical_D') (f.runtime.overlay as any).fault = async (stage: string) => {
      if (stage === 'after_blob_parent_fsync') await writeFile(join(f.local, 'Note.md'), 'Distinct D');
    };
    f.runtime.worker.run = async () => {
      invoked++;
      if (variant !== 'missing_pair') await writeFile(join(f.local, 'Note.md.icloud-conflict1'), 'Incoming C');
      if (variant === 'canonical_D') await writeFile(join(f.local, 'Note.md'), 'Distinct D');
      return '';
    };
    await assert.rejects(f.runtime.continueInterrupted(f.args));
    assert.equal(invoked, ['missing_pair', 'canonical_D', 'late_canonical_D'].includes(variant) ? 1 : 0);
    assert.deepEqual(f.runtime.overlay.beforeRun('one').map(h => h.applied), variant === 'journal' ? savedHeads.filter(h => h.path !== 'Note.md').map(h => h.applied) : savedHeads.map(h => h.applied));
    assert.equal(await f.runtime.overlay.inspect('one', 'Note.md'), null);
    assert.equal((await f.runtime.availability('one')).available, false);
    assert.equal(f.state.mirrors[0].blocker, variant === 'stronger_blocker' ? 'configuration' : 'rebuild');
    assert.equal(await readFile(join(f.local, 'Note.md.bb-conflict1'), 'utf8'), variant === 'changed_bytes' ? 'Checkpoint X' : 'Checkpoint B');
  } finally { await f.close(); }
});

test('complete pair on restart needs explicit continuation, never startup or ordinary run recovery', { skip: !linux }, async () => {
  const f = await fixture();
  try {
    await f.save('Note.md'); await rename(join(f.local, 'Note.md'), join(f.local, 'Note.md.bb-conflict1'));
    await writeFile(join(f.local, 'Note.md.icloud-conflict1'), 'Incoming C'); f.fence();
    await f.restart();
    assert.equal((await f.runtime.availability('one')).reason, 'recovery_required');
    assert.equal(f.runtime.overlay.beforeRun('one').length, 1);
    await assert.rejects(f.runtime.run(f.args), /recovery_required/);
    let runs = 0; f.runtime.worker.run = async () => { runs++; return ''; };
    await f.runtime.continueInterrupted(f.args);
    assert.equal(runs, 1); assert.equal((await f.runtime.overlay.inspect('one', 'Note.md'))?.incomingHash, hash('Incoming C'));
  } finally { await f.close(); }
});

test('already-entered suspended save cannot publish through a newly durable recovery fence; continuation drains it', { skip: !linux }, async () => {
  const f = await fixture(); const entered = gate(), released = gate();
  try {
    await f.save('Note.md');
    (f.runtime.overlay as any).fault = async (stage: string) => { if (stage === 'before_head') { entered.release(); await released.promise; } };
    const operationId = op();
    const save = f.runtime.commit(1, { mirrorId: 'one', path: 'Other.md', operationId, kind: 'create', expectedHash: null, bytes: Buffer.from('Suspended') });
    const rejected = assert.rejects(save, /recovery_required/); await entered.promise;
    await rename(join(f.local, 'Note.md'), join(f.local, 'Note.md.bb-conflict1')); f.fence();
    let invoked = false; f.runtime.worker.run = async () => { invoked = true; await writeFile(join(f.local, 'Note.md.icloud-conflict1'), 'Incoming C'); return ''; };
    const recovery = f.runtime.continueInterrupted(f.args);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(invoked, false);
    released.release(); await rejected; await recovery;
    assert.equal(await f.runtime.overlay.receipt(operationId), null);
    assert.equal((await f.runtime.overlay.receipts({ mirrorId: 'one', limit: 20 })).length, 1);
  } finally { released.release(); await f.close(); }
});

test('service preserves rebuild fence across running restart, Pause, Disconnect and failed explicit continuation', async () => {
  const repository = new MemoryState(); repository.value.connected = true;
  repository.value.mirrors.push({ id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'running', failure: 'recovery_required', blocker: 'rebuild', lastSuccess: null });
  const provider = new FakeCloudProvider(); let calls = 0;
  Object.assign(provider, { continueInterrupted: async () => { calls++; assert.equal(repository.value.mirrors[0].blocker, 'rebuild'); assert.equal(repository.value.mirrors[0].phase, 'running'); throw new CloudError('authentication'); } });
  const sync = new ICloudSync(provider, repository, () => new Date().toISOString(), () => 'unused', () => {});
  await sync.start(); assert.equal(sync.status().mirrors[0].blocker, 'rebuild');
  await sync.tick(); assert.equal(provider.synced, 0);
  await sync.pause('one'); assert.equal(sync.status().mirrors[0].enabled, false); assert.equal(sync.status().mirrors[0].failure, 'recovery_required');
  await sync.continueInterrupted('one'); assert.equal(calls, 1);
  assert.equal(sync.status().mirrors[0].blocker, 'rebuild'); assert.equal(sync.status().mirrors[0].enabled, false);
  await sync.disconnect(); assert.equal(sync.status().mirrors[0].blocker, 'rebuild');
  assert.equal(sync.status().mirrors[0].phase, 'failed'); await sync.stop();
});

test('verified continuation clears only its recovery fence and preserves prior user scheduling intention', async () => {
  for (const enabled of [true, false]) {
    const repository = new MemoryState(); repository.value.connected = true;
    repository.value.mirrors.push({ id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: true, enabled, phase: 'failed', failure: 'recovery_required', blocker: 'rebuild', lastSuccess: null });
    const provider = new FakeCloudProvider(); let calls = 0;
    Object.assign(provider, { continueInterrupted: async () => { calls++; assert.equal(repository.value.mirrors[0].blocker, 'rebuild'); } });
    const sync = new ICloudSync(provider, repository, () => new Date().toISOString(), () => 'unused', () => {});
    await sync.start(); await sync.continueInterrupted('one');
    assert.equal(calls, 1); assert.equal(sync.status().mirrors[0].blocker, null); assert.equal(sync.status().mirrors[0].enabled, enabled);
    await sync.tick(); assert.equal(provider.synced, enabled ? 1 : 0); await sync.stop();
  }
});
