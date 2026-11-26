import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest } from '../adapters/local-notes.ts';
import { receiptsFixture } from './receipt-fixture.ts';

test('folder move receipts page exact attachments, empty folders and freshly rewritten notes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-folder-evidence-'));
  const { db, fs, ledger } = receiptsFixture(root, join(root, 'receipts.sqlite'));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vaultId = 'generated', revision = 1;
  const baseline = ledger.folderDeliveryChanges(vaultId, null, 4);
  const source = 'Original', destination = 'Moved';
  const old = '[[Original/Note]]', updated = '[[Moved/Note]]';
  const attachment = Buffer.from([0, 127, 239, 32, 255]);
  await mkdir(join(root, source, 'empty'), { recursive: true });
  await writeFile(join(root, source, 'Note.md'), old);
  await writeFile(join(root, source, 'attachment.bin'), attachment);
  await writeFile(join(root, source, 'zero.md'), '');
  const operationId = randomUUID();
  const receipt = await fs.movePath({ vaultId, kind: 'folder', path: source, destination, operationId }, revision, async before => {
    await before();
    await rename(join(root, source), join(root, destination));
    await writeFile(join(root, destination, 'Note.md'), updated);
  });
  assert.equal(receipt.outcome, 'moved_locally_pending_sync');
  const delivered = ledger.folderDeliveryChanges(vaultId, baseline.cursor, 4);
  assert.equal(delivered.moves.length, 1);
  const move = delivered.moves[0]!;
  assert.equal(move.source, source);
  assert.equal(move.path, destination);
  assert.equal(move.operationId, operationId);
  assert.notEqual(move.destinationFingerprint, move.sourceFingerprint);
  assert.equal(ledger.folderDeliveryPage('other source', operationId, 'source', 0, 4), null);
  assert.throws(() => ledger.folderDeliveryPage(vaultId, operationId, 'destination', 5, 4), /invalid_query/);
  const sourcePage = ledger.folderDeliveryPage(vaultId, operationId, 'source', 0, 4)!;
  assert.equal(sourcePage.fingerprint, move.sourceFingerprint);
  assert.deepEqual(sourcePage.entries, [
    { path: 'Note.md', kind: 'file', size: old.length, hash: digest(old) },
    { path: 'attachment.bin', kind: 'file', size: attachment.length, hash: digest(attachment) },
    { path: 'empty', kind: 'directory' },
    { path: 'zero.md', kind: 'file', size: 0, hash: digest('') },
  ]);
  await writeFile(join(root, destination, 'Note.md'), 'newer independent change after the move');
  const first = ledger.folderDeliveryPage(vaultId, operationId, 'destination', 0, 1)!;
  assert.equal(first.path, destination);
  assert.equal(first.fingerprint, move.destinationFingerprint);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(first.entries, [{ path: 'Note.md', kind: 'file', size: updated.length, hash: digest(updated) }]);
  const rest = ledger.folderDeliveryPage(vaultId, operationId, 'destination', first.nextOffset!, 4)!;
  assert.deepEqual(rest.entries, sourcePage.entries.slice(1));
  assert.equal(rest.nextOffset, null);
});

test('folder evidence follows a confirmed post-crash rename and cannot include a symlink target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bb-folder-evidence-recovery-'));
  const { db, fs, ledger } = receiptsFixture(root, join(root, 'receipts.sqlite'));
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const vaultId = 'generated', revision = 1;
  await mkdir(join(root, 'one'));
  await writeFile(join(root, 'one', 'note.md'), 'recover the move');
  const interruptedId = randomUUID();
  const interrupted = await fs.movePath({ vaultId, kind: 'folder', path: 'one', destination: 'two', operationId: interruptedId }, revision, async before => {
    await before();
    await rename(join(root, 'one'), join(root, 'two'));
    throw new Error('lost local reply');
  });
  assert.equal(interrupted.outcome, 'uncertain');
  assert.equal(ledger.folderDeliveryPage(vaultId, interruptedId, 'source', 0, 2), null);
  assert.equal((await fs.moveReceipt(vaultId, revision, interruptedId))?.outcome, 'moved_locally_pending_sync');
  assert.deepEqual(ledger.folderDeliveryPage(vaultId, interruptedId, 'destination', 0, 2)?.entries,
    [{ path: 'note.md', kind: 'file', size: 16, hash: digest('recover the move') }]);

  await symlink(join(root, 'two', 'note.md'), join(root, 'two', 'link.md'));
  const withLink = randomUUID();
  assert.equal((await fs.movePath({ vaultId, kind: 'folder', path: 'two', destination: 'three', operationId: withLink }, revision, async before => {
    await before();
    await rename(join(root, 'two'), join(root, 'three'));
  })).outcome, 'moved_locally_pending_sync');
  assert.equal(ledger.folderDeliveryPage(vaultId, withLink, 'destination', 0, 2), null);
});
