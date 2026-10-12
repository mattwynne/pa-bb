import test from 'node:test';
import assert from 'node:assert/strict';
import { ICloudSync } from '../core/service.ts';
import { CloudError } from '../core/ports.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
import { diagnosticsSchema } from '../core/diagnostics.ts';
function fixture() {
  const provider = new FakeCloudProvider(); const state = new MemoryState(); let stored: any;
  let wall = Date.parse('2026-01-01T00:00:00Z'); let monotonic = 0; let brokenRead = false; let brokenWrite = false;
  const logs: unknown[] = [];
  const history = { load: async () => { if (brokenRead) throw new Error('sentinel-read-secret'); return structuredClone(stored); }, save: async (value: unknown) => { if (brokenWrite) throw new Error('sentinel-write-secret'); stored = structuredClone(value); } };
  const service = () => new ICloudSync(provider, state, () => new Date(wall).toISOString(), () => 'sentinel-private-mirror', (stage, failure, details) => logs.push({ stage, failure, details }), history, () => monotonic);
  const sync = service();
  const setup = async () => { await sync.start(); await sync.connect({ account: 'sentinel-account', password: 'sentinel-password' }); await sync.answerChallenge('123456'); await sync.browse(null); await sync.select('test'); await sync.enable('sentinel-private-mirror'); logs.length = 0; };
  return { provider, state, sync, service, setup, logs, history, advance: (ms: number) => { wall += ms; monotonic += ms; }, shiftWallClock: (ms: number) => { wall += ms; }, stored: () => stored, corrupt: (v: unknown) => { stored = v; }, failRead: () => { brokenRead = true; }, failWrite: () => { brokenWrite = true; } };
}
test('successful run history retains measured stages without private fields or routine success logs', async () => {
  const f = fixture(); await f.setup();
  f.provider.synchronize = async (_mirror, report) => {
    f.advance(10); report!({ stage: 'backing_up_cloud', bytes: 0, totalBytes: 4, files: 0, totalFiles: 1, msg: 'sentinel-token' } as any);
    f.advance(20); report!({ stage: 'backing_up_cloud', bytes: 4, totalBytes: 4, files: 1, totalFiles: 1, reusedFiles: 12 });
    f.advance(5); report!({ stage: 'verifying', bytes: 0, totalBytes: null, files: 0, totalFiles: null }); f.advance(15);
  };
  await f.sync.tick(); const history = diagnosticsSchema.parse(f.sync.diagnostics()); const run = history.runs.at(-1)!;
  assert.equal(run.sequence, 2); assert.equal(run.outcome, 'succeeded'); assert.equal(run.durationMs, 50);
  assert.deepEqual(run.stages.map(s => [s.stage, s.durationMs]), [['checking', 10], ['backing_up_cloud', 25], ['verifying', 15]]);
  assert.equal(run.stages[1].bytes, 4); assert.equal(run.stages[1].files, 1); assert.equal(run.stages[1].reusedFiles, 12); assert.equal(run.failure, null); assert.equal(run.failureStage, null);
  assert.doesNotMatch(JSON.stringify(history) + JSON.stringify(f.stored()) + JSON.stringify(f.logs), /sentinel/); assert.deepEqual(f.logs, []);
  const reloaded = f.service(); await reloaded.start(); assert.deepEqual(reloaded.diagnostics().runs, history.runs);
});
test('duration uses a monotonic clock and repeated stages accumulate rather than inventing elapsed wall time', async () => {
  const f = fixture(); await f.setup();
  f.provider.synchronize = async (_mirror, report) => {
    f.advance(10); report!({ stage: 'verifying', bytes: 0, totalBytes: null, files: 0, totalFiles: null });
    f.advance(15); f.shiftWallClock(-300_000); report!({ stage: 'checking', bytes: 0, totalBytes: null, files: 0, totalFiles: null }); f.advance(20);
  };
  await f.sync.tick(); const run = f.sync.diagnostics().runs.at(-1)!;
  assert.equal(run.durationMs, 45); assert.equal(run.stages.find(s => s.stage === 'checking')!.durationMs, 30); assert.equal(run.stages.find(s => s.stage === 'verifying')!.durationMs, 15);
  assert.ok(Date.parse(run.finishedAt) < Date.parse(run.startedAt));
});
test('expired valid history is removed from scoped storage on reload', async () => {
  const f = fixture(); await f.setup(); f.advance(8 * 86400_000); const reloaded = f.service(); await reloaded.start();
  assert.deepEqual(reloaded.diagnostics().runs, []); assert.deepEqual(f.stored().runs, []); assert.equal(f.stored().sequence, 1);
});
test('failure history and log context contain only whitelisted exit evidence and the failing stage', async () => {
  const f = fixture(); await f.setup(); const prior = f.sync.status().mirrors[0].lastSuccess;
  f.provider.synchronize = async (_mirror, report) => { report!({ stage: 'backing_up_cloud', bytes: 2, totalBytes: 4, files: 0, totalFiles: 1 }); f.advance(25); throw new CloudError('sync_failed', { kind: 'command_exit', exitCode: 4, message: 'sentinel-provider-body' } as any); };
  await f.sync.tick(); const run = f.sync.diagnostics().runs.at(-1)!;
  assert.equal(run.outcome, 'failed'); assert.equal(run.failure, 'sync_failed'); assert.equal(run.failureStage, 'backing_up_cloud'); assert.deepEqual(run.evidence, { kind: 'command_exit', exitCode: 4 });
  assert.deepEqual(f.logs, [{ stage: 'sync/backing_up_cloud', failure: 'sync_failed', details: { run: 2, evidence: { kind: 'command_exit', exitCode: 4 } } }]);
  assert.equal(f.sync.status().mirrors[0].lastSuccess, prior); assert.doesNotMatch(JSON.stringify(run) + JSON.stringify(f.logs), /sentinel/);
});
test('retention caps completed runs and age without resetting the internal sequence', async () => {
  const f = fixture(); await f.setup();
  for (let i = 0; i < 25; i++) { f.advance(60_000); await f.sync.tick(); }
  assert.equal(f.sync.diagnostics().runs.length, 20); assert.equal(f.sync.diagnostics().runs[0].sequence, 7);
  f.advance(8 * 86400_000); assert.equal(f.sync.diagnostics().runs.length, 0);
  await f.sync.tick(); assert.equal(f.sync.diagnostics().runs.length, 1); assert.equal(f.sync.diagnostics().runs[0].sequence, 27);
});
test('pending-run restart records interruption without inventing duration, stage or safe rollback', async () => {
  const f = fixture(); await f.setup(); let release!: () => void;
  f.provider.pending = new Promise(resolve => { release = resolve; }); const task = f.sync.tick();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.stored().active.sequence, 2); assert.equal(f.stored().runs.length, 1);
  const reloaded = f.service(); await reloaded.start(); const run = reloaded.diagnostics().runs.at(-1)!;
  assert.equal(run.outcome, 'interrupted'); assert.equal(run.durationMs, null); assert.equal(run.failureStage, null); assert.deepEqual(run.stages, []); assert.equal(reloaded.diagnostics().active, null);
  assert.equal(reloaded.status().mirrors[0].phase, 'failed');
  release(); await task;
});
test('diagnostic storage failure does not turn a completed sync into a failure or retry it', async () => {
  const f = fixture(); await f.setup(); f.failWrite(); f.advance(100); await f.sync.tick();
  assert.equal(f.sync.status().mirrors[0].phase, 'ready'); assert.equal(f.sync.status().mirrors[0].failure, null); assert.equal(f.provider.synced, 1);
  assert.equal(f.sync.diagnostics().persistent, false); assert.equal(f.sync.diagnostics().runs.at(-1)!.outcome, 'succeeded');
  assert.equal(f.logs.filter((l: any) => l.stage === 'history_write').length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /sentinel/);
});
test('malformed stored history and read failures are reported without exposing or overwriting private data', async () => {
  for (const readFailure of [false, true]) {
    const f = fixture(); f.corrupt({ secret: 'sentinel-stored-token' }); if (readFailure) f.failRead();
    await f.sync.start(); assert.equal(f.sync.diagnostics().persistent, false); assert.deepEqual(f.sync.diagnostics().runs, []);
    await f.sync.connect({ account: 'synthetic', password: 'synthetic' }); await f.sync.answerChallenge('123456'); await f.sync.browse(null); await f.sync.select('test'); await f.sync.enable('sentinel-private-mirror');
    assert.deepEqual(f.stored(), { secret: 'sentinel-stored-token' }); assert.doesNotMatch(JSON.stringify(f.sync.diagnostics()) + JSON.stringify(f.logs), /sentinel/);
  }
});
