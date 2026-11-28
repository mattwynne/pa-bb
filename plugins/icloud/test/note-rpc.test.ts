import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRpcContract, experimental_PluginRpcCallError } from '@get-bb/plugin-sdk';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
import { mirrorFileContract } from '../core/mirror-file-contract.ts';
import { statusSchema } from '../contract.ts';
import { FileStore } from '../adapters/file-store.ts';
import { MirrorRuntime } from '../adapters/mirror-runtime.ts';
import { ICloud } from '../../obsidian/adapters/icloud.ts';
import { MarkdownNotes } from '../../obsidian/adapters/markdown-notes.ts';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
async function setup() {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  await plugin(host.bb, { provider: new FakeCloudProvider(), repository: new MemoryState() });
  return host.harness;
}
test('file routes refuse clients, forged identities and mixed-version inputs', async () => {
  const harness = await setup();
  try {
    for (const method of ['mirrorChildren', 'mirrorFindDirectories', 'mirrorConfigure', 'fileRead', 'fileMove', 'fileMoveReceipts', 'fileCommit', 'fileReceipts', 'fileInspectConflict', 'fileResolveConflict'] as const) {
      const input = { folder: 'Projects', version: 1, markerName: '.marker', exclude: [], revision: 1, mirrorId: 'one', mirrorIds: ['one'], path: 'Note.md', destination: 'New.md', operationId: '12345678-1234-7123-8123-123456789abc', kind: 'replace', expectedHash: 'a'.repeat(64), base64: Buffer.from('sentinel-private-content').toString('base64'), token: '12345678-1234-7123-8123-123456789abc', expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'keep_local' };
      const fields: Record<string, string[]> = {
        mirrorChildren: ['version', 'revision', 'mirrorId', 'folder'],
        fileMove: ['version', 'revision', 'mirrorId', 'path', 'destination', 'expectedHash', 'operationId'], fileMoveReceipts: ['version', 'revision', 'mirrorId', 'operationId'],
        mirrorFindDirectories: ['version', 'revision', 'mirrorId', 'markerName', 'exclude'],
        mirrorConfigure: ['version', 'revision', 'mirrorIds'], fileRead: ['version', 'revision', 'mirrorId', 'path'], fileCommit: ['version', 'revision', 'mirrorId', 'path', 'operationId', 'kind', 'expectedHash', 'base64'], fileReceipts: ['version', 'revision', 'mirrorId'], fileInspectConflict: ['version', 'revision', 'mirrorId', 'path'], fileResolveConflict: ['version', 'revision', 'mirrorId', 'path', 'operationId', 'token', 'expectedLogicalHash', 'expectedIncomingHash', 'choice'],
      };
      const value = Object.fromEntries(fields[method].map(field => [field, (input as any)[field]]));
      for (const context of [undefined, { experimental_caller: { kind: 'plugin' as const, pluginId: 'fastmail' } }]) await assert.rejects(harness.behavior.callRpc(method, value, context), /Obsidian/);
      await assert.rejects(harness.behavior.callRpc(method, { ...value, version: 2 }, caller), /input validation/);
      await assert.rejects(harness.behavior.callRpc(method, { ...value, pluginId: 'obsidian' }, caller), /input validation/);
    }
  } finally { await harness.lifecycle.dispose(); }
});
test('missing native owner returns bounded failure without reflecting raw content or paths', async () => {
  const harness = await setup();
  try {
    const result = await harness.behavior.callRpc('mirrorConfigure', { version: 1, revision: 1, mirrorIds: ['one'] }, caller) as any;
    assert.equal(result.category, 'unavailable');
    const children = await harness.behavior.callRpc('mirrorChildren', { version: 1, revision: 1, mirrorId: 'one', folder: 'sentinel-private' }, caller) as any;
    assert.equal(children.category, 'unavailable');
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /iCloud mirror_configure unavailable/); assert.match(logs, /iCloud mirror_list unavailable/);
    assert.doesNotMatch(logs + JSON.stringify(result), /sentinel|Note.md|one|\/tmp\//);
  } finally { await harness.lifecycle.dispose(); }
});

