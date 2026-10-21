import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Application, applicationSavedSchema } from '../core/application.ts';
import type { ApplicationPorts, ApplicationSaved, Assessment } from '../core/application.ts';
import type { BbResult, RuntimeReview } from '../core/runtime-model.ts';

const row = (id: Assessment['id'], local: Assessment['local'] = 'stock'): Assessment => ({ id, local, installed: '0.1.0', available: '0.1.1', fingerprint: `original-${id}`, prerequisite: null });
function fixture(rows = [row('pa-updates')]) {
  let saved: ApplicationSaved | null = null, current: Application, bbResult: BbResult = { state: 'pending', actual: null };
  let selfResult: Awaited<ReturnType<NonNullable<ApplicationPorts['self']>['reconcile']>> = { state: 'updated', actual: '0.1.2' };
  let replace: (() => Promise<void>) | undefined;
  const events: string[] = [], writes: ApplicationSaved[] = [], logs: unknown[] = [];
  const ports: ApplicationPorts = {
    inspect: async () => structuredClone(rows), validateMix: async () => {},
    update: async id => { assert.notEqual(id, 'pa-updates', 'self must never enter the ordinary integration loop'); events.push(id); return { actual: '0.1.2', updated: true }; },
    quiesce: async ids => { assert.ok(!ids.includes('pa-updates'), 'self is never a sync pause target'); }, restore: async () => {},
    load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); writes.push(structuredClone(value)); }, diagnose: (stage, code) => { logs.push({ stage, code }); },
    self: {
      prepare: async authorized => { events.push('prepare-self'); assert.equal(authorized.fingerprint, 'original-pa-updates'); return { before: authorized.installed, source: 'fixture-before', requestedAt: new Date().toISOString() }; },
      apply: async intent => { assert.deepEqual(saved!.job!.selfIntent, intent); assert.equal(saved!.job!.phase, 'self-updating'); assert.equal(saved!.job!.syncReserved, false); assert.equal(saved!.job!.receipts.find(row => row.id === 'pa-updates')!.outcome, 'activating'); events.push('self'); await replace?.(); },
      reconcile: async () => { events.push('read-self'); return structuredClone(selfResult); },
    },
  };
  const make = () => (current = new Application(ports));
  const runtime = () => {
    const review: RuntimeReview = { target: { id: 'fixture', name: 'Fixture' }, runningThreadCount: 0, rows: ['pi', 'bb'].map(id => ({ id: id as 'pi' | 'bb', installed: '1.0.0', available: '1.0.1', fingerprint: id, source: id === 'pi' ? 'npmGlobal' : 'npm', state: 'ready', reason: null })) };
    ports.runtime = {
      inspect: async () => structuredClone(review), updateCli: async id => { events.push(id); return { actual: '1.0.2', source: 'npmGlobal' }; },
      prepareBb: async () => ({ hostId: 'fixture', previousResultId: null, requestedAt: new Date().toISOString(), fromVersion: '1.0.0', fromCommit: null }),
      applyBb: async () => { events.push('bb'); }, reconcileBb: async () => { events.push('read-bb'); return structuredClone(bbResult); },
    };
  };
  return { ports, make, runtime, events, writes, logs, saved: () => structuredClone(saved), current: () => current, onReplace: (action: () => Promise<void>) => { replace = action; }, bbResult: (result: BbResult) => { bbResult = result; }, selfResult: (result: typeof selfResult) => { selfResult = result; } };
}
async function apply(app: Application) { await app.start(); const review = (await app.review()).review!; await app.apply({ reviewId: review.id, choices: [] }); return review; }

