import { Before, Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { Application } from '../core/application.ts';
import { codeState, componentIds } from '../core/workspace.ts';
Before(function () {
  this.rows = []; this.local = []; this.applied = []; this.pulls = 0;
  this.ports = { inspect: async (_report, mode) => mode === 'local' ? this.local : this.rows,
    localCandidates: () => this.local, validateMix: async () => {},
    update: async (id, authority) => { this.applied.push({ id, mode: authority.mode }); return { actual: '1.0.0', updated: true }; },
    quiesce: async () => {}, restore: async () => {}, load: async () => null, save: async () => {}, diagnose() {},
    syncWorkspace: async () => { this.pulls++; throw new Error('Local source must be kept'); } };
});
const row = () => ({ id: 'google-calendar', installed: '1.0.0', available: '1.0.0', local: 'stock', fingerprint: 'loaded', targetFingerprint: 'b'.repeat(64), prerequisite: null });
Given('a local-path plugin with unapplied edits', function () { this.local = [{ ...row(), local: 'unknown', sourceMode: 'local' }]; });
When('I apply the local changes', async function () {
  this.app = new Application(this.ports); await this.app.start(); const review = (await this.app.review()).review;
  await this.app.applyLocal({ reviewId: review.id }); await this.app.join();
});
Then('that working code is applied without pulling or updating runtimes', function () {
  assert.deepEqual(this.applied, [{ id: 'google-calendar', mode: 'local' }]); assert.equal(this.pulls, 0);
  assert.equal(this.app.status().job.mode, 'local'); assert.deepEqual(this.app.status().job.runtimeReceipts, []);
});
Given('the working copy and origin agree but an older build was applied', function () {
  this.work = { local: false, upstream: false, working: 'b'.repeat(64), origin: 'b'.repeat(64) }; this.loaded = 'a'.repeat(64);
});
Then('the plugin is not reported up to date', function () { assert.equal(codeState(this.work, this.loaded), 'unapplied'); });
Given('origin offers different plugin contents with the same version', function () { this.rows = [row()]; });
Given('local and origin changes need Git review', function () {
  this.rows = [{ ...row(), sourceMode: 'local', local: 'unknown', prerequisite: 'source_work' }];
  this.ports.workspace = () => ({ head: 'a'.repeat(40), originHead: 'b'.repeat(40), dirty: true, ahead: false, behind: true,
    components: Object.fromEntries(componentIds.map(id => [id, { local: true, upstream: true, working: 'a'.repeat(64), origin: 'b'.repeat(64) }])) });
});
When('I update PA', async function () {
  this.app = new Application(this.ports); await this.app.start(); const review = (await this.app.review()).review;
  await this.app.apply({ reviewId: review.id, choices: [] }); await this.app.join();
});
Then('those contents are applied with that same version', function () {
  assert.deepEqual(this.applied, [{ id: 'google-calendar', mode: 'origin' }]);
  assert.equal(this.app.status().job.receipts[0].actual, '1.0.0');
});
Then('local work is kept without an empty successful update', function () {
  assert.deepEqual(this.applied, []); assert.equal(this.pulls, 0); assert.equal(this.app.status().job, null);
});
