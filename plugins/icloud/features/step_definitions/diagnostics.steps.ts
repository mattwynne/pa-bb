import { Given, When, Then, World } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { ICloudSync } from '../../core/service.ts';
import { CloudError } from '../../core/ports.ts';
import { FakeCloudProvider, MemoryState } from '../../test/fakes.ts';
type DiagnosticWorld = World & { diagnostic: { sync: ICloudSync; create: () => ICloudSync; provider: FakeCloudProvider; logs: unknown[]; prior: string | null; advance: (ms: number) => void; breakWrites: () => void } };
Given('a syncing installation with diagnostic history', async function(this: DiagnosticWorld) {
  const provider = new FakeCloudProvider(); const state = new MemoryState(); let stored: unknown; let writeFailure = false; let milliseconds = Date.parse('2026-01-01T00:00:00Z'); const logs: unknown[] = [];
  const history = { load: async () => stored, save: async (value: unknown) => { if (writeFailure) throw new Error('sentinel-storage-content'); stored = structuredClone(value); } };
  const create = () => new ICloudSync(provider, state, () => new Date(milliseconds).toISOString(), () => 'diagnostic-mirror', (stage, failure, details) => logs.push({ stage, failure, details }), history, () => milliseconds);
  const sync = create(); await sync.start(); await sync.connect({ account: 'synthetic', password: 'synthetic' }); await sync.answerChallenge('123456'); await sync.browse(null); await sync.select('test'); await sync.enable('diagnostic-mirror'); logs.length = 0;
  this.diagnostic = { sync, create, provider, logs, prior: sync.status().mirrors[0].lastSuccess, advance: ms => { milliseconds += ms; }, breakWrites: () => { writeFailure = true; } };
});
When('a measured diagnostic sync succeeds', async function(this: DiagnosticWorld) {
  const d = this.diagnostic;
  d.provider.synchronize = async (_mirror, report) => { d.advance(10); report!({ stage: 'backing_up_cloud', bytes: 0, totalBytes: 8, files: 0, totalFiles: 2, object: 'sentinel-private-filename' } as any); d.advance(20); report!({ stage: 'backing_up_cloud', bytes: 8, totalBytes: 8, files: 2, totalFiles: 2 }); };
  await d.sync.tick();
});
Then('its history includes stage durations and measured cloud transfer counts', function(this: DiagnosticWorld) { const run = this.diagnostic.sync.diagnostics().runs.at(-1)!; assert.equal(run.outcome, 'succeeded'); assert.equal(run.durationMs, 30); const cloud = run.stages.find(s => s.stage === 'backing_up_cloud')!; assert.equal(cloud.durationMs, 20); assert.equal(cloud.bytes, 8); assert.equal(cloud.files, 2); });
Then('no routine success log or private diagnostic field is emitted', function(this: DiagnosticWorld) { const d = this.diagnostic; assert.deepEqual(d.logs, []); assert.doesNotMatch(JSON.stringify(d.sync.diagnostics()), /sentinel/); });
When('a diagnostic cloud copy fails with exit code {int}', async function(this: DiagnosticWorld, exitCode: number) { const d = this.diagnostic; d.provider.synchronize = async (_mirror, report) => { d.provider.synced++; report!({ stage: 'backing_up_cloud', bytes: 0, totalBytes: 8, files: 0, totalFiles: 2 }); throw new CloudError('sync_failed', { kind: 'command_exit', exitCode, providerText: 'sentinel-token' } as any); }; await d.sync.tick(); });
Then('the failed history identifies a missing-file command exit without provider text', function(this: DiagnosticWorld) { const d = this.diagnostic; const run = d.sync.diagnostics().runs.at(-1)!; assert.equal(run.failureStage, 'backing_up_cloud'); assert.deepEqual(run.evidence, { kind: 'command_exit', exitCode: 4 }); assert.doesNotMatch(JSON.stringify(d.sync.diagnostics()) + JSON.stringify(d.logs), /sentinel/); });
Then('the diagnostic folder pauses without retrying or changing its last success', async function(this: DiagnosticWorld) { const d = this.diagnostic; const m = d.sync.status().mirrors[0]; assert.equal(m.phase, 'failed'); assert.equal(m.enabled, false); assert.equal(m.lastSuccess, d.prior); await d.sync.tick(); assert.equal(d.provider.synced, 1); });
When('the diagnostic installation restarts', async function(this: DiagnosticWorld) { this.diagnostic.sync = this.diagnostic.create(); await this.diagnostic.sync.start(); });
Then('its completed diagnostic summary is still available', function(this: DiagnosticWorld) { assert.equal(this.diagnostic.sync.diagnostics().runs.at(-1)!.outcome, 'succeeded'); assert.equal(this.diagnostic.sync.diagnostics().runs.at(-1)!.durationMs, 30); });
When('diagnostic history storage stops accepting writes', function(this: DiagnosticWorld) { this.diagnostic.breakWrites(); });
Then('the diagnostic folder still records sync success', function(this: DiagnosticWorld) { const d = this.diagnostic; assert.equal(d.sync.status().mirrors[0].phase, 'ready'); assert.notEqual(d.sync.status().mirrors[0].lastSuccess, d.prior); });
Then('diagnostic persistence is reported unavailable without leaking its error', function(this: DiagnosticWorld) { const d = this.diagnostic; assert.equal(d.sync.diagnostics().persistent, false); assert.equal((d.logs as any[]).filter(l => l.stage === 'history_write').length, 1); assert.doesNotMatch(JSON.stringify(d.logs), /sentinel/); });
