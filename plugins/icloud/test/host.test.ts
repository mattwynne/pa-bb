import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
import { statusSchema } from '../contract.ts';
import { diagnosticsSchema } from '../core/diagnostics.ts';
import { CloudError, activity } from '../core/ports.ts';
import type { CloudFolder } from '../core/ports.ts';
const setup = async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState();
  await plugin(host.bb, { provider, repository }); return { ...host, provider, repository };
};
test('first run registers only an inventory tool and a durable one-minute schedule', async () => {
  const { harness, provider } = await setup();
  try {
    const configuration = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.deepEqual(configuration.tools.map(t => t.name), ['icloud_list_local_folders']);
    assert.equal(statusSchema.parse(await harness.behavior.callRpc('status', null)).connected, false);
    assert.equal(provider.prepared + provider.synced, 0);
    assert.equal(harness.inspection.registrations.schedules[0].name, 'selected-folder-sync');
    await harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test('credentials and codes cross only protected HTTP forms, never inventory or logs', async () => {
  const { harness, provider } = await setup();
  try {
    const start = await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'synthetic@example.test', password: 'sentinel-password' }) });
    assert.equal(start.status, 200); assert.equal((await start.json()).challenge, 'verification_code');
    const done = await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    assert.equal(done.status, 200); assert.equal((await done.json()).connected, true);
    const folders = await harness.behavior.callRpc('browse', { parent: null }) as CloudFolder[];
    await harness.behavior.callRpc('select', { folderId: folders[0].id });
    assert.equal(provider.prepared + provider.synced, 0);
    const mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0];
    await harness.behavior.callRpc('enable', { id: mirror.id });
    const inventory = await harness.behavior.callRpc('inventory', null) as unknown[]; assert.equal(inventory.length, 1);
    assert.doesNotMatch(JSON.stringify([inventory, harness.inspection.logEntries]), /sentinel-password|123456|synthetic@example/);
    await harness.behavior.callRpc('disconnect', null); assert.equal((await harness.behavior.callRpc('inventory', null) as unknown[]).length, 1);
  } finally { await harness.lifecycle.dispose(); }
});
test('other plugins cannot invoke sync consent or account controls', async () => {
  const { harness } = await setup();
  try {
    const context = { experimental_caller: { kind: 'plugin' as const, pluginId: 'fastmail' } };
    for (const [method, input] of [['disconnect', null], ['browse', { parent: null }], ['select', { folderId: 'test' }], ['enable', { id: 'mirror-1' }], ['retry', { id: 'mirror-1' }], ['pause', { id: 'mirror-1' }]] as const) await assert.rejects(harness.behavior.callRpc(method, input, context), /settings/);
  } finally { await harness.lifecycle.dispose(); }
});
test('host-verified updater owns only its Pause reservation; clients and other plugins cannot forge it', async () => {
  const { harness, provider, bb } = await setup();
  const updater = { experimental_caller: { kind: 'plugin' as const, pluginId: 'pa-updates' } };
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id;
    await harness.behavior.callRpc('enable', { id });
    const updateJob = '11111111-1111-4111-8111-111111111111';
    await assert.rejects(harness.behavior.callRpc('pause', { updateJob }), /host-verified/);
    await assert.rejects(harness.behavior.callRpc('pause', { updateJob }, { experimental_caller: { kind: 'plugin', pluginId: 'fastmail' } }), /host-verified/);
    await assert.rejects(harness.behavior.callRpc('enable', { id }, updater), /settings/);
    await harness.behavior.callRpc('pause', { updateJob }, updater);
    assert.deepEqual(await bb.storage.kv.get('pa-update-pause-v1'), { jobId: updateJob, ownedIds: [id] });
    assert.equal(statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].enabled, false);
    for (const method of ['enable', 'retry', 'rebuild']) await assert.rejects(harness.behavior.callRpc(method, { id }), /operation/);
    await assert.rejects(harness.behavior.callRpc('enable', { updateJob: '22222222-2222-4222-8222-222222222222' }, updater), /operation/);
    const synced = provider.synced; await harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, synced);
    await harness.behavior.callRpc('enable', { updateJob }, updater);
    assert.equal(statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].enabled, true);
    assert.equal(provider.synced, synced, 'resume does not invent a new manual sync');
    for (const [method, input] of [['disconnect', null], ['browse', { parent: null }], ['select', { folderId: 'test' }], ['retry', { id }], ['rebuild', { id }]] as const) await assert.rejects(harness.behavior.callRpc(method, input, updater), /settings/);
  } finally { await harness.lifecycle.dispose(); }
});
test('user Pause during draining stays paused after the updater reservation and reload', async () => {
  const first = await setup(), updater = { experimental_caller: { kind: 'plugin' as const, pluginId: 'pa-updates' } };
  const { harness, provider, repository, bb } = first;
  const updateJob = '11111111-1111-4111-8111-111111111111';
  let release!: () => void, entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' }); await harness.behavior.callRpc('select', { folderId: 'other' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id;
    await harness.behavior.callRpc('enable', { id });
    provider.pending = new Promise<void>(resolve => { release = resolve; });
    const synchronize = provider.synchronize.bind(provider);
    provider.synchronize = async (...args) => { entered(); await synchronize(...args); };
    const running = harness.behavior.runSchedule('selected-folder-sync'); await entering;
    await harness.behavior.callRpc('pause', { updateJob }, updater); // Reservation closes future scheduling, current native turn drains.
    release(); await running;
    await harness.behavior.callRpc('pause', { id }); // User acts before updater's next drain poll.
    await harness.behavior.callRpc('pause', { updateJob }, updater);
    assert.ok(statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors.every(mirror => !mirror.enabled));
    await assert.rejects(harness.behavior.callRpc('enable', { id }), /operation/);
    const saved = await bb.storage.kv.get('pa-update-pause-v1');
    await harness.lifecycle.dispose();
    const next = createFakePluginHost({ pluginId: 'icloud' });
    await next.bb.storage.kv.set('pa-update-pause-v1', JSON.parse(JSON.stringify(saved)));
    try {
      await plugin(next.bb, { provider, repository });
      assert.equal(statusSchema.parse(await next.harness.behavior.callRpc('status', null)).updatePause?.jobId, updateJob);
      await next.harness.behavior.callRpc('enable', { updateJob }, updater);
      assert.ok(statusSchema.parse(await next.harness.behavior.callRpc('status', null)).mirrors.every(mirror => !mirror.enabled));
    } finally { await next.harness.lifecycle.dispose(); }
  } finally { release?.(); await harness.lifecycle.dispose(); }
});
test('an already-failed folder stays paused but releases updater ownership across reload so ordinary retry works', async () => {
  const { harness, provider, repository, bb } = await setup();
  const updater = { experimental_caller: { kind: 'plugin' as const, pluginId: 'pa-updates' } }, updateJob = '11111111-1111-4111-8111-111111111111';
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id;
    await harness.behavior.callRpc('enable', { id }); provider.fail = 'sync_failed'; await harness.behavior.runSchedule('selected-folder-sync');
    await harness.behavior.callRpc('pause', { updateJob }, updater);
    const saved = await bb.storage.kv.get('pa-update-pause-v1'); await harness.lifecycle.dispose();
    const next = createFakePluginHost({ pluginId: 'icloud' }); await next.bb.storage.kv.set('pa-update-pause-v1', JSON.parse(JSON.stringify(saved)));
    try {
      await plugin(next.bb, { provider, repository });
      const resumed = statusSchema.parse(await next.harness.behavior.callRpc('enable', { updateJob }, updater));
      assert.equal(resumed.updatePause?.jobId, null); assert.equal(resumed.updatePause?.manualRecovery, true);
      assert.equal(resumed.mirrors[0].enabled, false); assert.equal(resumed.mirrors[0].failure, 'sync_failed');
      assert.equal(await next.bb.storage.kv.get('pa-update-pause-v1'), null);
      provider.fail = null;
      const retried = statusSchema.parse(await next.harness.behavior.callRpc('retry', { id })); assert.equal(retried.mirrors[0].failure, null);
    } finally { await next.harness.lifecycle.dispose(); }
  } finally { await harness.lifecycle.dispose(); }
});
test('failed updater reservation storage is fail-closed and emits only a bounded diagnostic', async () => {
  const { bb, harness } = await setup();
  try {
    bb.storage.kv.set = async () => { throw new Error('PRIVATE_SENTINEL storage path credential'); };
    await assert.rejects(harness.behavior.callRpc('pause', { updateJob: '11111111-1111-4111-8111-111111111111' }, { experimental_caller: { kind: 'plugin', pluginId: 'pa-updates' } }), error => error instanceof Error && !error.message.includes('PRIVATE_SENTINEL'));
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /iCloud update_pause unavailable/); assert.doesNotMatch(logs, /PRIVATE_SENTINEL/);
  } finally { await harness.lifecycle.dispose(); }
});
test('the real schedule retries an enabled initialized failure and preserves failed history', async () => {
  const { harness, provider } = await setup();
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id; await harness.behavior.callRpc('enable', { id });
    provider.fail = 'sync_failed'; await harness.behavior.runSchedule('selected-folder-sync');
    let mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0];
    assert.equal(mirror.enabled, true); assert.equal(mirror.retryPending, true); assert.equal(mirror.blocker, null);
    provider.fail = null; await harness.behavior.runSchedule('selected-folder-sync');
    mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0]; assert.equal(mirror.phase, 'ready'); assert.equal(mirror.failure, null);
    const history = diagnosticsSchema.parse(await harness.behavior.callRpc('diagnostics', null));
    assert.deepEqual(history.runs.map(run => run.outcome), ['succeeded', 'failed', 'succeeded']);
  } finally { await harness.lifecycle.dispose(); }
});
test('pause cancels a pending scheduled retry without clearing its last failure', async () => {
  const { harness, provider } = await setup();
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id; await harness.behavior.callRpc('enable', { id });
    provider.fail = 'sync_failed'; await harness.behavior.runSchedule('selected-folder-sync'); const attempts = provider.synced;
    await harness.behavior.callRpc('pause', { id }); provider.fail = null; await harness.behavior.runSchedule('selected-folder-sync');
    const mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0];
    assert.equal(provider.synced, attempts); assert.equal(mirror.enabled, false); assert.equal(mirror.phase, 'failed'); assert.equal(mirror.failure, 'sync_failed'); assert.equal(mirror.retryPending, false);
  } finally { await harness.lifecycle.dispose(); }
});
test('reconnect requires explicit Resume before the scheduler restarts an authorized mirror', async () => {
  const { harness, provider } = await setup();
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id; await harness.behavior.callRpc('enable', { id });
    provider.fail = 'authentication'; await harness.behavior.runSchedule('selected-folder-sync'); const attempts = provider.synced;
    let mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0]; assert.equal(mirror.blocker, 'reconnect'); assert.equal(mirror.enabled, true);
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' }); provider.fail = null;
    await harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, attempts);
    mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0]; assert.equal(mirror.blocker, 'reconnect'); assert.equal(mirror.enabled, true);
    await harness.behavior.callRpc('enable', { id }); assert.equal(provider.synced, attempts + 1);
    mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0]; assert.equal(mirror.phase, 'ready'); assert.equal(mirror.blocker, null);
  } finally { await harness.lifecycle.dispose(); }
});
test('actionable failures stop scheduling while only repaired capacity and configuration allow explicit safe retry', async () => {
  for (const [failure, blocker, retryable] of [['recovery_required', 'rebuild', false], ['configuration', 'configuration', true], ['capacity', 'capacity', true], ['invalid_selection', 'configuration', true]] as const) {
    const { harness, provider } = await setup();
    try {
      await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
      await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
      await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
      const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id; await harness.behavior.callRpc('enable', { id });
      provider.fail = failure; await harness.behavior.runSchedule('selected-folder-sync'); const attempts = provider.synced; provider.fail = null;
      await harness.behavior.runSchedule('selected-folder-sync'); assert.equal(provider.synced, attempts);
      let mirror = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0]; assert.equal(mirror.blocker, blocker); assert.equal(mirror.retryPending, false);
      if (!retryable) await assert.rejects(harness.behavior.callRpc('retry', { id }), /recovery/);
      else {
        provider.fail = failure; mirror = statusSchema.parse(await harness.behavior.callRpc('retry', { id })).mirrors[0];
        assert.equal(provider.synced, attempts + 1); assert.equal(mirror.blocker, blocker); assert.equal(mirror.failure, failure);
        provider.fail = null; mirror = statusSchema.parse(await harness.behavior.callRpc('retry', { id })).mirrors[0];
        assert.equal(provider.synced, attempts + 2); assert.equal(mirror.phase, 'ready'); assert.equal(mirror.blocker, null);
      }
    } finally { await harness.lifecycle.dispose(); }
  }
});
test('legacy failed initialized mirrors have an explicit ordinary retry RPC', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState();
  repository.value.connected = true; repository.value.mirrors.push({ id: 'legacy', folder: { id: 'test', name: 'Test Vault', ancestors: [] }, initialized: true, enabled: false, phase: 'failed', lastSuccess: '2026-01-01T00:00:00.000Z', failure: 'sync_failed' } as any);
  await plugin(host.bb, { provider, repository });
  try {
    const before = statusSchema.parse(await host.harness.behavior.callRpc('status', null)).mirrors[0]; assert.equal(before.failure, 'sync_failed'); assert.equal(before.blocker, null);
    const after = statusSchema.parse(await host.harness.behavior.callRpc('retry', { id: 'legacy' }));
    assert.equal(provider.prepared, 0); assert.equal(provider.synced, 1); assert.equal(after.mirrors[0].phase, 'ready'); assert.equal(after.mirrors[0].enabled, true);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('a disconnected restored failure never promises an automatic retry', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState();
  repository.value.connected = false; repository.value.mirrors.push({ id: 'offline', folder: { id: 'test', name: 'Test Vault', ancestors: [] }, initialized: true, enabled: true, phase: 'failed', lastSuccess: '2026-01-01T00:00:00.000Z', failure: 'sync_failed', blocker: null });
  await plugin(host.bb, { provider, repository });
  try {
    const mirror = statusSchema.parse(await host.harness.behavior.callRpc('status', null)).mirrors[0];
    assert.equal(mirror.enabled, true); assert.equal(mirror.retryPending, false); assert.equal(mirror.stale, true);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('reload verifies saved authorization without treating an unknown read failure as expired authorization', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState();
  repository.value.connected = true;
  provider.verifyConnection = async () => { throw new Error('sentinel-private-session'); };
  await plugin(host.bb, { provider, repository });
  try {
    assert.equal(statusSchema.parse(await host.harness.behavior.callRpc('status', null)).connected, true);
    for (let i = 0; i < 100 && !JSON.stringify(host.harness.inspection.logEntries).includes('restore_connection'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /restore_connection unknown/); assert.doesNotMatch(logs, /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
for (const failure of ['sync_failed', 'source_changed'] as const) test(`${failure} progress identifies a bounded operation stage and clears private counters`, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState(); repository.value.connected = true;
  await plugin(host.bb, { provider, repository });
  try {
    await host.harness.behavior.callRpc('browse', { parent: null }); await host.harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await host.harness.behavior.callRpc('status', null)).mirrors[0].id;
    await host.harness.behavior.callRpc('enable', { id });
    provider.synchronize = async (_mirror, report) => { report?.({ ...activity('backing_up_cloud'), msg: 'sentinel-private', lastError: 'sentinel-token' } as any); throw new CloudError(failure); };
    await host.harness.behavior.runSchedule('selected-folder-sync');
    const state = statusSchema.parse(await host.harness.behavior.callRpc('status', null)); assert.equal(state.mirrors[0].phase, 'failed'); assert.equal(state.mirrors[0].progress, null);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.ok(logs.includes(`iCloud sync/backing_up_cloud ${failure}`)); assert.doesNotMatch(logs + JSON.stringify(state), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('read-only diagnostics persist in scoped SQLite and safely correlate a failed command with its run', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState(); repository.value.connected = true;
  await plugin(host.bb, { provider, repository });
  try {
    const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'fastmail' } };
    const empty = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', null, caller)); assert.equal(empty.persistent, true); assert.deepEqual(empty.runs, []);
    await host.harness.behavior.callRpc('browse', { parent: null }); await host.harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await host.harness.behavior.callRpc('status', null)).mirrors[0].id; await host.harness.behavior.callRpc('enable', { id });
    provider.synchronize = async (_mirror, report) => { report!({ ...activity('backing_up_cloud'), object: 'sentinel-file', lastError: 'sentinel-token' } as any); throw new CloudError('sync_failed', { kind: 'command_exit', exitCode: 4, message: 'sentinel-body' } as any); };
    await host.harness.behavior.runSchedule('selected-folder-sync'); const history = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', null, caller));
    assert.equal(history.runs.at(-1)!.sequence, 2); assert.deepEqual(history.runs.at(-1)!.evidence, { kind: 'command_exit', exitCode: 4 });
    const stored = host.bb.storage.database().prepare('SELECT body FROM icloud_sync_runs ORDER BY sequence').all().map(row => JSON.parse((row as { body: string }).body)); assert.deepEqual(stored, history.runs);
    assert.equal(await host.bb.storage.kv.get('sync-diagnostics'), undefined);
    const errors = diagnosticsSchema.parse(await host.harness.behavior.callRpc('diagnostics', { outcome: 'errors', limit: 100 }, caller)); assert.equal(errors.runs.length, 1); assert.equal(errors.runs[0].sequence, 2);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /iCloud sync\/backing_up_cloud sync_failed run=2 evidence=command_exit exit=4/);
    assert.doesNotMatch(JSON.stringify(history) + JSON.stringify(stored) + logs, /sentinel|Test Vault|synthetic\/mirrors/);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('SDK-native SQLite paging retains more than twenty summaries and validates page inputs', async () => {
  const { bb, harness, provider } = await setup();
  try {
    await harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"synthetic"}' });
    await harness.behavior.fetchHttp('POST', '/challenge', { headers: { 'Content-Type': 'application/json' }, body: '{"answer":"123456"}' });
    await harness.behavior.callRpc('browse', { parent: null }); await harness.behavior.callRpc('select', { folderId: 'test' });
    const id = statusSchema.parse(await harness.behavior.callRpc('status', null)).mirrors[0].id; await harness.behavior.callRpc('enable', { id });
    for (let i = 0; i < 25; i++) await harness.behavior.runSchedule('selected-folder-sync');
    const first = diagnosticsSchema.parse(await harness.behavior.callRpc('diagnostics', null)); assert.equal(first.retained.successes, 26); assert.equal(first.runs.length, 20); assert.equal(first.nextBefore, 7);
    const older = diagnosticsSchema.parse(await harness.behavior.callRpc('diagnostics', { before: first.nextBefore })); assert.deepEqual(older.runs.map(r => r.sequence), [1, 2, 3, 4, 5, 6]);
    assert.equal((bb.storage.database().prepare('SELECT COUNT(*) AS count FROM icloud_sync_runs').get() as { count: number }).count, 26);
    await assert.rejects(harness.behavior.callRpc('diagnostics', { limit: 101 })); assert.equal(provider.synced, 25);
    assert.doesNotMatch(JSON.stringify(first) + JSON.stringify(older), /Test Vault|synthetic|password/);
  } finally { await harness.lifecycle.dispose(); }
});
test('controlled provider and form failures have bounded diagnostics with no sentinel leaks', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider();
  provider.connect = async () => { throw Object.assign(new Error('sentinel-password'), { code: 'sentinel-code', cause: 'sentinel-private-content' }); };
  await plugin(host.bb, { provider, repository: new MemoryState() });
  try {
    const result = await host.harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"synthetic@example.test","password":"sentinel-password"}' });
    assert.equal(result.status, 400);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /iCloud connect unknown/);
    assert.doesNotMatch(logs + JSON.stringify(await result.json()), /sentinel|synthetic@example/);
    const invalid = await host.harness.behavior.fetchHttp('POST', '/connect', { headers: { 'Content-Type': 'application/json' }, body: '{"account":"sentinel-invalid","password":"sentinel-password"}' });
    assert.equal(invalid.status, 400); assert.doesNotMatch(JSON.stringify(await invalid.json()), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
