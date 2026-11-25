import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { receiptsFixture } from './receipt-fixture.ts';
import { fileIdentity, type LocalReceipt } from '../adapters/local-receipts.ts';
import { digest } from '../adapters/local-notes.ts';
import type { RecoveryInput } from '../core/receipt-recovery.ts';

const mirrorId = 'one', revision = 1, scope = { vaultIds: [mirrorId], revision };
async function fixtureDirs(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'obsidian-receipt-test-'));
  const root = join(directory, 'vault'), dbPath = join(directory, 'receipts.sqlite');
  await mkdir(root);
  const open = (legacy?: unknown) => {
    const result = receiptsFixture(root, dbPath, legacy);
    t.after(() => { if (result.db.open) result.db.close(); });
    const recover = (request: Exclude<RecoveryInput, { action: 'list' }>, owner = 'worker') => result.fs.recovery(request, scope, owner, () => {});
    return { ...result, recover };
  };
  const crash = async (phase: 'intent' | 'publication', path: string) => {
    const operationId = randomUUID();
    const worker = fileURLToPath(new URL('./receipt-crash-worker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', worker, root, dbPath, operationId, phase, path], { stdio: 'ignore' });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    return operationId;
  };
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { root, directory, open, crash };
}

test('real crashes preserve an applied stage, an untouched stage, and divergent evidence', async t => {
  const fixture = await fixtureDirs(t);
  const applied = await fixture.crash('publication', 'Applied.md');
  const notApplied = await fixture.crash('intent', 'Unpublished.md');
  const divergent = await fixture.crash('publication', 'Changed.md');
  await rename(join(fixture.root, 'Changed.md'), join(fixture.root, 'Original incarnation.md'));
  await writeFile(join(fixture.root, 'Changed.md'), 'Generated');
  const { fs, db, recover } = fixture.open();
  assert.equal(await fs.recoveryHasWork(scope.vaultIds, []), true);
  assert.deepEqual((await fs.recoveryPage(scope.vaultIds, [])).operations.map(row => row.operationId), [applied, notApplied, divergent]);
  const proof = async (operationId: string, check: 'publication' | 'nonpublication') => {
    const result = await recover({ action: 'check', operationId, check });
    assert.equal(result.status, 'proven');
    assert.ok('token' in result && result.token);
    return result.token;
  };
  const win = await proof(applied, 'publication');
  const lost = await proof(notApplied, 'nonpublication');
  const rejected = await recover({ action: 'settle', operationId: applied, outcome: 'applied', token: win }, 'foreign-worker');
  assert.equal(rejected.status, 'review');
  const outcomes = await Promise.all([
    recover({ action: 'settle', operationId: applied, outcome: 'applied', token: win }),
    recover({ action: 'settle', operationId: applied, outcome: 'applied', token: win }),
    recover({ action: 'settle', operationId: notApplied, outcome: 'not_applied', token: lost }),
  ]);
  assert.deepEqual(outcomes.map(row => row.status), ['applied', 'applied', 'not_applied']);
  const check = { action: 'check', operationId: divergent } as const;
  assert.equal((await recover({ ...check, check: 'publication' })).status, 'review');
  assert.equal((await recover({ ...check, check: 'nonpublication' })).status, 'review');
  assert.equal((await recover({ action: 'settle', operationId: divergent, outcome: 'applied', token: win })).status, 'review');
  assert.equal(await readFile(join(fixture.root, 'Changed.md'), 'utf8'), 'Generated');
  await assert.rejects(access(join(fixture.root, 'Unpublished.md'), fsConstants.F_OK));
  assert.equal((await readdir(fixture.root)).filter(name => name.endsWith('.tmp')).length, 1);
  assert.deepEqual((db.prepare("SELECT operation_id FROM obsidian_receipt_events WHERE event = 'terminal' ORDER BY sequence").pluck().all()), [applied, notApplied]);
  assert.equal((await fs.receipts({ mirrorId, revision, operationId: notApplied, limit: 1 })).receipts[0].outcome, 'not_saved');
  assert.deepEqual((await fs.recoveryPage(scope.vaultIds, [])).operations.map(row => row.operationId), [divergent]);
  await assert.rejects(fs.commit({ mirrorId, revision, path: 'Changed.md', operationId: randomUUID(),
    expectedHash: digest('Generated'), text: 'Blocked', kind: 'replace' }), { category: 'busy' });
  assert.equal((await fs.commit({ mirrorId, revision, path: 'Independent.md', operationId: randomUUID(),
    expectedHash: null, text: 'Independent', kind: 'create' })).outcome, 'saved_locally_pending_sync');
});