test('directory RPCs require host identity and disclose no path on refusal', async () => {
  const harness = await setup();
  try {
    const status = statusSchema.strict().parse(await harness.behavior.callRpc('status', null));
    assert.equal(status.mirrorAccessVersion, null);
    assert.ok(!Object.hasOwn(status, 'mirrorDirectoryGrantVersion'));
    await assert.rejects(harness.behavior.callRpc('mirrorDirectoryCapabilities', null), { code: 'forbidden' });
    await assert.rejects(harness.behavior.callRpc('mirrorDirectoryCapabilities', null, { experimental_caller: { kind: 'plugin', pluginId: 'fastmail' } }), { code: 'forbidden' });
    await assert.rejects(harness.behavior.callRpc('mirrorDirectoryCapabilities', { pluginId: 'obsidian' }, caller), { code: 'invalid_input' });
    assert.deepEqual(await harness.behavior.callRpc('mirrorDirectoryCapabilities', null, caller), {});
    const request = { mirrorId: 'private-mirror', revision: 1 };
    for (const [method, stage] of [['mirrorDirectory', 'mirror_directory'], ['mirrorDirectoryGrant', 'mirror_directory_grant']]) {
      await assert.rejects(harness.behavior.callRpc(method, request), /host-verified Obsidian/);
      await assert.rejects(harness.behavior.callRpc(method, request, { experimental_caller: { kind: 'plugin', pluginId: 'fastmail' } }), /host-verified Obsidian/);
      for (const input of [{ ...request, directory: '/tmp/sentinel' }, { ...request, pluginId: 'obsidian' }, { ...request, revision: '1' }]) {
        await assert.rejects(harness.behavior.callRpc(method, input, caller), /input validation/);
      }
      await assert.rejects(harness.behavior.callRpc(method, request, caller), /mirror directory is unavailable/);
      assert.match(JSON.stringify(harness.inspection.logEntries), new RegExp(`iCloud ${stage} unavailable`));
    }
    assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /private-mirror|\/tmp\/sentinel/);
  } finally { await harness.lifecycle.dispose(); }
});

test('an old producer has no capability method, which is distinct from an authorization refusal', async () => {
  const old = createFakePluginHost({ pluginId: 'icloud' });
  old.bb.rpc.register(defineRpcContract({ mirrorDirectory: mirrorFileContract.mirrorDirectory }), { mirrorDirectory: () => ({ directory: '/generated' }) });
  try {
    assert.deepEqual(await old.harness.behavior.callRpc('mirrorDirectory', { mirrorId: 'one', revision: 1 }, caller), { directory: '/generated' });
    await assert.rejects(old.harness.behavior.callRpc('mirrorDirectoryCapabilities', null, caller), (error: unknown) => {
      return error instanceof experimental_PluginRpcCallError && error.code === 'unknown_method';
    });
  } finally { await old.harness.lifecycle.dispose(); }
});

test('grant output is strict and carries only canonical unsigned decimal strings', () => {
  const grant = { directory: '/generated', rootDev: '0', rootIno: '9007199254740993' };
  const schema = mirrorFileContract.mirrorDirectoryGrant.output;
  assert.deepEqual(schema.parse(grant), grant);
  for (const malformed of ['', '00', '01', '-1', '+1', '1.0', '1e3', ' 1', '1\n', 1, null, undefined]) {
    assert.equal(schema.safeParse({ ...grant, rootDev: malformed }).success, false);
    assert.equal(schema.safeParse({ ...grant, rootIno: malformed }).success, false);
  }
  assert.equal(schema.safeParse({ ...grant, extra: true }).success, false);
  assert.equal(mirrorFileContract.mirrorDirectory.output.safeParse(grant).success, false);
});

