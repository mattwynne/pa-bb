import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { runtimePorts } from '../adapters/runtime.ts';
import { ApplicationError } from '../core/application-model.ts';

type Sdk = BbPluginApi['sdk'];
type AppStatus = Awaited<ReturnType<Sdk['system']['appUpdate']>>;
type CliStatus = Awaited<ReturnType<Sdk['hosts']['providerCliStatus']>>[string];
function fixture() {
  let primaryHostId: string | null = 'pa-server';
  const calls: unknown[] = [], logs: string[] = [], controller = new AbortController();
  const app: AppStatus = { activity: { phase: 'idle' }, available: { channel: 'latest', commit: null, commitCount: null, subjects: [], version: '0.46.1' }, blocked: null, current: { version: '0.46.0', commit: null }, lastResult: null, runningThreadCount: 0, support: { kind: 'supported', mode: 'npm' } };
  const cli = (id: string): CliStatus => ({ currentVersion: '1.0.0', displayName: id, executableName: id, executablePath: `/fixture/npm/bin/${id}`, installAction: { command: 'PRIVATE_SENTINEL command', kind: 'update', label: 'Update' }, installSource: 'npmGlobal', installed: true, latestVersion: '1.0.1', minimumSupportedVersion: '1.0.0', needsUpdate: true, npmGlobalPackageVersion: '1.0.0', npmPackageName: `fixture-${id}`, versionUnsupported: false });
  const providers = { pi: cli('pi'), codex: cli('codex') };
  const bb = { log: { warn: (message: string) => { logs.push(message); } }, sdk: {
    system: { config: async () => ({ primaryHostId }), appUpdate: async () => structuredClone(app), applyAppUpdate: async (input: unknown) => { calls.push(input); app.activity = { phase: 'preparing', output: ['PRIVATE_SENTINEL'], startedAt: new Date().toISOString(), step: 'install', targetVersion: '0.46.2' }; } },
    hosts: { get: async ({ hostId }: { hostId: string }) => ({ id: hostId, name: 'PA test server' }), providerCliStatus: async ({ hostId }: { hostId: string }) => { calls.push(['status', hostId]); return structuredClone(providers); }, installProviderCli: async (input: { hostId: string; provider: 'pi' | 'codex'; actionKind: string }) => { calls.push(input); const status = providers[input.provider]; status.currentVersion = status.npmGlobalPackageVersion = '1.0.2'; return [{ type: 'output', text: 'PRIVATE_SENTINEL', provider: input.provider, stream: 'stdout' }, { type: 'completed', provider: input.provider, success: true, exitCode: 0, signal: null }]; } },
  } } as unknown as BbPluginApi;
  return { app, providers, bb, calls, logs, controller, ports: runtimePorts(bb, controller.signal), setHost: (id: string | null) => { primaryHostId = id; } };
}
test('runtime checks publish each native result without waiting for the other read', async () => {
  for (const slow of ['bb', 'providers']) {
    const f = fixture(); let release!: () => void, reported!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), first = new Promise<void>(resolve => { reported = resolve; });
    const seen: { id: string; state: string; reason: unknown; target: unknown }[] = [];
    const original = f.bb.sdk.system.appUpdate;
    if (slow === 'bb') f.bb.sdk.system.appUpdate = async input => { await gate; return original(input); };
    else f.bb.sdk.hosts.providerCliStatus = async () => { await gate; throw new Error('PRIVATE_SENTINEL credentials'); };
    const checking = f.ports.inspect((row, target) => {
      seen.push({ id: row.id, state: row.state, reason: row.reason, target });
      if (seen.length === (slow === 'bb' ? 2 : 1)) reported();
    });
    await first;
    try {
      assert.deepEqual(seen.map(row => row.id), slow === 'bb' ? ['pi', 'codex'] : ['bb']);
      assert.ok(seen.every(row => row.state === 'ready'));
      assert.ok(seen.every(row => JSON.stringify(row.target) === JSON.stringify({ id: 'pa-server', name: 'PA test server' })));
    } finally { release(); }
    const final = await checking; assert.deepEqual(final.rows.map(row => row.id), ['pi', 'codex', 'bb']);
    if (slow === 'providers') assert.ok(seen.filter(row => row.id !== 'bb').every(row => row.state === 'unavailable' && row.reason === 'unavailable'));
    assert.ok(!JSON.stringify([seen, final, f.logs]).includes('PRIVATE_SENTINEL'));
    assert.ok(!f.calls.some(call => typeof call === 'object' && call !== null && ('actionKind' in call || 'confirmInterruptingThreads' in call)));
  }
});
test('runtime actions bind the configured primary host and report actual managed CLI versions, never installer output', async () => {
  const f = fixture(), review = await f.ports.inspect();
  assert.deepEqual(review.target, { id: 'pa-server', name: 'PA test server' });
  const actual = await f.ports.updateCli('pi', review);
  assert.deepEqual(actual, { actual: '1.0.2', source: 'npmGlobal' });
  assert.ok(f.calls.some(call => JSON.stringify(call) === JSON.stringify({ hostId: 'pa-server', provider: 'pi', actionKind: 'update' })));
  assert.ok(!JSON.stringify([review, actual]).includes('PRIVATE_SENTINEL'));
});
test('missing or changed primary host never falls back to a browser or local machine', async () => {
  const f = fixture(), review = await f.ports.inspect();
  f.setHost(null); const missing = await f.ports.inspect();
  assert.equal(missing.target, null); assert.ok(missing.rows.every(row => row.state === 'unavailable'));
  f.setHost('another-machine');
  await assert.rejects(f.ports.updateCli('pi', review), (error: unknown) => error instanceof ApplicationError && error.category === 'changed');
  assert.ok(!f.calls.some(call => typeof call === 'object' && call !== null && 'actionKind' in call));
});
test('missing CLIs are prerequisites, never silent provider installations', async () => {
  const f = fixture(); Object.assign(f.providers.pi, { installed: false, currentVersion: null, installSource: 'notInstalled', npmGlobalPackageVersion: null, executablePath: null, installAction: { command: 'PRIVATE_SENTINEL', kind: 'install', label: 'Install' } });
  const review = await f.ports.inspect(); assert.equal(review.rows.find(row => row.id === 'pi')?.reason, 'not_installed');
  assert.equal(review.rows.find(row => row.id === 'pi')?.state, 'unavailable');
  await assert.rejects(f.ports.updateCli('pi', review), ApplicationError);
  assert.ok(!f.calls.some(call => typeof call === 'object' && call !== null && 'actionKind' in call));
});
test('external CLI installs and changed executable provenance are not overwritten', async () => {
  const f = fixture(), before = await f.ports.inspect();
  f.providers.pi.installSource = 'external';
  assert.equal((await f.ports.inspect()).rows.find(row => row.id === 'pi')?.reason, 'unsupported_install');
  await assert.rejects(f.ports.updateCli('pi', before), ApplicationError);
  f.providers.codex.executablePath = '/different/codex';
  await assert.rejects(f.ports.updateCli('codex', before), ApplicationError);
});
test('BB restart forwards explicit native consent, records intent and reconciles only a fresh matching native result', async () => {
  const f = fixture(), review = await f.ports.inspect(); f.app.runningThreadCount = 1;
  await assert.rejects(f.ports.prepareBb(review, false), (error: unknown) => error instanceof ApplicationError && error.category === 'busy');
  const intent = await f.ports.prepareBb(review, true);
  await f.ports.applyBb(intent, true); assert.ok(f.calls.some(call => JSON.stringify(call) === '{"confirmInterruptingThreads":true}'));
  assert.equal((await f.ports.reconcileBb(intent)).state, 'pending');
  f.app.activity = { phase: 'idle' }; f.app.current.version = '0.46.2';
  f.app.lastResult = { id: 'native-result', acknowledged: false, finishedAt: new Date().toISOString(), from: { version: '0.46.0', commit: null }, to: { version: '0.46.2', commit: null }, logTail: ['PRIVATE_SENTINEL'], message: 'PRIVATE_SENTINEL', outcome: 'updated', phase: null };
  assert.deepEqual(await f.ports.reconcileBb(intent), { state: 'updated', actual: '0.46.2' });
  assert.equal((await f.ports.reconcileBb({ ...intent, previousResultId: 'native-result' })).state, 'pending');
  assert.equal((await f.ports.reconcileBb({ ...intent, previousResultId: 'native-result', requestedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() })).state, 'uncertain');
  f.app.lastResult.from.version = '0.45.0'; assert.equal((await f.ports.reconcileBb(intent)).state, 'uncertain');
});
test('unsupported BB channels and dirty source installs do not become native update offers', async () => {
  const f = fixture(); f.app.available!.channel = 'nightly';
  assert.equal((await f.ports.inspect()).rows.find(row => row.id === 'bb')?.state, 'unavailable');
  f.app.support = { kind: 'supported', mode: 'source' }; f.app.available!.channel = 'main';
  f.app.blocked = { reason: 'uncommitted-changes', message: 'PRIVATE_SENTINEL' };
  const review = await f.ports.inspect(); assert.equal(review.rows.find(row => row.id === 'bb')?.state, 'unavailable');
  assert.ok(!JSON.stringify(review).includes('PRIVATE_SENTINEL'));
});
test('runtime write admission rechecks host after status and persisted BB preparation', async () => {
  const f = fixture(), review = await f.ports.inspect(), intent = await f.ports.prepareBb(review, false);
  const status = f.bb.sdk.hosts.providerCliStatus;
  f.bb.sdk.hosts.providerCliStatus = async args => { const value = await status(args); f.setHost('another-machine'); return value; };
  await assert.rejects(f.ports.updateCli('pi', review), ApplicationError);
  await assert.rejects(f.ports.applyBb(intent, false), ApplicationError);
  assert.ok(!f.calls.some(call => typeof call === 'object' && call !== null && ('actionKind' in call || 'confirmInterruptingThreads' in call)));
});
test('a native late-thread consent refusal is busy, not a lost restart response', async () => {
  const f = fixture(), review = await f.ports.inspect(), intent = await f.ports.prepareBb(review, false);
  f.app.runningThreadCount = 1; f.bb.sdk.system.applyAppUpdate = async () => { throw new Error('PRIVATE_SENTINEL'); };
  await assert.rejects(f.ports.applyBb(intent, false), (error: unknown) => error instanceof ApplicationError && error.category === 'busy');
});
test('runtime discovery failures have bounded diagnostics and fetch failure is not an unsupported installation', async () => {
  const f = fixture(); f.bb.sdk.hosts.providerCliStatus = async () => { throw new Error('PRIVATE_SENTINEL'); };
  f.app.blocked = { reason: 'fetch-failed', message: 'PRIVATE_SENTINEL' };
  const review = await f.ports.inspect();
  assert.equal(review.rows.find(row => row.id === 'bb')?.reason, 'unavailable');
  assert.deepEqual(f.logs, ['pa-updates stage=runtime_provider outcome=unavailable', 'pa-updates stage=runtime_app outcome=unavailable']);
  assert.ok(!JSON.stringify([f.logs, review]).includes('PRIVATE_SENTINEL'));
});
test('disposal fences native runtime write admission', async () => {
  const f = fixture(), review = await f.ports.inspect(), intent = await f.ports.prepareBb(review, false); f.controller.abort();
  await assert.rejects(f.ports.updateCli('pi', review)); await assert.rejects(f.ports.applyBb(intent, false));
  assert.ok(!f.calls.some(call => typeof call === 'object' && call !== null && 'actionKind' in call));
});
