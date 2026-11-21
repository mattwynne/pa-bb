import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { NoteError, NoteStore } from '../../icloud/adapters/note-store.ts';
import { plugin } from '../server.ts';
import { VaultError, type VaultFiles } from '../core/ports.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';

type MoveInput = Parameters<NonNullable<VaultFiles['move']>>[0];
type PhysicalReceipt = MoveInput & Awaited<ReturnType<NonNullable<VaultFiles['move']>>>;
type Journal = {
  start(): void;
  move(root: string, input: MoveInput): Promise<PhysicalReceipt>;
  receipts(mirrorId: string, operationId: string): PhysicalReceipt[];
};

test('archive in a vault over 128 notes repairs a backlink beyond 64,000 characters and leaves a durable receipt', { skip: process.platform !== 'linux' }, async t => {
  // Load the real producer journal without requiring an iCloud npm install.
  const { NoteMoves }: { NoteMoves: new (db: Database.Database, store: NoteStore) => Journal } =
    await import(new URL('../../icloud/adapters/note-move.ts', import.meta.url).href);
  const root = await mkdtemp(join(tmpdir(), 'obsidian-archive-'));
  const vault = join(root, 'vault');
  const path = 'Projects/Active/Service a heater.md';
  const destination = 'Projects/Done/Service a heater.md';
  const original = '---\nstatus: active\n---\n# Service a heater\n- [x] Service\n';
  for (const folder of ['Projects/Active', 'Projects/Done', 'Reference']) {
    await mkdir(join(vault, folder), { recursive: true });
  }
  for (let i = 0; i < 512; i++) {
    await writeFile(join(vault, 'Reference', `Note ${i}.md`), 'A synthetic reference note.\n');
  }
  await writeFile(join(vault, path), original);
  const indexPrefix = 'Generated reference text. '.repeat(6000)
    + '\n\n```markdown\n[[Projects/Active/Service a heater|Example in code]]\n```\n\n';
  await writeFile(join(vault, 'Reference/Index.md'), indexPrefix + '[[Projects/Active/Service a heater|Service]]\n');

  const databasePath = join(root, 'moves.sqlite');
  const db = new Database(databasePath);
  const store = new NoteStore(join(root, 'repairs'));
  const moves = new NoteMoves(db, store);
  db.exec('CREATE TABLE icloud_note_overlay_totals(id INTEGER PRIMARY KEY, recovery_bytes INTEGER, staged_recovery_bytes INTEGER)');
  moves.start();
  const files: VaultFiles = Object.assign(new FilesFake(), {
    list: () => store.list(vault),
    read: async (_id: string, _revision: number, notePath: string) => {
      try { return await store.read(vault, notePath); }
      catch (error) {
        if (error instanceof NoteError) throw new VaultError(error.category);
        throw error;
      }
    },
    move: (input: MoveInput) => moves.move(vault, input),
    moveReceipts: async ({ mirrorId, operationId }: Parameters<NonNullable<VaultFiles['moveReceipts']>>[0]) => moves.receipts(mirrorId, operationId),
    commit: (input: Parameters<VaultFiles['commit']>[0]) => store.commit(vault, input, new AbortController().signal),
  });
  const { harness, bb } = createFakePluginHost({ pluginId: 'obsidian' });
  t.after(async () => {
    try { await harness.lifecycle.dispose(); }
    finally { if (db.open) db.close(); await rm(root, { recursive: true, force: true }); }
  });
  await plugin(bb, { catalog: new CatalogFake(), files, repository: new MemoryState() });
  await harness.behavior.callRpc('connect', { vaultId: 'one' });
  const call = async (name: string, input: unknown) => {
    const result = await harness.behavior.callAgentTool(name, input, { threadId: 'archive-test' });
    assert.ok(typeof result !== 'string');
    const block = result.content[0];
    assert.ok(block.type === 'text');
    return { isError: result.isError, response: JSON.parse(block.text) };
  };
  const run = async (name: string, input: unknown) => {
    const { isError, response } = await call(name, input);
    assert.equal(isError, undefined, JSON.stringify(response));
    return response;
  };

  assert.equal((await store.list(vault)).paths.length, 514);
  const target = { vaultId: 'one', path };
  const read = await run('obsidian_read_note', target);
  assert.equal(read.complete, true);
  assert.equal(read.editReady, true);
  const request = { ...target, destination, expectedHash: read.hash };
  const extra = join(vault, 'Reference/Extra.md');
  await writeFile(extra, 'é'.repeat(512 * 1024 + 1));
  const refused = await call('obsidian_move_note', request);
  assert.equal(refused.isError, true);
  assert.equal(refused.response.category, 'unsupported');
  assert.match(refused.response.nextAction, /could not be fully read/);
  assert.equal((await readFile(join(vault, path), 'utf8')), original);
  await assert.rejects(readFile(join(vault, destination)), { code: 'ENOENT' });
  assert.equal(db.prepare('SELECT count(*) AS count FROM icloud_note_moves').pluck().get(), 0);
  await rm(extra);

  const result = await run('obsidian_move_note', request);
  assert.equal(result.outcome, 'moved_supported_links_updated');
  assert.equal((await run('obsidian_move_status', { vaultId: 'one', operationId: result.operationId })).physical, 'moved_locally_pending_sync');
  assert.equal(await readFile(join(vault, destination), 'utf8'), original);
  await assert.rejects(readFile(join(vault, path)), { code: 'ENOENT' });
  assert.equal(await readFile(join(vault, 'Reference/Index.md'), 'utf8'), indexPrefix + '[[Projects/Done/Service a heater|Service]]\n');

  db.close();
  const reopened = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const [receipt] = new NoteMoves(reopened, store).receipts('one', result.operationId);
    assert.equal(receipt.outcome, 'moved_locally_pending_sync');
    assert.equal(receipt.destination, destination);
    assert.equal(receipt.expectedHash, read.hash);
  } finally {
    reopened.close();
  }
});
