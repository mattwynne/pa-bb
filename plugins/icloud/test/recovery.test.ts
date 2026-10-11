import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { RecoveryCopies, treeSize } from '../adapters/recovery-copies.ts';
import type { CommandRunner } from '../adapters/rclone-process.ts';
test('independent recovery copies deduplicate content and retain deleted versions until expiry', async () => {
  const root = await mkdtemp('/tmp/icloud-recovery-'); let now = Date.now(); let content = 'original note';
  await mkdir(root + '/local');
  const runner: CommandRunner = async args => {
    if (args[0] === 'size') return JSON.stringify({ bytes: Buffer.byteLength(content) });
    await writeFile(args[2] + '/note.md', content); return '';
  };
  const copies = new RecoveryCopies(root + '/backups', runner, 1024 * 1024, () => now);
  try {
    await copies.capture('mirror-1', 'synthetic:', root + '/local');
    await copies.capture('mirror-1', 'synthetic:', root + '/local');
    assert.equal((await readdir(root + '/backups/blobs')).length, 1); assert.equal((await readdir(root + '/backups/snapshots')).length, 1);
    content = 'new version'; await copies.capture('mirror-1', 'synthetic:', root + '/local');
    assert.equal((await readdir(root + '/backups/blobs')).length, 2);
    const blobs = await Promise.all((await readdir(root + '/backups/blobs')).map(name => readFile(root + '/backups/blobs/' + name, 'utf8')));
    assert.ok(blobs.includes('original note'));
    now += 31 * 86400_000; await copies.capture('mirror-1', 'synthetic:', root + '/local');
    assert.equal((await readdir(root + '/backups/blobs')).length, 1);
    assert.ok(await treeSize(root + '/backups') < 1024 * 1024);
  } finally { await rm(root, { recursive: true }); }
});
test('interrupted backup staging is retained and blocks new snapshots', async () => {
  const root = await mkdtemp('/tmp/icloud-recovery-'); await mkdir(root + '/staging-interrupted'); await writeFile(root + '/staging-interrupted/kept', 'private-recovery');
  try {
    const copies = new RecoveryCopies(root, async () => '', 1024 * 1024);
    await assert.rejects(copies.capture('mirror-1', 'synthetic:', root), /recovery_required/);
    assert.equal(await readFile(root + '/staging-interrupted/kept', 'utf8'), 'private-recovery');
  } finally { await rm(root, { recursive: true }); }
});
