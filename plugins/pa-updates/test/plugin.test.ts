import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { harness as portsHarness } from './fixtures.ts';
import { statusSchema } from '../core/model.ts';
import type { ApplicationPorts } from '../core/application.ts';
import { applicationSavedSchema, applicationStatusSchema } from '../core/application-model.ts';
import { hasFreshOffers } from '../core/notice.ts';
import type { RuntimeReview } from '../core/runtime-model.ts';
const idleApplication: ApplicationPorts = {
  inspect: async () => [], validateMix: async () => {}, update: async () => { throw new Error('Discovery must not update'); },
  quiesce: async () => {}, restore: async () => {}, load: async () => null, save: async () => {}, diagnose() {},
};
test('startup/scheduled discovery notifies later integration or runtime offers without replacing completed, kept or uncertain results', async () => {
  for (const outcome of ['updated', 'kept', 'uncertain'] as const) for (const offer of ['plugin', 'runtime']) {
    const rows = [{ id: 'google-calendar', installed: '0.1.0', available: '0.1.1', local: outcome === 'kept' ? 'custom' : 'stock', fingerprint: 'original', prerequisite: null }];
    const runtime: RuntimeReview = { target: { id: 'fixture-host', name: 'Fixture' }, runningThreadCount: 0,
      rows: [{ id: 'pi', installed: '1.0.1', available: null, state: 'current', source: 'npmGlobal', fingerprint: 'pi', reason: null }] };
    let saved = applicationSavedSchema.parse({ review: { id: '11111111-1111-4111-8111-111111111111', at: new Date().toISOString(), rows, runtime }, job: {
      id: '22222222-2222-4222-8222-222222222222', reviewId: '11111111-1111-4111-8111-111111111111', phase: outcome === 'uncertain' ? 'attention' : 'complete',
      receipts: [{ id: 'google-calendar', choice: outcome === 'kept' ? 'keep' : 'install', before: '0.1.0', preview: '0.1.1', actual: outcome === 'updated' ? '0.1.1' : outcome === 'kept' ? '0.1.0' : null, outcome }], syncReserved: false, failure: outcome === 'uncertain' ? 'interrupted' : null,
    } });
    const original = structuredClone(saved); let inspections = 0, runtimeInspections = 0;
    let latestRows = outcome === 'updated' ? [] : structuredClone(original.review!.rows);
    const unexpected = async (): Promise<never> => { throw new Error('Discovery must not update'); };
    const application: ApplicationPorts = { ...idleApplication, load: async () => saved, save: async value => { saved = structuredClone(value); }, inspect: async () => { inspections++; return latestRows; },
      runtime: { inspect: async () => { runtimeInspections++; return runtime; }, updateCli: unexpected, prepareBb: unexpected, applyBb: unexpected, reconcileBb: unexpected } };
    for (let generation = 0; generation < 2; generation++) {
      const { bb, harness } = createFakePluginHost({ pluginId: 'pa-updates' });
      try {
        await plugin(bb, portsHarness().ports, application);
        await harness.runService('initial-discovery').done;
        const initial = applicationStatusSchema.parse(await harness.callRpc('applicationStatus', null));
        assert.equal(hasFreshOffers(initial), generation === 1, 'No duplicate old offer; reload rediscovers a genuinely later release');
        if (offer === 'plugin') latestRows = original.review!.rows.map(row => ({ ...row, installed: outcome === 'updated' ? '0.1.1' : '0.1.0', available: '0.1.2' }));
        else { runtime.rows[0].available = '1.0.2'; runtime.rows[0].state = 'ready'; }
        await harness.runSchedule('release-discovery');
        const visible = applicationStatusSchema.parse(await harness.callRpc('applicationStatus', null));
        assert.equal(hasFreshOffers(visible), true, 'The actual notice predicate sees the new offer');
        assert.equal(hasFreshOffers(visible, Date.parse(visible.offers!.checkedAt) + 6 * 60 * 60 * 1000), false);
        assert.equal(visible.review?.id, visible.job?.reviewId, 'Saved receipts remain visible');
        assert.deepEqual(visible.job, original.job); assert.deepEqual(saved, original, 'Automatic discovery does not rewrite saved results');
        if (generation === 1) {
          const next = applicationStatusSchema.parse(await harness.callRpc('review', null));
          assert.notEqual(next.review?.id, next.job?.reviewId); assert.deepEqual(next.job, original.job);
          assert.equal(offer === 'plugin' ? next.review?.rows[0].available : next.review?.runtime?.rows[0].available, offer === 'plugin' ? '0.1.2' : '1.0.2');
        }
      } finally { await harness.dispose(); }
    }
    assert.equal(inspections, 5); assert.equal(runtimeInspections, 5);
  }
});
test('typed application RPCs retain read-only discovery and reject cross-plugin writes; diagnostics stay bounded', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'pa-updates' }); const h = portsHarness();
  const { diagnose: _diagnose, ...ports } = h.ports;
  await plugin(bb, ports, idleApplication);
  assert.deepEqual(harness.registrations.rpcMethods.sort(), ['applicationStatus', 'apply', 'check', 'resumeSync', 'review', 'status']);
  for (const method of ['review', 'resumeSync', 'apply']) await assert.rejects(harness.callRpc(method, method !== 'apply' ? null : { reviewId: '11111111-1111-4111-8111-111111111111', choices: [] }, { experimental_caller: { kind: 'plugin', pluginId: 'other' } }));
  statusSchema.parse(await harness.callRpc('status', null));
  await assert.rejects(harness.callRpc('check', null, { experimental_caller: { kind: 'plugin', pluginId: 'other' } }));
  await assert.rejects(harness.callRpc('check', { path: 'PRIVATE_SENTINEL', command: 'reset' }));
  await Promise.all([harness.runSchedule('release-discovery'), harness.callRpc('check', null)]);
  assert.equal(h.calls(), 1); assert.equal(harness.sdk.calls.length, 0);
  h.advance(); ports.feed = async () => { throw new Error('PRIVATE_SENTINEL body token /private'); };
  // Dependencies are captured when constructed: mutate original referenced port
  // via a second plugin instance to exercise the production diagnostic boundary.
  await harness.dispose();
  const next = createFakePluginHost({ pluginId: 'pa-updates' });
  await plugin(next.bb, { ...ports, feed: ports.feed }, idleApplication); await next.harness.callRpc('check', null);
  const logs = JSON.stringify(next.harness.logEntries);
  assert.match(logs, /pa-updates stage=feed outcome=unavailable/); assert.ok(!logs.includes('PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(await next.harness.callRpc('status', null)).includes('PRIVATE_SENTINEL'));
  await next.harness.dispose();
});