test('a synthetic vault selects Markdown over the same RPC that reads and saves binary files', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const root = join(dirname(host.bb.storage.database().name), 'sync');
  const directory = join(root, 'mirrors/one');
  const baseline = join(root, 'baselines/one');
  const repository = new MemoryState();
  repository.value.mirrors.push({
    id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] },
    initialized: true, enabled: false, phase: 'paused', failure: null, blocker: null, lastSuccess: null,
  });
  const worker = new RcloneProcess(root);
  worker.ensure = async () => {};
  worker.checkAvailability = async () => {};
  worker.call = async () => ({ type: 'alias', remote: 'generated' });
  const runtime = new MirrorRuntime(root, host.bb.storage.database() as Database.Database, worker,
    new FileStore(join(root, 'note-operations')), () => repository.value);
  runtime.wake = () => {};
  const op = () => {
    const time = Date.now().toString(16).padStart(12, '0');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
  };
  try {
    await mkdir(join(directory, 'Vault', '.obsidian'), { recursive: true });
    await mkdir(baseline, { recursive: true });
    await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
    const notePath = 'Vault/Plan.md', filePath = 'Vault/attachment.bin';
    const text = '\uFEFF---\r\nstatus: active\r\n---\r\n# Plan\r\n';
    const binary = Buffer.from([0xff, 0, 0x81]);
    await writeFile(join(directory, notePath), text);
    await writeFile(join(directory, filePath), binary);
    await plugin(host.bb, { repository, worker, runtime });
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input, caller);
    const sdk = { plugins: {
      async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
      async callRpc(request: { method: string; input: unknown; outputSchema: { parse(value: unknown): unknown } }) {
        return request.outputSchema.parse(await rpc(request.method, request.input));
      },
    } } as unknown as ConstructorParameters<typeof ICloud>[0];
    const obsidian = new ICloud(sdk, () => {});
    await obsidian.configure({ revision: 1, vaultIds: ['one'] });
    const target = { version: 1, mirrorId: 'one', revision: 1, path: filePath };
    const before = mirrorFileContract.fileRead.output.parse(await rpc('fileRead', target));
    assert.ok(before.ok && 'base64' in before.value);
    assert.deepEqual(Buffer.from(before.value.base64, 'base64'), binary);
    const replacement = Buffer.from([0, 0xf0, 0x01]);
    const save = mirrorFileContract.fileCommit.output.parse(await rpc('fileCommit', {
      ...target, operationId: op(), kind: 'replace', expectedHash: before.value.hash, base64: replacement.toString('base64'),
    }));
    assert.ok(save.ok);
    const read = mirrorFileContract.fileRead.output.parse(await rpc('fileRead', target));
    assert.ok(read.ok && 'base64' in read.value);
    assert.deepEqual(Buffer.from(read.value.base64, 'base64'), replacement);

    assert.deepEqual(await obsidian.vaultRoots('one', 1), { roots: ['Vault'], incomplete: false });
    assert.deepEqual((await obsidian.children('one', 1, 'Vault')).entries, [
      { name: '.obsidian', kind: 'directory' }, { name: 'Plan.md', kind: 'markdown' },
    ]);
    await assert.rejects(obsidian.read('one', 1, filePath), /invalid_path/);
    const note = await obsidian.read('one', 1, notePath);
    assert.equal(note.text, text);
    assert.equal(new MarkdownNotes().frontmatter(note.text).properties.status, 'active');
    const edit = { mirrorId: 'one', revision: 1, path: notePath, operationId: op(),
      kind: 'replace' as const, expectedHash: note.hash, text: text + '[[Next]]\r\n' };
    const edited = await obsidian.commit(edit);
    assert.equal(edited.outcome, 'saved_locally_pending_sync');
    assert.equal((await obsidian.read('one', 1, notePath)).text, edit.text);
    assert.deepEqual((await obsidian.receipts({ mirrorId: 'one', revision: 1, limit: 20 }))
      .map(receipt => receipt.operationId), [edited.operationId]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('fake-host grant stays additive and authorizes only the current validated binding', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const db = host.bb.storage.database();
  const root = join(dirname(db.name), 'sync');
  const mirrorId = 'private-mirror';
  const directory = join(root, 'mirrors', mirrorId);
  const baseline = join(root, 'baselines', mirrorId);
  const repository = new MemoryState();
  repository.value.mirrors.push({ id: mirrorId, folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: true, enabled: false, phase: 'paused', failure: null, blocker: null, lastSuccess: null });
  const worker = new RcloneProcess(root);
  worker.ensure = async () => {};
  worker.checkAvailability = async () => {};
  worker.call = async method => { assert.equal(method, 'config/get'); return { type: 'alias', remote: 'generated' }; };
  try {
    await mkdir(directory, { recursive: true });
    await mkdir(baseline, { recursive: true });
    await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
    await plugin(host.bb, { repository, worker });
    const { behavior } = host.harness;
    const status = statusSchema.strict().parse(await behavior.callRpc('status', null));
    assert.equal(status.mirrorAccessVersion, 3);
    assert.ok(!Object.hasOwn(status, 'mirrorDirectoryGrantVersion'));
    assert.deepEqual(await behavior.callRpc('mirrorDirectoryCapabilities', null, caller), { mirrorDirectoryGrantVersion: 1 });
    assert.equal(mirrorFileContract.mirrorDirectoryCapabilities.output.safeParse({ mirrorDirectoryGrantVersion: 2 }).success, false);
    assert.equal(mirrorFileContract.mirrorDirectoryCapabilities.output.safeParse({ directory }).success, false);
    assert.equal(status.mirrors[0].filesystem, 'ready');
    const target = { mirrorId, revision: 1 };
    const requestGrant = () => behavior.callRpc('mirrorDirectoryGrant', target, caller);
    const fence = () => db.prepare('SELECT mirror_id FROM icloud_note_direct').all();
    await assert.rejects(requestGrant(), /connected folder selection/);
    await behavior.callRpc('mirrorConfigure', { version: 1, revision: 1, mirrorIds: [mirrorId] }, caller);
    await assert.rejects(behavior.callRpc('mirrorDirectoryGrant', { ...target, revision: 0 }, caller), /connected folder selection/);
    await assert.rejects(behavior.callRpc('mirrorDirectoryGrant', { ...target, mirrorId: 'other' }, caller), /connected folder selection/);
    assert.deepEqual(fence(), []);
    const { dev, ino } = await lstat(directory, { bigint: true });
    assert.deepEqual(await requestGrant(), { directory, rootDev: dev.toString(), rootIno: ino.toString() });
    assert.deepEqual(fence(), [{ mirror_id: mirrorId }]);
    assert.deepEqual(await behavior.callRpc('mirrorDirectory', target, caller), { directory });
    await rename(directory, `${directory}-original`);
    await mkdir(directory);
    await assert.rejects(requestGrant(), error => {
      assert.match(String(error), /mirror directory is unavailable/);
      assert.ok(!String(error).includes(directory));
      return true;
    });
    const publicData = JSON.stringify([status, await behavior.callRpc('inventory', null), await behavior.callRpc('diagnostics', null)]);
    assert.ok(!publicData.includes(directory));
    assert.doesNotMatch(publicData, /rootDev|rootIno/);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /iCloud mirror_directory_grant source_changed/);
    assert.ok(!logs.includes(directory));
    assert.doesNotMatch(logs, /private-mirror|rootDev|rootIno/);
  } finally { await host.harness.lifecycle.dispose(); }
});

