import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Application, ApplicationError } from '../core/application.ts';
import type { ApplicationPorts, SourceSwitch } from '../core/application.ts';
import { applicationSavedSchema, switchSourceInputSchema, SourceSwitchError } from '../core/application-model.ts';
import { componentIds } from '../core/workspace.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let saved: unknown = null, external: SourceSwitch | null = null;
  const events: string[] = [], logs: unknown[] = [];
  const ports: ApplicationPorts = {
    inspect: async () => [], inventory: () => componentIds.map(id => ({ id, installed: '0.3.0', local: 'stock', state: 'current', prerequisite: null, sourceMode: 'managed', sourceGeneration: 'a'.repeat(64) })),
    validateMix: async () => {}, update: async () => { throw Error('Unexpected ordinary update'); },
    quiesce: async (ids, _job, remember) => { if (ids.some(id => id === 'icloud' || id === 'obsidian')) { events.push('reserve'); await remember(); } },
    restore: async () => { events.push('restore'); },
    load: async () => saved, save: async value => { saved = structuredClone(value); events.push('persist'); }, diagnose: (stage, code) => { logs.push({ stage, code }); },
    sourceMode: {
      prepare: async receipt => { events.push('prepare'); external = structuredClone(receipt); },
      launch: async receipt => { events.push('launch'); assert.equal(applicationSavedSchema.parse(saved).sourceSwitch?.jobId, receipt.jobId); external = { ...receipt, phase: 'running' }; },
      recover: async () => { if (!external || external.phase !== 'attention') throw new ApplicationError('busy'); external = { ...external, manualRecovery: true, recovery: 'target_verified' }; return structuredClone(external); },
      drain: async () => {},
      observe: async () => structuredClone(external),
      settle: async receipt => { events.push('settle'); external = structuredClone(receipt); },
    },
  };
  return { ports, events, logs, app: new Application(ports), external: (value?: SourceSwitch) => value ? external = structuredClone(value) : external, saved: () => saved };
}
test('source switch input is strict, per-plugin, and requires literal loss confirmation', () => {
  const valid = { reviewId: '11111111-1111-4111-8111-111111111111', id: 'fastmail', target: 'local', confirmLoss: true };
  assert.ok(switchSourceInputSchema.safeParse(valid).success);
  for (const changes of [{ confirmLoss: false }, { confirmLoss: undefined }, { id: 'other' }, { target: 'path:/private' }, { path: '/private' }, { sourceUrl: 'http://private' }]) assert.equal(switchSourceInputSchema.safeParse({ ...valid, ...changes }).success, false);
  assert.ok(applicationSavedSchema.safeParse({ review: null, job: null }).success, 'older saved schema remains valid');
});
test('all six IDs share one admission and consume their exact review, without runtime/update calls', async () => {
  for (const id of componentIds) {
    const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
    const request = { reviewId: review.id, id, target: 'local' as const, confirmLoss: true as const };
    const results = await Promise.allSettled([f.app.switchSource(request), f.app.switchSource(request)]); await f.app.join();
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.events.filter(e => e === 'launch').length, 1);
    assert.ok(f.events.indexOf('persist') < f.events.indexOf('prepare'));
    assert.equal(f.app.status().sourceSwitch?.configuration, 'reset_expected');
    await assert.rejects(f.app.switchSource(request), ApplicationError);
  }
});
test('checking and stale reviews close source admission', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  const gate = deferred(), entered = deferred();
  f.ports.inspect = async () => { entered.resolve(); await gate.promise; return []; };
  const checking = f.app.review(); await entered.promise;
  await assert.rejects(f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }), ApplicationError);
  gate.resolve(); await checking;
  await assert.rejects(f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }), ApplicationError);
  assert.equal(f.events.includes('launch'), false);
});
test('ordinary apply, reconciliation and persisted sync reservations share the source-switch mutex', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.ports.inspect = async () => [{ id: 'fastmail', installed: '0.3.0', available: '0.3.1', local: 'stock', fingerprint: 'current', prerequisite: null }];
  f.ports.update = async () => { entered.resolve(); await gate.promise; return { actual: '0.3.1', updated: true }; };
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await entered.promise;
  await assert.rejects(f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }));
  gate.resolve(); await f.app.join();
  const g = fixture(); await g.app.start(); const current = (await g.app.review()).review!, observing = deferred(), observed = deferred();
  g.ports.sourceMode!.observe = async () => { observing.resolve(); await observed.promise; return null; };
  const refresh = g.app.refresh(); await observing.promise;
  await assert.rejects(g.app.switchSource({ reviewId: current.id, id: 'fastmail', target: 'local', confirmLoss: true })); observed.resolve(); await refresh;
  const stored = applicationSavedSchema.parse(f.saved()); stored.job!.syncReserved = true;
  const h = fixture(); h.ports.load = async () => stored;
  await h.app.start();
  await assert.rejects(h.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }));
  assert.equal(f.events.includes('launch') || g.events.includes('launch') || h.events.includes('launch'), false);
});
test('in-flight switch survives disposal; startup and refresh only observe, never replay', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.switchSource({ reviewId: review.id, id: 'pa-updates', target: 'local', confirmLoss: true }); await f.app.join();
  await f.app.dispose(); const count = f.events.filter(e => e === 'launch').length;
  const next = new Application(f.ports); await next.start(); await next.refresh();
  assert.equal(next.status().sourceSwitch?.phase, 'running');
  f.external({ ...f.external()!, removed: true, removalAttempted: true, installAdmitted: true, configuration: 'deleted', phase: 'complete', actual: '0.3.0' });
  await next.refresh(); await next.review({ automatic: true });
  assert.equal(next.status().sourceSwitch?.phase, 'complete'); assert.equal(next.status().sourceSwitch?.configuration, 'deleted');
  assert.equal(f.events.filter(e => e === 'launch').length, count);
});
test('failure after removal is durable manual recovery, never another remove/install or ordinary apply', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }); await f.app.join();
  f.external({ ...f.external()!, phase: 'attention', reason: 'install_failed', removalAttempted: true, removed: true, installAdmitted: true, configuration: 'deleted', manualRecovery: true });
  const next = new Application(f.ports); await next.start(); await next.refresh();
  const reviewId = next.status().review?.id;
  await next.review(); await next.apply({ reviewId: review.id, choices: [] });
  assert.equal(next.status().review?.id, reviewId); assert.equal(next.status().applying, false);
  await assert.rejects(next.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }));
  assert.equal(f.events.filter(e => e === 'launch').length, 1);
});
test('partial pause handoff never auto-restores; full handoff releases only after successful native verification', async () => {
  for (const handoff of [false, true]) {
    const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
    await f.app.switchSource({ reviewId: review.id, id: 'icloud', target: 'local', confirmLoss: true }); await f.app.join();
    f.external({ ...f.external()!, phase: handoff ? 'complete' : 'attention', reason: handoff ? null : 'pause_incomplete', pauseHandoff: handoff, manualRecovery: !handoff, configuration: handoff ? 'deleted' : 'reset_expected' });
    const next = new Application(f.ports); await next.start(); assert.equal(f.events.includes('restore'), false);
    await next.refresh(); await next.refresh(); await next.resumeSync();
    assert.equal(f.events.filter(e => e === 'restore').length, handoff ? 1 : 0);
    assert.equal(next.status().sourceSwitch?.syncReserved, !handoff);
  }
});
test('explicit recovery serializes with all work and persists the cleared external and KV receipt', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }); await f.app.join();
  f.external({ ...f.external()!, phase: 'attention', reason: 'install_failed', removalAttempted: true, removed: true, installAdmitted: true, configuration: 'deleted', manualRecovery: true });
  await f.app.refresh(); const gate = deferred(), entered = deferred();
  const recover = f.ports.sourceMode!.recover;
  f.ports.sourceMode!.recover = async jobId => { entered.resolve(); await gate.promise; return recover(jobId); };
  const input = { jobId: f.external()!.jobId }, pending = f.app.acknowledgeSourceRecovery(input); await entered.promise;
  await assert.rejects(f.app.acknowledgeSourceRecovery(input));
  await assert.rejects(f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }));
  assert.equal((await f.app.review()).review?.id, review.id); await f.app.apply({ reviewId: review.id, choices: [] });
  gate.resolve(); const result = await pending;
  assert.equal(result.sourceSwitch?.phase, 'complete'); assert.equal(result.sourceSwitch?.manualRecovery, false);
  assert.equal(applicationSavedSchema.parse(f.saved()).sourceSwitch?.manualRecovery, false); assert.equal(f.external()?.manualRecovery, false);
  assert.notEqual((await f.app.review()).review?.id, review.id); assert.equal(f.events.filter(e => e === 'launch').length, 1);
});
test('launch-attempt failure preserves the adapter confirmed pre-write terminal receipt', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.ports.sourceMode!.launch = async receipt => {
    f.external({ ...receipt, phase: 'attention', reason: 'unavailable', configuration: 'reset_expected', manualRecovery: false });
    throw new Error('PRIVATE_SENTINEL process output');
  };
  await f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }); await f.app.join();
  assert.equal(f.app.status().sourceSwitch?.phase, 'attention'); assert.equal(f.app.status().sourceSwitch?.manualRecovery, false);
  assert.equal(f.app.status().sourceSwitch?.configuration, 'reset_expected'); assert.equal(f.app.status().sourceSwitch?.removalAttempted, false);
  assert.equal(applicationSavedSchema.parse(f.saved()).sourceSwitch?.phase, 'attention');
  assert.notEqual((await f.app.review()).review?.id, review.id); assert.ok(!JSON.stringify([f.logs, f.saved()]).includes('PRIVATE_SENTINEL'));
});
test('disposal during recovery verification admits neither cleanup nor obsolete KV writes', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.switchSource({ reviewId: review.id, id: 'icloud', target: 'local', confirmLoss: true }); await f.app.join();
  f.external({ ...f.external()!, phase: 'attention', reason: 'pause_incomplete', manualRecovery: true }); await f.app.refresh();
  const entered = deferred(), gate = deferred();
  f.ports.sourceMode!.recover = async () => { entered.resolve(); await gate.promise; return { ...f.external()!, manualRecovery: true, pauseHandoff: true, recovery: 'aborted_before_removal' }; };
  const pending = f.app.acknowledgeSourceRecovery({ jobId: f.external()!.jobId }); const rejection = assert.rejects(pending); await entered.promise;
  const before = f.saved(); await f.app.dispose(); gate.resolve(); await rejection;
  assert.deepEqual(f.saved(), before); assert.equal(f.events.includes('restore'), false);
});
test('dependency preparation failure exposes a fixed safe reason without resetting settings', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.ports.sourceMode!.prepare = async () => { throw new SourceSwitchError('dependencies_missing'); };
  await f.app.switchSource({ reviewId: review.id, id: 'pa-updates', target: 'local', confirmLoss: true }); await f.app.join();
  assert.equal(f.app.status().sourceSwitch?.reason, 'dependencies_missing'); assert.equal(f.app.status().sourceSwitch?.configuration, 'reset_expected');
  assert.equal(f.app.status().sourceSwitch?.removalAttempted, false); assert.equal(f.events.includes('launch'), false);
});
test('preflight failure is safe and bounded; disposal before preparation ends admits no detached write', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.ports.sourceMode!.prepare = async () => { throw Error('PRIVATE_SENTINEL body token /private'); };
  await f.app.switchSource({ reviewId: review.id, id: 'fastmail', target: 'local', confirmLoss: true }); await f.app.join();
  assert.equal(f.app.status().sourceSwitch?.reason, 'unavailable'); assert.equal(f.app.status().sourceSwitch?.configuration, 'reset_expected');
  assert.ok(!JSON.stringify([f.saved(), f.logs, f.app.status()]).includes('PRIVATE_SENTINEL'));
  const g = fixture(); await g.app.start(); const r = (await g.app.review()).review!, gate = deferred(), entered = deferred();
  g.ports.sourceMode!.prepare = async () => { entered.resolve(); await gate.promise; };
  await g.app.switchSource({ reviewId: r.id, id: 'pa-updates', target: 'local', confirmLoss: true }); await entered.promise;
  await g.app.dispose(); gate.resolve(); await g.app.join(); assert.equal(g.events.includes('launch'), false);
});
