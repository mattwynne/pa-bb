import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRpcContract, experimental_PluginRpcCallError } from '@get-bb/plugin-sdk';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
import { noteRpcContract } from '../core/note-contract.ts';
import { statusSchema } from '../contract.ts';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
async function setup() {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  await plugin(host.bb, { provider: new FakeCloudProvider(), repository: new MemoryState() });
  return host.harness;
}
test('v2 routes refuse clients, forged identities and mixed-version inputs before accessing notes', async () => {
  const harness = await setup();
  try {
    for (const method of ['noteChildren', 'noteSearch', 'noteSearchClose', 'noteConfigure', 'noteList', 'noteRead', 'noteMove', 'noteMoveReceipts', 'noteCommit', 'noteReceipts', 'noteInspectConflict', 'noteResolveConflict'] as const) {
      const input = { folder: 'Projects', version: 2, searchVersion: 1, projection: 'hits', cursor: '12345678-1234-7123-8123-123456789abc', revision: 1, mirrorId: 'one', mirrorIds: ['one'], path: 'Note.md', destination: 'New.md', operationId: '12345678-1234-7123-8123-123456789abc', kind: 'replace', expectedHash: 'a'.repeat(64), text: 'sentinel-private-content', token: '12345678-1234-7123-8123-123456789abc', expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'keep_local' };
      const fields: Record<string, string[]> = {
        noteChildren: ['version', 'revision', 'mirrorId', 'folder'],
        noteMove: ['version', 'revision', 'mirrorId', 'path', 'destination', 'expectedHash', 'operationId'], noteMoveReceipts: ['version', 'revision', 'mirrorId', 'operationId'],
        noteSearch: ['version', 'searchVersion', 'projection', 'revision', 'mirrorId', 'text'], noteSearchClose: ['version', 'revision', 'cursor'],
        noteConfigure: ['version', 'revision', 'mirrorIds'], noteList: ['version', 'revision', 'mirrorId'], noteRead: ['version', 'revision', 'mirrorId', 'path'], noteCommit: ['version', 'revision', 'mirrorId', 'path', 'operationId', 'kind', 'expectedHash', 'text'], noteReceipts: ['version', 'revision', 'mirrorId'], noteInspectConflict: ['version', 'revision', 'mirrorId', 'path'], noteResolveConflict: ['version', 'revision', 'mirrorId', 'path', 'operationId', 'token', 'expectedLogicalHash', 'expectedIncomingHash', 'choice'],
      };
      const value = Object.fromEntries(fields[method].map(field => [field, (input as any)[field]]));
      for (const context of [undefined, { experimental_caller: { kind: 'plugin' as const, pluginId: 'fastmail' } }]) await assert.rejects(harness.behavior.callRpc(method, value, context), /Obsidian/);
      await assert.rejects(harness.behavior.callRpc(method, { ...value, version: 1 }, caller), /input validation/);
      await assert.rejects(harness.behavior.callRpc(method, { ...value, pluginId: 'obsidian' }, caller), /input validation/);
    }
  } finally { await harness.lifecycle.dispose(); }
});
test('missing native owner returns bounded failure without reflecting raw content or paths', async () => {
  const harness = await setup();
  try {
    const result = await harness.behavior.callRpc('noteConfigure', { version: 2, revision: 1, mirrorIds: ['one'] }, caller) as any;
    assert.equal(result.category, 'unavailable');
    const search = await harness.behavior.callRpc('noteSearch', { version: 2, searchVersion: 1, revision: 1, mirrorId: 'one', projection: 'hits', text: 'sentinel-private' }, caller) as any;
    assert.equal(search.category, 'unavailable');
    const children = await harness.behavior.callRpc('noteChildren', { version: 2, revision: 1, mirrorId: 'one', folder: 'sentinel-private' }, caller) as any;
    assert.equal(children.category, 'unavailable');
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /iCloud note_configure unavailable/); assert.match(logs, /iCloud note_search unavailable/);
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
  old.bb.rpc.register(defineRpcContract({ mirrorDirectory: noteRpcContract.mirrorDirectory }), { mirrorDirectory: () => ({ directory: '/generated' }) });
  try {
    assert.deepEqual(await old.harness.behavior.callRpc('mirrorDirectory', { mirrorId: 'one', revision: 1 }, caller), { directory: '/generated' });
    await assert.rejects(old.harness.behavior.callRpc('mirrorDirectoryCapabilities', null, caller), (error: unknown) => {
      return error instanceof experimental_PluginRpcCallError && error.code === 'unknown_method';
    });
  } finally { await old.harness.lifecycle.dispose(); }
});

