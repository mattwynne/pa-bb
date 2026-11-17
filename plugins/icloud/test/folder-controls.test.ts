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
    await assert.rejects(f.sync.disconnect(), /busy/);
    f.release.resolve(); await f.running;
    assert.equal(f.sync.status().mirrors[0].phase, 'paused');
    await f.sync.tick(); assert.equal(f.provider.synced, 1);
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
