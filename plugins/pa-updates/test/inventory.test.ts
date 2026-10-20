import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { installedInventory } from '../adapters/inventory.ts';
import { applicationPorts } from '../adapters/application.ts';
import { Baselines } from '../adapters/baseline.ts';
import { ApplicationError } from '../core/application-model.ts';
import { SOURCE_URL, compare } from '../core/release.ts';
import { SHA, record } from './fixtures.ts';
test('only public read APIs; installed display is authoritative, candidate history is never guessed as activation', async () => {
  const calls: string[] = []; const runtime = { bb: '0.45.0', sdk: '0.6.15' };
  const bb = { pluginId: 'pa-updates', sdk: { plugins: new Proxy({
    async list() { calls.push('list'); return { plugins: [{ id: 'google-calendar', version: '0.1.1' }, { id: 'pa-updates', app: { bundle: { sdkVersion: '0.6.37' } } }] }; },
    async getSource() { calls.push('getSource'); return { requested: `git:${SOURCE_URL}@release/source`, subdirectory: 'plugins/google-calendar', resolved: `${SOURCE_URL}@release/source (${SHA.slice(0, 12)})`, history: [{ version: 'b'.repeat(40) }] }; },
  }, { get(object, key) { if (!(key in object)) throw new Error('Forbidden update/install/remove API'); return object[key as keyof typeof object]; } }), system: { async version() { return { currentVersion: '0.45.0' }; } } } } as unknown as BbPluginApi;
  const result = await installedInventory(bb)(new AbortController().signal);
  assert.equal(result.runtime?.sdk, '0.6.37');
  assert.equal(result.installed?.revision, SHA.slice(0, 12)); assert.deepEqual(calls, ['list', 'getSource']);
  assert.equal(compare(result.installed, record(), runtime), 'revision_unavailable');
  assert.equal(compare(result.installed, record('0.1.1', 'b'.repeat(40)), runtime), 'source_mismatch');
});
test('paired update checks kept installed siblings without offers and refuses legacy stopped migrations', async () => {
  let version = '0.2.3', lists = 0;
  const bb = { sdk: { plugins: { async list() { lists++; return { plugins: [{ id: 'icloud', version }, { id: 'obsidian', version: '0.3.1' }] }; } } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb);
  await assert.rejects(ports.validateMix(['obsidian']), error => error instanceof ApplicationError && error.category === 'paired_migration');
  version = '0.4.0';
  await assert.rejects(ports.validateMix(['obsidian']), error => error instanceof ApplicationError && error.category === 'incompatible');
  await ports.validateMix(['google-calendar']); assert.equal(lists, 2, 'unrelated updates do not attempt a paired migration');
});
test('one unsupported source is isolated and unchanged trusted integrations still seed their originals', async t => {
  const checked: string[] = [], inspected: string[] = [], logs: string[] = [];
  t.mock.method(Baselines.prototype, 'inspect', async (id: string) => { inspected.push(id); return { local: 'stock', fingerprint: 'original', originalVersion: '0.1.6' }; });
  const bb = { storage: { kv: { get: async () => null, set: async () => {} } }, log: { warn: (message: string) => { logs.push(message); } }, sdk: { plugins: {
    list: async () => ({ plugins: [{ id: 'google-calendar', version: '0.1.1' }, { id: 'fastmail', version: '0.1.6' }] }),
    getSource: async ({ pluginId }: { pluginId: string }) => pluginId === 'google-calendar' ? { requested: 'path:fixture-local' } : { requested: `git:${SOURCE_URL}@main`, subdirectory: 'plugins/fastmail', resolved: `${SOURCE_URL}@main (${SHA.slice(0, 12)})` },
    checkUpdates: async ({ pluginId }: { pluginId: string }) => { checked.push(pluginId); return [{ id: pluginId, outcome: 'current' }]; },
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb), rows = await ports.inspect(), inventory = ports.inventory!();
  assert.deepEqual(checked, ['google-calendar', 'fastmail']); assert.deepEqual(inspected, ['fastmail']); assert.equal(rows.length, 0);
  assert.equal(inventory[0].id, 'google-calendar'); assert.equal(inventory[0].local, 'unknown'); assert.equal(inventory[0].state, 'unavailable');
  assert.equal(inventory[1].state, 'current'); assert.deepEqual(logs, ['pa-updates stage=review outcome=baseline_unknown']);
});
test('missing checker SDK metadata never guesses compatibility from the development pin', async () => {
  const bb = { pluginId: 'pa-updates', sdk: { plugins: { async list() { return { plugins: [] }; } }, system: { async version() { return { currentVersion: '0.46.0' }; } } } } as unknown as BbPluginApi;
  const result = await installedInventory(bb)(new AbortController().signal);
  assert.equal(result.runtime, null); assert.equal(result.installed, null);
});
test('source and runtime failures are separate, safe inventory diagnostics', async () => {
  const logs: unknown[] = [];
  const bb = { sdk: { plugins: { async list() { return { plugins: [{ id: 'google-calendar', version: '0.1.1' }] }; }, async getSource() { throw new Error('PRIVATE_SENTINEL'); } }, system: { async version() { throw new Error('PRIVATE_SENTINEL'); } } } } as unknown as BbPluginApi;
  const result = await installedInventory(bb, (...args) => { logs.push(args); })(new AbortController().signal);
  assert.equal(result.runtime, null); assert.equal(result.installed?.source, 'unavailable'); assert.ok(!JSON.stringify(logs).includes('PRIVATE_SENTINEL'));
});
