import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { applicationPorts } from '../adapters/application.ts';
import { Baselines } from '../adapters/baseline.ts';
import { ApplicationError } from '../core/application-model.ts';
import { originUrl as SOURCE_URL } from '../core/workspace.ts';
const SHA = 'a'.repeat(40);
test('paired update checks kept installed siblings without offers and refuses legacy stopped migrations', async () => {
  let version = '0.2.3', lists = 0;
  const bb = { sdk: { plugins: { async list() { lists++; return { plugins: [{ id: 'icloud', version }, { id: 'obsidian', version: '0.3.1' }] }; } } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb);
  await assert.rejects(ports.validateMix(['obsidian']), error => error instanceof ApplicationError && error.category === 'paired_migration');
  version = '0.4.0';
  await assert.rejects(ports.validateMix(['obsidian']), error => error instanceof ApplicationError && error.category === 'incompatible');
  await ports.validateMix(['google-calendar']); assert.equal(lists, 2);
});
test('one unsupported source is isolated and unchanged managed integrations retain original verification', async t => {
  const checked: string[] = [], inspected: string[] = [], logs: string[] = [];
  t.mock.method(Baselines.prototype, 'inspect', async (id: string) => { inspected.push(id); return { local: 'stock', fingerprint: 'original', originalVersion: '0.1.6' }; });
  const bb = { storage: { kv: { get: async () => null, set: async () => {} } }, log: { warn: (message: string) => { logs.push(message); } }, sdk: { plugins: {
    list: async () => ({ plugins: [{ id: 'google-calendar', version: '0.1.1' }, { id: 'fastmail', version: '0.1.6' }] }),
    getSource: async ({ pluginId }: { pluginId: string }) => pluginId === 'google-calendar' ? { requested: 'path:fixture-local' } : { requested: `git:${SOURCE_URL}@main`, subdirectory: 'plugins/fastmail', resolved: `${SOURCE_URL}@main (${SHA.slice(0, 12)})` },
    checkUpdates: async ({ pluginId }: { pluginId: string }) => { checked.push(pluginId); return [{ id: pluginId, outcome: 'current' }]; },
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb), rows = await ports.inspect(), inventory = ports.inventory!();
  assert.deepEqual(checked, ['google-calendar', 'fastmail']); assert.deepEqual(inspected, ['fastmail']); assert.equal(rows.length, 0);
  assert.equal(inventory[0].state, 'unavailable'); assert.equal(inventory[1].state, 'current');
  assert.deepEqual(logs, ['pa-updates stage=review outcome=baseline_unknown']);
});
test('self reconciliation uses read-only public provenance and logs failures once without private details', async t => {
  let fail = false, version = '0.1.0', commit = 'a'.repeat(40), local: 'stock' | 'custom' = 'stock';
  const logs: string[] = []; let nativeWrites = 0;
  t.mock.method(Baselines.prototype, 'inspect', async () => ({ local, fingerprint: 'original', originalVersion: version }));
  const bb = { storage: { kv: { get: async () => null, set: async () => {} } }, log: { warn: (message: string) => logs.push(message) }, sdk: { plugins: {
    list: async () => { if (fail) throw Object.assign(new Error('PRIVATE_SENTINEL account token'), { body: 'PRIVATE_SENTINEL provider response' }); return { plugins: [{ id: 'pa-updates', version, enabled: true, status: 'running', rootDir: '/fixture/pa-updates' }] }; },
    getSource: async () => ({ requested: `git:${SOURCE_URL}@main`, subdirectory: 'plugins/pa-updates', resolved: `${SOURCE_URL} (${commit})` }),
    applyUpdate: async () => { nativeWrites++; throw new Error('reconciliation must never activate'); },
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb), intent = { before: '0.1.0', source: `${SOURCE_URL} (${commit})`, requestedAt: new Date().toISOString() };
  assert.equal((await ports.self!.reconcile(intent)).state, 'pending');
  assert.equal((await ports.self!.reconcile(intent, true)).state, 'unchanged');
  version = '0.1.2'; commit = 'b'.repeat(40); assert.deepEqual(await ports.self!.reconcile(intent), { state: 'updated', actual: '0.1.2' });
  fail = true; assert.equal((await ports.self!.reconcile(intent)).state, 'uncertain'); await ports.self!.reconcile(intent);
  assert.deepEqual(logs, ['pa-updates stage=self-reconcile outcome=unavailable']); assert.ok(!JSON.stringify(logs).includes('PRIVATE_SENTINEL'));
  fail = false; local = 'custom'; assert.equal((await ports.self!.reconcile(intent)).state, 'uncertain'); assert.equal(nativeWrites, 0);
});
test('self rechecks native source after durable intent and refuses a retarget before admission', async t => {
  let requested = `git:${SOURCE_URL}@main`, commit = 'a'.repeat(40), nativeWrites = 0;
  t.mock.method(Baselines.prototype, 'inspect', async () => ({ local: 'stock', fingerprint: 'original', originalVersion: '0.1.0' }));
  const bb = { storage: { kv: { get: async () => null, set: async () => {} } }, sdk: { plugins: {
    list: async () => ({ plugins: [{ id: 'pa-updates', version: '0.1.0', enabled: true, status: 'running', rootDir: '/fixture/pa-updates' }] }),
    getSource: async () => ({ requested, subdirectory: 'plugins/pa-updates', resolved: `${SOURCE_URL} (${commit})` }),
    applyUpdate: async () => { nativeWrites++; return { outcome: 'unchanged' }; },
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb), intent = await ports.self!.prepare({ installed: '0.1.0', fingerprint: 'original', jobId: '00000000-0000-4000-8000-000000000001' });
  commit = 'b'.repeat(40); await assert.rejects(ports.self!.apply(intent), error => error instanceof ApplicationError && error.category === 'changed');
  commit = 'a'.repeat(40); requested = `git:${SOURCE_URL}@pinned`; await assert.rejects(ports.self!.apply(intent));
  assert.equal(nativeWrites, 0);
});