test('settle rechecks evidence and survives reopening the SQLite handle', async t => {
  const f = await fixtureDirs(t);
  const operationId = await f.crash('publication', 'Race.md');
  const first = f.open();
  const proof = await first.recover({ action: 'check', operationId, check: 'publication' });
  assert.ok(proof.status === 'proven' && 'token' in proof && proof.token);
  await writeFile(join(f.root, 'Race.md'), 'Newer content');
  assert.equal((await first.recover({ action: 'settle', operationId, outcome: 'applied', token: proof.token })).status, 'review');
  first.db.close();
  const restarted = f.open();
  assert.equal((await restarted.recover({ action: 'inspect', operationId })).status, 'unresolved');
  assert.equal(await readFile(join(f.root, 'Race.md'), 'utf8'), 'Newer content');
});

test('migrates full old history, bulk saves past its cap, and proves a dependent move across later saves', async t => {
  const f = await fixtureDirs(t);
  await writeFile(join(f.root, 'Destination.md'), 'Moved');
  const root = fileIdentity(await stat(f.root)), version = await stat(join(f.root, 'Destination.md'));
  const at = new Date().toISOString(), operationId = randomUUID();
  const move: LocalReceipt = { kind: 'move', path: 'Source.md', destination: 'Destination.md', at, mirrorId, operationId,
    root, inode: fileIdentity(version), birthtime: version.birthtimeMs, hash: digest('Moved'), outcome: 'moved_locally_pending_sync' };
  const history: LocalReceipt[] = [move, ...Array.from({ length: 511 }, (_, index): LocalReceipt => ({
    kind: 'save', operationId: randomUUID(), path: `Old-${index}.md`, mirrorId, at, root, inode: root, hash: digest('Old'),
    previousHash: null, outcome: 'saved_locally_pending_sync',
  }))];
  const first = f.open(history);
  assert.equal(await first.fs.recoveryHasWork(scope.vaultIds, []), false);
  for (const [previous, next] of [['Moved', 'Later'], ['Later', 'Latest']]) {
    assert.equal((await first.fs.commit({ mirrorId, revision, path: move.destination, operationId: randomUUID(),
      expectedHash: digest(previous), kind: 'replace', text: next })).outcome, 'saved_locally_pending_sync');
  }
  for (let n = 0; n < 12; n++) {
    assert.equal((await first.fs.commit({ mirrorId, revision, path: `Bulk-${n}.md`, operationId: randomUUID(),
      expectedHash: null, kind: 'create', text: '# Generated' })).outcome, 'saved_locally_pending_sync');
  }
  first.db.close();
  const restarted = f.open(history);
  assert.equal(await restarted.fs.recoveryHasWork(scope.vaultIds, []), false);
  assert.equal((await restarted.fs.moveReceipt(mirrorId, revision, operationId))?.outcome, 'moved_locally_pending_sync');
  const old = history[1];
  assert.equal((await restarted.fs.receipts({ mirrorId, revision, operationId: old.operationId, limit: 1 })).receipts[0].path, old.path);
  const count = restarted.db.prepare("SELECT count(*) FROM obsidian_receipt_events WHERE event = 'intent'").pluck().get();
  assert.equal(count, 526);
  await rename(join(f.root, 'Destination.md'), join(f.root, 'Different.md'));
  await writeFile(join(f.root, 'Destination.md'), 'Latest');
  assert.equal((await restarted.fs.moveReceipt(mirrorId, revision, operationId))?.outcome, 'uncertain');
});


