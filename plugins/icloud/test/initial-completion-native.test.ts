// Generated-only host-faithful RPC + real inherited-flock/native bisync tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, symlink, link, chmod, rename, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { CloudError } from '../core/ports.ts';
import { MemoryState } from './fakes.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_RUNTIME_NATIVE === '1';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const operationId = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
async function fixture(bandwidth?: string) {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const root = join(dirname(host.bb.storage.database().name), 'sync');
  const generated = await mkdtemp('/tmp/icloud-completion-'), remote = join(generated, 'remote');
  const repository = new MemoryState(); repository.value.connected = true;
  const worker = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!, bandwidth);
  const runtime = new NoteRuntime(root, host.bb.storage.database(), worker, new NoteStore(join(root, 'note-operations')), () => repository.value);
  const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<any>;
  const commands: string[][] = [];
  const run = worker.run.bind(worker);
  worker.run = async (...args) => { commands.push(args[0]); return run(...args); };
  try {
    for (const folder of ['Reference', 'Downloads']) {
      await mkdir(join(remote, folder), { recursive: true });
      await writeFile(join(remote, folder, 'Generated.md'), 'Initial generated content');
      await writeFile(join(remote, folder, 'Unchanged.md'), 'Unchanged');
    }
    await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote }, opt: { nonInteractive: true } });
    await plugin(host.bb, { repository, worker, runtime });
    for (let i = 0; i < 100 && (await rpc('status', null)).connectionCheck === 'unknown'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const folders = await rpc('browse', { parent: null });
    // Establish the pre-existing account binding, just as another healthy
    // initialized mirror would. Then reproduce the old registerMirror bug.
    await rpc('select', { folderId: folders.find((item: any) => item.name === 'Reference').id });
    const reference = (await rpc('status', null)).mirrors[0];
    await rpc('enable', { id: reference.id }); await rpc('pause', { id: reference.id });
    const register = runtime.registerMirror.bind(runtime);
    runtime.registerMirror = async () => runtime.idleFiles(async () => {
      try { await worker.call('config/get', { name: 'icloud' }); }
      catch { throw new CloudError('source_changed'); }
    });
    await rpc('select', { folderId: folders.find((item: any) => item.name === 'Downloads').id });
    const id = (await rpc('status', null)).mirrors[1].id;
    await rpc('enable', { id }); runtime.registerMirror = register;
    const failed = (await rpc('status', null)).mirrors[1];
    assert.equal(failed.failure, 'source_changed'); assert.equal(failed.blocker, 'initialization');
    assert.equal(failed.initialized, false); assert.equal(failed.enabled, false);
    const local = join(root, 'mirrors', id), baseline = join(root, 'baselines', id), marker = join(baseline, 'initialized');
    assert.equal(await readFile(marker, 'utf8'), '1');
    const before = structuredClone(repository.value.mirrors[1]);
    return { host, root, generated, remote, repository, worker, runtime, rpc, id, local, baseline, marker, commands, before,
      async close() { await host.harness.lifecycle.dispose(); await rm(generated, { recursive: true, force: true }); } };
  } catch (error) { await runtime.stop(); await host.harness.lifecycle.dispose(); await rm(generated, { recursive: true, force: true }); throw error; }
}

