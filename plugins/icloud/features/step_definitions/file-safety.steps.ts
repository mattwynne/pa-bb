import { Given, When, Then, After } from '@cucumber/cucumber';
import type { World } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, rename } from 'node:fs/promises';
import { RcloneProcess } from '../../adapters/rclone-process.ts';
import { RcloneCloudProvider } from '../../adapters/rclone-cloud-provider.ts';
import { category, evidence } from '../../core/ports.ts';
import type { Mirror } from '../../core/ports.ts';
async function trace<T>(operation: string, task: () => Promise<T>): Promise<T> {
  if (!process.env.RCLONE_TEST_TRACE) return task();
  const started = performance.now(); process.stderr.write(JSON.stringify({ boundary: operation, outcome: 'started' }) + '\n');
  try { const result = await task(); process.stderr.write(JSON.stringify({ boundary: operation, outcome: 'completed', durationMs: Math.round(performance.now() - started) }) + '\n'); return result; }
  catch (error) { process.stderr.write(JSON.stringify({ boundary: operation, outcome: 'failed', category: category(error), evidence: evidence(error), durationMs: Math.round(performance.now() - started) }) + '\n'); throw error; }
}
interface SafetyWorld extends World { real?: { root: string; cloud: string; local: string; process: RcloneProcess; provider: RcloneCloudProvider; mirror: Mirror; cloudDownloads: string[] } }
Given('two disposable filesystem folders and stock rclone', async function(this: SafetyWorld) {
  if (!process.env.RCLONE_TEST_BINARY) return 'skipped';
  const root = await mkdtemp('/tmp/icloud-safety-'); const cloud = root + '/cloud/Test Vault'; await mkdir(cloud, { recursive: true });
  const worker = new RcloneProcess(root + '/worker', process.env.RCLONE_TEST_BINARY);
  const mirror: Mirror = { id: 'mirror-1', folder: { id: Buffer.from('Test Vault').toString('base64url'), name: 'Test Vault', ancestors: [] }, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null };
  const cloudDownloads: string[] = [];
  const provider = new RcloneCloudProvider(root + '/worker', (method, body) => worker.call(method, body), async (args, capture, report) => {
    if (args[0] === 'copy' && args[1].startsWith('icloud:')) cloudDownloads.push(...(await readFile(args[args.indexOf('--files-from-raw') + 1], 'utf8')).trimEnd().split('\n'));
    return trace(['lsjson', 'copy', 'copyto', 'bisync'].includes(args[0]) ? args[0] : 'command', () => worker.run(args, capture, report));
  }, () => worker.checkAvailability(), () => worker.stop());
  this.real = { root, cloud, local: provider.localFolder(mirror), process: worker, provider, mirror, cloudDownloads };
  await trace('configure', () => worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: root + '/cloud' }, opt: { nonInteractive: true } }));
});
Given('an initialized two-way mirror with five notes', async function(this: SafetyWorld) {
  const r = this.real!; for (const name of ['cloud.md', 'stable1.md', 'stable2.md', 'stable3.md', 'stable4.md']) await writeFile(r.cloud + '/' + name, 'original note');
  await r.provider.prepareMirror(r.mirror); r.mirror.initialized = true;
  assert.equal(await readFile(r.local + '/cloud.md', 'utf8'), 'original note');
});
async function changed(path: string, content: string) { await writeFile(path, content); const time = new Date(Date.now() + 3000); await utimes(path, time, time); }
When('I change the cloud note to {string}', async function(this: SafetyWorld, content: string) { await changed(this.real!.cloud + '/cloud.md', content); });
When('I add a local note containing {string}', async function(this: SafetyWorld, content: string) { await changed(this.real!.local + '/local.md', content); });
When('I change the local cloud note to {string}', async function(this: SafetyWorld, content: string) { await changed(this.real!.local + '/cloud.md', content); });
When('the cloud adapter synchronizes the mirror', async function(this: SafetyWorld) { await this.real!.provider.synchronize(this.real!.mirror); });
Then('the local cloud note contains {string}', async function(this: SafetyWorld, content: string) { assert.equal(await readFile(this.real!.local + '/cloud.md', 'utf8'), content); });
Then('the cloud local note contains {string}', async function(this: SafetyWorld, content: string) { assert.equal(await readFile(this.real!.cloud + '/local.md', 'utf8'), content); });
Then('both sides keep both conflicting versions', async function(this: SafetyWorld) {
  for (const dir of [this.real!.cloud, this.real!.local]) {
    const conflicts = (await readdir(dir)).filter(name => name.startsWith('cloud.md.'));
    assert.equal(conflicts.length, 2);
    const versions = await Promise.all(conflicts.map(name => readFile(dir + '/' + name, 'utf8')));
    assert.deepEqual(versions.sort(), ['a cloud version of the note', 'a different BB version of the note'].sort());
  }
});
When('I delete the local cloud note', async function(this: SafetyWorld) { await rm(this.real!.local + '/cloud.md'); });
Then('the cloud note is deleted', async function(this: SafetyWorld) { assert.ok(!(await readdir(this.real!.cloud)).includes('cloud.md')); });
Then('recovery copies still contain the original note', async function(this: SafetyWorld) {
  const dir = this.real!.root + '/worker/backups/blobs'; const blobs = await Promise.all((await readdir(dir)).map(name => readFile(dir + '/' + name, 'utf8')));
  assert.ok(blobs.includes('original note'));
});
When('I rename the cloud note', async function(this: SafetyWorld) { await rename(this.real!.cloud + '/cloud.md', this.real!.cloud + '/renamed.md'); });
Then('the local folder contains the renamed note instead of the old name', async function(this: SafetyWorld) {
  const names = await readdir(this.real!.local); assert.ok(names.includes('renamed.md')); assert.ok(!names.includes('cloud.md'));
});
When('recovery capacity is exhausted', async function(this: SafetyWorld) {
  const r = this.real!; r.provider = new RcloneCloudProvider(r.root + '/worker', (method, body) => r.process.call(method, body), (args, capture, report) => r.process.run(args, capture, report), () => r.process.checkAvailability(), () => r.process.stop(), 1);
});
Then('synchronization is rejected before the cloud note changes', async function(this: SafetyWorld) {
  const r = this.real!; await assert.rejects(r.provider.synchronize(r.mirror), /capacity/); assert.equal(await readFile(r.cloud + '/cloud.md', 'utf8'), 'original note');
});
When('I add cloud notes with literal comment and newline filenames', async function(this: SafetyWorld) {
  const r = this.real!; await mkdir(r.cloud + '/nested');
  await changed(r.cloud + '/nested/#literal.md', 'literal comment filename'); await changed(r.cloud + '/nested/one\ntwo.md', 'literal newline filename');
});
Then('both unusual filenames and their contents are mirrored exactly', async function(this: SafetyWorld) {
  assert.equal(await readFile(this.real!.local + '/nested/#literal.md', 'utf8'), 'literal comment filename');
  assert.equal(await readFile(this.real!.local + '/nested/one\ntwo.md', 'utf8'), 'literal newline filename');
});
Given('an unchanged indexed recovery copy', async function(this: SafetyWorld) { await this.real!.provider.synchronize(this.real!.mirror); this.real!.cloudDownloads.length = 0; });
Then('no cloud file bodies were downloaded for recovery', function(this: SafetyWorld) { assert.deepEqual(this.real!.cloudDownloads, []); });
Then('only the changed cloud note was downloaded for recovery', function(this: SafetyWorld) { assert.deepEqual(this.real!.cloudDownloads, ['cloud.md']); });
Then('recovery copies contain both new note versions', async function(this: SafetyWorld) {
  const root = this.real!.root + '/worker/backups/blobs'; const values = await Promise.all((await readdir(root)).map(name => readFile(root + '/' + name, 'utf8')));
  assert.ok(values.includes('a cloud version of the note')); assert.ok(values.includes('a different BB version of the note'));
});
After(async function(this: SafetyWorld) { if (this.real) { await trace('stop', () => this.real!.process.stop()); await rm(this.real.root, { recursive: true }); } });
