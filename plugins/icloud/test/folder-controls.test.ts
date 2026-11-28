import test from 'node:test';
import assert from 'node:assert/strict';
import { ICloudSync } from '../core/service.ts';
import { CloudError } from '../core/ports.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  const provider = new FakeCloudProvider(); const repository = new MemoryState(); let id = 0;
  const sync = new ICloudSync(provider, repository, () => '2026-11-16T12:00:00Z', () => `mirror-${++id}`, () => {});
  await sync.start(); await sync.connect({ account: 'synthetic', password: 'synthetic' }); await sync.answerChallenge('123456');
  await sync.browse(null); await sync.select('test'); await sync.enable('mirror-1');
  const entered = deferred(); const release = deferred();
  provider.synchronize = async () => { provider.synced++; entered.resolve(); await release.promise; if (provider.fail) throw new CloudError(provider.fail); };
  const running = sync.tick(); await entered.promise;
  return { sync, provider, repository, release, running };
}
test('browse, select and Pause work while a scheduled native sync is held open', async () => {
  const f = await fixture();
  try {
    assert.equal(f.sync.status().mirrors[0].phase, 'running');
    assert.equal((await f.sync.browse(null)).length, 2);
    await f.sync.select('other');
    await assert.rejects(f.sync.select('other'), /invalid_selection/);
    await f.sync.pause('mirror-1');
    assert.equal(f.sync.status().mirrors[0].enabled, false);
    assert.equal(f.sync.status().mirrors[0].phase, 'running');
    assert.equal(f.repository.value.mirrors[0].enabled, false);
    assert.deepEqual(f.sync.activity(), { admissionPaused: true, busy: true }); // Pause is not drain completion.
    await assert.rejects(f.sync.disconnect(), /busy/);
    f.release.resolve(); await f.running;
    assert.equal(f.sync.status().mirrors[0].phase, 'paused');
    assert.deepEqual(f.sync.activity(), { admissionPaused: true, busy: false });
    await f.sync.tick(); assert.equal(f.provider.synced, 1);
    await f.sync.stop();
    const restarted = new ICloudSync(f.provider, f.repository, () => '2026-11-16T12:00:00Z', () => 'unused', () => {});
    await restarted.start();
    assert.equal(restarted.status().mirrors[0].phase, 'paused');
    assert.equal(restarted.status().mirrors[0].failure, null);
    assert.equal(restarted.status().mirrors[0].enabled, false);
    await restarted.stop();
  } finally { f.release.resolve(); await f.running; await f.sync.stop(); }
});
test('enabling a selected folder during sync schedules preparation without a second native run', async () => {
  const f = await fixture();
  try {
    await f.sync.browse(null); await f.sync.select('other'); await f.sync.enable('mirror-2');
    assert.equal(f.provider.prepared, 1);
    assert.equal(f.sync.status().mirrors[1].enabled, true);
    f.release.resolve(); await f.running; await f.sync.tick();
    assert.equal(f.provider.prepared, 2);
    assert.equal(f.sync.status().mirrors[1].initialized, true);
  } finally { f.release.resolve(); await f.running; await f.sync.stop(); }
});
test('Pause during a failed sync preserves the failure and stops retries', async () => {
  const f = await fixture();
  try {
    f.provider.fail = 'sync_failed'; await f.sync.pause('mirror-1'); f.release.resolve(); await f.running;
    const mirror = f.sync.status().mirrors[0];
    assert.equal(mirror.phase, 'failed'); assert.equal(mirror.failure, 'sync_failed'); assert.equal(mirror.retryPending, false);
  } finally { f.release.resolve(); await f.running; await f.sync.stop(); }
});
test('a directory authorization failure remains a reconnect stop after the native child finishes', async () => {
  const f = await fixture();
  try {
    f.provider.listFolders = async () => { throw new CloudError('authentication'); };
    await assert.rejects(f.sync.browse(null), /authentication/);
    f.release.resolve(); await f.running;
    assert.equal(f.sync.status().connected, false);
    assert.equal(f.sync.status().mirrors[0].blocker, 'reconnect');
    assert.equal(f.sync.status().mirrors[0].failure, 'authentication');
  } finally { f.release.resolve(); await f.running; await f.sync.stop(); }
});
test('shutdown drains a folder listing and rejects new controls', async () => {
  const f = await fixture(); const listed = deferred(); const entered = deferred();
  try {
    f.provider.listFolders = async () => { entered.resolve(); await listed.promise; return []; };
    const browsing = f.sync.browse(null); await entered.promise;
    let stopped = false; const stopping = f.sync.stop().then(() => { stopped = true; });
    f.release.resolve(); await f.running; assert.equal(stopped, false);
    await assert.rejects(f.sync.browse(null), /busy/);
    listed.resolve(); await browsing; await stopping;
  } finally { listed.resolve(); f.release.resolve(); await f.running; await f.sync.stop(); }
});

