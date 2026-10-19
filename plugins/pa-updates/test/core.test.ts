import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, parseRelease, MAX_RECORD } from '../core/release.ts';
import { Updates, INTERVAL } from '../core/service.ts';
import { CheckError, statusSchema } from '../core/model.ts';
import { SHA, record, harness } from './fixtures.ts';
const runtime = { bb: '0.45.0', sdk: '0.6.15' };
const installed = { version: '0.1.1', revision: SHA, source: 'trusted' as const };
test('comparison distinguishes absence, source evidence, newer versions and engine declarations', () => {
  assert.equal(compare(null, record(), runtime), 'no_plugin');
  assert.equal(compare(undefined, record(), runtime), 'inventory_unavailable');
  assert.equal(compare(installed, null, runtime), 'no_release');
  assert.equal(compare(installed, record(), runtime), 'current');
  assert.equal(compare(installed, record('0.1.2'), runtime), 'available');
  assert.equal(compare(installed, record('0.1.0'), runtime), 'installed_newer');
  assert.equal(compare({ ...installed, revision: 'b'.repeat(40) }, record(), runtime), 'source_mismatch');
  assert.equal(compare({ ...installed, revision: null }, record(), runtime), 'revision_unavailable');
  assert.equal(compare({ ...installed, source: 'other' }, record('0.1.2'), runtime), 'source_mismatch');
  assert.equal(compare(installed, record('0.1.2'), { ...runtime, bb: '0.44.0' }), 'incompatible');
  assert.equal(compare(installed, record(), null), 'compatibility_unavailable');
});
test('strict records reject commands, URLs, paths, duplicate IDs, commits, notes and unknown schema', () => {
  for (const change of [
    (r: any) => { r.schemaVersion = 2; }, (r: any) => { r.url = 'https://evil.invalid'; },
    (r: any) => { r.plugins.push(r.plugins[0]); }, (r: any) => { r.plugins[0].subdirectory = '../private'; },
    (r: any) => { r.plugins[0].sourceCommit = 'b'.repeat(40); }, (r: any) => { r.sourceCommit = 'main'; },
    (r: any) => { r.plugins[0].engines.bb = 'not a range'; }, (r: any) => { r.plugins[0].version = 'bad'; },
    (r: any) => { r.plugins[0].notes = '\0private'; }, (r: any) => { r.plugins[0].notes = 'x'.repeat(8001); },
  ]) { const candidate = structuredClone(record()); change(candidate); assert.throws(() => parseRelease(JSON.stringify(candidate))); }
  assert.throws(() => parseRelease(' '.repeat(MAX_RECORD + 1)));
  assert.throws(() => parseRelease(JSON.stringify(record()), 'pa-release-' + 'b'.repeat(40)));
});
test('first, joined checks, cooldown, restart, stale data, recovery and local work are independent', async () => {
  const h = harness(); const service = new Updates(h.ports); await service.start();
  assert.equal(service.status().comparison, 'first');
  const checks = await Promise.all(Array.from({ length: 20 }, () => service.check()));
  assert.equal(h.calls(), 1); assert.equal(checks[0].comparison, 'current');
  statusSchema.parse(service.status());
  await service.check(); assert.equal(h.calls(), 1);
  const restarted = new Updates(h.ports); await restarted.start(); await restarted.check(false); assert.equal(h.calls(), 1);
  h.advance(INTERVAL); assert.equal(service.status().stale, true);
  h.ports.feed = async () => { throw new Error('PRIVATE_SENTINEL token=/secret/path'); };
  h.ports.local = async () => ({ outcome: 'local_changes', reason: 'observed', at: new Date(h.ports.now()).toISOString() });
  const failed = await service.check(); assert.equal(failed.stale, true); assert.equal(failed.feedFailure, 'unavailable');
  assert.equal(failed.observation?.release?.identity, record().identity); assert.notEqual(failed.lastAttempt, failed.lastSuccess);
  assert.equal(failed.observation?.local.outcome, 'local_changes'); assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_SENTINEL'));
  h.advance(); h.ports.feed = async () => null;
  const recovered = await service.check(); assert.equal(recovered.feedFailure, null); assert.equal(recovered.comparison, 'no_release');
});
test('identity mutation is rejected without losing last validated record', async () => {
  const h = harness(); const service = new Updates(h.ports); await service.start(); await service.check(); h.advance();
  h.ports.feed = async () => ({ text: JSON.stringify({ ...record(), plugins: [{ ...record().plugins[0], notes: 'changed' }] }), identity: record().identity });
  const status = await service.check(); assert.equal(status.feedFailure, 'mutated'); assert.equal(status.observation?.release?.plugins[0].notes, record().plugins[0].notes);
});
test('inventory and local failures do not masquerade as feed failures or clean state', async () => {
  const h = harness(); h.ports.inventory = async () => { throw new Error('PRIVATE_SENTINEL'); }; h.ports.local = async () => { throw new Error('PRIVATE_SENTINEL'); };
  const service = new Updates(h.ports); await service.start(); const status = await service.check();
  assert.equal(status.feedFailure, null); assert.equal(status.comparison, 'inventory_unavailable'); assert.equal(status.observation?.local.outcome, 'not_assessed');
  assert.deepEqual(h.logs, ['inventory:unavailable', 'local:unavailable']);
});
test('persisted pins and cooldown survive reload; storage failure is explicit and fail-closed', async () => {
  const h = harness(); const service = new Updates(h.ports); await service.start(); await service.check();
  const restarted = new Updates(h.ports); await restarted.start(); h.advance();
  h.ports.feed = async () => ({ identity: record().identity, text: JSON.stringify(record()).replace('baseline.', 'mutated.') });
  assert.equal((await restarted.check()).feedFailure, 'mutated');
  h.ports.load = async () => { throw new Error('PRIVATE_SENTINEL'); };
  const broken = new Updates(h.ports); await broken.start(); assert.equal((await broken.check()).storageFailure, true);
  assert.ok(!JSON.stringify(h.logs).includes('PRIVATE_SENTINEL'));
});
test('disposal aborts joined work and does not launch future requests', async () => {
  const h = harness(); let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  h.ports.feed = signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new CheckError('cancelled')), { once: true }); started(); });
  const service = new Updates(h.ports); await service.start(); const checking = service.check(); await ready; await service.stop(); await checking;
  assert.equal(service.status().checking, false); assert.equal(service.status().observation, null);
  h.advance(INTERVAL); await service.check(); assert.equal(service.status().observation, null);
});
