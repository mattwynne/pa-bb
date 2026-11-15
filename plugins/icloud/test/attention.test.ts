import test from 'node:test';
import assert from 'node:assert/strict';
import { ICloudSync } from '../core/service.ts';
import { CloudError } from '../core/ports.ts';
import type { Mirror } from '../core/ports.ts';
import { attentionSnapshot, emptyAttention, DAY, verifiedDate } from '../core/attention.ts';
import { rcConnectionFailure } from '../adapters/rclone-connection-failure.ts';
import { RcloneCloudProvider } from '../adapters/rclone-cloud-provider.ts';
import { diagnosticMessage } from '../adapters/diagnostic-log.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
const signed = '2026-01-01T00:00:00.000Z';
const mirror = (id: string, extra: Partial<Mirror> = {}): Mirror => ({ id, folder: { id, name: 'Synthetic', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null, blocker: null, ...extra });
function fixture() {
  let now = Date.parse(signed);
  const repository = new MemoryState(); const provider = new FakeCloudProvider(); const logs: string[] = [];
  const sync = new ICloudSync(provider, repository, () => new Date(now).toISOString(), () => 'synthetic-id', (stage, failure, details) => logs.push(diagnosticMessage(stage, failure, details)));
  return { sync, provider, repository, logs, advance: (days: number) => { now += days * DAY; } };
}
for (const days of [24, 25, 30]) test(`verified sign-in age day ${days} is an estimate, never a scheduling change`, async () => {
  const f = fixture(); f.repository.value = { connected: true, challenge: null, mirrors: [mirror('one')], lastSignInCompletedAt: signed }; f.advance(days); await f.sync.start();
  assert.equal(f.sync.status().attention?.stage ?? null, days < 25 ? null : 'reminder');
  await f.sync.tick(); assert.equal(f.provider.synced, 1); assert.equal(f.sync.status().connected, true);
});
test('unknown, malformed, impossible and future verified dates stay unknown', () => {
  for (const value of [undefined, null, '', 'PRIVATE_SENTINEL', '2026-02-30T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01']) {
    assert.equal(verifiedDate(value, Date.parse(signed)), null);
    assert.equal(attentionSnapshot(emptyAttention(), value, Date.parse(signed)), null);
  }
});
test('only completed protected sign-in advances metadata; pending, failed, restore, browse and sync do not', async () => {
  const f = fixture(); f.repository.value.connected = true; await f.sync.start(); f.sync.restoreConnection(); await new Promise(resolve => setImmediate(resolve));
  await f.sync.browse(null); assert.equal(f.sync.status().lastSignInCompletedAt, null);
  await f.sync.connect({ account: 'PRIVATE_SENTINEL', password: 'PRIVATE_SENTINEL' }); assert.equal(f.sync.status().lastSignInCompletedAt, null);
  f.provider.answerChallenge = async () => { throw new CloudError('unavailable'); };
  await assert.rejects(f.sync.answerChallenge('123456')); assert.equal(f.sync.status().lastSignInCompletedAt, null);
  f.provider.answerChallenge = async () => ({ connected: true });
  await f.sync.answerChallenge('123456'); assert.equal(f.sync.status().lastSignInCompletedAt, signed);
  f.advance(1); await f.sync.browse(null); await f.sync.tick(); assert.equal(f.sync.status().lastSignInCompletedAt, signed);
  assert.doesNotMatch(JSON.stringify([f.logs, f.sync.status()]), /PRIVATE_SENTINEL|123456/);
});
test('protected provider verification failure never returns a connected result or seeds a date', async () => {
  const repository = new MemoryState();
  const provider = new RcloneCloudProvider('/synthetic', async method => {
    if (method === 'config/listremotes') return { remotes: [] };
    if (method === 'operations/list') throw new CloudError('unavailable');
    return { State: '' };
  }, async () => '', async () => {}, async () => {});
  const sync = new ICloudSync(provider, repository, () => signed, () => 'id', () => {}); await sync.start();
  await assert.rejects(sync.connect({ account: 'PRIVATE_SENTINEL', password: 'PRIVATE_SENTINEL' }), /unavailable/);
  assert.equal(sync.status().lastSignInCompletedAt, null); assert.equal(sync.status().connected, false);
});
for (const failure of ['authentication', 'provider_rejected', 'unavailable', 'interrupted', 'recovery_required'] as const) test(`${failure} remains distinct and reauthentication preserves paused/critical mirrors`, async () => {
  const f = fixture(); f.repository.value = { connected: true, challenge: null, mirrors: [mirror('one'), mirror('two'), mirror('paused', { enabled: false, phase: 'paused' }), mirror('critical', { phase: 'failed', blocker: 'rebuild', failure: 'recovery_required' })] }; await f.sync.start();
  f.provider.fail = failure; await f.sync.tick();
  const failed = f.sync.status();
  assert.equal(failed.attention?.stage ?? null, ['authentication', 'provider_rejected'].includes(failure) ? failure : null);
  assert.equal(failed.connected, failure !== 'authentication');
  const count = f.provider.synced; await f.sync.tick();
  if (['authentication', 'provider_rejected'].includes(failure)) assert.equal(f.provider.synced, count);
  const preserved = f.sync.status().mirrors.filter(m => ['paused', 'critical'].includes(m.id));
  await f.sync.connect({ account: 'synthetic', password: 'PRIVATE_SENTINEL' }); await f.sync.answerChallenge('123456');
  assert.equal(f.sync.status().attention, null); assert.deepEqual(f.sync.status().mirrors.filter(m => ['paused', 'critical'].includes(m.id)), preserved);
  assert.equal(f.sync.status().mirrors.find(m => m.id === 'one')!.enabled, true);
});
test('bounded current RC evidence does not diagnose arbitrary prose, unrelated operations or network failures', () => {
  const classify = (error: unknown, status = 500, method = 'operations/list', body = { fs: 'icloud:' }) => rcConnectionFailure(method, body, status, JSON.stringify({ error }));
  assert.equal(classify('trust token expired, please reauth'), 'authentication');
  assert.equal(classify('PRIVATE_SENTINEL trust token expired, please reauth'), 'sync_failed');
  assert.equal(classify('HTTP error 421 (421 Misdirected Request) returned body: "PRIVATE_SENTINEL"'), 'provider_rejected');
  assert.equal(classify('PRIVATE_SENTINEL says token expired HTTP 421'), 'sync_failed');
  assert.equal(classify('connection reset by peer PRIVATE_SENTINEL'), 'sync_failed');
  assert.equal(classify('anything', 421), 'provider_rejected');
  assert.equal(classify('trust token expired, please reauth', 500, 'config/create'), 'sync_failed');
  assert.equal(classify('trust token expired, please reauth', 500, 'operations/list', { fs: 'other:' }), 'sync_failed');
  assert.equal(classify({ status: 421, message: 'PRIVATE_SENTINEL' }), 'sync_failed');
  assert.equal(rcConnectionFailure('operations/list', { fs: 'icloud:' }, 500, 'malformed PRIVATE_SENTINEL'), 'sync_failed');
});
test('one durable claim across windows/reload, bounded snooze, stage override and no offline backlog', async () => {
  const f = fixture(); f.repository.value.lastSignInCompletedAt = signed; f.repository.value.connected = true; f.advance(25); await f.sync.start();
  const generation = f.sync.status().attention!.generation;
  f.sync.attentionPresence('inline', true); assert.equal(await f.sync.attentionAction(generation, 'claim'), false);
  f.sync.attentionPresence('inline', false);
  assert.deepEqual(await Promise.all([f.sync.attentionAction(generation, 'claim'), f.sync.attentionAction(generation, 'claim')]), [true, false]);
  const reloaded = new ICloudSync(f.provider, f.repository, () => new Date(Date.parse(signed) + 25 * DAY).toISOString(), () => 'id', () => {}); await reloaded.start();
  assert.equal(await reloaded.attentionAction(generation, 'claim'), false);
  assert.equal(await f.sync.attentionAction(generation, 'snooze'), true);
  assert.equal(Date.parse(f.sync.status().attention!.snoozedUntil!) - (Date.parse(signed) + 25 * DAY), DAY);
  f.advance(0.9); assert.equal(await f.sync.attentionAction(f.sync.status().attention!.generation, 'claim'), false);
  f.advance(0.1); assert.equal(f.sync.status().attention!.snoozedUntil, null);
  f.advance(5); assert.equal(await f.sync.attentionAction(generation, 'claim'), false); // no backlog of missed intervals
  assert.equal(await f.sync.attentionAction(f.sync.status().attention!.generation, 'claim'), true);
  await f.sync.attentionAction(f.sync.status().attention!.generation, 'snooze');
  f.provider.verifyConnection = async () => { throw new CloudError('authentication'); }; f.sync.restoreConnection(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sync.status().attention!.stage, 'authentication'); assert.equal(f.sync.status().attention!.snoozedUntil, null);
  assert.equal(await f.sync.attentionAction(f.sync.status().attention!.generation, 'claim'), true);
  f.sync.restoreConnection(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.sync.attentionAction(f.sync.status().attention!.generation, 'claim'), false);
});
test('snooze failure is honest and status/snooze remain responsive during unlimited native work', async () => {
  const f = fixture(); f.repository.value = { connected: true, challenge: null, mirrors: [mirror('one')], lastSignInCompletedAt: signed }; f.advance(30); await f.sync.start();
  let release!: () => void; f.provider.pending = new Promise<void>(resolve => { release = resolve; });
  const running = f.sync.tick(); await new Promise(resolve => setImmediate(resolve));
  const generation = f.sync.status().attention!.generation;
  assert.equal(f.sync.status().mirrors[0].phase, 'running');
  const save = f.repository.save.bind(f.repository); f.repository.save = async () => { throw new Error('PRIVATE_SENTINEL'); };
  await assert.rejects(f.sync.attentionAction(generation, 'snooze'), /unavailable/);
  assert.equal(f.sync.status().attention!.snoozedUntil, null); assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_SENTINEL/);
  f.repository.save = save;
  assert.equal(await f.sync.attentionAction(generation, 'snooze'), true);
  release(); await running;
  assert.ok(f.repository.value.attentionState!.snoozedUntil);
});

test('a routine network check failure is unavailable, not proven expiry or a new verified sign-in', async () => {
  const f = fixture(); f.repository.value.connected = true; f.repository.value.lastSignInCompletedAt = signed;
  await f.sync.start(); f.provider.verifyConnection = async () => { throw new CloudError('unavailable'); };
  f.advance(1); f.sync.restoreConnection(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sync.status().connectionCheck, 'unavailable'); assert.equal(f.sync.status().connected, true);
  assert.equal(f.sync.status().attention, null); assert.equal(f.sync.status().lastSignInCompletedAt, signed);
});
