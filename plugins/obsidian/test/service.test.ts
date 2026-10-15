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
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Empty.md', expectedHash: empty.hash!, append: '---\na: [broken\n' }), (e: any) => e.category === 'properties_unsupported');
  assert.equal(files.notes.has('one/Unsafe.md'), false); assert.equal(files.notes.get('one/Empty.md'), ''); assert.ok(note.complete);
});
test('uncertain reply persists operation identity across restart and inspection prevents double append', async () => {
  const { service, files, catalog, state } = await setup(); const read = await service.read({ vaultId: 'one', path: 'Launch.md' }); const commit = files.commit.bind(files);
  files.commit = async input => { await commit(input); throw new VaultError('uncertain'); };
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: read.hash!, append: 'Once\r\n' }), /uncertain/); assert.equal(state.value.pending?.length, 1);
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
  const save = service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: note.hash!, append: 'Decision\r\n' }); await entered.promise;
  await service.remove('one'); release.resolve(); await assert.rejects(save, /not_connected/); await assert.rejects(service.read({ vaultId: 'one', path: 'Launch.md' }), /not_connected/);
});
test('source changes invalidate pagination; hidden nested notes are searched without exclusions', async () => {
  const { service, files, catalog } = await setup(); files.notes.set('one/.hidden/deep/Launch.md', '# Launch hidden\n');
  const first = await service.search({ text: 'Launch', limit: 1 }); assert.ok(first.nextCursor); catalog.value.sources[0].phase = 'running';
  const continued = await service.search({ cursor: first.nextCursor! }); assert.ok(continued.results.length); catalog.value.sources[0].phase = 'ready';
  const all = await service.search({ text: 'Launch' }); assert.ok(all.results.some(r => r.path === '.hidden/deep/Launch.md'));
});
test('heading reads and truncated notes do not permit edits; unrelated vaults remain usable', async () => {
  const { service, files, catalog } = await setup(); const section = await service.read({ vaultId: 'one', path: 'Launch.md', heading: 'Launch' }); assert.equal(section.complete, false);
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: section.hash!, append: 'No\n' }), /complete_read_required/);
  files.notes.set('one/Large.md', 'x'.repeat(49000)); const large = await service.read({ vaultId: 'one', path: 'Large.md' }); assert.equal(large.complete, false);
  catalog.value.sources[0].phase = 'failed'; catalog.value.sources[0].failure = 'sync_failed'; catalog.value.sources[0].local = { ...catalog.value.sources[0].local, available: false, reason: 'recovery_required' };
  const result = await service.search({ text: 'Launch' }); assert.equal(result.incomplete, true); assert.equal(result.failures[0].vaultId, 'one'); assert.equal(result.results[0].vaultId, 'two');
});
test('cancellation before commit admission leaves the note and pending state unchanged', async () => {
  const { service, files, state } = await setup(); const read = files.read.bind(files); const entered = gate(); const release = gate(); const controller = new AbortController();
  const note = await service.read({ vaultId: 'one', path: 'Launch.md' });
  files.read = async (...args) => { const value = await read(...args); entered.resolve(); await release.promise; return value; };
  const save = service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: note.hash!, append: 'Cancelled' }, controller.signal); await entered.promise; controller.abort(); release.resolve(); await assert.rejects(save, /cancelled/);
  assert.equal(files.saved.length, 0); assert.equal(state.value.pending?.length ?? 0, 0);
});
test('whole-note reads report malformed properties without executing or normalizing them', async () => {
  const { service, files } = await setup(); const text = '---\na: !unsafe secret\n---\nOriginal\n'; files.notes.set('one/Unsafe.md', text);
  const note = await service.read({ vaultId: 'one', path: 'Unsafe.md' }); assert.equal(note.text, text); assert.ok(note.warnings.includes('properties_unsupported'));
});
test('metadata read arriving after removal cannot expose revoked content', async () => {
  const { service, files } = await setup(); files.notes.set('one/Launch.md', '# Private\n'); const read = files.read.bind(files); const entered = gate(); const release = gate();
  files.read = async (...args: Parameters<typeof read>) => { const note = await read(...args); entered.resolve(); await release.promise; return note; };
  const pending = service.metadata({ vaultId: 'one', path: 'Launch.md' }); await entered.promise; await service.remove('one'); release.resolve();
  await assert.rejects(pending, (e: unknown) => e instanceof VaultError && e.category === 'not_connected');
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
  const note = await service.read({ vaultId: 'one', path: 'Tasks.md' }); await service.edit({ vaultId: 'one', path: 'Tasks.md', expectedHash: note.hash!, task: { line: 5, marker: 'x' } });
  const updated = await service.read({ vaultId: 'one', path: 'Tasks.md' }); await service.properties({ vaultId: 'one', path: 'Tasks.md', expectedHash: updated.hash!, addAliases: ['Added'] });
  assert.match(files.notes.get('one/Tasks.md')!, /other: 1 # retain\r\n/); assert.match(files.notes.get('one/Tasks.md')!, /- \[x\] Ship \^task\r\n/); assert.deepEqual(new MarkdownNotes().parse(files.notes.get('one/Tasks.md')!).aliases, ['Existing', 'Added']);
});
test('local capability, not cloud phase, enables running, paused, disconnected and failed-retry sources', async () => {
  const { service, catalog, files } = await setup();
  for (const phase of ['running', 'paused', 'failed'] as const) {
    catalog.value.connected = phase !== 'failed'; catalog.value.sources[0].phase = phase;
    catalog.value.sources[0].enabled = phase === 'running'; catalog.value.sources[0].lastSuccess = null;
    catalog.value.sources[0].failure = phase === 'failed' ? 'sync_failed' : null;
    const status = await service.status({ vaultId: 'one' }); assert.equal(status.vaults[0].source?.local.available, true);
    const read = await service.read({ vaultId: 'one', path: 'Launch.md' }); assert.equal(read.stale, true); await service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: read.hash!, append: phase });
    assert.ok((await service.metadata({ vaultId: 'one', path: 'Launch.md' })).hash);
    assert.ok((await service.tasks({ vaultId: 'one' })).results.length);
    assert.equal((await service.resolve({ vaultId: 'one', path: 'Launch.md', link: 'Other' })).status, 'resolved');
  }
  const created = await service.create({ vaultId: 'one', path: '.hidden/deep/New.md', text: '# Hidden\n- [ ] New\n[[Other]]\n' });
  assert.equal(created.receipt.kind, 'save'); assert.equal((await service.search({ text: 'Hidden' })).results.some((row: any) => row.path === '.hidden/deep/New.md'), true);
  assert.equal((await service.tasks({ path: '.hidden/deep/New.md' })).results.length, 1);
  assert.equal((await service.resolve({ vaultId: 'one', path: '.hidden/deep/New.md', link: 'Other' })).status, 'resolved');
  catalog.value.sources[0].local = { ...catalog.value.sources[0].local, available: false, reason: 'source_changed' };
  await assert.rejects(service.read({ vaultId: 'one', path: 'Launch.md' }), /source_unavailable/);
  assert.equal((await service.search({ vaultId: 'one', text: 'Launch' })).incomplete, true);
  assert.equal(files.saved.length, 4);
});
test('different-note writes overlap without losing pending IDs or unrelated complete-read proofs', async () => {
  const { service, files, state } = await setup(); files.notes.set('one/A.md', 'A'); files.notes.set('one/B.md', 'B');
  const a = await service.read({ vaultId: 'one', path: 'A.md' }); const b = await service.read({ vaultId: 'one', path: 'B.md' });
  const commit = files.commit.bind(files); const entered = gate(); const release = gate();
  files.commit = async input => { if (input.path === 'A.md') { entered.resolve(); await release.promise; } return commit(input); };
  const first = service.edit({ vaultId: 'one', path: 'A.md', expectedHash: a.hash!, append: '1' }); await entered.promise;
  assert.equal(state.value.pending?.length, 1);
  const second = await service.edit({ vaultId: 'one', path: 'B.md', expectedHash: b.hash!, append: '2' });
  assert.equal(second.receipt.kind, 'save'); assert.equal(state.value.pending?.length, 1);
  release.resolve(); await first; assert.equal(state.value.pending?.length, 0);
  // B's proof was not erased by A's write. The already observed B hash is now stale by CAS.
  await assert.rejects(service.edit({ vaultId: 'one', path: 'B.md', expectedHash: b.hash!, append: '3' }), /complete_read_required|conflict/);
});
test('same-note overlapping saves cannot reuse the read proof or bypass a pending commit', async () => {
  const { service, files, state } = await setup(); const read = await service.read({ vaultId: 'one', path: 'Launch.md' }); const commit = files.commit.bind(files); const entered = gate(); const release = gate();
  files.commit = async input => { entered.resolve(); await release.promise; return commit(input); };
  const first = service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: read.hash!, append: 'One' }); await entered.promise;
  await assert.rejects(service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: read.hash!, append: 'Two' }), /uncertain/);
  assert.equal(state.value.pending?.length, 1); release.resolve(); await first; assert.equal(files.notes.get('one/Launch.md')?.includes('Two'), false);
});
test('lost removal reply remains unconfirmed and cannot re-admit stale reads', async () => {
  const { service, files, state } = await setup(); const configure = files.configure.bind(files); let once = true;
  files.configure = async value => { await configure(value); if (once && !value.vaultIds.includes('one')) { once = false; throw new VaultError('uncertain'); } };
  await assert.rejects(service.remove('one'), /uncertain/); assert.equal(state.value.unconfirmedRevision, state.value.revision);
  await assert.rejects(service.read({ vaultId: 'one', path: 'Launch.md' }), /not_connected/);
  assert.equal((await service.status()).configurationUnconfirmed, false); assert.deepEqual(files.configuration.vaultIds, ['two']);
});
test('incoming content and explicit absence never grant logical edit proof; all guarded choices use distinct receipts', async () => {
  const { service, files } = await setup(); const key = 'one/Launch.md';
  for (const [choice, incoming, result] of [['keep_local', null, 'saved_locally_pending_sync'], ['accept_incoming', 'Incoming', 'adopted_content'], ['accept_incoming', null, 'adopted_absence'], ['replace', 'Incoming', 'saved_locally_pending_sync']] as const) {
    files.notes.set(key, 'Local'); const inspection = { token: randomUUID(), logicalHash: (await service.read({ vaultId: 'one', path: 'Launch.md' })).hash!, incomingHash: incoming === null ? null : (await import('./fakes.ts')).hash(incoming), incomingAbsent: incoming === null };
    files.conflicts.set(key, { inspection, incoming });
    const status = await service.status({ vaultId: 'one', path: 'Launch.md' }); assert.equal(status.conflict?.inspection?.token, inspection.token);
    const version = await service.read({ vaultId: 'one', path: 'Launch.md', selector: { version: 'incoming', token: inspection.token } });
    assert.equal(version.absent, incoming === null); if (incoming === null) assert.equal(version.hash, null);
    await assert.rejects(service.edit({ vaultId: 'one', path: 'Launch.md', expectedHash: incoming === null ? 'a'.repeat(64) : version.hash!, append: 'Unsafe' }), /complete_read_required/);
    const resolved = await service.edit({ vaultId: 'one', path: 'Launch.md', resolution: { ...inspection, expectedLogicalHash: inspection.logicalHash, expectedIncomingHash: inspection.incomingHash, choice, ...(choice === 'replace' ? { text: 'Chosen' } : {}) } });
    assert.equal(resolved.receipt.kind, 'resolution'); assert.equal(resolved.receipt.outcome, result);
    if (result === 'adopted_absence') assert.equal(resolved.receipt.hash, null);
    const receipts = await service.status({ vaultId: 'one', operationId: resolved.operationId, path: 'Launch.md' }); assert.equal(receipts.receipts[0].kind, 'resolution');
  }
});
test('lost resolution reply persists exact ID across restart, never replays, stale token cannot resolve', async () => {
  const { service, files, catalog, state } = await setup(); const key = 'one/Launch.md'; const read = await service.read({ vaultId: 'one', path: 'Launch.md' }); const token = randomUUID();
  files.conflicts.set(key, { inspection: { token, logicalHash: read.hash!, incomingHash: null, incomingAbsent: true }, incoming: null });
  await assert.rejects(service.recover({ vaultId: 'one', path: 'Launch.md', token: randomUUID(), expectedLogicalHash: read.hash!, expectedIncomingHash: null, choice: 'accept_incoming' }), /conflict/);
  const resolve = files.resolve.bind(files); files.resolve = async input => { await resolve(input); throw new VaultError('uncertain'); };
  await assert.rejects(service.recover({ vaultId: 'one', path: 'Launch.md', token, expectedLogicalHash: read.hash!, expectedIncomingHash: null, choice: 'accept_incoming' }), /uncertain/);
  const pendingId = state.value.pending?.[0].operationId; assert.ok(pendingId); assert.equal(state.value.pending?.[0].kind, 'resolution');
  const restarted = new Obsidian(catalog, files, new MarkdownNotes(), state, randomUUID, Date.now, () => {}); await restarted.start();
  const status = await restarted.status({ vaultId: 'one', path: 'Launch.md', operationId: pendingId }); assert.equal(status.receipts[0].operationId, pendingId); assert.equal(status.receipts[0].kind, 'resolution'); assert.equal(state.value.pending?.length, 0);
  assert.equal(files.saved.filter(r => r.operationId === pendingId).length, 1);
});
test('cloud freshness does not expire cursor, but local safety change and removal do', async () => {
  const { service, catalog } = await setup(); const first = await service.search({ text: 'Launch', limit: 1 }); assert.ok(first.nextCursor);
  catalog.value.connected = false; catalog.value.sources[0].phase = 'running'; catalog.value.sources[0].lastSuccess = null;
  assert.ok((await service.search({ cursor: first.nextCursor! })).results.length);
  const next = await service.search({ text: 'Launch', limit: 1 }); catalog.value.sources[0].local = { ...catalog.value.sources[0].local, available: false, reason: 'source_changed' };
  await assert.rejects(service.search({ cursor: next.nextCursor! }), /cursor_expired/);
});
test('bounded over-limit no-hit is incomplete, never evidence of absence', async () => {
  const { service, files } = await setup(); for (let i = 0; i < 510; i++) files.notes.set(`one/.hidden/n${i}.md`, 'Unrelated');
  const result = await service.search({ vaultId: 'one', text: 'Needle' }); assert.equal(result.results.length, 0); assert.equal(result.incomplete, true); assert.ok(result.warnings.includes('scan_limit'));
});
test('verified names and legacy pending IDs persist across failed catalog/restart without reset', async () => {
  const { service, catalog, files, state } = await setup();
  const first = await service.status(); assert.equal(first.vaults[0].name, 'Launch');
  const legacyId = randomUUID(); await state.save({ ...state.value, pending: [{ operationId: legacyId, vaultId: 'one', path: 'Launch.md', at: new Date().toISOString() }] });
  service.stop(); const restarted = new Obsidian(catalog, files, new MarkdownNotes(), state, randomUUID, Date.now, () => {}); await restarted.start();
  catalog.value = { setup: 'check_failed', nextAction: 'Check again.', connected: false, compatible: false, sources: [] };
  const status = await restarted.status(); assert.equal(status.vaults[0].source, null); assert.equal(status.vaults[0].name, 'Launch');
  assert.equal(status.uncertainOperations[0].operationId, legacyId); assert.equal(status.receiptFailures[0].category, 'source_unavailable');
  assert.deepEqual(state.value.vaultIds, ['one', 'two']);
});
test('receipt lookup failures stay uncertain after a definite resolution response', async () => {
  const { service, files, state } = await setup(); const read = await service.read({ vaultId: 'one', path: 'Launch.md' }); const token = randomUUID();
  files.conflicts.set('one/Launch.md', { inspection: { token, logicalHash: read.hash!, incomingHash: null, incomingAbsent: true }, incoming: null });
  files.receipts = async () => { throw new VaultError('unavailable'); };
  await assert.rejects(service.recover({ vaultId: 'one', path: 'Launch.md', token, expectedLogicalHash: read.hash!, expectedIncomingHash: null, choice: 'accept_incoming' }), /uncertain/);
  assert.equal(state.value.pending?.[0].kind, 'resolution'); assert.equal(files.saved.at(-1)?.kind, 'resolution');
});
test('two simultaneously submitted different-note operations keep both durable pending rows', async () => {
  const { service, files, state } = await setup(); files.notes.set('one/A.md', 'A'); files.notes.set('one/B.md', 'B');
  const a = await service.read({ vaultId: 'one', path: 'A.md' }); const b = await service.read({ vaultId: 'one', path: 'B.md' });
  const entered = gate(); const release = gate(); let submissions = 0; const commit = files.commit.bind(files);
  files.commit = async input => { if (++submissions === 2) entered.resolve(); await release.promise; return commit(input); };
  const first = service.edit({ vaultId: 'one', path: 'A.md', expectedHash: a.hash!, append: '1' });
  const second = service.edit({ vaultId: 'one', path: 'B.md', expectedHash: b.hash!, append: '2' });
  await entered.promise; assert.equal(state.value.pending?.length, 2); assert.equal(new Set(state.value.pending?.map(p => p.operationId)).size, 2);
  release.resolve(); await Promise.all([first, second]); assert.equal(state.value.pending?.length, 0);
  assert.equal(files.notes.get('one/A.md'), 'A1'); assert.equal(files.notes.get('one/B.md'), 'B2');
});