test('grant output is strict and carries only canonical unsigned decimal strings', () => {
  const grant = { directory: '/generated', rootDev: '0', rootIno: '9007199254740993' };
  const schema = noteRpcContract.mirrorDirectoryGrant.output;
  assert.deepEqual(schema.parse(grant), grant);
  for (const malformed of ['', '00', '01', '-1', '+1', '1.0', '1e3', ' 1', '1\n', 1, null, undefined]) {
    assert.equal(schema.safeParse({ ...grant, rootDev: malformed }).success, false);
    assert.equal(schema.safeParse({ ...grant, rootIno: malformed }).success, false);
  }
  assert.equal(schema.safeParse({ ...grant, extra: true }).success, false);
  assert.equal(noteRpcContract.mirrorDirectory.output.safeParse(grant).success, false);
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
    assert.equal(noteRpcContract.mirrorDirectoryCapabilities.output.safeParse({ mirrorDirectoryGrantVersion: 2 }).success, false);
    assert.equal(noteRpcContract.mirrorDirectoryCapabilities.output.safeParse({ directory }).success, false);
    assert.equal(status.mirrors[0].filesystem, 'ready');
    const target = { mirrorId, revision: 1 };
    const requestGrant = () => behavior.callRpc('mirrorDirectoryGrant', target, caller);
    const fence = () => db.prepare('SELECT mirror_id FROM icloud_note_direct').all();
    await assert.rejects(requestGrant(), /connected vault selection/);
    await behavior.callRpc('noteConfigure', { version: 2, revision: 1, mirrorIds: [mirrorId] }, caller);
    await assert.rejects(behavior.callRpc('mirrorDirectoryGrant', { ...target, revision: 0 }, caller), /connected vault selection/);
    await assert.rejects(behavior.callRpc('mirrorDirectoryGrant', { ...target, mirrorId: 'other' }, caller), /connected vault selection/);
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
test('wired direct mirror wakes native sync on an existing baseline and keeps staging out of the replica', { skip: !binary, timeout: 20000 }, async () => {
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
    assert.equal(initial.noteAccessVersion, 2);
    assert.equal(initial.mirrorAccessVersion, 3);
    assert.equal(initial.mirrors[0].filesystem, 'ready');
    assert.deepEqual(Object.keys(initial.mirrors[0].local).sort(), ['applicationBlocker', 'available', 'pendingAgeMs', 'reason']);
    const target = { mirrorId: 'one', revision: 1 };
    await assert.rejects(behavior.callRpc('mirrorDirectory', target, caller), /connected vault selection/);
    await behavior.callRpc('noteConfigure', { version: 2, revision: 1, mirrorIds: ['one'] }, caller);
    assert.deepEqual(await behavior.callRpc('mirrorDirectory', target, caller), { directory });
    const stage = '.obsidian-bb-12345678-1234-7123-8123-123456789abc.tmp';
    await writeFile(join(directory, stage), 'temporary bytes');
    await writeFile(join(directory, 'Published.md'), 'direct local edit');
    for (let attempt = 0; attempt < 100 && !(await status()).mirrors[0].lastSuccess; attempt++) await delay(75);
    assert.equal(await readFile(join(remote, 'Published.md'), 'utf8'), 'direct local edit');
    await assert.rejects(readFile(join(remote, stage)), { code: 'ENOENT' });
    assert.ok((await status()).mirrors[0].lastSuccess);
    await delay(550);
    assert.equal(runs, 1);
    await writeFile(join(remote, 'Inbound.md'), 'cloud-only edit');
    await behavior.runSchedule('selected-folder-sync');
    assert.equal(await readFile(join(directory, 'Inbound.md'), 'utf8'), 'cloud-only edit');
    await delay(550);
    assert.equal(runs, 2);
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
