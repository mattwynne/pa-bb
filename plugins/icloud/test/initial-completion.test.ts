import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CloudError } from '../core/ports.ts';
import type { Mirror } from '../core/ports.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
const original = (): Mirror => ({ id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: false, enabled: false, phase: 'failed', failure: 'source_changed', blocker: 'initialization', lastSuccess: null });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(change: (mirror: Mirror) => void = () => {}, complete: (mirror: Mirror) => Promise<void> = async () => {}) {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const repository = new MemoryState(); repository.value.connected = true;
  const mirror = original(); change(mirror); repository.value.mirrors.push(mirror);
  const provider = new FakeCloudProvider(); let calls = 0;
  Object.assign(provider, { completeInitialRegistration: async (item: Mirror) => { calls++; await complete(item); } });
  await plugin(host.bb, { provider, repository });
  for (let i = 0; i < 100 && (await host.harness.behavior.callRpc('status', null) as any).connectionCheck === 'unknown'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return { host, repository, provider, get calls() { return calls; }, complete: () => host.harness.behavior.callRpc('completeInitialRegistration', { id: 'one' }) as Promise<any> };
}
for (const [variant, change] of Object.entries({
  wrong_failure: (m: Mirror) => { m.failure = 'recovery_required'; },
  retained: (m: Mirror) => { m.phase = 'retained'; },
  rebuild: (m: Mirror) => { m.blocker = 'rebuild'; },
  enabled: (m: Mirror) => { m.enabled = true; },
  initialized: (m: Mirror) => { m.initialized = true; },
  already_attempted: (m: Mirror) => { m.initialCompletionAttempted = true; },
})) test(`host RPC refuses initial completion for ${variant}`, async () => {
  const f = await fixture(change);
  try {
    const before = structuredClone(f.repository.value);
    await assert.rejects(f.complete(), /paused for recovery/);
    assert.equal(f.calls, 0); assert.deepEqual(f.repository.value, before);
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('host RPC is client-only and an explicit one-shot completion preserves failed state until success', async () => {
  const entered = gate(), release = gate();
  const f = await fixture(() => {}, async mirror => {
    assert.deepEqual(mirror, { ...original(), initialCompletionAttempted: true });
    entered.release(); await release.promise;
  });
  try {
    await assert.rejects(f.host.harness.behavior.callRpc('completeInitialRegistration', { id: 'one' }, { experimental_caller: { kind: 'plugin', pluginId: 'obsidian' } }), /settings/);
    const pending = f.complete(); await entered.promise;
    assert.deepEqual(f.repository.value.mirrors[0], { ...original(), initialCompletionAttempted: true });
    await assert.rejects(f.complete(), /still running/);
    release.release(); const result = await pending;
    assert.equal(result.mirrors[0].initialized, true); assert.equal(result.mirrors[0].phase, 'paused'); assert.equal(result.mirrors[0].enabled, false);
    await assert.rejects(f.complete(), /paused for recovery/); assert.equal(f.calls, 1);
  } finally { release.release(); await f.host.harness.lifecycle.dispose(); }
});

for (const failure of ['interrupted', 'recovery_required', 'unknown'] as const) test(`completion ${failure} is consumed across a host reload, with original failure retained and safe diagnostics`, async () => {
  const f = await fixture(() => {}, async () => {
    if (failure === 'unknown') throw Object.assign(new Error('PRIVATE_SENTINEL body'), { code: 'PRIVATE_SENTINEL', cause: 'PRIVATE_SENTINEL' });
    throw new CloudError(failure, { kind: 'command_exit', exitCode: 7, native: 'unknown_fatal' });
  });
  try {
    const result = await f.complete();
    assert.deepEqual(f.repository.value.mirrors[0], { ...original(), initialCompletionAttempted: true });
    assert.equal(result.mirrors[0].local.available, false);
    assert.equal((await f.host.harness.behavior.callRpc('diagnostics', {}) as any).runs.at(-1).failure, failure);
    assert.doesNotMatch(JSON.stringify(f.host.harness.inspection.logEntries), /PRIVATE_SENTINEL/);
    const replacement = await f.host.harness.lifecycle.reload(bb => plugin(bb, { provider: f.provider, repository: f.repository }));
    try {
      for (let i = 0; i < 100 && (await replacement.harness.behavior.callRpc('status', null) as any).connectionCheck === 'unknown'; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await new Promise(resolve => setImmediate(resolve));
      await assert.rejects(replacement.harness.behavior.callRpc('completeInitialRegistration', { id: 'one' }), /paused for recovery/); assert.equal(f.calls, 1);
    } finally { await replacement.harness.lifecycle.dispose(); }
  } finally { await f.host.harness.lifecycle.dispose(); }
});

test('an unpersisted attempt cannot start native work or leak storage errors', async () => {
  const f = await fixture();
  f.repository.save = async () => { throw new Error('PRIVATE_SENTINEL consume failure'); };
  try {
    await assert.rejects(f.complete(), /did not complete/);
    assert.equal(f.calls, 0);
    await assert.rejects(f.complete(), /paused for recovery/);
    assert.equal(f.calls, 0);
    assert.match(JSON.stringify(f.host.harness.inspection.logEntries), /initial_completion\/checking.*unknown/);
    assert.doesNotMatch(JSON.stringify(f.host.harness.inspection.logEntries), /PRIVATE_SENTINEL/);
  } finally { await f.host.harness.lifecycle.dispose(); }
});

for (const applied of [false, true]) test(`failed/uncertain final persistence (applied=${applied}) keeps a consumed disabled stop in memory rather than repeating native work`, async () => {
  const f = await fixture();
  const save = f.repository.save.bind(f.repository);
  f.repository.save = async state => {
    if (state.mirrors[0].initialized) {
      if (applied) await save(state);
      throw new Error('PRIVATE_SENTINEL persistence');
    }
    await save(state);
  };
  try {
    const result = await f.complete();
    assert.equal(result.mirrors[0].initialCompletionAttempted, true); assert.equal(result.mirrors[0].initialized, false);
    assert.equal(result.mirrors[0].failure, 'source_changed'); assert.equal(result.mirrors[0].enabled, false);
    await assert.rejects(f.complete(), /paused for recovery/); assert.equal(f.calls, 1);
    assert.doesNotMatch(JSON.stringify(f.host.harness.inspection.logEntries), /PRIVATE_SENTINEL/);
    assert.equal(f.repository.value.mirrors[0].initialized, applied);
  } finally { await f.host.harness.lifecycle.dispose(); }
});