test('explicit RPC completes an actual downloaded/failed registration in place, paused; ordinary bidirectional follow-up works', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const rootBefore = await stat(f.local), baselineBefore = await stat(f.baseline);
    const originalHistory = (await f.rpc('diagnostics', {})).runs;
    const result = await f.rpc('completeInitialRegistration', { id: f.id });
    const mirror = result.mirrors[1];
    assert.equal(mirror.id, f.id); assert.equal(mirror.initialized, true); assert.equal(mirror.enabled, false);
    assert.equal(mirror.phase, 'paused'); assert.equal(mirror.failure, null); assert.equal(mirror.blocker, null);
    assert.equal(mirror.initialCompletionAttempted, true); assert.equal(mirror.local.available, true);
    assert.equal((await stat(f.local)).ino, rootBefore.ino); assert.equal((await stat(f.baseline)).ino, baselineBefore.ino);
    assert.equal(await readFile(f.marker, 'utf8'), '1');
    assert.deepEqual((await f.rpc('diagnostics', {})).runs.slice(0, 2), originalHistory);
    await assert.rejects(f.rpc('completeInitialRegistration', { id: f.id }), /paused for recovery/);
    const note = (method: string, input: unknown) => f.host.harness.behavior.callRpc(method, input, caller) as Promise<any>;
    assert.equal((await note('noteConfigure', { version: 2, revision: 1, mirrorIds: [f.id] })).ok, true);
    const target = { version: 2, revision: 1, mirrorId: f.id, path: 'Generated.md' };
    assert.equal((await note('noteRead', target)).value.text, 'Initial generated content');
    assert.equal((await note('noteCommit', { ...target, operationId: operationId(), kind: 'replace', expectedHash: hash('Initial generated content'), text: 'Local generated edit' })).ok, true);
    for (let i = 0; i < 100 && await readFile(join(f.local, 'Generated.md'), 'utf8') !== 'Local generated edit'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await f.host.harness.behavior.runSchedule('selected-folder-sync');
    assert.equal(await readFile(join(f.remote, 'Downloads/Generated.md'), 'utf8'), 'Initial generated content', 'completion must not auto-enable');
    await f.rpc('enable', { id: f.id }); await f.host.harness.behavior.runSchedule('selected-folder-sync');
    assert.equal(await readFile(join(f.remote, 'Downloads/Generated.md'), 'utf8'), 'Local generated edit');
    await writeFile(join(f.remote, 'Downloads/Generated.md'), 'A longer remote generated change');
    await f.host.harness.behavior.runSchedule('selected-folder-sync');
    assert.equal((await note('noteRead', target)).value.text, 'A longer remote generated change');
    assert.equal(f.commands.filter(args => args.includes('--resync')).length, 2);
    assert.equal(f.commands.length, 5);
    assert.ok(f.commands.every(args => !args.includes('--force')));
    assert.equal((await f.rpc('status', null)).mirrors.length, 2);
  } finally { await f.close(); }
});

for (const variant of ['missing_marker', 'symlink_marker', 'hardlink_marker', 'public_marker', 'wrong_marker', 'public_root', 'root_binding', 'folder_binding', 'account', 'missing_account'] as const) test(`initial completion refuses ${variant}, preserving original data and safe stop`, { skip: !enabled, timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    if (variant === 'missing_marker') await unlink(f.marker);
    if (variant === 'symlink_marker') { await rename(f.marker, join(f.generated, 'marker')); await symlink(join(f.generated, 'marker'), f.marker); }
    if (variant === 'hardlink_marker') await link(f.marker, join(f.generated, 'marker-link'));
    if (variant === 'missing_account') f.host.bb.storage.database().exec('DELETE FROM icloud_note_account');
    if (variant === 'public_marker') await chmod(f.marker, 0o644);
    if (variant === 'wrong_marker') await writeFile(f.marker, '0');
    if (variant === 'public_root') await chmod(f.local, 0o755);
    if (variant === 'account') await f.runtime.call('config/update', { name: 'icloud', parameters: { remote: f.generated }, opt: { nonInteractive: true } });
    if (variant === 'root_binding' || variant === 'folder_binding') {
      // A registration may have bound the filesystem before failing later.
      await f.runtime.registerMirror({ ...f.before, blocker: null });
      if (variant === 'root_binding') {
        await rename(f.local, join(f.generated, 'preserved')); await mkdir(f.local, { mode: 0o700 });
        await writeFile(join(f.local, 'Generated.md'), 'Replacement must not be sent');
      } else f.host.bb.storage.database().prepare('UPDATE icloud_note_bindings SET folder_id=? WHERE mirror_id=?').run(Buffer.from('Reference').toString('base64url'), f.id);
    }
    const result = await f.rpc('completeInitialRegistration', { id: f.id });
    const mirror = result.mirrors[1];
    assert.equal(mirror.initialized, false); assert.equal(mirror.enabled, false); assert.equal(mirror.phase, 'failed');
    assert.equal(mirror.failure, 'source_changed'); assert.equal(mirror.blocker, 'initialization');
    assert.equal(mirror.initialCompletionAttempted, true); assert.equal(f.commands.length, 2, 'refuse before native work');
    assert.equal(await readFile(join(f.remote, 'Downloads/Generated.md'), 'utf8'), 'Initial generated content');
    const attempt = (await f.rpc('diagnostics', {})).runs.at(-1);
    assert.equal(attempt.outcome, 'failed');
    await assert.rejects(f.rpc('completeInitialRegistration', { id: f.id }), /paused for recovery/);
    assert.equal(f.commands.length, 2);
    assert.doesNotMatch(JSON.stringify(f.host.harness.inspection.logEntries), /Initial generated|Generated\.md/);
  } finally { await f.close(); }
});

