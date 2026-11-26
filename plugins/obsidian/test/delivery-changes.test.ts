import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('delivery changes carry the canonical predecessor from resolved conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-vault-resolution-delivery-'));
  const { db, fs, ledger } = receiptsFixture(root, join(root, 'receipt.sqlite'));
  try {
    const mirrorId = 'generated', revision = 1;
    const baseline = ledger.deliveryChanges(mirrorId, null, 4);
    const expected = [];
    for (const { path, hasCanonical, choice } of [
      { path: 'Replace.md', hasCanonical: true, choice: 'replace' },
      { path: 'Adopt.md', hasCanonical: false, choice: 'accept_incoming' },
    ] as const) {
      const localPath = join(root, path + (hasCanonical ? '' : '.bb-conflict1'));
      const incomingPath = join(root, path + '.icloud-conflict1');
      await writeFile(localPath, 'Local');
      await writeFile(incomingPath, 'Incoming');
      const conflict = await fs.inspect(mirrorId, revision, path);
      assert.ok(conflict);
      const operationId = randomUUID();
      const content = choice === 'replace' ? 'Resolved' : 'Incoming';
      await fs.resolve({ mirrorId, revision, path, operationId, choice,
        token: conflict.token, expectedLogicalHash: conflict.logicalHash,
        expectedIncomingHash: conflict.incomingHash, ...(choice === 'replace' ? { text: content } : {}) });
      assert.equal(await readFile(join(root, path), 'utf8'), content);
      await assert.rejects(readFile(incomingPath), { code: 'ENOENT' });
      expected.push({ operationId, path, previousHash: hasCanonical ? digest('Local') : null, hash: digest(content) });
    }
    // Older resolution receipts did not retain a canonical predecessor.
    const legacy: LocalReceipt = { kind: 'resolution', operationId: randomUUID(), mirrorId, path: 'Old.md',
      at: new Date().toISOString(), hash: digest('legacy'), choice: 'replace',
      root: { dev: 1, ino: 1 }, inode: { dev: 1, ino: 2 }, outcome: 'uncertain' };
    ledger.begin(legacy);
    ledger.finish({ ...legacy, outcome: 'saved_locally_pending_sync' });
    const page = ledger.deliveryChanges(mirrorId, baseline.cursor, 4);
    assert.deepEqual(page.changes.map(({ sequence: _sequence, ...change }) => change), expected);
    assert.equal(page.hasMore, false);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