test('failed run checkpoint leaves a live mirror eligible for the next poll without starting native work', async () => {
  const provider = new FakeCloudProvider();
  const repository = new MemoryState();
  repository.value.connected = true;
  repository.value.mirrors.push({ id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null });
  const entered = deferred();
  const release = deferred();
  const save = repository.save.bind(repository);
  let fail = true;
  repository.save = async state => {
    if (fail && state.mirrors[0].phase === 'running') {
      entered.resolve();
      await release.promise;
      throw new Error('PRIVATE_SENTINEL');
    }
    await save(state);
  };
  const logs: string[] = [];
  const sync = new ICloudSync(provider, repository, () => new Date().toISOString(), () => 'unused', (stage, failure) => logs.push(`${stage} ${failure}`));
  await sync.start();
  try {
    const tick = sync.tick();
    await entered.promise;
    const paused = sync.pause('one');
    release.resolve();
    await Promise.all([tick, paused]);
    assert.equal(provider.synced, 0);
    assert.equal(sync.status().mirrors[0].progress, null);
    assert.equal(repository.value.mirrors[0].phase, 'paused');
    assert.equal((await sync.diagnostics()).active, null);
    assert.deepEqual(logs, ['sync/persist_start unknown']);
    fail = false;
    await sync.enable('one');
    await sync.tick();
    assert.equal(provider.synced, 1);
    assert.equal(repository.value.mirrors[0].phase, 'ready');
  } finally { release.resolve(); await sync.stop(); }
});

test('a failed initial run checkpoint can be retried by the ordinary schedule after the storage error clears', async () => {
  const provider = new FakeCloudProvider();
  const repository = new MemoryState();
  repository.value.connected = true;
  repository.value.mirrors.push({ id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: false, enabled: false, phase: 'paused', failure: null, blocker: null, lastSuccess: null });
  const save = repository.save.bind(repository);
  repository.save = async state => {
    if (state.mirrors[0].phase === 'running') throw new Error('PRIVATE_SENTINEL');
    await save(state);
  };
  const sync = new ICloudSync(provider, repository, () => new Date().toISOString(), () => 'unused', () => {});
  await sync.start();
  try {
    await assert.rejects(sync.enable('one'), /unavailable/);
    assert.equal(provider.prepared, 0);
    assert.equal(sync.status().mirrors[0].phase, 'ready');
    repository.save = save;
    await sync.tick();
    assert.equal(provider.prepared, 1);
    assert.equal(repository.value.mirrors[0].initialized, true);
  } finally { await sync.stop(); }
});

test('a finished ordinary scan is reported once; a failed scan is not', async () => {
  const provider = new FakeCloudProvider(); const repository = new MemoryState(); let id = 0;
  const sync = new ICloudSync(provider, repository, () => '2026-11-16T12:00:00Z', () => `mirror-${++id}`, () => {});
  await sync.start(); await sync.connect({ account: 'synthetic', password: 'synthetic' }); await sync.answerChallenge('123456');
  await sync.browse(null); await sync.select('test'); await sync.enable('mirror-1');
  const reported: string[] = [];
  sync.onSynced = mirrorId => { reported.push(mirrorId); throw new Error('a consumer failure cannot fail the scan'); };
  await sync.tick();
  assert.equal(provider.synced, 1);
  assert.deepEqual(reported, ['mirror-1']);
  assert.equal(sync.status().mirrors[0].failure, null);
  provider.fail = 'sync_failed';
  await sync.tick();
  assert.equal(provider.synced, 2);
  assert.deepEqual(reported, ['mirror-1']);
});
