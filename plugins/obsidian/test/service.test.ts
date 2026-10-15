import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Obsidian } from '../core/service.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
import { VaultError } from '../core/ports.ts';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function setup() { const catalog = new CatalogFake(); const files = new FilesFake(); const state = new MemoryState(); const logs: string[] = []; const service = new Obsidian(catalog, files, new MarkdownNotes(), state, randomUUID, Date.now, (stage, category) => logs.push(`${stage} ${category}`)); await service.start(); await service.connect('one'); await service.connect('two'); return { service, catalog, files, state, logs }; }
test('malformed properties cannot be created or introduced through an append', async () => {
  const { service, files } = await setup();
  await assert.rejects(service.create({ vaultId: 'one', path: 'Unsafe.md', text: '---\na: !unsafe sentinel\n---\n' }), (e: any) => e.category === 'properties_unsupported');
  const note = await service.read({ vaultId: 'one', path: 'Launch.md' });
  // An unterminated frontmatter delimiter created by an append must not bypass validation.
  files.notes.set('one/Empty.md', ''); const empty = await service.read({ vaultId: 'one', path: 'Empty.md' });
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Empty.md', expectedHash: empty.hash, append: '---\na: [broken\n' }), (e: any) => e.category === 'properties_unsupported');
  assert.equal(files.notes.has('one/Unsafe.md'), false); assert.equal(files.notes.get('one/Empty.md'), ''); assert.ok(note.complete);
});
test('uncertain reply persists operation identity across restart and inspection prevents double append', async () => {
  const { service, files, catalog, state } = await setup(); const read = await service.read({ vaultId: 'one', path: 'Launch.md' }); const commit = files.commit.bind(files);
  files.commit = async input => { await commit(input); throw new VaultError('uncertain'); };
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: read.hash, append: 'Once\r\n' }), /uncertain/); assert.equal(state.value.pending?.length, 1);
  const restarted = new Obsidian(catalog, files, new MarkdownNotes(), state, randomUUID, Date.now, () => {}); await restarted.start();
  const status = await restarted.status({ vaultId: 'one', path: 'Launch.md' }); assert.equal(status.receipts.length, 1); assert.equal(status.uncertainOperations.length, 0); assert.equal(files.notes.get('one/Launch.md')?.match(/Once/g)?.length, 1);
});
test('removal during a pending read discards late content and revokes receipt access', async () => {
  const { service, files } = await setup(); const entered = gate(); const release = gate(); const read = files.read.bind(files);
  files.read = async (...args) => { const result = await read(...args); entered.resolve(); await release.promise; return result; };
  const pending = service.read({ vaultId: 'one', path: 'Launch.md' }); await entered.promise; await service.remove('one'); release.resolve();
  await assert.rejects(pending, /not_connected/); await assert.rejects(service.status({ vaultId: 'one' }), /not_connected/);
});
test('an in-flight commit and removal cannot both be acknowledged before commit settles', async () => {
  const { service, files } = await setup(); const entered = gate(); const release = gate(); const commit = files.commit.bind(files); const note = await service.read({ vaultId: 'one', path: 'Launch.md' });
  files.commit = async input => { entered.resolve(); await release.promise; return commit(input); };
  const save = service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: note.hash, append: 'Decision\r\n' }); await entered.promise;
  await assert.rejects(service.remove('one'), /busy/); release.resolve(); await save; await service.remove('one'); await assert.rejects(service.read({ vaultId: 'one', path: 'Launch.md' }), /not_connected/);
});
test('source changes invalidate pagination; hidden nested notes are searched without exclusions', async () => {
  const { service, files, catalog } = await setup(); files.notes.set('one/.hidden/deep/Launch.md', '# Launch hidden\n');
  const first = await service.search({ text: 'Launch', limit: 1 }); assert.ok(first.nextCursor); catalog.value.sources[0].phase = 'running';
  await assert.rejects(service.search({ cursor: first.nextCursor! }), /cursor_expired/); catalog.value.sources[0].phase = 'ready';
  const all = await service.search({ text: 'Launch' }); assert.ok(all.results.some(r => r.path === '.hidden/deep/Launch.md'));
});
test('heading reads and truncated notes do not permit edits; unrelated vaults remain usable', async () => {
  const { service, files, catalog } = await setup(); const section = await service.read({ vaultId: 'one', path: 'Launch.md', heading: 'Launch' }); assert.equal(section.complete, false);
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: section.hash, append: 'No\n' }), /complete_read_required/);
  files.notes.set('one/Large.md', 'x'.repeat(49000)); const large = await service.read({ vaultId: 'one', path: 'Large.md' }); assert.equal(large.complete, false);
  catalog.value.sources[0].phase = 'failed'; catalog.value.sources[0].failure = 'sync_failed';
  const result = await service.search({ text: 'Launch' }); assert.equal(result.incomplete, true); assert.equal(result.failures[0].vaultId, 'one'); assert.equal(result.results[0].vaultId, 'two');
});
test('cancellation before commit admission leaves the note and pending state unchanged', async () => {
  const { service, files, state } = await setup(); const read = files.read.bind(files); const entered = gate(); const release = gate(); const controller = new AbortController();
  const note = await service.read({ vaultId: 'one', path: 'Launch.md' });
  files.read = async (...args) => { const value = await read(...args); entered.resolve(); await release.promise; return value; };
  const save = service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: note.hash, append: 'Cancelled' }, controller.signal); await entered.promise; controller.abort(); release.resolve(); await assert.rejects(save, /cancelled/);
  assert.equal(files.saved.length, 0); assert.equal(state.value.pending?.length ?? 0, 0);
});
test('whole-note reads report malformed properties without executing or normalizing them', async () => {
  const { service, files } = await setup(); const text = '---\na: !unsafe secret\n---\nOriginal\n'; files.notes.set('one/Unsafe.md', text);
  const note = await service.read({ vaultId: 'one', path: 'Unsafe.md' }); assert.equal(note.text, text); assert.ok(note.warnings.includes('properties_unsupported'));
});
test('removal between the final file observation and metadata continuation discards revoked content', async () => {
  const { service, files } = await setup(); files.notes.set('one/Launch.md', '# Private\n'); const read = files.read.bind(files); let removal: Promise<void> | undefined;
  files.read = async (...args: Parameters<typeof read>) => { const note = await read(...args); queueMicrotask(() => { removal = service.remove('one'); }); return note; };
  await assert.rejects(service.metadata({ vaultId: 'one', path: 'Launch.md' }), (e: unknown) => e instanceof VaultError && e.category === 'not_connected'); await removal;
});
test('a search cannot resurrect cached rows after removal during its final async continuation', async () => {
  const { service, files } = await setup(); files.notes.set('one/Launch.md', '# Private\n'); const scan = (service as any).scan.bind(service);
  (service as any).scan = async (...args: any[]) => { const result = await scan(...args); await service.remove('one'); return result; };
  await assert.rejects(service.search({ vaultId: 'one', text: 'Private' }), (e: unknown) => e instanceof VaultError && e.category === 'not_connected'); assert.equal((service as any).cursors.size, 0);
});
test('known operation inspection is independent of the latest receipt page', async () => {
  const { service } = await setup(); const first = await service.create({ vaultId: 'one', path: 'First.md', text: '# First\n' }); await service.create({ vaultId: 'one', path: 'Second.md', text: '# Second\n' });
  const status = await service.status({ vaultId: 'one', operationId: first.operationId, limit: 1 }); assert.equal(status.receipts.length, 1); assert.equal(status.receipts[0].operationId, first.operationId);
});
test('task edits and alias additions preserve original CRLF and other properties', async () => {
  const { service, files } = await setup(); const text = '---\r\naliases: [Existing]\r\nother: 1 # retain\r\n---\r\n- [ ] Ship ^task\r\n'; files.notes.set('one/Tasks.md', text);
  const note = await service.read({ vaultId: 'one', path: 'Tasks.md' }); await service.edit({ vaultId: 'one', path: 'Tasks.md', expectedHash: note.hash, task: { line: 5, marker: 'x' } });
  const updated = await service.read({ vaultId: 'one', path: 'Tasks.md' }); await service.properties({ vaultId: 'one', path: 'Tasks.md', expectedHash: updated.hash, addAliases: ['Added'] });
  assert.match(files.notes.get('one/Tasks.md')!, /other: 1 # retain\r\n/); assert.match(files.notes.get('one/Tasks.md')!, /- \[x\] Ship \^task\r\n/); assert.deepEqual(new MarkdownNotes().parse(files.notes.get('one/Tasks.md')!).aliases, ['Existing', 'Added']);
});
