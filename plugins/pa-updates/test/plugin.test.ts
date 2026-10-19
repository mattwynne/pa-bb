import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';
import { harness as portsHarness } from './fixtures.ts';
import { statusSchema } from '../core/model.ts';
test('typed RPCs, one host schedule, no tools or write APIs; failures have bounded attributable logs', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'pa-updates' }); const h = portsHarness();
  const { diagnose: _diagnose, ...ports } = h.ports;
  await plugin(bb, ports);
  assert.deepEqual(harness.registrations.rpcMethods.sort(), ['check', 'status']);
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
  await plugin(next.bb, { ...ports, feed: ports.feed }); await next.harness.callRpc('check', null);
  const logs = JSON.stringify(next.harness.logEntries);
  assert.match(logs, /pa-updates stage=feed outcome=unavailable/); assert.ok(!logs.includes('PRIVATE_SENTINEL'));
  assert.ok(!JSON.stringify(await next.harness.callRpc('status', null)).includes('PRIVATE_SENTINEL'));
  await next.harness.dispose();
});
