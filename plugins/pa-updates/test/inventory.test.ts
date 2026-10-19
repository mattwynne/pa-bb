import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { installedInventory } from '../adapters/inventory.ts';
import { SOURCE_URL, compare } from '../core/release.ts';
import { SHA, record } from './fixtures.ts';
test('only public read APIs; installed display is authoritative, candidate history is never guessed as activation', async () => {
  const calls: string[] = []; const runtime = { bb: '0.45.0', sdk: '0.6.15' };
  const bb = { sdk: { plugins: new Proxy({
    async list() { calls.push('list'); return { plugins: [{ id: 'google-calendar', version: '0.1.1' }] }; },
    async getSource() { calls.push('getSource'); return { requested: `git:${SOURCE_URL}@release/source`, subdirectory: 'plugins/google-calendar', resolved: `${SOURCE_URL}@release/source (${SHA.slice(0, 12)})`, history: [{ version: 'b'.repeat(40) }] }; },
  }, { get(object, key) { if (!(key in object)) throw new Error('Forbidden update/install/remove API'); return object[key as keyof typeof object]; } }), system: { async version() { return { currentVersion: '0.45.0' }; } } } } as unknown as BbPluginApi;
  const result = await installedInventory(bb)(new AbortController().signal);
  assert.equal(result.installed?.revision, SHA.slice(0, 12)); assert.deepEqual(calls, ['list', 'getSource']);
  assert.equal(compare(result.installed, record(), runtime), 'revision_unavailable');
  assert.equal(compare(result.installed, record('0.1.1', 'b'.repeat(40)), runtime), 'source_mismatch');
});
test('source and runtime failures are separate, safe inventory diagnostics', async () => {
  const logs: unknown[] = [];
  const bb = { sdk: { plugins: { async list() { return { plugins: [{ id: 'google-calendar', version: '0.1.1' }] }; }, async getSource() { throw new Error('PRIVATE_SENTINEL'); } }, system: { async version() { throw new Error('PRIVATE_SENTINEL'); } } } } as unknown as BbPluginApi;
  const result = await installedInventory(bb, (...args) => { logs.push(args); })(new AbortController().signal);
  assert.equal(result.runtime, null); assert.equal(result.installed?.source, 'unavailable'); assert.ok(!JSON.stringify(logs).includes('PRIVATE_SENTINEL'));
});
