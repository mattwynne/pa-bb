import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { CloudError } from '../core/ports.ts';
const binary = process.env.RCLONE_TEST_BINARY;
const native = process.platform === 'linux' && !!binary;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test('filesystem access and actual native workers exclude one another on the inherited owner', { skip: !native }, async () => {
  const root = await mkdtemp('/tmp/icloud-note-worker-'); const worker = new RcloneProcess(root + '/worker', binary);
  const entered = deferred(); const release = deferred();
  try {
    await mkdir(root + '/source'); await mkdir(root + '/target');
    await writeFile(root + '/source/generated.md', 'generated');
    const access = worker.withFiles(async signal => { assert.equal(signal.aborted, false); entered.resolve(); await release.promise; return 'read'; });
    await entered.promise;
    await assert.rejects(worker.run(['copy', root + '/source', root + '/target']), (e: any) => e instanceof CloudError && e.category === 'busy');
    await assert.rejects(worker.withFiles(async () => 'second'), /busy/);
    const contender = new RcloneProcess(root + '/worker', binary);
    await assert.rejects(contender.ensure(), /busy/); await contender.stop();
    release.resolve(); assert.equal(await access, 'read');
    await worker.run(['copy', root + '/source', root + '/target']);
    assert.equal(await readFile(root + '/target/generated.md', 'utf8'), 'generated');
  } finally { release.resolve(); await worker.stop(); await rm(root, { recursive: true }); }
});
test('disposal cancels file admission and retains native ownership until file work settles', { skip: !native }, async () => {
  const root = await mkdtemp('/tmp/icloud-note-disposal-'); const worker = new RcloneProcess(root + '/worker', binary);
  const entered = deferred(); const cancelled = deferred(); const release = deferred();
  try {
    const access = worker.withFiles(async signal => { signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); entered.resolve(); await release.promise; });
    await entered.promise; let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; }); await cancelled.promise;
    assert.equal(stopped, false); await assert.rejects(worker.withFiles(async () => {}), /interrupted|busy/);
    const contender = new RcloneProcess(root + '/worker', binary); await assert.rejects(contender.ensure(), /busy/); await contender.stop();
    release.resolve(); await access; await stopping;
    const replacement = new RcloneProcess(root + '/worker', binary); await replacement.withFiles(async () => {}); await replacement.stop();
  } finally { release.resolve(); await worker.stop(); await rm(root, { recursive: true }); }
});
test('a running native transfer returns bounded busy without waiting for the long job', { skip: !native }, async () => {
  const root = await mkdtemp('/tmp/icloud-note-busy-'); const worker = new RcloneProcess(root + '/worker', binary);
  try {
    await mkdir(root + '/source'); await mkdir(root + '/target'); await writeFile(root + '/source/generated.md', Buffer.alloc(12 * 1024 * 1024));
    let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    const transfer = worker.run(['copy', root + '/source', root + '/target', '--disable', 'Copy'], false, () => enter());
    await entered; const start = performance.now();
    await assert.rejects(worker.withFiles(async () => {}), /busy/); assert.ok(performance.now() - start < 500);
    await transfer; await worker.withFiles(async () => {});
  } finally { await worker.stop(); await rm(root, { recursive: true }); }
});
