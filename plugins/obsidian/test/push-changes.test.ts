import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { receiptsFixture } from './receipt-fixture.ts';
import { digest } from '../adapters/local-notes.ts';
import type { LocalReceipt } from '../adapters/local-receipts.ts';

test('each applied local change is reported once for iCloud to push; a refused change is not', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'obsidian-push-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'vault');
  await mkdir(root);
  const applied: LocalReceipt[] = [];
  const { fs, db } = receiptsFixture(root, join(directory, 'receipts.db'), undefined, row => applied.push(row));
  t.after(() => db.close());
  const scope = { mirrorId: 'one', revision: 1 };

  await fs.commit({ ...scope, path: 'Note.md', operationId: randomUUID(), expectedHash: null, text: 'one', kind: 'create' });
  await fs.commit({ ...scope, path: 'Note.md', operationId: randomUUID(), expectedHash: digest('one'), text: 'two', kind: 'replace' });
  await assert.rejects(fs.commit({ ...scope, path: 'Note.md', operationId: randomUUID(), expectedHash: digest('stale'), text: 'three', kind: 'replace' }));
  await mkdir(join(root, 'Source'));
  await writeFile(join(root, 'Source', 'Inside.md'), 'inside');
  await fs.movePath({ vaultId: 'one', path: 'Source', destination: 'Destination', operationId: randomUUID(), kind: 'folder' }, 1, async before => {
    await before();
    await rename(join(root, 'Source'), join(root, 'Destination'));
  });

  assert.deepEqual(applied.map(row => [row.kind, row.path, row.kind === 'move' ? row.destination : null, row.kind === 'move' ? row.directory ?? null : null]), [
    ['save', 'Note.md', null, null],
    ['save', 'Note.md', null, null],
    ['move', 'Source', 'Destination', true],
  ]);
});
