import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { RcloneCloudProvider } from '../adapters/rclone-cloud-provider.ts';
import { CloudError } from '../core/ports.ts';
import type { Mirror } from '../core/ports.ts';
import { MemoryState } from './fakes.ts';
import { statusSchema } from '../contract.ts';
import { diagnosticsSchema } from '../core/diagnostics.ts';

const binary = process.env.RCLONE_TEST_BINARY;
const mirror: Mirror = { id: 'mirror-1', folder: { id: Buffer.from('Test Vault').toString('base64url'), name: 'Test Vault', ancestors: [] }, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null, blocker: null };

test('ordinary Retry uses only native bisync, preserves opaque legacy copies and never replaces an initialized mirror', { skip: !binary, timeout: 90_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-native-retry-'); const cloud = root + '/cloud/Test Vault'; const workerRoot = root + '/worker';
  await mkdir(cloud, { recursive: true }); await writeFile(cloud + '/note.md', 'kept cloud version');
  const process = new RcloneProcess(workerRoot, binary); const repository = new MemoryState(); const host = createFakePluginHost({ pluginId: 'icloud' });
  let failNext = false; const commands: string[][] = [];
  const provider = new RcloneCloudProvider(workerRoot, (method, body) => process.call(method, body), async (args, capture, report) => {
    assert.equal(args[0], 'bisync'); commands.push(args);
    if (failNext) { failNext = false; throw new CloudError('sync_failed', { kind: 'command_exit', exitCode: 1 }); }
    return process.run(args, capture, report);
  }, () => process.checkAvailability(), () => process.stop());
  try {
    await process.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: root + '/cloud' }, opt: { nonInteractive: true } });
    await provider.prepareMirror(mirror);
    repository.value = { connected: true, challenge: null, mirrors: [{ ...mirror, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00.000Z' }] };
    await plugin(host.bb, { provider, repository });
    failNext = true; await host.harness.behavior.runSchedule('selected-folder-sync');
    await host.harness.behavior.callRpc('pause', { id: mirror.id });
    const stage = workerRoot + '/backups/staging-unknown'; await mkdir(stage, { recursive: true }); await writeFile(stage + '/unique.partial', 'old recovery evidence');
    commands.length = 0;
    const status = statusSchema.parse(await host.harness.behavior.callRpc('retry', { id: mirror.id }));
    assert.equal(status.mirrors.length, 1); assert.equal(status.mirrors[0].id, mirror.id); assert.equal(status.mirrors[0].phase, 'ready');
    assert.equal(status.mirrors[0].enabled, true); assert.equal(status.mirrors[0].failure, null);
    assert.equal(await readFile(workerRoot + '/mirrors/' + mirror.id + '/note.md', 'utf8'), 'kept cloud version');
    assert.equal(await readFile(workerRoot + '/baselines/' + mirror.id + '/initialized', 'utf8'), '1');
    assert.equal(await readFile(stage + '/unique.partial', 'utf8'), 'old recovery evidence');
    assert.deepEqual(await readdir(workerRoot + '/backups'), ['staging-unknown']);
    assert.equal(commands.length, 1); assert.ok(commands.every(args => !args.includes('--resync')));
    const history = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', null));
    assert.deepEqual(history.runs.map(run => run.outcome), ['failed', 'succeeded']); assert.equal(history.runs[0].failure, 'sync_failed');
    assert.deepEqual(history.runs[0].evidence, { kind: 'command_exit', exitCode: 1 });
    assert.ok(history.runs.every(run => run.stages.every(stage => ['checking', 'transferring', 'verifying'].includes(stage.stage))));
  } finally { await host.harness.lifecycle.dispose().catch(() => {}); await process.stop(); await rm(root, { recursive: true }); }
});

