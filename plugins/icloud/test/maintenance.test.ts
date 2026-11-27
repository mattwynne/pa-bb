import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type Database from 'better-sqlite3';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import type { Mirror, State } from '../core/ports.ts';
import { statusSchema } from '../contract.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';

const runId = '11111111-1111-4111-8111-111111111111';
const otherRun = '22222222-2222-4222-8222-222222222222';
const updater = { experimental_caller: { kind: 'plugin' as const, pluginId: 'pa-updates' } };
const obsidian = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
const defer = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
function mirror(id: string, properties: Partial<Mirror> = {}): Mirror {
  return { id, folder: { id: 'Z2VuZXJhdGVk', name: 'PRIVATE_SENTINEL', ancestors: [] }, initialized: true,
    enabled: true, phase: 'ready', lastSuccess: '2026-10-01T00:00:00.000Z', failure: null, blocker: null, ...properties };
}
function commands({ harness }: ReturnType<typeof createFakePluginHost>) {
  const run = async (action: string, id?: string, signal?: AbortSignal) => {
    const result = await harness.behavior.runCli(['maintenance', action, '--json', ...(id ? ['--run-id', id] : [])], { signal });
    assert.doesNotMatch(result.stdout ?? '', /PRIVATE_SENTINEL/);
    assert.doesNotMatch(result.stderr ?? '', /PRIVATE_SENTINEL/);
    return { code: result.exitCode, value: JSON.parse(result.stdout!) };
  };
  return { run, status: async () => (await run('status')).value,
    rpcStatus: async () => statusSchema.parse(await harness.behavior.callRpc('status', null)) };
}
const until = async (condition: () => Promise<boolean>) => {
  for (let attempts = 0; attempts < 200; attempts++) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail('synthetic iCloud work did not drain');
};

test('CLI hold closes sync admission, survives reload, and restores only eligible prior scheduling', { timeout: 10000 }, async () => {
  let host = createFakePluginHost({ pluginId: 'icloud' });
  const { behavior } = host.harness;
  let cli = commands(host);
  const provider = new FakeCloudProvider();
  const repository = new MemoryState();
  repository.value.connected = true;
  repository.value.mirrors = [
    mirror('running'), mirror('healthy'), mirror('pause-during-hold'),
    mirror('user-paused', { enabled: false, phase: 'paused' }),
    mirror('failed', { phase: 'failed', failure: 'configuration', blocker: 'configuration' }),
  ];
  const entered = defer(), complete = defer();
  const sync = provider.synchronize.bind(provider);
  provider.synchronize = (...args) => { entered.release(); return sync(...args); };
  provider.pending = complete.promise;
  provider.fail = 'sync_failed';
  try {
    await plugin(host.bb, { repository, provider });
    await until(async () => (await cli.rpcStatus()).connectionCheck === 'verified');
    const before = structuredClone(repository.value);
    assert.equal((await cli.status()).runId, null);
    assert.deepEqual(repository.value, before, 'status is read-only');
    const running = behavior.runSchedule('selected-folder-sync');
    await entered.promise;
    const [first, overlap] = await Promise.all([cli.run('pause', runId), cli.run('pause', otherRun)]);
    assert.equal(first.code, 0);
    assert.deepEqual(first.value, { admissionPaused: true, active: true, ready: false, runId,
      previouslyEnabled: 4, lastRestore: null, persistence: 'confirmed', updaterHeld: false });
    assert.equal(overlap.value.error.code, 'busy');
    assert.equal((await cli.run('restore', runId)).value.error.code, 'busy');
    assert.equal((await cli.run('pause', runId)).value.previouslyEnabled, 4);
    assert.deepEqual((await cli.rpcStatus()).maintenance, { admissionPaused: true, active: true, ready: false });
    await assert.rejects(behavior.callRpc('pause', { updateJob: otherRun }, updater), /operation/);
    await assert.rejects(behavior.callRpc('enable', { id: 'user-paused' }), /operation/);
    await behavior.callRpc('pause', { id: 'pause-during-hold' });
    complete.release();
    await running;
    await behavior.runSchedule('selected-folder-sync');
    assert.equal(provider.synced, 1, 'the admitted sync finished and subsequent folders never started');
    await until(async () => (await cli.status()).ready);
    assert.equal((await cli.rpcStatus()).mirrors[0].retryPending, false);
    host = await host.harness.lifecycle.reload(bb => plugin(bb, { repository, provider }));
    cli = commands(host);
    assert.equal((await cli.status()).runId, runId);
    await until(async () => (await cli.status()).ready);
    assert.equal((await cli.run('restore', otherRun)).value.error.code, 'busy');
    const restored = (await cli.run('restore', runId)).value;
    assert.equal(restored.runId, null);
    assert.deepEqual(restored.lastRestore, { runId, restored: 1, leftPaused: 3 });
    assert.deepEqual((await cli.run('restore', runId)).value, restored, 'repeat restore is receipt read-back');
    assert.equal((await cli.run('pause', runId)).value.error.code, 'busy');
    assert.deepEqual(repository.value.mirrors.map(({ enabled, phase, failure, blocker, lastSuccess }) => [enabled, phase, failure, blocker, lastSuccess]), [
      [false, 'failed', 'sync_failed', null, before.mirrors[0].lastSuccess],
      [true, 'ready', null, null, before.mirrors[1].lastSuccess],
      [false, 'paused', null, null, before.mirrors[2].lastSuccess],
      [false, 'paused', null, null, before.mirrors[3].lastSuccess],
      [false, 'failed', 'configuration', 'configuration', before.mirrors[4].lastSuccess],
    ]);
    assert.equal(provider.synced, 1, 'restore does not start a sync');
    await host.harness.behavior.callRpc('pause', { updateJob: otherRun }, updater);
    assert.equal((await cli.status()).updaterHeld, true);
    assert.equal((await cli.run('pause', '33333333-3333-4333-8333-333333333333')).value.error.code, 'busy');
    await host.harness.behavior.callRpc('enable', { updateJob: otherRun }, updater);
  } finally { complete.release(); await host.harness.lifecycle.dispose(); }
});

