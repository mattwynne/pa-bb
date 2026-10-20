import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Application, ApplicationError } from '../core/application.ts';
import type { ApplicationPorts, Assessment } from '../core/application.ts';
import type { RuntimeReview, BbResult } from '../core/runtime-model.ts';
import { hasFreshOffers } from '../core/notice.ts';
const row = (id: Assessment['id'] = 'google-calendar', local: Assessment['local'] = 'stock'): Assessment => ({ id, installed: '0.1.0', available: '0.1.1', local, fingerprint: `original-${id}`, prerequisite: null });
function fixture(rows = [row()]) {
  let stored: unknown, updates: string[] = [], logs: unknown[] = [];
  const ports: ApplicationPorts = {
    inspect: async () => structuredClone(rows), validateMix: async () => {}, update: async id => { updates.push(id); return { actual: '0.1.2', updated: true }; },
    quiesce: async () => {}, restore: async () => {}, load: async () => stored,
    save: async value => { stored = structuredClone(value); }, diagnose: (stage, code) => { logs.push({ stage, code }); },
  };
  return { rows, ports, updates, logs, app: new Application(ports), stored: () => stored };
}
test('one server-owned review applies ordinary newer release and records actual versions, not preview pins', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.rows[0].available = '0.1.2';
  await Promise.all(Array.from({ length: 4 }, () => f.app.apply({ reviewId: review.id, choices: [] })));
  await f.app.join(); assert.deepEqual(f.updates, ['google-calendar']);
  const state = f.app.status(); assert.equal(state.job?.phase, 'complete');
  assert.equal(state.job?.receipts[0].preview, '0.1.1'); assert.equal(state.job?.receipts[0].actual, '0.1.2');
  await assert.rejects(f.app.apply({ reviewId: review.id, choices: [] }), ApplicationError);
});
test('custom defaults keep; explicit replacement updates only authorized components', async () => {
  const f = fixture([row('google-calendar', 'custom'), row('fastmail', 'custom'), row('google-drive')]);
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [{ id: 'fastmail', choice: 'install' }] }); await f.app.join();
  assert.deepEqual(f.updates, ['fastmail', 'google-drive']);
  assert.equal(f.app.status().job?.receipts.find(r => r.id === 'google-calendar')?.outcome, 'kept');
});
test('all kept is not an empty success; arbitrary choices and stale local authorization cannot apply', async () => {
  const f = fixture([row('google-calendar', 'custom')]); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); assert.equal(f.app.status().job, null);
  await assert.rejects(f.app.apply({ reviewId: review.id, choices: [{ id: 'icloud', choice: 'install' }] }));
  f.rows[0].fingerprint = 'new-local-edit';
  await f.app.apply({ reviewId: review.id, choices: [{ id: 'google-calendar', choice: 'install' }] }); await f.app.join();
  assert.deepEqual(f.updates, []); assert.equal(f.app.status().job?.failure, 'changed');
});
test('partial/uncertain writes are not retried and diagnostics cannot echo host exception text', async () => {
  const f = fixture([row('google-calendar'), row('fastmail')]);
  f.ports.update = async id => { f.updates.push(id); if (id === 'fastmail') throw new Error('PRIVATE_SENTINEL credentials response'); return { actual: '0.1.2', updated: true }; };
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.phase, 'attention'); assert.equal(f.app.status().job?.receipts[1].outcome, 'uncertain');
  assert.ok(!JSON.stringify([f.app.status(), f.logs, f.stored()]).includes('PRIVATE_SENTINEL'));
  const restarted = new Application(f.ports); await restarted.start(); assert.deepEqual(f.updates, ['google-calendar', 'fastmail']);
});
test('pause restoration is persisted before mutation and retained if restoring fails', async () => {
  const f = fixture(); let pauseJob: string;
  f.ports.quiesce = async (_ids, jobId, remember) => { pauseJob = jobId; await remember(); throw new ApplicationError('unavailable'); };
  f.ports.restore = async jobId => { assert.equal(jobId, pauseJob); throw new Error('PRIVATE_SENTINEL'); };
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.deepEqual(f.updates, []); assert.equal(f.app.status().job?.syncReserved, true);
  assert.equal((await f.app.review()).review?.id, review.id, 'do not overwrite a job with unresolved pause restoration');
});
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
test('explicit Check again joining automatic discovery promotes the same scan to a fresh review', async () => {
  for (const blockRuntime of [false, true]) {
    const f = fixture(); await f.app.start(); const previous = (await f.app.review()).review!;
    await f.app.apply({ reviewId: previous.id, choices: [] }); await f.app.join(); const job = f.app.status().job;
    f.rows[0].installed = '0.1.2'; f.rows[0].available = '0.1.3';
    const gate = deferred(), entered = deferred(); let inspections = 0;
    f.ports.inspect = async () => { inspections++; if (!blockRuntime) { entered.resolve(); await gate.promise; } return f.rows; };
    if (blockRuntime) f.ports.runtime = { ...runtimeFixture().ports.runtime!, inspect: async () => { entered.resolve(); await gate.promise; return { target: null, runningThreadCount: 0, rows: [] }; } };
    const automatic = f.app.review({ automatic: true }); await entered.promise;
    const explicit = f.app.review(); assert.equal(explicit, automatic);
    gate.resolve(); const result = await explicit;
    assert.equal(inspections, 1); assert.notEqual(result.review?.id, previous.id);
    assert.equal(result.review?.rows[0].available, '0.1.3'); assert.deepEqual(result.job, job);
  }
});
test('automatic discovery retains an active job and cannot reuse pre-apply readiness as a completion notification', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  assert.equal(hasFreshOffers(f.app.status()), true);
  const entered = deferred(), gate = deferred();
  f.ports.update = async () => { entered.resolve(); await gate.promise; return { actual: '0.1.2', updated: true }; };
  await f.app.apply({ reviewId: review.id, choices: [] }); await entered.promise;
  const active = f.app.status(), stored = f.stored();
  try {
    const result = await f.app.review({ automatic: true });
    assert.deepEqual(result.job, active.job); assert.deepEqual(f.stored(), stored); assert.equal(hasFreshOffers(result), false);
  } finally { gate.resolve(); await f.app.join(); }
  assert.equal(hasFreshOffers(f.app.status()), false);
});
test('automatic offers can refresh a reserved result but cannot invite application or discard recovery', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.ports.quiesce = async (_ids, _job, remember) => { await remember(); throw new ApplicationError('unavailable'); };
  f.ports.restore = async () => { throw new ApplicationError('unavailable'); };
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join(); const saved = f.stored();
  f.rows[0].available = '0.1.3';
  const result = await f.app.review({ automatic: true });
  assert.equal(result.offers?.available, true); assert.equal(hasFreshOffers(result), false);
  assert.deepEqual(f.stored(), saved); assert.equal(result.review?.id, result.job?.reviewId);
  assert.equal((await f.app.review()).review?.id, review.id);
});
test('a failed automatic scan invalidates readiness without losing the saved result', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join(); const saved = f.stored();
  f.rows[0].available = '0.1.3'; assert.equal(hasFreshOffers(await f.app.review({ automatic: true })), true);
  f.ports.inspect = async () => { throw new Error('PRIVATE_SENTINEL'); };
  const result = await f.app.review({ automatic: true });
  assert.equal(result.offers, null); assert.equal(hasFreshOffers(result), false); assert.deepEqual(f.stored(), saved);
});
test('disposing during review fences obsolete KV writers, without waiting for its read', async () => {
  const f = fixture(); await f.app.start(); const gate = deferred<Assessment[]>();
  f.ports.inspect = () => gate.promise;
  const oldReview = f.app.review(); await f.app.dispose();
  f.ports.inspect = async () => [row()];
  const replacement = new Application(f.ports); await replacement.start(); const fresh = await replacement.review();
  gate.resolve([row('fastmail')]); await oldReview;
  assert.deepEqual(f.stored(), { review: fresh.review, job: null });
});
test('disposal stops delayed preflight from admitting a native update; it never joins a held registration lock', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  const gate = deferred<Assessment[]>(); f.ports.inspect = () => gate.promise;
  await f.app.apply({ reviewId: review.id, choices: [] });
  await f.app.dispose(); // Must finish while preflight is still pending.
  const replacement = new Application(f.ports); await replacement.start(); const saved = f.stored();
  gate.resolve([row()]); await f.app.join();
  assert.deepEqual(f.updates, []); assert.deepEqual(f.stored(), saved);
  assert.equal(replacement.status().job?.failure, 'interrupted');
});
test('already-issued native request can settle after disposal, but cannot overwrite the replacement receipt', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  const entered = deferred(), nativeLock = deferred();
  f.ports.update = async id => { f.updates.push(id); entered.resolve(); await nativeLock.promise; return { actual: '0.1.2', updated: true }; };
  await f.app.apply({ reviewId: review.id, choices: [] }); await entered.promise;
  await f.app.dispose(); // Waiting for update here would deadlock with BB's disposer lock.
  const replacement = new Application(f.ports); await replacement.start(); const saved = f.stored();
  nativeLock.resolve(); await f.app.join();
  assert.deepEqual(f.stored(), saved); assert.equal(replacement.status().job?.receipts[0].outcome, 'uncertain');
});
test('disposal drains only in-flight storage before allowing replacement startup', async () => {
  const f = fixture(); await f.app.start(); const entered = deferred(), gate = deferred();
  const save = f.ports.save; f.ports.save = async value => { entered.resolve(); await gate.promise; await save(value); };
  const reviewing = f.app.review(); await entered.promise;
  let disposed = false; const disposal = f.app.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  gate.resolve(); await disposal; await reviewing; assert.equal(disposed, true);
});
test('disposal fences an in-flight explicit sync restoration too', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.ports.quiesce = async (_ids, _jobId, remember) => { await remember(); throw new ApplicationError('unavailable'); };
  f.ports.restore = async () => { throw new ApplicationError('unavailable'); };
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  const gate = deferred(); f.ports.restore = () => gate.promise;
  const restoring = f.app.resumeSync(); await f.app.dispose(); const saved = f.stored();
  gate.resolve(); await restoring; assert.deepEqual(f.stored(), saved);
});
function runtimeFixture(rows = [row()]) {
  const f = fixture(rows), events: string[] = [];
  const runtime: RuntimeReview = { target: { id: 'pa-server', name: 'PA test server' }, runningThreadCount: 0, rows: ['pi', 'codex', 'bb'].map(id => ({ id: id as 'pi' | 'codex' | 'bb', installed: id === 'bb' ? '0.46.0' : '1.0.0', available: id === 'bb' ? '0.46.1' : '1.0.1', source: id === 'bb' ? 'npm' : 'npmGlobal', fingerprint: `original-${id}`, state: 'ready', reason: null })) };
  let result: BbResult = { state: 'pending', actual: null };
  f.ports.quiesce = async (_ids, _job, remember) => { events.push('pause'); await remember(); };
  f.ports.restore = async () => { events.push('restore'); };
  f.ports.runtime = {
    inspect: async () => structuredClone(runtime),
    updateCli: async id => { events.push(id); return { actual: '1.0.2', source: 'npmGlobal' }; },
    prepareBb: async () => ({ hostId: 'pa-server', previousResultId: null, requestedAt: new Date().toISOString(), fromVersion: '0.46.0', fromCommit: null }),
    applyBb: async () => { const saved = f.app.status().job!; assert.equal(saved.phase, 'restarting'); assert.equal(saved.syncReserved, false); assert.ok(saved.bbIntent); events.push('bb'); },
    reconcileBb: async () => structuredClone(result),
  };
  return { ...f, runtime, events, result: (next: BbResult) => { result = next; } };
}
test('a new native source-BB offer can follow a successful update without a different displayed version', async () => {
  const f = runtimeFixture([]); f.runtime.rows = f.runtime.rows.filter(row => row.id === 'bb');
  Object.assign(f.runtime.rows[0], { installed: '0.46.0', available: '0.46.0', source: 'source' });
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  f.result({ state: 'updated', actual: '0.46.0' }); await f.app.refresh(); const saved = f.stored();
  f.runtime.rows[0].fingerprint = 'new-installed-commit';
  assert.equal(hasFreshOffers(await f.app.review({ automatic: true })), true);
  assert.deepEqual(f.stored(), saved);
  f.runtime.rows[0].state = 'current'; f.runtime.rows[0].available = null;
  assert.equal(hasFreshOffers(await f.app.review({ automatic: true })), false);
});
test('one persisted job restores integrations, updates CLIs, then reconciles BB after restart without reissuing native writes', async () => {
  const f = runtimeFixture(); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.deepEqual(f.events, ['pause', 'restore', 'pi', 'codex', 'bb']);
  assert.equal(f.app.status().job?.phase, 'restarting'); assert.equal(f.app.status().applying, true);
  await f.app.apply({ reviewId: review.id, choices: [] }); assert.equal((await f.app.review()).review?.id, review.id);
  await f.app.dispose(); f.result({ state: 'updated', actual: '0.46.2' });
  const restarted = new Application(f.ports); await restarted.start();
  assert.equal(restarted.status().job?.phase, 'complete');
  assert.deepEqual(restarted.status().job?.runtimeReceipts.map(row => [row.id, row.actual]), [['pi', '1.0.2'], ['codex', '1.0.2'], ['bb', '0.46.2']]);
  assert.equal(f.events.filter(event => event === 'bb').length, 1);
});
test('provisional launcher startup stays reconcilable and definitive native failures are not called uncertain', async () => {
  for (const outcome of ['updated', 'failed'] as const) {
    const f = runtimeFixture(); await f.app.start(); const review = (await f.app.review()).review!;
    await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join(); await f.app.dispose();
    const restarted = new Application(f.ports); await restarted.start();
    assert.equal(restarted.status().job?.phase, 'restarting');
    f.result({ state: outcome, actual: outcome === 'updated' ? '0.46.2' : '0.46.0' });
    await restarted.refresh();
    assert.equal(restarted.status().job?.runtimeReceipts.find(row => row.id === 'bb')?.outcome, outcome);
    assert.equal(f.events.filter(event => event === 'bb').length, 1);
  }
});
test('known native admission refusals finish as failed without waiting for a restart result', async () => {
  const f = runtimeFixture(); f.ports.runtime!.applyBb = async () => { throw new ApplicationError('busy'); };
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.phase, 'attention'); assert.equal(f.app.status().job?.failure, 'busy');
  assert.equal(f.app.status().job?.runtimeReceipts.find(row => row.id === 'bb')?.outcome, 'failed');
});
test('late native result can resolve an uncertain BB receipt without a new restart', async () => {
  const f = runtimeFixture(); f.result({ state: 'uncertain', actual: null }); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join(); assert.equal(f.app.status().job?.phase, 'attention');
  f.result({ state: 'updated', actual: '0.46.2' }); await f.app.refresh();
  assert.equal(f.app.status().job?.phase, 'complete'); assert.equal(f.events.filter(event => event === 'bb').length, 1);
});
test('failed folders release sync reservation and remain an attention result, not an endless resume trap', async () => {
  const f = runtimeFixture(); f.ports.restore = async () => 'manual_recovery'; await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.syncReserved, false); assert.equal(f.app.status().job?.failure, 'sync_recovery'); assert.ok(!f.events.includes('bb'));
});
test('unknown integrations are skipped without claiming local customization or blocking runtime offers', async () => {
  const f = runtimeFixture([row('google-calendar', 'unknown')]); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.receipts[0].outcome, 'skipped'); assert.deepEqual(f.updates, []); assert.ok(f.events.includes('pi'));
});
test('runtime-only updates are not discarded as an empty integration job', async () => {
  const f = runtimeFixture([]); await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.receipts.length, 0); assert.equal(f.app.status().job?.runtimeReceipts.length, 3);
});
test('new running threads require native restart consent before any integration mutation', async () => {
  const f = runtimeFixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.runtime.runningThreadCount = 1;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.failure, 'busy'); assert.deepEqual(f.updates, []); assert.deepEqual(f.events, []);
});
test('changed runtime host and CLI fingerprint fail preflight without mutation', async () => {
  for (const change of ['host', 'fingerprint']) {
    const f = runtimeFixture(); await f.app.start(); const review = (await f.app.review()).review!;
    if (change === 'host') f.runtime.target!.id = 'another-machine'; else f.runtime.rows[0].fingerprint = 'another-install';
    await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
    assert.equal(f.app.status().job?.failure, 'changed'); assert.deepEqual(f.events, []);
  }
});
test('uncertain CLI writes preserve earlier actual receipts and never proceed to BB or retry on reload', async () => {
  const f = runtimeFixture(); f.ports.runtime!.updateCli = async id => { f.events.push(id); if (id === 'codex') throw new Error('PRIVATE_SENTINEL'); return { actual: '1.0.2', source: 'npmGlobal' }; };
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().job?.runtimeReceipts[0].actual, '1.0.2'); assert.equal(f.app.status().job?.runtimeReceipts[1].outcome, 'uncertain');
  const restarted = new Application(f.ports); await restarted.start(); assert.ok(!f.events.includes('bb'));
  assert.equal(f.events.filter(event => event === 'codex').length, 1);
  assert.ok(!JSON.stringify([f.stored(), f.logs]).includes('PRIVATE_SENTINEL'));
});
test('failure to persist BB restart intent prevents native restart admission', async () => {
  const f = runtimeFixture(), save = f.ports.save;
  f.ports.save = async value => { if (value.job?.phase === 'restarting') throw new Error('PRIVATE_SENTINEL'); await save(value); };
  await f.app.start(); const review = (await f.app.review()).review!;
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.equal(f.app.status().failure, 'storage'); assert.ok(!f.events.includes('bb'));
});
test('storage failure refuses to start application', async () => {
  const f = fixture(); await f.app.start(); const review = (await f.app.review()).review!;
  f.ports.save = async () => { throw new Error('PRIVATE_SENTINEL storage'); };
  await f.app.apply({ reviewId: review.id, choices: [] }); await f.app.join();
  assert.deepEqual(f.updates, []); assert.equal(f.app.status().failure, 'storage');
});
