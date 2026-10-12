import test from 'node:test';
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { RecoveryCopies, treeSize } from '../adapters/recovery-copies.ts';
import type { SyncProgress } from '../core/ports.ts';
import { recoveryFixture } from './recovery-fixture.ts';
const blobs = async (root: string) => Promise.all((await readdir(root + '/backups/blobs')).map(name => readFile(root + '/backups/blobs/' + name, 'utf8')));
const captures = async (root: string) => Promise.all((await readdir(root + '/backups/snapshots')).map(name => readFile(root + '/backups/snapshots/' + name, 'utf8').then(JSON.parse)));
const transfers = (commands: string[][]) => commands.filter(args => ['copy', 'copyto'].includes(args[0]));
test('validated short cloud copies and zero-download runs report exact final counts without stats samples', async () => {
  const f = await recoveryFixture(); const progress: SyncProgress[] = []; const copies = new RecoveryCopies(f.root + '/backups', (args, capture) => f.run(args, capture));
  try {
    await f.put('cloud', 'note.md', 'tiny'); await copies.capture('mirror-1', f.cloud, f.local, p => progress.push(p));
    assert.deepEqual(progress.filter(p => p.stage === 'backing_up_cloud').at(-1), { stage: 'backing_up_cloud', bytes: 4, totalBytes: 4, files: 1, totalFiles: 1, reusedFiles: 0 });
    progress.length = 0; await copies.capture('mirror-1', f.cloud, f.local, p => progress.push(p));
    assert.deepEqual(progress.filter(p => p.stage === 'backing_up_cloud').at(-1), { stage: 'backing_up_cloud', bytes: 0, totalBytes: null, files: 0, totalFiles: null, reusedFiles: 1 });
  } finally { await rm(f.root, { recursive: true }); }
});
test('an incomplete cloud staging copy cannot report invented successful final counts', async () => {
  const f = await recoveryFixture(); const progress: SyncProgress[] = []; const copies = new RecoveryCopies(f.root + '/backups', (args, capture) => args[0] === 'copy' ? Promise.resolve('') : f.run(args, capture));
  try {
    await f.put('cloud', 'note.md', 'tiny'); await assert.rejects(copies.capture('mirror-1', f.cloud, f.local, p => progress.push(p)), /source_changed/);
    assert.ok(progress.filter(p => p.stage === 'backing_up_cloud').every(p => p.bytes === 0 && p.files === 0));
  } finally { await rm(f.root, { recursive: true }); }
});
test('warm unchanged snapshots verify blobs, reference local content, and download no file bodies', async () => {
  const f = await recoveryFixture(); let now = Date.now(); const copies = new RecoveryCopies(f.root + '/backups', f.run, 1024 * 1024, () => now);
  try {
    await f.put('cloud', 'note.md', 'original note'); await f.put('local', 'note.md', 'original note');
    await copies.capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1);
    f.commands.length = 0; await copies.capture('mirror-1', f.cloud, f.local);
    assert.equal(transfers(f.commands).length, 0); assert.equal((await blobs(f.root)).length, 1); assert.equal((await captures(f.root)).length, 1);
    await f.put('cloud', 'note.md', 'new version'); await copies.capture('mirror-1', f.cloud, f.local);
    assert.ok((await blobs(f.root)).includes('original note')); assert.ok((await blobs(f.root)).includes('new version'));
    now += 31 * 86400_000; f.commands.length = 0; await copies.capture('mirror-1', f.cloud, f.local);
    assert.equal(transfers(f.commands).length, 1); assert.equal((await captures(f.root)).length, 1);
    assert.ok(await treeSize(f.root + '/backups') < 1024 * 1024);
  } finally { await rm(f.root, { recursive: true }); }
});
test('only changed cloud paths are selected and deleted/renamed versions remain recoverable', async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'nested/#note.md', 'old'); await f.put('cloud', 'stable.md', 'stable'); await copies.capture('mirror-1', f.cloud, f.local);
    await f.put('cloud', 'nested/#note.md', 'new', 1_000_001); f.commands.length = 0;
    await copies.capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1);
    assert.deepEqual((await captures(f.root)).sort((a, b) => b.generation - a.generation)[0].entries.map((e: any) => e.path), ['nested/#note.md', 'stable.md']);
    await rename(f.cloud + '/nested/#note.md', f.cloud + '/renamed.md'); await rm(f.cloud + '/stable.md');
    await copies.capture('mirror-1', f.cloud, f.local); assert.ok((await blobs(f.root)).includes('old')); assert.ok((await blobs(f.root)).includes('stable'));
  } finally { await rm(f.root, { recursive: true }); }
});
for (const change of ['edit', 'delete', 'add', 'metadata'] as const) test(`local ${change} forces a cloud backup even when cloud size/time/identity are unchanged`, async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'note.md', 'AA'); if (change !== 'add') await f.put('local', 'note.md', 'AA');
    await copies.capture('mirror-1', f.cloud, f.local); f.commands.length = 0;
    await f.put('cloud', 'note.md', 'BB'); // Deliberately identical length and modification time.
    if (change === 'delete') await rm(f.local + '/note.md'); else await f.put('local', 'note.md', change === 'metadata' ? 'AA' : 'CC', change === 'metadata' ? 1_000_001 : 1_000_000);
    await copies.capture('mirror-1', f.cloud, f.local); assert.ok(transfers(f.commands).some(args => args[1] === f.cloud)); assert.ok((await blobs(f.root)).includes('BB'));
  } finally { await rm(f.root, { recursive: true }); }
});
test('new mirrors cannot reuse another mirror index and unknown cloud timestamps are never cached', async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'note.md', 'AA'); await copies.capture('mirror-1', f.cloud, f.local); f.commands.length = 0;
    await copies.capture('mirror-2', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1);
    f.unknownTime(); await copies.capture('mirror-1', f.cloud, f.local); f.commands.length = 0;
    await copies.capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1);
  } finally { await rm(f.root, { recursive: true }); }
});
test('legacy and incomplete manifests retain versions but require a complete indexed capture', async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'note.md', 'AA'); await copies.capture('mirror-1', f.cloud, f.local);
    const path = join(f.root, 'backups/snapshots', (await readdir(f.root + '/backups/snapshots'))[0]); const previous = JSON.parse(await readFile(path, 'utf8'));
    delete previous.schema; await writeFile(path, JSON.stringify(previous)); f.commands.length = 0;
    await copies.capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1);
    for (const name of await readdir(f.root + '/backups/snapshots')) { const p = f.root + '/backups/snapshots/' + name; const s = JSON.parse(await readFile(p, 'utf8')); s.complete = false; await writeFile(p, JSON.stringify(s)); }
    f.commands.length = 0; await copies.capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1); assert.ok((await blobs(f.root)).includes('AA'));
  } finally { await rm(f.root, { recursive: true }); }
});
for (const problem of ['missing', 'corrupt', 'symlink'] as const) test(`${problem} recovery blobs stop before new transfers`, async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'note.md', 'AA'); await copies.capture('mirror-1', f.cloud, f.local);
    const path = f.root + '/backups/blobs/' + (await readdir(f.root + '/backups/blobs'))[0];
    if (problem === 'corrupt') await writeFile(path, 'sentinel-private-content');
    else { await rm(path); if (problem === 'symlink') await symlink(f.cloud + '/note.md', path); }
    f.commands.length = 0; await assert.rejects(copies.capture('mirror-1', f.cloud, f.local), /recovery_required/); assert.equal(transfers(f.commands).length, 0);
  } finally { await rm(f.root, { recursive: true }); }
});
for (const side of ['cloud', 'local'] as const) test(`changing ${side} during capture preserves staging and prevents a complete snapshot`, async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'note.md', 'AA'); await f.put('local', 'note.md', 'AA');
    f.afterCopy(async () => { await f.put(side, 'note.md', 'BB', 1_000_001); });
    await assert.rejects(copies.capture('mirror-1', f.cloud, f.local), /source_changed/);
    assert.equal((await readdir(f.root + '/backups/snapshots')).length, 0); assert.ok((await readdir(f.root + '/backups')).some(n => n.startsWith('staging-')));
  } finally { await rm(f.root, { recursive: true }); }
});
test('encoding-sensitive filenames use exact standard paths and never unsafe cache matches', async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    await f.put('cloud', 'nested/one\ntwo.md', 'AA'); await copies.capture('mirror-1', f.cloud, f.local);
    assert.equal(transfers(f.commands)[0][0], 'copy'); assert.equal((await captures(f.root))[0].entries[0].path, 'nested/one␊two.md');
    assert.ok((await blobs(f.root)).includes('AA')); f.commands.length = 0;
    await copies.capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 1);
  } finally { await rm(f.root, { recursive: true }); }
});
test('native local copies span multiple chunks and retain exact bytes and empty files', async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run);
  try {
    const content = 'bounded bytes '.repeat(20_000); await f.put('local', 'nested/new.md', content); await f.put('local', 'empty.md', '');
    await copies.capture('mirror-1', f.cloud, f.local); assert.ok((await blobs(f.root)).includes(content)); assert.ok((await blobs(f.root)).includes(''));
  } finally { await rm(f.root, { recursive: true }); }
});
test('a growing local source cannot write beyond its planned staging budget', async () => {
  const f = await recoveryFixture(); const copies = new RecoveryCopies(f.root + '/backups', f.run); let grew = false;
  try {
    const content = 'x'.repeat(128 * 1024); await f.put('local', 'note.md', content);
    await assert.rejects(copies.capture('mirror-1', f.cloud, f.local, progress => {
      if (!grew && progress.stage === 'backing_up_local' && progress.bytes > 0) { grew = true; appendFileSync(f.local + '/note.md', 'y'.repeat(1024 * 1024)); }
    }), /source_changed/);
    const stage = (await readdir(f.root + '/backups')).find(n => n.startsWith('staging-'))!;
    assert.equal((await readFile(f.root + '/backups/' + stage + '/local/note.md', 'utf8')).length, content.length);
    assert.equal((await readdir(f.root + '/backups/snapshots')).length, 0);
  } finally { await rm(f.root, { recursive: true }); }
});
test('capacity includes index metadata but a warm run need not reserve full-folder downloads', async () => {
  const f = await recoveryFixture();
  try {
    await f.put('cloud', 'note.md', 'x'.repeat(100_000)); await new RecoveryCopies(f.root + '/backups', f.run).capture('mirror-1', f.cloud, f.local);
    const limit = await treeSize(f.root + '/backups') + 70_000; f.commands.length = 0;
    await new RecoveryCopies(f.root + '/backups', f.run, limit).capture('mirror-1', f.cloud, f.local); assert.equal(transfers(f.commands).length, 0);
    await f.put('cloud', 'note.md', 'y'.repeat(100_000), 1_000_001); f.commands.length = 0;
    await assert.rejects(new RecoveryCopies(f.root + '/backups', f.run, limit).capture('mirror-1', f.cloud, f.local), /capacity/); assert.equal(transfers(f.commands).length, 0);
  } finally { await rm(f.root, { recursive: true }); }
});
test('interrupted backup staging is retained and blocks new snapshots', async () => {
  const f = await recoveryFixture(); await mkdir(f.root + '/backups'); await mkdir(f.root + '/backups/staging-interrupted'); await writeFile(f.root + '/backups/staging-interrupted/kept', 'private-recovery');
  try {
    await assert.rejects(new RecoveryCopies(f.root + '/backups', f.run).capture('mirror-1', f.cloud, f.local), /recovery_required/);
    assert.equal(await readFile(f.root + '/backups/staging-interrupted/kept', 'utf8'), 'private-recovery'); assert.equal(f.commands.length, 0);
  } finally { await rm(f.root, { recursive: true }); }
});
test('unsafe, duplicate and malformed provider listings fail with fixed categories only', async () => {
  const f = await recoveryFixture();
  try {
    for (const records of [[{ Path: '../sentinel-secret', IsDir: false, Size: 0 }], [{ Path: 'note', IsDir: false, Size: -1 }], [{ Path: 'note', IsDir: false, Size: 0 }, { Path: 'note', IsDir: false, Size: 0 }], { error: 'sentinel-token' }]) {
      await assert.rejects(new RecoveryCopies(f.root + '/backups', async () => JSON.stringify(records)).capture('mirror-1', f.cloud, f.local), error => { assert.doesNotMatch(String(error), /sentinel/); return true; });
    }
  } finally { await rm(f.root, { recursive: true }); }
});
