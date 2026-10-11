import { Before, Given, When, Then, World, setWorldConstructor } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { ICloudSync } from '../../core/service.ts';
import { FakeCloudProvider, MemoryState } from '../../test/fakes.ts';
import type { Failure } from '../../core/ports.ts';
class SyncWorld extends World {
  provider = new FakeCloudProvider(); repository = new MemoryState();
  logs: string[] = []; now = 0; nextId = 0; rejected = false; prior: string | null = null; calls = 0;
  service = this.createService();
  createService() { return new ICloudSync(this.provider, this.repository, () => new Date(++this.now * 60_000).toISOString(), () => `mirror-${++this.nextId}`, (stage, failure) => this.logs.push(`${stage} ${failure}`)); }
  mirror() { return this.service.status().mirrors[0]; }
  async connect() { await this.service.connect({ account: 'synthetic-account', password: 'synthetic-password' }); }
  async connected() { await this.connect(); await this.service.answerChallenge('123456'); }
  async selected() { await this.connected(); await this.service.browse(null); await this.service.select('test'); }
  async syncing() { await this.selected(); await this.service.enable(this.mirror().id); this.prior = this.mirror().lastSuccess; this.calls = this.provider.synced; }
}
setWorldConstructor(SyncWorld);
Before(async function(this: SyncWorld) { await this.service.start(); });
Given('a new iCloud installation', function() {});
Given('a connected Apple account and selected Test Vault', async function(this: SyncWorld) { await this.selected(); });
Given('a syncing Test Vault', async function(this: SyncWorld) { await this.syncing(); });
When('I connect my Apple account', async function(this: SyncWorld) { await this.connect(); });
Then('BB asks for a verification code', function(this: SyncWorld) { assert.equal(this.service.status().challenge, 'verification_code'); });
When('I answer the Apple challenge', async function(this: SyncWorld) { await this.service.answerChallenge('123456'); });
When('I select the Test Vault folder', async function(this: SyncWorld) { await this.service.browse(null); await this.service.select('test'); });
When('a minute passes', async function(this: SyncWorld) { await this.service.tick(); });
When('another minute passes', async function(this: SyncWorld) { this.calls = this.provider.synced; await this.service.tick(); });
Then('no files have been synchronized', function(this: SyncWorld) { assert.equal(this.provider.prepared + this.provider.synced, 0); });
Then('my folder is paused', function(this: SyncWorld) { assert.equal(this.mirror().phase, 'paused'); assert.equal(this.mirror().enabled, false); });
When('I enable syncing', async function(this: SyncWorld) { await this.service.enable(this.mirror().id); });
When('I pause syncing', async function(this: SyncWorld) { await this.service.pause(this.mirror().id); });
When('I resume syncing', async function(this: SyncWorld) { await this.service.enable(this.mirror().id); });
Then('the cloud provider prepared the mirror once', function(this: SyncWorld) { assert.equal(this.provider.prepared, 1); });
Then('the cloud provider synchronized the mirror once', function(this: SyncWorld) { assert.equal(this.provider.synced, 1); });
Then('the folder has a last successful sync', function(this: SyncWorld) { assert.ok(this.mirror().lastSuccess); });
Then('no additional files have been synchronized', function(this: SyncWorld) { assert.equal(this.provider.synced, this.calls); });
When('the provider fails with {word}', function(this: SyncWorld, failure: Failure) { this.provider.fail = failure; });
Then('the folder requires recovery', function(this: SyncWorld) { assert.equal(this.mirror().phase, 'failed'); assert.equal(this.mirror().enabled, false); });
Then('its last successful sync is unchanged', function(this: SyncWorld) { assert.equal(this.mirror().lastSuccess, this.prior); });
Then('the failed run is not retried', function(this: SyncWorld) { assert.equal(this.provider.synced, this.calls); });
Then('resuming is rejected', async function(this: SyncWorld) { await assert.rejects(this.service.enable(this.mirror().id)); });
When('BB restarts with a running mirror recorded', async function(this: SyncWorld) { this.repository.value.mirrors[0].phase = 'running'; this.service = this.createService(); await this.service.start(); });
When('I disconnect Apple', async function(this: SyncWorld) { await this.service.disconnect(); });
Then('the local mirror remains available', function(this: SyncWorld) { assert.equal(this.service.inventory().length, 1); assert.equal(this.provider.disconnected, 1); });
When('a synchronization is still running at the next tick', async function(this: SyncWorld) {
  let release!: () => void; this.provider.pending = new Promise(resolve => { release = resolve; });
  const running = this.service.tick(); await new Promise(resolve => setImmediate(resolve));
  await this.service.tick(); assert.equal(this.provider.synced, 1); release(); await running;
});
Then('only one synchronization is in flight', function(this: SyncWorld) { assert.equal(this.provider.synced, 1); });
When('I select a child of Test Vault', async function(this: SyncWorld) { await this.service.browse('test'); try { await this.service.select('child'); } catch { this.rejected = true; } });
Then('the selection is rejected', function(this: SyncWorld) { assert.equal(this.rejected, true); });
When('I request a fresh mirror from iCloud', async function(this: SyncWorld) { await this.service.rebuild(this.mirror().id); });
Then('the previous mirror is retained without automatic repair', function(this: SyncWorld) { assert.equal(this.mirror().phase, 'retained'); assert.equal(this.mirror().enabled, false); assert.equal(this.provider.synced, 1); });
Then('a different local mirror is initialized', function(this: SyncWorld) { const mirrors = this.service.status().mirrors; assert.equal(mirrors.length, 2); assert.notEqual(mirrors[0].id, mirrors[1].id); assert.equal(mirrors[1].initialized, true); assert.equal(this.provider.prepared, 2); });
When('I also select Other Vault', async function(this: SyncWorld) { await this.service.select('other'); });
Then('Other Vault remains paused', function(this: SyncWorld) { assert.equal(this.service.status().mirrors[1].phase, 'paused'); });