test('cancellation and uncertain writes reconcile by run receipt without logging private content', async () => {
  let host = createFakePluginHost({ pluginId: 'icloud' });
  const repository = new MemoryState();
  let cli = commands(host);
  const save = repository.save.bind(repository), load = repository.load.bind(repository);
  const writing = defer(), finish = defer();
  const cancel = new AbortController();
  try {
    await plugin(host.bb, { repository, provider: new FakeCloudProvider() });
    assert.equal((await cli.run('pause', otherRun, AbortSignal.abort())).value.error.code, 'busy');
    assert.equal((await cli.status()).runId, null);
    repository.save = async (state: State) => {
      await save(state);
      writing.release();
      await finish.promise;
      throw new Error('PRIVATE_SENTINEL path/password');
    };
    const pause = cli.run('pause', runId, cancel.signal);
    await writing.promise;
    cancel.abort();
    assert.equal((await cli.status()).persistence, 'writing');
    assert.equal((await cli.status()).ready, false);
    finish.release();
    assert.equal((await pause).code, 0);
    assert.equal((await cli.status()).runId, runId);
    repository.load = async () => { throw new Error('PRIVATE_SENTINEL read-back'); };
    assert.equal((await cli.run('restore', runId)).value.error.code, 'unavailable');
    const unconfirmed = await cli.status();
    assert.equal(unconfirmed.persistence, 'unconfirmed');
    assert.equal(unconfirmed.admissionPaused, true);
    assert.equal(unconfirmed.ready, false);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /iCloud maintenance_write unavailable/);
    assert.doesNotMatch(logs, /PRIVATE_SENTINEL/);
    repository.load = load;
    repository.save = save;
    host = await host.harness.lifecycle.reload(bb => plugin(bb, { repository, provider: new FakeCloudProvider() }));
    cli = commands(host);
    assert.deepEqual((await cli.status()).lastRestore, { runId, restored: 0, leftPaused: 0 });
    assert.equal((await cli.status()).persistence, 'confirmed');
    repository.save = async () => { throw new Error('PRIVATE_SENTINEL rejected write'); };
    assert.equal((await cli.run('pause', otherRun)).value.error.code, 'unavailable');
    assert.equal((await cli.status()).runId, null);
    assert.equal((await cli.status()).persistence, 'confirmed');
  } finally { finish.release(); await host.harness.lifecycle.dispose(); }
});

