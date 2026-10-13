import { Given, When, Then, After, World } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { ICloudSync } from '../../core/service.ts';
import { activity } from '../../core/ports.ts';
import type { SyncStage, ProgressReporter } from '../../core/ports.ts';
import { FakeCloudProvider, MemoryState } from '../../test/fakes.ts';
import { progressPercent } from '../../sync-progress.tsx';
type ProgressWorld = World & { progressService?: ICloudSync; progressProvider: FakeCloudProvider; progressRepository: MemoryState; progressPrior: string | null; progressTask?: Promise<unknown>; progressRelease?: () => void; lateReport?: ProgressReporter };
async function setupProgress(this: ProgressWorld, enabled: boolean) {
  let clock = 0;
  this.progressProvider = new FakeCloudProvider(); this.progressRepository = new MemoryState();
  this.progressService = new ICloudSync(this.progressProvider, this.progressRepository, () => new Date(++clock * 60_000).toISOString(), () => 'progress-folder', () => {});
  await this.progressService.start(); await this.progressService.connect({ account: 'synthetic', password: 'synthetic' }); await this.progressService.answerChallenge('123456');
  await this.progressService.browse(null); await this.progressService.select('test'); if (enabled) await this.progressService.enable('progress-folder');
  this.progressPrior = this.progressService.status().mirrors[0].lastSuccess;
}
Given('a progress test folder with a successful sync', async function(this: ProgressWorld) { await setupProgress.call(this, true); });
Given('a selected progress test folder before initial preparation', async function(this: ProgressWorld) { await setupProgress.call(this, false); });
When('initial progress preparation is waiting to finish', async function(this: ProgressWorld) {
  this.progressProvider.pending = new Promise(resolve => { this.progressRelease = resolve; });
  this.progressProvider.prepareMirror = async (_mirror, report) => { this.progressProvider.report = report ?? null; await this.progressProvider.pending; };
  this.progressTask = this.progressService!.enable('progress-folder'); await new Promise(resolve => setImmediate(resolve));
});
Then('initial preparation has progress but no successful timestamp', function(this: ProgressWorld) {
  const mirror = this.progressService!.status().mirrors[0]; assert.equal(mirror.initialized, false); assert.equal(mirror.lastSuccess, null); assert.equal(progressPercent(mirror.progress!), 25);
});
When('another progress test sync is waiting to finish', async function(this: ProgressWorld) {
  this.progressProvider.pending = new Promise(resolve => { this.progressRelease = resolve; });
  this.progressTask = this.progressService!.tick(); await new Promise(resolve => setImmediate(resolve));
  this.lateReport = this.progressProvider.report!;
});
When('its provider reports the {string} stage with unknown totals', function(this: ProgressWorld, stage: SyncStage) { this.progressProvider.report!(activity(stage)); });
Then('the running folder reports {string} activity without a percentage', function(this: ProgressWorld, stage: SyncStage) {
  const mirror = this.progressService!.status().mirrors[0]; assert.equal(mirror.phase, 'running'); assert.equal(mirror.progress!.stage, stage); assert.equal(progressPercent(mirror.progress!), null);
});
Then('its successful timestamp has not changed', function(this: ProgressWorld) { assert.equal(this.progressService!.status().mirrors[0].lastSuccess, this.progressPrior); });
Then('its progress is not stored in the repository', function(this: ProgressWorld) { assert.equal('progress' in this.progressRepository.value.mirrors[0], false); });
When('its provider reports a quarter of the transfer with extra private fields', function(this: ProgressWorld) {
  this.progressProvider.report!({ stage: 'transferring', bytes: 256, totalBytes: 1024, files: 1, totalFiles: 4, object: 'sentinel-private-file', msg: 'sentinel-password' } as any);
});
Then('the running folder reports {int} percent transfer progress', function(this: ProgressWorld, percent: number) { assert.equal(progressPercent(this.progressService!.status().mirrors[0].progress!), percent); });
Then('no private progress field is exposed', function(this: ProgressWorld) { assert.doesNotMatch(JSON.stringify(this.progressService!.status()), /sentinel/); });
When('its provider reports that all transfers finished', function(this: ProgressWorld) { this.progressProvider.report!({ stage: 'transferring', bytes: 1024, totalBytes: 1024, files: 4, totalFiles: 4 }); });
Then('the folder is still running with its previous successful timestamp', function(this: ProgressWorld) { const mirror = this.progressService!.status().mirrors[0]; assert.equal(mirror.phase, 'running'); assert.equal(mirror.lastSuccess, this.progressPrior); });
When('the progress test sync finishes', async function(this: ProgressWorld) { this.progressRelease!(); await this.progressTask; });
Then('the successful timestamp advances and progress disappears', function(this: ProgressWorld) { const mirror = this.progressService!.status().mirrors[0]; assert.equal(mirror.phase, 'ready'); assert.notEqual(mirror.lastSuccess, this.progressPrior); assert.equal(mirror.progress, null); });
Then('late provider progress is ignored', function(this: ProgressWorld) { this.lateReport!(activity('checking')); assert.equal(this.progressService!.status().mirrors[0].progress, null); });
When('the progress test provider fails', async function(this: ProgressWorld) { this.progressProvider.fail = 'capacity'; this.progressRelease!(); await this.progressTask; });
When('the progress test installation restarts', async function(this: ProgressWorld) {
  this.progressService = new ICloudSync(new FakeCloudProvider(), this.progressRepository, () => 'unused', () => 'unused', () => {}); await this.progressService.start();
});
Then('the progress test folder needs recovery with no progress', function(this: ProgressWorld) { const mirror = this.progressService!.status().mirrors[0]; assert.equal(mirror.phase, 'failed'); assert.equal(mirror.progress, null); });
After(async function(this: ProgressWorld) { this.progressRelease?.(); await this.progressTask; });