test('scheduler retries native interruption, respects Pause across reload, and preserves stronger critical blockers', { skip: !binary, timeout: 90_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-native-scheduler-'); const cloud = root + '/cloud/Test Vault'; const workerRoot = root + '/worker'; await mkdir(cloud, { recursive: true });
  const repository = new MemoryState(); let process = new RcloneProcess(workerRoot, binary); let failure: CloudError | null = null; const commands: string[][] = [];
  const provider = () => new RcloneCloudProvider(workerRoot, (method, body) => process.call(method, body), async (args, capture, report) => {
    assert.equal(args[0], 'bisync'); commands.push(args);
    if (failure) { const error = failure; failure = null; throw error; }
    return process.run(args, capture, report);
  }, () => process.checkAvailability(), () => process.stop());
  const put = async (text: string, offset = 0) => { const path = cloud + '/note.md'; await writeFile(path, text); const time = new Date(Date.now() + 5_000 + offset); await utimes(path, time, time); };
  let host = createFakePluginHost({ pluginId: 'icloud' });
  try {
    await process.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: root + '/cloud' }, opt: { nonInteractive: true } });
    await put('original'); for (let i = 0; i < 4; i++) await writeFile(`${cloud}/stable-${i}.md`, `stable-${i}`);
    const first = provider(); await first.prepareMirror(mirror);
    repository.value = { connected: true, challenge: null, mirrors: [{ ...mirror, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00.000Z' }] };
    await plugin(host.bb, { provider: first, repository }); commands.length = 0;
    await put('retry succeeds', 1); failure = new CloudError('interrupted', { kind: 'command_timeout' });
    await host.harness.behavior.runSchedule('selected-folder-sync');
    let state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].retryPending, true);
    assert.equal(state.mirrors[0].lastSuccess, '2026-01-01T00:00:00.000Z');
    await host.harness.behavior.runSchedule('selected-folder-sync');
    assert.equal(await readFile(workerRoot + '/mirrors/mirror-1/note.md', 'utf8'), 'retry succeeds');

    failure = new CloudError('sync_failed', { kind: 'command_exit', exitCode: 5 }); await host.harness.behavior.runSchedule('selected-folder-sync');
    await host.harness.behavior.callRpc('pause', { id: mirror.id }); await host.harness.lifecycle.dispose();
    process = new RcloneProcess(workerRoot, binary); host = createFakePluginHost({ pluginId: 'icloud' }); await plugin(host.bb, { provider: provider(), repository });
    const stopped = commands.length; await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(commands.length, stopped);
    state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].enabled, false); assert.equal(state.mirrors[0].failure, 'sync_failed');
    await host.harness.behavior.callRpc('retry', { id: mirror.id });

    await host.harness.lifecycle.dispose(); repository.value.mirrors[0].phase = 'running'; repository.value.mirrors[0].enabled = true;
    process = new RcloneProcess(workerRoot, binary); host = createFakePluginHost({ pluginId: 'icloud' }); await plugin(host.bb, { provider: provider(), repository });
    state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].retryPending, true); assert.equal(state.mirrors[0].failure, 'interrupted');
    await host.harness.behavior.runSchedule('selected-folder-sync');
    state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].phase, 'ready'); assert.equal(state.mirrors[0].failure, null);
    failure = new CloudError('recovery_required', { kind: 'command_exit', exitCode: 7 }); await host.harness.behavior.runSchedule('selected-folder-sync');
    const blocked = commands.length; await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(commands.length, blocked);
    await host.harness.lifecycle.dispose(); process = new RcloneProcess(workerRoot, binary); host = createFakePluginHost({ pluginId: 'icloud' }); await plugin(host.bb, { provider: provider(), repository });
    await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(commands.length, blocked);
    state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].blocker, 'rebuild');
    assert.ok(commands.every(args => !args.includes('--resync'))); assert.ok(!(await readdir(workerRoot)).includes('backups'));
  } finally { await host.harness.lifecycle.dispose().catch(() => {}); await process.stop(); await rm(root, { recursive: true }); }
});
