import test from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { emptyState } from '../core/ports.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('only exact cloud directory reads share native work, and drain before the next turn', async () => {
  const entered = deferred(); const release = deferred(); const listed = deferred(); const listing = deferred(); const calls: string[] = [];
  const worker = {
    async run() { entered.resolve(); await release.promise; return ''; },
    async call(method: string) { calls.push(method); if (method === 'operations/list') { listing.resolve(); await listed.promise; } return { list: [] }; },
    requestStop() {}, async stop() {},
  } as unknown as RcloneProcess;
  // No startup/admission or filesystem operation is invoked in this turn test.
  const runtime = new NoteRuntime('/synthetic', {} as Database.Database, worker, new NoteStore('/synthetic'), emptyState);
  const running = runtime.run(['copy', '/synthetic/source', '/synthetic/target']);
  try {
    await entered.promise;
    const read = runtime.call('operations/list', { fs: 'icloud:', remote: '', opt: { dirsOnly: true } });
    await listing.promise;
    const config = runtime.call('config/get', { name: 'icloud' });
    const files = runtime.call('operations/list', { fs: '/synthetic/local', remote: '', opt: { dirsOnly: true } });
    const nonDirectory = runtime.call('operations/list', { fs: 'icloud:', remote: '', opt: { dirsOnly: false } });
    assert.deepEqual(calls, ['operations/list']);
    release.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['operations/list']);
    listed.resolve(); await read; await running; await config; await files; await nonDirectory;
    assert.deepEqual(calls, ['operations/list', 'config/get', 'operations/list', 'operations/list']);
  } finally { release.resolve(); listed.resolve(); await running; await runtime.stop(); }
});

test('owned native worker lists cloud directories during a real throttled transfer without opening mirror files', { skip: process.platform !== 'linux' || !process.env.RCLONE_TEST_BINARY, timeout: 30_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-directory-native-');
  const { bb, harness } = createFakePluginHost({ pluginId: 'icloud' });
  const worker = new RcloneProcess(root + '/worker', process.env.RCLONE_TEST_BINARY!, '512k');
  const runtime = new NoteRuntime(root + '/worker', bb.storage.database() as Database.Database, worker, new NoteStore(root + '/notes'), emptyState);
  let running: Promise<unknown> | undefined;
  try {
    await mkdir(root + '/remote/Folder', { recursive: true }); await mkdir(root + '/target');
    await writeFile(root + '/remote/generated.bin', Buffer.alloc(3 * 1024 * 1024));
    await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: root + '/remote' }, opt: { nonInteractive: true } });
    await runtime.start(); const entered = deferred(); let finished = false;
    running = runtime.run(['copy', root + '/remote', root + '/target', '--disable', 'Copy'], false, () => entered.resolve()).then(() => { finished = true; });
    await entered.promise;
    const at = performance.now();
    const result = await runtime.call('operations/list', { fs: 'icloud:', remote: '', opt: { dirsOnly: true } });
    assert.deepEqual(result.list.map((item: { Name: string }) => item.Name), ['Folder']);
    assert.ok(performance.now() - at < 2_000); assert.equal(finished, false);
    await assert.rejects(worker.withFiles(async () => {}), /busy/);
    await running;
  } finally { await running?.catch(() => {}); await runtime.stop(); await harness.lifecycle.dispose(); await rm(root, { recursive: true, force: true }); }
});
