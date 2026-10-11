import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
import { statusSchema } from '../contract.ts';
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
    for (const [method, input] of [['disconnect', null], ['browse', { parent: null }], ['select', { folderId: 'test' }], ['enable', { id: 'mirror-1' }], ['pause', { id: 'mirror-1' }]] as const) await assert.rejects(harness.behavior.callRpc(method, input, context), /settings/);
  } finally { await harness.lifecycle.dispose(); }
});
test('reload verifies saved authorization with a real provider read and fails closed safely', async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState();
  repository.value.connected = true;
  provider.verifyConnection = async () => { throw new Error('sentinel-private-session'); };
  await plugin(host.bb, { provider, repository });
  try {
    assert.equal(statusSchema.parse(await host.harness.behavior.callRpc('status', null)).connected, false);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /restore_connection unknown/); assert.doesNotMatch(logs, /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
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
