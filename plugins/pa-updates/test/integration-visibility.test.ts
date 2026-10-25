import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import childProcess, { execFile, type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationPorts } from '../adapters/application.ts';
import { Baselines } from '../adapters/baseline.ts';
import { Application, integrationId, applicationSavedSchema } from '../core/application.ts';
import { hasFreshOffers } from '../core/notice.ts';
import { originUrl as SOURCE_URL } from '../core/workspace.ts';
const ids = integrationId.options;
function fixture(t: TestContext) {
  const outcomes = new Map<string, string>(), locals = new Map<string, 'stock' | 'custom' | 'unknown'>(), versions = new Map<string, string>();
  const pinned = new Set<string>(), sameSources = new Set<string>(), logs: string[] = [], originals: string[] = [];
  let saved: unknown;
  t.mock.method(Baselines.prototype, 'inspect', async (id: string) => {
    originals.push(id); if (locals.get(id) === 'unknown') throw new Error('PRIVATE_SENTINEL');
    return { local: locals.get(id) ?? 'stock', fingerprint: `original-${id}`, originalVersion: '1.0.0' };
  });
  t.mock.method(Baselines.prototype, 'manifest', async (_revision: string, id: string) => ({ version: versions.get(id) ?? '1.1.0' }));
  t.mock.method(Baselines.prototype, 'sourceIdentity', async (revision: string, id: string) => (revision === 'b'.repeat(40) && !sameSources.has(id) ? 'b' : 'a').repeat(64));
  const bb = { storage: { kv: { get: async (key: string) => key === 'application-v1' ? saved : null, set: async (key: string, value: unknown) => { if (key === 'application-v1') saved = structuredClone(value); } } }, log: { warn: (message: string) => logs.push(message) }, sdk: { plugins: {
    list: async () => ({ plugins: ids.map(id => ({ id, version: '1.0.0', rootDir: `/fixture/${'a'.repeat(40)}/plugins/${id}` })) }),
    getSource: async ({ pluginId: id }: { pluginId: string }) => ({ requested: `git:${SOURCE_URL}@${pinned.has(id) ? 'a'.repeat(40) : 'main'}`, subdirectory: `plugins/${id}`, resolved: `${SOURCE_URL} (${'a'.repeat(40)})` }),
    checkUpdates: async ({ pluginId: id }: { pluginId: string }) => [{ id, outcome: outcomes.get(id) ?? 'current', ...(outcomes.get(id) === 'update-available' ? { candidate: { version: 'b'.repeat(40) } } : {}) }],
  } } } as unknown as BbPluginApi;
  const ports = applicationPorts(bb); delete ports.runtime;
  const updates: string[] = [], pauses: string[][] = [];
  ports.update = async id => { updates.push(id); return { actual: '1.1.0', updated: true }; };
  ports.quiesce = async installing => { pauses.push(installing); };
  return { ports, bb, saved: () => structuredClone(saved), outcomes, locals, versions, pinned, sameSources, originals, logs, updates, pauses };
}
test('all six current components remain visible without offers, notices, writes or receipts; snapshot survives reload', async t => {
  const f = fixture(t); // A repository-only candidate is also current, not an offer.
  f.outcomes.set('google-calendar', 'update-available'); f.versions.set('google-calendar', '1.0.0'); f.sameSources.add('google-calendar');
  const app = new Application(f.ports); await app.start(); const state = await app.review();
  assert.deepEqual(state.review?.rows, []); assert.equal(state.review?.inventory?.length, 6);
  assert.ok(state.review?.inventory?.every(row => row.state === 'current' && row.local === 'stock'));
  assert.equal(hasFreshOffers(state), false);
  await app.apply({ reviewId: state.review!.id, choices: [] }); await app.join();
  assert.equal(app.status().job, null); assert.deepEqual(f.updates, []); assert.deepEqual(f.pauses, []);
  const reloaded = new Application(f.ports); await reloaded.start(); assert.deepEqual(reloaded.status().review, state.review);
});
test('inventory and offered assessments expose actual native enablement without changing old snapshots', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available');
  const list = f.bb.sdk.plugins.list;
  f.bb.sdk.plugins.list = async args => ({ plugins: (await list(args)).plugins.map(plugin => ({ ...plugin, enabled: plugin.id !== 'google-calendar' })) });
  const app = new Application(f.ports); await app.start(); const state = await app.review();
  assert.equal(state.review?.rows[0].sourceEnabled, false);
  assert.equal(state.review?.inventory?.find(row => row.id === 'google-calendar')?.sourceEnabled, false);
  assert.equal(state.review?.inventory?.find(row => row.id === 'fastmail')?.sourceEnabled, true);
  const saved = applicationSavedSchema.parse({ review: { id: state.review!.id, at: state.review!.at, rows: [] }, job: null });
  assert.equal(saved.review?.inventory, undefined);
});
test('inventory, progress and assessments carry only the current workspace origin fact; old saved rows remain valid', async t => {
  const f = fixture(t), root = await mkdtemp(join(tmpdir(), 'pa-origin-facts-')), checkout = join(root, 'checkout');
  const exec = promisify(execFile), spawn = childProcess.spawn;
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => exec('git', args, { cwd: checkout, env, timeout: 10000 });
  let selected: string | undefined = checkout;
  const ports = applicationPorts(f.bb, SOURCE_URL, async () => selected); delete ports.runtime;
  const transport = t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: SpawnOptions) => {
    const actual = [...args];
    if (actual.includes('fetch')) {
      assert.equal(command, 'git'); assert.ok(actual.includes(SOURCE_URL));
      actual[actual.indexOf(SOURCE_URL)] = checkout; actual.unshift('-c', 'protocol.file.allow=always');
    }
    return spawn(command, actual, options);
  });
  syncBuiltinESMExports();
  try {
    await mkdir(checkout); await git('init', '-b', 'main');
    for (const id of ids) { await mkdir(join(checkout, 'plugins', id), { recursive: true }); await writeFile(join(checkout, 'plugins', id, 'server.ts'), 'fixture\n'); }
    await git('add', '.'); await git('commit', '-m', 'fixture'); await git('remote', 'add', 'origin', SOURCE_URL);
    f.outcomes.set('google-calendar', 'update-available');
    for (const expected of [true, false, true, null]) {
      if (expected === null) selected = undefined;
      else await git('remote', 'set-url', 'origin', expected ? SOURCE_URL : 'https://github.com/example/working-fork.git');
      await ports.development!();
      const progress: object[] = [];
      const assessments = await ports.inspect(row => progress.push(row)), inventory = ports.inventory!();
      for (const row of [...assessments, ...inventory, ...progress]) {
        if (expected === null) assert.equal(Object.hasOwn(row, 'originComparisonMatches'), false, 'no undefined property in native BB JSON');
        else assert.equal((row as { originComparisonMatches?: boolean }).originComparisonMatches, expected);
      }
      assert.equal(inventory.length, 6); assert.equal(assessments.length, 1); assert.equal(progress.length, 6);
      const old = { review: { id: '11111111-1111-4111-8111-111111111111', at: new Date().toISOString(), rows: assessments.map(({ originComparisonMatches: _fact, ...row }) => row), inventory: inventory.map(({ originComparisonMatches: _fact, ...row }) => row), runtime: null }, job: null };
      assert.deepEqual(applicationSavedSchema.parse(old), old, 'saved schemas need not contain the new fact');
    }
  } finally { transport.mock.restore(); syncBuiltinESMExports(); await ports.cancel?.(); await rm(root, { recursive: true, force: true }); }
});
test('same-version origin code changes are offers, not current versions', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available'); f.versions.set('google-calendar', '1.0.0');
  const app = new Application(f.ports); await app.start(); const state = await app.review();
  assert.equal(state.review?.rows[0]?.available, '1.0.0');
  assert.equal(state.review?.inventory?.find(row => row.id === 'google-calendar')?.state, 'offered');
  assert.equal(hasFreshOffers(state), true);
});
test('current inventory never becomes an install, choice, pause target or receipt in a mixed review', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available'); f.outcomes.set('fastmail', 'update-available');
  f.locals.set('fastmail', 'custom'); f.locals.set('icloud', 'custom');
  for (const replaceCustom of [false, true]) {
    f.ports.load = async () => null; f.updates.length = 0; f.pauses.length = 0;
    const app = new Application(f.ports); await app.start(); const state = await app.review();
    assert.equal(state.review?.inventory?.length, 6); assert.deepEqual(state.review?.rows.map(row => row.id), ['google-calendar', 'fastmail']);
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
    { id: 'pa-updates', state: 'current', local: 'stock', prerequisite: null },
  ]);
  assert.ok(!f.originals.includes('icloud')); assert.ok(!JSON.stringify([state, f.logs]).includes('PRIVATE_SENTINEL'));
});
test('a slow integration exposes earlier fresh results without publishing a partial review or admitting apply', async t => {
  const f = fixture(t); const observed: ReturnType<Application['status']>[] = [];
  const app = new Application(f.ports, () => observed.push(app.status())); await app.start();
  const previous = (await app.review()).review!, saved = f.saved(); observed.length = 0;
  f.outcomes.set('google-calendar', 'update-available'); f.outcomes.set('fastmail', 'update-available'); f.locals.set('fastmail', 'custom');
  f.outcomes.set('google-drive', 'unavailable'); f.locals.set('obsidian', 'unknown');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), blocked = new Promise<void>(resolve => { entered = resolve; });
  const check = f.bb.sdk.plugins.checkUpdates;
  f.bb.sdk.plugins.checkUpdates = async input => { if (input?.pluginId === 'fastmail') { entered(); await gate; } return check(input); };
  const checking = app.review(); await blocked;
  try {
    const partial = app.status(); assert.equal(partial.checking, true); assert.equal(partial.progress?.requested, true);
    assert.deepEqual(partial.progress?.integrations.map(row => [row.id, row.state]), [['google-calendar', 'offered']]);
    assert.deepEqual(partial.review, previous); assert.deepEqual(f.saved(), saved); assert.equal(hasFreshOffers(partial), false);
    await app.apply({ reviewId: previous.id, choices: [] }); assert.equal(app.status().job, null); assert.deepEqual(f.updates, []);
    assert.ok(observed.every(state => !state.progress || state.checking));
    partial.progress!.integrations.length = 0; assert.equal(app.status().progress?.integrations.length, 1, 'status snapshots cannot mutate progress');
  } finally { release(); }
  const final = await checking; assert.equal(final.progress, null); assert.notEqual(final.review?.id, previous.id);
  assert.equal(final.review?.inventory?.find(row => row.id === 'google-drive')?.prerequisite, 'unavailable');
  assert.equal(final.review?.inventory?.find(row => row.id === 'obsidian')?.prerequisite, 'baseline_unknown');
  assert.ok(!JSON.stringify([observed, f.logs, final]).includes('PRIVATE_SENTINEL'));
  assert.ok(!Object.hasOwn(f.saved() as object, 'progress'));
  await app.apply({ reviewId: final.review!.id, choices: [] }); await app.join();
  assert.deepEqual(f.updates, ['google-calendar']); assert.equal(app.status().job?.receipts.find(row => row.id === 'fastmail')?.outcome, 'kept');
});
test('source work alone is not an offer, pause target or receipt; fresh preflight also checks local-work decisions', async t => {
  const f = fixture(t); let developmentReads = 0;
  f.ports.development = async () => { developmentReads++; return { 'google-calendar': 'clean', fastmail: 'clean', 'google-drive': 'clean', icloud: 'unpublished', obsidian: 'unpublished', 'pa-updates': 'clean' };  };
  const app = new Application(f.ports); await app.start(); const state = await app.review();
  assert.deepEqual(state.review?.rows, []); assert.equal(hasFreshOffers(state), false);
  assert.ok(state.review?.inventory?.every(row => row.local === 'stock'));
  assert.deepEqual(state.review?.inventory?.filter(row => row.development === 'unpublished').map(row => row.id), ['icloud', 'obsidian']);
  await app.apply({ reviewId: state.review!.id, choices: [] }); assert.equal(app.status().job, null); assert.deepEqual(f.updates, []); assert.deepEqual(f.pauses, []);
  f.outcomes.set('google-calendar', 'update-available'); f.outcomes.set('fastmail', 'update-available'); f.locals.set('fastmail', 'custom');
  const next = await app.review(); const readsBeforeApply = developmentReads;
  await app.apply({ reviewId: next.review!.id, choices: [] }); await app.join();
  assert.equal(developmentReads, readsBeforeApply + 2, 'both preflight boundaries recheck source-work decisions without changing installed fingerprints');
  assert.deepEqual(f.updates, ['google-calendar']); assert.equal(app.status().job?.receipts.find(row => row.id === 'fastmail')?.outcome, 'kept');
  assert.ok(app.status().job?.receipts.every(row => row.id !== 'icloud' && row.id !== 'obsidian'));
});
test('failed canonical checkout inspection is unknown with safe diagnostics, not a clean assessment', async t => {
  const f = fixture(t), ports = applicationPorts(f.bb, SOURCE_URL, async () => { throw new Error('PRIVATE_SENTINEL /private/checkout'); }); delete ports.runtime;
  const app = new Application(ports); await app.start(); const state = await app.review();
  assert.ok(state.review?.inventory?.every(row => row.development === 'unknown'));
  assert.deepEqual(state.review?.rows, []); assert.ok(f.logs.includes('pa-updates stage=development outcome=unavailable'));
  assert.ok(!JSON.stringify([state, f.logs]).includes('PRIVATE_SENTINEL'));
});
test('unpublished work with an upstream release defaults to Keep, requires explicit opt-in, and never fakes installed customization', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available');
  f.ports.development = async () => ({ 'google-calendar': 'unpublished', fastmail: 'clean', 'google-drive': 'clean', icloud: 'clean', obsidian: 'clean', 'pa-updates': 'clean' });
  const app = new Application(f.ports); await app.start(); const state = await app.review(), row = state.review!.rows[0];
  assert.equal(row.local, 'stock'); assert.equal(row.fingerprint, 'original-google-calendar'); assert.equal(row.decision, 'choose');
  assert.equal(hasFreshOffers(state), true, 'the released offer, not local work, creates readiness');
  await app.apply({ reviewId: state.review!.id, choices: [] }); await app.join();
  assert.equal(app.status().job, null); assert.deepEqual(f.updates, []); assert.deepEqual(f.pauses, []);
  await app.apply({ reviewId: state.review!.id, choices: [{ id: 'google-calendar', choice: 'install' }] }); await app.join();
  assert.deepEqual(f.updates, ['google-calendar']); assert.equal(app.status().job?.receipts[0].outcome, 'updated');
});
test('new source work after a stock review cannot silently acquire overwrite permission', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available');
  const app = new Application(f.ports); await app.start(); const state = await app.review();
  assert.equal(state.review!.rows[0].decision, 'automatic');
  f.ports.development = async () => ({ 'google-calendar': 'unpublished', fastmail: 'clean', 'google-drive': 'clean', icloud: 'clean', obsidian: 'clean', 'pa-updates': 'clean' });
  await app.apply({ reviewId: state.review!.id, choices: [] }); await app.join();
  assert.equal(app.status().job?.failure, 'changed'); assert.deepEqual(f.updates, []); assert.deepEqual(f.pauses, []);
});
test('legacy source-work reviews gain the safe decision but no new component or job receipt', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available');
  const app = new Application(f.ports); await app.start(); const review = (await app.review()).review!;
  delete review.rows[0].decision; review.inventory!.find(row => row.id === 'google-calendar')!.development = 'unpublished';
  f.ports.load = async () => ({ review, job: null });
  const restored = new Application(f.ports); await restored.start();
  assert.equal(restored.status().review!.rows[0].decision, 'choose'); assert.equal(restored.status().review!.rows[0].local, 'stock');
  await restored.apply({ reviewId: review.id, choices: [] }); assert.equal(restored.status().job, null); assert.deepEqual(f.updates, []);
});
test('saved reviews written before the inventory addition still parse without inventing current status', () => {
  const old = { review: { id: '11111111-1111-4111-8111-111111111111', at: new Date().toISOString(), rows: [], runtime: null }, job: null };
  assert.deepEqual(applicationSavedSchema.parse(old), old);
});