test('ordinary native baseline failure is not converted into forced resync or repeatable completion', { skip: !enabled, timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const listings = (await readdir(f.baseline)).filter(name => name.endsWith('.lst'));
    assert.ok(listings.length >= 2);
    for (const name of listings) await unlink(join(f.baseline, name));
    const result = await f.rpc('completeInitialRegistration', { id: f.id });
    assert.equal(result.mirrors[1].initialized, false); assert.equal(result.mirrors[1].enabled, false);
    assert.equal(result.mirrors[1].failure, 'source_changed'); assert.equal(result.mirrors[1].initialCompletionAttempted, true);
    assert.equal(f.commands.length, 3); assert.ok(!f.commands[2].includes('--resync'));
    assert.equal((await f.rpc('diagnostics', {})).runs.at(-1).outcome, 'failed');
    assert.equal(await readFile(join(f.local, 'Generated.md'), 'utf8'), 'Initial generated content');
    await assert.rejects(f.rpc('completeInitialRegistration', { id: f.id }), /paused for recovery/);
  } finally { await f.close(); }
});

test('native uncertain failure is one-shot, safely diagnosed, and retains the original failure and files', { skip: !enabled, timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    f.worker.run = async args => { f.commands.push(args); throw new CloudError('recovery_required', { kind: 'command_exit', exitCode: 7, native: 'unknown_fatal' }); };
    const result = await f.rpc('completeInitialRegistration', { id: f.id });
    assert.deepEqual(f.repository.value.mirrors[1], { ...f.before, initialCompletionAttempted: true });
    assert.equal(result.mirrors[1].local.available, false);
    await f.host.harness.behavior.runSchedule('selected-folder-sync');
    await assert.rejects(f.rpc('completeInitialRegistration', { id: f.id }), /paused for recovery/);
    assert.equal(f.commands.length, 3);
    const run = (await f.rpc('diagnostics', {})).runs.at(-1);
    assert.equal(run.failure, 'recovery_required'); assert.equal(run.evidence.native, 'unknown_fatal');
    assert.match(JSON.stringify(f.host.harness.inspection.logEntries), /initial_completion\/checking.*recovery_required.*unknown_fatal/);
    assert.equal(await readFile(join(f.local, 'Generated.md'), 'utf8'), 'Initial generated content');
    assert.equal(await readFile(f.marker, 'utf8'), '1');
  } finally { await f.close(); }
});