test('native self admission is durable, last, and disposal never joins its own replacement', async () => {
  const f = fixture([row('google-calendar'), row('pa-updates')]); const old = f.make(); let replacement: Application;
  f.ports.quiesce = async (ids, _job, remember) => { assert.deepEqual(ids, ['google-calendar']); f.events.push('pause'); await remember(); };
  f.ports.restore = async () => { f.events.push('restore'); };
  f.onReplace(async () => {
    await old.dispose(); const writes = f.writes.length;
    replacement = f.make(); await replacement.start();
    assert.equal(f.writes.length, writes); assert.ok(!f.events.includes('read-self'), 'replacement factory must return before native reads');
  });
  const review = await apply(old); await old.join(); const saved = f.saved()!;
  assert.deepEqual(f.events, ['pause', 'google-calendar', 'restore', 'prepare-self', 'self']);
  assert.equal(saved.job!.phase, 'self-updating'); const writes = f.writes.length;
  const result = await replacement!.refresh();
  assert.equal(result.job!.id, saved.job!.id); assert.equal(result.job!.reviewId, review.id); assert.equal(result.job!.phase, 'complete');
  assert.equal(result.job!.receipts.find(row => row.id === 'pa-updates')!.actual, '0.1.2');
  assert.equal(f.writes.length, writes + 1); await replacement!.refresh(); assert.equal(f.events.filter(event => event === 'self').length, 1);
});
test('after BB restart only the same job’s not-yet-admitted final self step can continue', async () => {
  const f = fixture([row('google-calendar'), row('pa-updates')]); f.runtime(); const old = f.make();
  const review = await apply(old); await old.join(); assert.equal(old.status().job!.phase, 'restarting');
  assert.deepEqual(f.events, ['google-calendar', 'pi', 'bb', 'read-bb']); const jobId = old.status().job!.id;
  await old.dispose(); f.bbResult({ state: 'updated', actual: '1.0.2' });
  const restarted = f.make(), before = [...f.events]; await restarted.start(); assert.deepEqual(f.events, before);
  let replacement: Application;
  f.onReplace(async () => { await restarted.dispose(); replacement = f.make(); await replacement.start(); });
  await Promise.all([restarted.refresh(), restarted.refresh()]); await restarted.join();
  assert.deepEqual(f.events, ['google-calendar', 'pi', 'bb', 'read-bb', 'read-bb', 'prepare-self', 'self']);
  const done = await replacement!.refresh(); assert.equal(done.job!.phase, 'complete'); assert.equal(done.job!.id, jobId); assert.equal(done.job!.reviewId, review.id);
  assert.deepEqual(done.job!.runtimeReceipts.map(row => row.outcome), ['updated', 'updated']); assert.equal(done.job!.receipts[1].outcome, 'updated');
  await replacement!.refresh(); assert.equal(f.events.filter(event => event === 'self').length, 1);
});
test('a restored continuation-only checkpoint releases reconciliation after self preflight fails', async () => {
  const f = fixture(), original = f.make(); await original.start();
  const review = (await original.review()).review!;
  await f.ports.save(applicationSavedSchema.parse({ review, job: {
    id: '22222222-2222-4222-8222-222222222222', reviewId: review.id, phase: 'self-updating', failure: null,
    syncReserved: false, selfIntent: null, bbIntent: null, runtimeReceipts: [], confirmInterruptingThreads: false,
    receipts: [{ id: 'pa-updates', choice: 'install', before: '0.1.0', preview: '0.1.1', actual: null, outcome: 'pending' }],
  } }));
  await original.dispose(); f.ports.inspect = async () => [];
  const restored = f.make(); await restored.start();
  await restored.refresh(); await restored.join();
  assert.equal(restored.status().job!.phase, 'attention'); assert.equal(restored.status().job!.failure, 'changed');
  assert.equal(restored.status().job!.selfIntent, null); assert.deepEqual(f.events, []);
  assert.deepEqual(await restored.refresh(), restored.status(), 'refresh must not retain the initial applying snapshot');
  const fresh = await restored.review(); assert.equal(fresh.applying, false);
  assert.notEqual(fresh.review!.id, review.id, 'a failed continuation must not block a new review');
});
test('failed or uncertain BB stops the remaining self step rather than inventing a continuation or retry', async () => {
  for (const state of ['failed', 'uncertain'] as const) {
    const f = fixture(); f.runtime(); f.bbResult({ state, actual: state === 'failed' ? '1.0.0' : null });
    const app = f.make(); await apply(app); await app.join();
    assert.equal(app.status().job!.phase, 'attention'); assert.equal(app.status().job!.selfIntent, null);
    assert.equal(app.status().job!.receipts[0].outcome, 'pending');
    await app.dispose(); const restored = f.make(); await restored.start(); await restored.refresh();
    assert.ok(!f.events.includes('prepare-self')); assert.ok(!f.events.includes('self')); assert.equal(f.events.filter(event => event === 'bb').length, 1);
  }
});
test('a kept self remains unchanged while another released component updates', async () => {
  const f = fixture([row('google-calendar'), row('pa-updates', 'custom')]), app = f.make();
  await apply(app); await app.join(); assert.deepEqual(f.events, ['google-calendar']);
  assert.equal(app.status().job!.receipts[1].outcome, 'kept'); assert.equal(app.status().job!.selfIntent, null);
  const only = fixture([row('pa-updates', 'custom')]), kept = only.make(); await apply(kept); assert.equal(kept.status().job, null); assert.deepEqual(only.events, []);
});
test('self intent storage failure prevents admission, and an admitted uncertain write is never replayed', async () => {
  const blocked = fixture(), stopped = blocked.make(), save = blocked.ports.save;
  blocked.ports.save = async value => { if (value.job?.selfIntent) throw new Error('PRIVATE_SENTINEL'); await save(value); };
  await apply(stopped); await stopped.join(); assert.equal(stopped.status().failure, 'storage'); assert.ok(!blocked.events.includes('self'));
  const f = fixture(), app = f.make(); f.onReplace(async () => { throw new Error('PRIVATE_SENTINEL'); });
  await apply(app); await app.join(); assert.equal(app.status().job!.receipts[0].outcome, 'uncertain'); await app.dispose();
  const restored = f.make(); await restored.start(); f.selfResult({ state: 'uncertain', actual: null }); await restored.refresh();
  const writes = f.writes.length; await restored.refresh(); assert.equal(f.writes.length, writes, 'unchanged read-only results must not create a realtime write loop');
  f.selfResult({ state: 'updated', actual: '0.1.2' }); await restored.refresh(); assert.equal(restored.status().job!.phase, 'complete');
  assert.equal(f.events.filter(event => event === 'self').length, 1); assert.ok(!JSON.stringify([f.saved(), f.logs, blocked.logs]).includes('PRIVATE_SENTINEL'));
});
test('self reconciliation cannot race discovery through the shared original-build cache', async () => {
  const rows = [row('pa-updates')], f = fixture(rows), app = f.make();
  f.onReplace(async () => { throw new Error('PRIVATE_SENTINEL'); }); await apply(app); await app.join();
  f.selfResult({ state: 'uncertain', actual: null });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), blocked = new Promise<void>(resolve => { entered = resolve; });
  f.ports.inspect = async () => { entered(); await gate; return structuredClone(rows); };
  const checking = app.review({ automatic: true }); await blocked;
  const before = f.events.filter(event => event === 'read-self').length;
  try { await app.refresh(); assert.equal(f.events.filter(event => event === 'read-self').length, before); }
  finally { release(); await checking; }
  await app.refresh(); assert.equal(f.events.filter(event => event === 'read-self').length, before + 1);
});
test('older saved jobs default self intent to null and never acquire a self receipt', async () => {
  const f = fixture([row('google-calendar')]), app = f.make(); await apply(app); await app.join();
  const old = f.saved()!; delete (old.job as Partial<NonNullable<ApplicationSaved['job']>>).selfIntent;
  const parsed = applicationSavedSchema.parse(old); assert.equal(parsed.job!.selfIntent, null);
  f.ports.load = async () => old; const restored = f.make(); await restored.start(); await restored.refresh();
  assert.deepEqual(restored.status().job!.receipts.map(row => row.id), ['google-calendar']); assert.ok(!f.events.includes('self'));
});