test('capability facts come only from the raw host probe, never an SDK/version guess; absent stubs stay false', async t => {
  const f = fixture(t); f.outcomes.set('google-calendar', 'update-available');
  await f.ports.inspect(); assert.ok(f.ports.inventory!().every(row => row.sourceSwitchSupported === false));
  Object.defineProperty(f.bb, 'server', { value: { loopbackBaseUrl: 'http://127.0.0.1:45678' } });
  const calls: string[] = []; let raw: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push(String(url)); assert.equal(init?.redirect, 'error'); assert.equal(init?.method, undefined); assert.equal(init?.body, undefined);
    return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  for (const value of [{ currentVersion: '999.0.0' }, { experimental_directPluginSourceMoves: false }, { experimental_directPluginSourceMoves: 'true', private: 'PRIVATE_SENTINEL' }, { experimental_directPluginSourceMoves: true }]) {
    raw = value; const progress: { sourceSwitchSupported?: boolean }[] = [];
    const rows = await f.ports.inspect(row => progress.push(row));
    const expected = value.experimental_directPluginSourceMoves === true;
    assert.ok([...rows, ...f.ports.inventory!(), ...progress].every(row => row.sourceSwitchSupported === expected));
    assert.ok(!JSON.stringify([rows, f.ports.inventory!(), f.logs]).includes('PRIVATE_SENTINEL'));
  }
  assert.ok(calls.every(url => url === 'http://127.0.0.1:45678/api/v1/system/version')); assert.equal(calls.length, 4);
});