test('migrated uncertain saves retain exact evidence and cannot use the new dispatch barrier', async t => {
  const f = await fixtureDirs(t);
  const path = 'Migrated.md';
  const file = join(f.root, path);
  await writeFile(file, 'Migrated generated content');
  const info = await stat(file);
  const operationId = randomUUID();
  const row: LocalReceipt = {
    kind: 'save', mirrorId, path, operationId, hash: digest('Migrated generated content'), previousHash: null,
    root: fileIdentity(await stat(f.root)), inode: fileIdentity(info), birthtime: info.birthtimeMs,
    at: new Date().toISOString(), outcome: 'uncertain',
  };
  const { fs, recover } = f.open([row]);
  assert.equal((await recover({ action: 'check', operationId, check: 'nonpublication' })).status, 'review');
  assert.equal((await fs.receipts({ mirrorId, path, operationId, revision, limit: 1 })).receipts[0].outcome, 'saved_locally_pending_sync');
  assert.equal(await fs.recoveryHasWork(scope.vaultIds, []), false);
});

test('uncertain folder move blocks both subtrees and closes only when its original directory is found', async t => {
  const f = await fixtureDirs(t);
  const { fs, ledger, recover } = f.open();
  await mkdir(join(f.root, 'Source'));
  await writeFile(join(f.root, 'Source', 'Note.md'), 'Generated');
  const operationId = randomUUID();
  const request = { vaultId: mirrorId, path: 'Source', destination: 'Destination', operationId, kind: 'folder' as const };
  const finish = ledger.finish.bind(ledger);
  ledger.finish = () => { throw new Error('Injected terminal failure'); };
  const moved = await fs.movePath(request, revision, async before => {
    await before();
    await rename(join(f.root, request.path), join(f.root, request.destination));
  });
  ledger.finish = finish;
  assert.equal(moved.outcome, 'uncertain');
  await assert.rejects(fs.commit({ mirrorId, revision, operationId: randomUUID(), path: 'Destination/Note.md',
    expectedHash: digest('Generated'), text: 'Blocked', kind: 'replace' }), { category: 'busy' });
  const proof = await recover({ action: 'check', operationId, check: 'publication' });
  assert.ok(proof.status === 'proven' && 'token' in proof && proof.token);
  assert.equal((await recover({ action: 'settle', operationId, outcome: 'applied', token: proof.token })).status, 'applied');
  assert.equal((await fs.moveReceipt(mirrorId, revision, operationId))?.outcome, 'moved_locally_pending_sync');
});

test('an interrupted conflict cleanup preserves copies and requires review', async t => {
  const f = await fixtureDirs(t);
  const { fs } = f.open();
  const path = 'Conflict.md';
  await writeFile(join(f.root, path), 'Before');
  const incoming = join(f.root, path + '.icloud-conflict1');
  await writeFile(incoming, 'Incoming');
  const conflict = await fs.inspect(mirrorId, revision, path);
  assert.ok(conflict);
  const operationId = randomUUID();
  // Simulate an I/O failure in cleanup after the replacement is verified.
  const files = (fs as unknown as { files: { removeCopy(): Promise<void> } }).files;
  files.removeCopy = async () => { throw new Error('Synthetic privacy sentinel'); };
  await assert.rejects(fs.resolve({ mirrorId, path, revision, operationId, choice: 'accept_incoming',
    token: conflict.token, expectedLogicalHash: conflict.logicalHash, expectedIncomingHash: conflict.incomingHash }), { category: 'uncertain' });
  const { recover } = f.open();
  const result = await recover({ action: 'check', operationId, check: 'publication' });
  assert.deepEqual(result, { operationId, status: 'review', blocker: 'conflict_cleanup_unconfirmed' });
  assert.equal(await readFile(join(f.root, path), 'utf8'), 'Incoming');
  assert.equal(await readFile(incoming, 'utf8'), 'Incoming');
});
