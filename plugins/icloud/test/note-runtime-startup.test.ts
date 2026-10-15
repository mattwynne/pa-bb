// Generated local Linux fixtures. The real plugin entry point must acquire
// ownership before sync-state writes as well as before overlay migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { MemoryState } from './fakes.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_RUNTIME_NATIVE === '1';

test('plugin startup cannot write sync state or migrate history before owning the native generation', { skip: !enabled, timeout: 20000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const db = host.bb.storage.database();
  const root = join(dirname(db.name), 'sync');
  const owner = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!);
  const candidate = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!);
  const repository = new MemoryState();
  let saves = 0;
  const save = repository.save.bind(repository);
  repository.save = async state => { saves++; await save(state); };
  try {
    await owner.ensure();
    await assert.rejects(plugin(host.bb, { repository, worker: candidate }), (error: any) => error.category === 'busy');
    assert.equal(saves, 0, 'a rejected replacement must not rewrite the predecessor sync state');
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'icloud_%'").all(), [], 'history and note migrations both require ownership');
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /iCloud note_owner busy/);
  } finally {
    await candidate.stop(); await owner.stop(); await host.harness.lifecycle.dispose();
  }
});

test('failed plugin initialization releases acquired ownership without leaking raw storage errors', { skip: !enabled, timeout: 20000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const root = join(dirname(host.bb.storage.database().name), 'sync');
  const candidate = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!);
  const replacement = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!);
  const repository = new MemoryState();
  repository.save = async () => { throw new Error('sentinel-private-storage-content'); };
  try {
    await assert.rejects(plugin(host.bb, { repository, worker: candidate }), (error: any) => error.category === 'unavailable' && !String(error).includes('sentinel'));
    await replacement.ensure();
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel-private-storage-content/);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /iCloud startup unknown/);
  } finally {
    await candidate.stop(); await replacement.stop(); await host.harness.lifecycle.dispose();
  }
});