const binary = process.env.RCLONE_TEST_BINARY;
test('wired direct mirror pushes an Obsidian change at once, scans on schedule and keeps staging out of the replica', { skip: !binary, timeout: 20000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const root = join(dirname(host.bb.storage.database().name), 'sync');
  const generated = await mkdtemp('/tmp/icloud-direct-rpc-');
  const remote = join(generated, 'generated');
  const directory = join(root, 'mirrors/one');
  const baseline = join(root, 'baselines/one');
  const prepare = new RcloneProcess(root, binary);
  const worker = new RcloneProcess(root, binary);
  const repository = new MemoryState();
  repository.value.connected = true;
  repository.value.mirrors.push({ id: 'one', folder: { id: 'Z2VuZXJhdGVk', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null });
  let runs = 0;
  const run = worker.run.bind(worker);
  worker.run = async (...args) => { runs++; return run(...args); };
  try {
    await mkdir(remote);
    await writeFile(join(remote, 'Existing.md'), 'existing');
    await prepare.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: generated }, opt: { nonInteractive: true } });
    await mkdir(directory, { recursive: true });
    await mkdir(baseline, { recursive: true });
    await prepare.run(syncArguments('icloud:generated', directory, baseline, true));
    await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
    await prepare.stop();
    await plugin(host.bb, { repository, worker });
    const { behavior } = host.harness;
    const status = async () => await behavior.callRpc('status', null) as any;
    const initial = await status();
    assert.equal(initial.mirrorFileAccessVersion, 1);
    assert.equal(initial.mirrorAccessVersion, 3);
    assert.equal(initial.mirrors[0].filesystem, 'ready');
    assert.deepEqual(Object.keys(initial.mirrors[0].local).sort(), ['applicationBlocker', 'available', 'pendingAgeMs', 'reason']);
    const target = { mirrorId: 'one', revision: 1 };
    await assert.rejects(behavior.callRpc('mirrorDirectory', target, caller), /connected folder selection/);
    await behavior.callRpc('mirrorConfigure', { version: 1, revision: 1, mirrorIds: ['one'] }, caller);
    assert.deepEqual(await behavior.callRpc('mirrorDirectory', target, caller), { directory });
    const stages = ['.bb-mirror-', '.obsidian-bb-'].map(prefix => prefix + '12345678-1234-7123-8123-123456789abc.tmp');
    for (const stage of stages) await writeFile(join(directory, stage), 'temporary bytes');
    await writeFile(join(directory, 'Published.md'), 'direct local edit');
    const push = { mirrorId: 'one', change: { kind: 'write', path: 'Published.md' } };
    await assert.rejects(behavior.callRpc('pushChange', push, { experimental_caller: { kind: 'client' as const } }), /host-verified Obsidian/);
    assert.equal(await behavior.callRpc('pushChange', push, caller), null);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await readFile(join(remote, 'Published.md'), 'utf8').catch(() => null)) break;
      await delay(50);
    }
    assert.equal(await readFile(join(remote, 'Published.md'), 'utf8'), 'direct local edit');
    assert.equal(runs, 0, 'a push does not start a scan');
    assert.ok(host.harness.inspection.logEntries.some(entry => /iCloud direct_push sent kind=write elapsedMs=\d+/.test(JSON.stringify(entry))));
    await writeFile(join(remote, 'Inbound.md'), 'cloud-only edit');
    await behavior.runSchedule('selected-folder-sync');
    assert.equal(runs, 1);
    assert.equal(await readFile(join(directory, 'Inbound.md'), 'utf8'), 'cloud-only edit');
    for (const stage of stages) await assert.rejects(readFile(join(remote, stage)), { code: 'ENOENT' });
    assert.ok((await status()).mirrors[0].lastSuccess);
    const publicData = JSON.stringify([await status(), await behavior.callRpc('inventory', null), await behavior.callRpc('diagnostics', null), host.harness.inspection.logEntries]);
    assert.ok(!publicData.includes(directory));
    assert.doesNotMatch(publicData, /temporary bytes|direct local edit|cloud-only edit/);
  } finally {
    await host.harness.lifecycle.dispose();
    await worker.stop();
    await prepare.stop();
    await rm(generated, { recursive: true, force: true });
  }
});