for (const boundary of ['post_native_account', 'post_native_index'] as const) test(`successful native completion still fails closed at ${boundary}`, { skip: !enabled, timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    if (boundary === 'post_native_index') f.runtime.overlay.indexLegacy = async () => { throw new Error('PRIVATE_SENTINEL index failure'); };
    if (boundary === 'post_native_account') {
      const run = f.worker.run.bind(f.worker);
      f.worker.run = async (...args) => {
        const result = await run(...args);
        await f.worker.call('config/update', { name: 'icloud', parameters: { remote: f.generated }, opt: { nonInteractive: true } });
        return result;
      };
    } else f.runtime.overlay.indexLegacy = async () => { throw new Error('PRIVATE_SENTINEL indexing body'); };
    const result = await f.rpc('completeInitialRegistration', { id: f.id });
    assert.equal(result.mirrors[1].initialized, false); assert.equal(result.mirrors[1].enabled, false);
    assert.equal(result.mirrors[1].failure, 'source_changed'); assert.equal(result.mirrors[1].initialCompletionAttempted, true);
    assert.equal(f.commands.length, 3);
    assert.equal((await f.rpc('diagnostics', {})).runs.at(-1).outcome, 'failed');
    assert.doesNotMatch(JSON.stringify(f.host.harness.inspection.logEntries), /PRIVATE_SENTINEL/);
    assert.equal(await readFile(f.marker, 'utf8'), '1');
  } finally { await f.close(); }
});

test('shutdown interrupts an actual native completion transfer and leaves the consumed failed mirror stopped', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture('512k');
  let complete: Promise<any> | undefined;
  try {
    await writeFile(join(f.remote, 'Downloads/generated-transfer.bin'), Buffer.alloc(8 * 1024 * 1024, 65));
    complete = f.rpc('completeInitialRegistration', { id: f.id });
    for (let i = 0; i < 200 && !(f.worker as any).children.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok((f.worker as any).children.size, 'real native CLI entered the completion turn');
    await f.runtime.stop(); await complete.catch(() => {});
    assert.deepEqual(f.repository.value.mirrors[1], { ...f.before, initialCompletionAttempted: true });
    assert.equal(await readFile(f.marker, 'utf8'), '1');
    assert.equal(await readFile(join(f.local, 'Generated.md'), 'utf8'), 'Initial generated content');
    assert.equal(f.commands.filter(args => args.includes('--resync')).length, 2);
  } finally { await complete?.catch(() => {}); await f.close(); }
});

test('completion excludes concurrent controls/native turns and shutdown retains ownership until drain', { skip: !enabled, timeout: 20000 }, async () => {
  const f = await fixture(); const entered = gate(), release = gate();
  let complete: Promise<any> | undefined, queued: Promise<any> | undefined;
  try {
    const run = f.worker.run.bind(f.worker);
    f.worker.run = async (...args) => { entered.release(); await release.promise; return run(...args); };
    complete = f.rpc('completeInitialRegistration', { id: f.id }); await entered.promise;
    assert.deepEqual(f.repository.value.mirrors[1], { ...f.before, initialCompletionAttempted: true });
    assert.equal((await f.rpc('status', null)).mirrors[1].completingInitial, true);
    await assert.rejects(f.rpc('completeInitialRegistration', { id: f.id }), /still running/);
    await assert.rejects(f.rpc('enable', { id: f.id }), /still running/);
    let queuedFinished = false;
    queued = f.runtime.call('rc/noop', {}).then(() => { queuedFinished = true; }, () => { queuedFinished = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(queuedFinished, false);
    let disposed = false; const disposal = f.host.harness.lifecycle.dispose().then(() => { disposed = true; });
    const challenger = new RcloneProcess(f.root, process.env.RCLONE_TEST_BINARY!);
    await assert.rejects(challenger.ensure(), /busy/); await challenger.stop();
    assert.equal(disposed, false);
    release.release(); await complete.catch(() => {}); await queued; await disposal;
    assert.deepEqual(f.repository.value.mirrors[1], { ...f.before, initialCompletionAttempted: true });
  } finally { release.release(); await complete?.catch(() => {}); await queued?.catch(() => {}); await f.close(); }
});
