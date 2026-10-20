import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { applicationPorts } from '../adapters/application.ts';
import { Baselines } from '../adapters/baseline.ts';
import { Application, integrationId, applicationSavedSchema } from '../core/application.ts';
import { hasFreshOffers } from '../core/notice.ts';
import { SOURCE_URL } from '../core/release.ts';
const ids = integrationId.options;
function fixture(t: TestContext) {
  const outcomes = new Map<string, string>(), locals = new Map<string, 'stock' | 'custom' | 'unknown'>(), versions = new Map<string, string>();
  const pinned = new Set<string>(), logs: string[] = [], originals: string[] = [];
  let saved: unknown;
  t.mock.method(Baselines.prototype, 'inspect', async (id: string) => {
    originals.push(id); if (locals.get(id) === 'unknown') throw new Error('PRIVATE_SENTINEL');
    return { local: locals.get(id) ?? 'stock', fingerprint: `original-${id}`, originalVersion: '1.0.0' };
  });
  t.mock.method(Baselines.prototype, 'manifest', async (_revision: string, id: string) => ({ version: versions.get(id) ?? '1.1.0' }));
  const bb = { storage: { kv: { get: async (key: string) => key === 'application-v1' ? saved : null, set: async (key: string, value: unknown) => { if (key === 'application-v1') saved = structuredClone(value); } } }, log: { warn: (message: string) => logs.push(message) }, sdk: { plugins: {
    list: async () => ({ plugins: ids.map(id => ({ id, version: '1.0.0', rootDir: `/fixture/${id}` })) }),
    getSource: async ({ pluginId: id }: { pluginId: string }) => ({ requested: `git:${SOURCE_URL}@${pinned.has(id) ? 'a'.repeat(40) : 'main'}`, subdirectory: `plugins/${id}`, resolved: `${SOURCE_URL} (${'a'.repeat(40)})` }),
    checkUpdates: async ({ pluginId: id }: { pluginId: string }) => [{ id, outcome: outcomes.get(id) ?? 'current', ...(outcomes.get(id) === 'update-available' ? { candidate: { version: 'b'.repeat(40) } } : {}) }],
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb); delete ports.runtime;
  const updates: string[] = [], pauses: string[][] = [];
  ports.update = async id => { updates.push(id); return { actual: '1.1.0', updated: true }; };
  ports.quiesce = async installing => { pauses.push(installing); };
  return { ports, outcomes, locals, versions, pinned, originals, logs, updates, pauses };
}
test('all five current integrations remain visible without offers, notices, writes or receipts; snapshot survives reload', async t => {
  const f = fixture(t); // A repository-only candidate is also current, not an offer.
  f.outcomes.set('google-calendar', 'update-available'); f.versions.set('google-calendar', '1.0.0');
  const app = new Application(f.ports); await app.start(); const state = await app.review();
  assert.deepEqual(state.review?.rows, []); assert.equal(state.review?.inventory?.length, 5);
  assert.ok(state.review?.inventory?.every(row => row.state === 'current' && row.local === 'stock'));
  assert.equal(hasFreshOffers(state), false);
  await app.apply({ reviewId: state.review!.id, choices: [] }); await app.join();
  assert.equal(app.status().job, null); assert.deepEqual(f.updates, []); assert.deepEqual(f.pauses, []);
  const reloaded = new Application(f.ports); await reloaded.start(); assert.deepEqual(reloaded.status().review, state.review);
});
test('current inventory never becomes an install, choice, pause target or receipt in a mixed review', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available'); f.outcomes.set('fastmail', 'update-available');
  f.locals.set('fastmail', 'custom'); f.locals.set('icloud', 'custom');
  for (const replaceCustom of [false, true]) {
    f.ports.load = async () => null; f.updates.length = 0; f.pauses.length = 0;
    const app = new Application(f.ports); await app.start(); const state = await app.review();
    assert.equal(state.review?.inventory?.length, 5); assert.deepEqual(state.review?.rows.map(row => row.id), ['google-calendar', 'fastmail']);
    await assert.rejects(app.apply({ reviewId: state.review!.id, choices: [{ id: 'icloud', choice: 'install' }] }));
    await app.apply({ reviewId: state.review!.id, choices: replaceCustom ? [{ id: 'fastmail', choice: 'install' }] : [] }); await app.join();
    const installed = replaceCustom ? ['google-calendar', 'fastmail'] : ['google-calendar'];
    assert.deepEqual(f.updates, installed); assert.ok(f.pauses.every(ids => JSON.stringify(ids) === JSON.stringify(installed)));
    assert.deepEqual(app.status().job?.receipts.map(row => row.id), ['google-calendar', 'fastmail']);
    assert.equal(app.status().job?.receipts[1].outcome, replaceCustom ? 'updated' : 'kept');
  }
});
test('current custom, pinned, failed checks and unknown baselines remain distinct; none becomes an offer', async t => {
  const f = fixture(t); f.locals.set('fastmail', 'custom'); f.outcomes.set('google-drive', 'unavailable');
  f.pinned.add('icloud'); f.outcomes.set('icloud', 'pinned'); f.locals.set('obsidian', 'unknown');
  const app = new Application(f.ports); await app.start(); const state = await app.review(), inventory = state.review!.inventory!;
  assert.deepEqual(state.review?.rows, []); assert.equal(hasFreshOffers(state), false);
  assert.deepEqual(inventory.map(({ id, state, local, prerequisite }) => ({ id, state, local, prerequisite })), [
    { id: 'google-calendar', state: 'current', local: 'stock', prerequisite: null },
    { id: 'fastmail', state: 'current', local: 'custom', prerequisite: null },
    { id: 'google-drive', state: 'unavailable', local: 'stock', prerequisite: 'unavailable' },
    { id: 'icloud', state: 'pinned', local: 'unknown', prerequisite: null },
    { id: 'obsidian', state: 'unavailable', local: 'unknown', prerequisite: 'baseline_unknown' },
  ]);
  assert.ok(!f.originals.includes('icloud')); assert.ok(!JSON.stringify([state, f.logs]).includes('PRIVATE_SENTINEL'));
});
test('saved reviews written before the inventory addition still parse without inventing current status', () => {
  const old = { review: { id: '11111111-1111-4111-8111-111111111111', at: new Date().toISOString(), rows: [], runtime: null }, job: null };
  assert.deepEqual(applicationSavedSchema.parse(old), old);
});