const binary = process.env.RCLONE_TEST_BINARY;
test('native note work drains through the hold while the existing owner and baseline are preserved', { skip: !binary, timeout: 30000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const db = host.bb.storage.database() as Database.Database;
  const root = join(dirname(db.name), 'sync'), baseline = join(root, 'baselines', 'one');
  const remote = await mkdtemp('/tmp/icloud-maintenance-');
  const directory = join(root, 'mirrors', 'one');
  const worker = new RcloneProcess(root, binary);
  const challenger = new RcloneProcess(root, binary);
  const repository = new MemoryState();
  repository.value = { connected: true, challenge: null, mirrors: [mirror('one')] };
  const notes = new NoteStore(join(root, 'note-operations'));
  const runtime = new NoteRuntime(root, db, worker, notes, () => repository.value);
  const beforeHead = defer(), finish = defer();
  try {
    await mkdir(join(remote, 'generated'));
    await writeFile(join(remote, 'generated', 'Note.md'), 'A');
    await worker.ensure();
    await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote }, opt: { nonInteractive: true } });
    await mkdir(directory); await mkdir(baseline);
    await worker.run(syncArguments('icloud:generated', directory, baseline, true));
    await writeFile(join(baseline, 'initialized'), '1', { mode: 0o600 });
    const baselineBytes = async () => Promise.all((await readdir(baseline)).sort().map(name => readFile(join(baseline, name))));
    const original = await baselineBytes();
    await plugin(host.bb, { repository, worker, runtime });
    const cli = commands(host);
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input, obsidian) as Promise<any>;
    await rpc('noteConfigure', { version: 2, revision: 1, mirrorIds: ['one'] });
    Object.assign(runtime.overlay, { fault: async (stage: string) => {
      if (stage === 'before_head') { beforeHead.release(); await finish.promise; }
    } });
    const target = { version: 2, mirrorId: 'one', revision: 1, path: 'Note.md' };
    const operationId = `${Date.now().toString(16).padStart(12, '0').replace(/^(........)/, '$1-')}-7111-8111-111111111111`;
    const save = rpc('noteCommit', { ...target, operationId, kind: 'replace', text: 'B', expectedHash: createHash('sha256').update('A').digest('hex') });
    await beforeHead.promise;
    const hold = (await cli.run('pause', runId)).value;
    assert.equal(hold.admissionPaused, true);
    assert.equal(hold.active, true);
    assert.equal(hold.ready, false);
    assert.equal((await rpc('noteRead', target)).category, 'busy');
    await assert.rejects(rpc('mirrorDirectory', { mirrorId: 'one', revision: 1 }), /paused new mirror access/);
    await assert.rejects(challenger.ensure(), { category: 'busy' });
    finish.release();
    assert.equal((await save).value.outcome, 'saved_locally_pending_sync');
    await until(async () => (await cli.status()).ready);
    assert.equal(await readFile(join(directory, 'Note.md'), 'utf8'), 'B');
    assert.equal(await readFile(join(remote, 'generated', 'Note.md'), 'utf8'), 'A');
    assert.deepEqual(await baselineBytes(), original);
    assert.equal((await cli.run('restore', runId)).value.lastRestore.restored, 1);
    assert.equal((await rpc('noteRead', target)).value.text, 'B');
  } finally { finish.release(); await host.harness.lifecycle.dispose(); await worker.stop(); await challenger.stop(); await rm(remote, { recursive: true, force: true }); }
});
