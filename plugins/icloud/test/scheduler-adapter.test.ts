import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { RcloneCloudProvider, treeSize } from '../adapters/rclone-cloud-provider.ts';
import { CloudError } from '../core/ports.ts';
import type { Mirror } from '../core/ports.ts';
import { MemoryState } from './fakes.ts';
import { statusSchema } from '../contract.ts';
import { diagnosticsSchema } from '../core/diagnostics.ts';

const binary = process.env.RCLONE_TEST_BINARY;
const mirror: Mirror = { id: 'mirror-1', folder: { id: Buffer.from('Test Vault').toString('base64url'), name: 'Test Vault', ancestors: [] }, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null, blocker: null };

test('whole plugin scheduler and stock adapter recover bounded capture failures and restored running state', { skip: !binary, timeout: 90_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-scheduler-adapter-'); const cloud = root + '/cloud/Test Vault'; const workerRoot = root + '/worker'; await mkdir(cloud, { recursive: true });
  const repository = new MemoryState(); let process = new RcloneProcess(workerRoot, binary); let listing = 0; let failListing = 0; let mutateAfterCloudCopy: (() => Promise<void>) | null = null;
  const provider = () => new RcloneCloudProvider(workerRoot, (method, body) => process.call(method, body), async (args, capture, report) => {
    if (args[0] === 'lsjson' && ++listing === failListing) throw new CloudError('sync_failed', { kind: 'command_exit', exitCode: 5 });
    const result = await process.run(args, capture, report);
    if (args[0] === 'copy' && args[1].startsWith('icloud:') && mutateAfterCloudCopy) { const mutate = mutateAfterCloudCopy; mutateAfterCloudCopy = null; await mutate(); }
    return result;
  }, () => process.checkAvailability(), () => process.stop());
  const put = async (text: string, offset = 0) => { const path = cloud + '/note.md'; await writeFile(path, text); const time = new Date(Date.now() + 5_000 + offset); await utimes(path, time, time); };
  let host = createFakePluginHost({ pluginId: 'icloud' });
  try {
    await process.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: root + '/cloud' }, opt: { nonInteractive: true } });
    await put('original'); for (let i = 0; i < 4; i++) await writeFile(`${cloud}/stable-${i}.md`, `stable-${i}`);
    const initialProvider = provider(); await initialProvider.prepareMirror(mirror); mirror.initialized = true; mirror.enabled = true; mirror.phase = 'ready'; mirror.lastSuccess = '2026-01-01T00:00:00.000Z';
    repository.value = { connected: true, challenge: null, mirrors: [structuredClone(mirror)] };
    await plugin(host.bb, { provider: initialProvider, repository });

    await put('first-list-retry', 1); listing = 0; failListing = 1; await host.harness.behavior.runSchedule('selected-folder-sync');
    let state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].retryPending, true);
    listing = 0; failListing = 0; await host.harness.behavior.runSchedule('selected-folder-sync'); state = statusSchema.parse(await host.harness.behavior.callRpc('status', null));
    const firstRetryHistory = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', null));
    assert.equal(await readFile(workerRoot + '/mirrors/mirror-1/note.md', 'utf8'), 'first-list-retry', JSON.stringify({ state, runs: firstRetryHistory.runs }));

    await put('second-list-retry', 2);
    for (let attempt = 0; attempt < 2; attempt++) {
      listing = 0; failListing = 2; await host.harness.behavior.runSchedule('selected-folder-sync');
      assert.equal((await readdir(workerRoot + '/backups')).filter(name => name.startsWith('staging-')).length, 1);
      assert.ok(await treeSize(workerRoot + '/backups') <= 1024 * 1024 * 1024);
    }
    listing = 0; failListing = 0; await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(await readFile(workerRoot + '/mirrors/mirror-1/note.md', 'utf8'), 'second-list-retry');

    await put('changes-during-capture', 3); mutateAfterCloudCopy = () => put('stable-after-change', 4); listing = 0;
    await host.harness.behavior.runSchedule('selected-folder-sync'); state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].failure, 'source_changed'); assert.equal(state.mirrors[0].retryPending, true);
    await host.harness.behavior.runSchedule('selected-folder-sync'); assert.equal(await readFile(workerRoot + '/mirrors/mirror-1/note.md', 'utf8'), 'stable-after-change');
    const history = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', null)); assert.deepEqual(history.runs.map(run => run.outcome), ['failed', 'succeeded', 'failed', 'failed', 'succeeded', 'failed', 'succeeded']);

    await host.harness.lifecycle.dispose(); repository.value.mirrors[0].phase = 'running'; repository.value.mirrors[0].enabled = true;
    process = new RcloneProcess(workerRoot, binary); listing = 0; failListing = 0; host = createFakePluginHost({ pluginId: 'icloud' }); await plugin(host.bb, { provider: provider(), repository });
    state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].retryPending, true); assert.equal(state.mirrors[0].failure, 'interrupted');
    await host.harness.behavior.runSchedule('selected-folder-sync'); state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].phase, 'ready'); assert.equal(state.mirrors[0].failure, null);
  } finally { await host.harness.lifecycle.dispose().catch(() => {}); await process.stop(); await rm(root, { recursive: true }); }
});
