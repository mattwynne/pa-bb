import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest } from '../adapters/local-notes.ts';
import type { LocalReceipt } from '../adapters/local-receipts.ts';
import { receiptsFixture } from './receipt-fixture.ts';

test('delivery changes resume in publication order after restart with bounded, scoped pages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-vault-delivery-fixture-'));
  const dbPath = join(root, 'receipt.sqlite');
  let fixture = receiptsFixture(root, dbPath);
  try {
    const baseline = fixture.ledger.deliveryChanges('generated', null, 1);
    const delayed: LocalReceipt = {
      kind: 'save', operationId: randomUUID(), mirrorId: 'generated', path: 'late.md',
      at: new Date().toISOString(), hash: digest('later'), previousHash: digest('before'),
      root: { dev: 1, ino: 1 }, inode: { dev: 1, ino: 2 }, outcome: 'uncertain',
    };
    fixture.ledger.begin(delayed);
    const first = randomUUID();
    await writeFile(join(root, 'first.md'), 'original');
    await fixture.fs.commit({ mirrorId: 'generated', revision: 1, path: 'first.md', operationId: first,
      kind: 'replace', expectedHash: digest('original'), text: 'changed' });

    const canceled = { ...delayed, operationId: randomUUID(), path: 'failed.md' };
    fixture.ledger.begin(canceled);
    fixture.ledger.finish({ ...canceled, outcome: 'not_saved' });
    const foreign = { ...delayed, operationId: randomUUID(), mirrorId: 'other' };
    fixture.ledger.begin(foreign);
    fixture.ledger.finish({ ...foreign, outcome: 'saved_locally_pending_sync' });

    const firstPage = fixture.ledger.deliveryChanges('generated', baseline.cursor, 1);
    assert.deepEqual(firstPage.changes.map(row => row.operationId), [first]);
    assert.equal(firstPage.hasMore, false);
    fixture.ledger.finish({ ...delayed, outcome: 'saved_locally_pending_sync' });
    const next = randomUUID();
    await fixture.fs.commit({ mirrorId: 'generated', revision: 1, path: 'create.md', operationId: next,
      kind: 'create', expectedHash: null, text: 'new' });
    fixture.db.close();
    fixture = receiptsFixture(root, dbPath);

    const resumed = fixture.ledger.deliveryChanges('generated', firstPage.cursor, 1);
    assert.deepEqual(resumed.changes.map(row => row.operationId), [delayed.operationId]);
    assert.equal(resumed.hasMore, true);
    const final = fixture.ledger.deliveryChanges('generated', resumed.cursor, 1);
    assert.deepEqual(final.changes.map(row => [row.operationId, row.previousHash]), [[next, null]]);
    assert.equal(final.hasMore, false);
    assert.throws(() => fixture.ledger.deliveryChanges('generated', final.cursor + 1, 1), /source_changed/);
  } finally {
    fixture.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
