import { Given, When, Then, setWorldConstructor } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Obsidian } from '../../core/service.ts';
import { MarkdownNotes } from '../../adapters/markdown-notes.ts';
import { CatalogFake, FilesFake, MemoryState } from '../../test/fakes.ts';
class World {
  catalog = new CatalogFake(); files = new FilesFake(); state = new MemoryState(); result: any; before = ''; version = ''; error: any;
  service = this.make();
  make() { return new Obsidian(this.catalog, this.files, new MarkdownNotes(), this.state, randomUUID, () => Date.parse('2026-01-01T00:00:00Z'), () => {}); }
}
setWorldConstructor(World);
Given('two generated iCloud vaults', async function(this: World) { await this.service.start(); });
Given('both vaults are connected', async function(this: World) { await this.service.connect('one'); await this.service.connect('two'); });
When('I search all connected vaults for {string}', async function(this: World, text: string) { this.result = await this.service.search({ text }); });
Then('no source notes are exposed', function(this: World) { assert.deepEqual(this.result.results, []); });
Then('the results identify vaults {string} and {string}', function(this: World, one: string, two: string) { assert.deepEqual(this.result.results.map((r: any) => r.vaultId).sort(), [one, two]); });
When('I read {string} in vault {string}', async function(this: World, path: string, vaultId: string) { this.result = await this.service.read({ vaultId, path }); this.before = this.result.text; this.version = this.result.hash; });
Then('the complete note version and source lines are returned', function(this: World) { assert.equal(this.result.complete, true); assert.match(this.result.hash, /^[a-f0-9]{64}$/); assert.equal(this.result.lineStart, 1); assert.equal(this.result.lineEnd, 3); });
Then('I can follow {string} within vault {string}', async function(this: World, link: string, vaultId: string) { const result = await this.service.resolve({ vaultId, path: 'Launch.md', link }); assert.equal(result.status, 'resolved'); assert.equal((result as any).path, 'Other.md'); });
Then('one unfinished task is returned for {string}', async function(this: World, path: string) { const result = await this.service.tasks({ vaultId: 'one', path, complete: false }); assert.equal(result.results.length, 1); assert.equal(result.results[0].lineStart, 2); });
When('I append a decision to that version', async function(this: World) { this.result = await this.service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: this.version, append: 'Decision\r\n' }); });
Then('the original bytes precede the decision', function(this: World) { assert.equal(this.files.notes.get('one/Launch.md'), this.before + 'Decision\r\n'); });
Then('the save says saved locally pending sync', function(this: World) { assert.equal(this.result.receipt.outcome, 'saved_locally_pending_sync'); assert.match(this.result.message, /does not verify delivery/); });
When('the source changes before I append', async function(this: World) { this.files.notes.set('one/Launch.md', 'Concurrent change\r\n'); try { await this.service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: this.version, append: 'stale' }); } catch (e) { this.error = e; } });
Then('the stale edit is rejected without replacing the change', function(this: World) { assert.equal(this.error.category, 'conflict'); assert.equal(this.files.notes.get('one/Launch.md'), 'Concurrent change\r\n'); });
When('I remove vault {string}', async function(this: World, id: string) { await this.service.remove(id); });
Then('vault {string} cannot be read or inspected', async function(this: World, id: string) { await assert.rejects(this.service.read({ vaultId: id, path: 'Launch.md' }), /not_connected/); await assert.rejects(this.service.status({ vaultId: id }), /not_connected/); });
Then('the generated source notes still exist', function(this: World) { assert.equal(this.files.notes.size, 3); });
When('the plugin restarts', async function(this: World) { this.service.stop(); this.service = this.make(); await this.service.start(); });
Then('both vaults remain connected', async function(this: World) { assert.equal((await this.service.status()).vaults.length, 2); });
When('vault {string} fails', function(this: World, id: string) { this.catalog.value.sources.find(s => s.id === id)!.phase = 'failed'; });
Then('vault {string} has results with a partial failure for {string}', function(this: World, good: string, failed: string) { assert.equal(this.result.results[0].vaultId, good); assert.equal(this.result.incomplete, true); assert.equal(this.result.failures[0].vaultId, failed); });
