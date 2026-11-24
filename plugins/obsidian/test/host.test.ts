import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState, hash } from './fakes.ts';
import { settingsSchema, tools } from '../contract.ts';
import { desktopRenameUncertain, VaultError, type VaultFiles } from '../core/ports.ts';
import { parseLinks } from '../core/vault-links.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
const names = ['obsidian_status', 'obsidian_search_notes', 'obsidian_read_note', 'obsidian_get_note_metadata', 'obsidian_resolve_link', 'obsidian_list_tasks', 'obsidian_move_note', 'obsidian_move_status', 'obsidian_preview_folder_move', 'obsidian_apply_folder_move', 'obsidian_create_note', 'obsidian_edit_note', 'obsidian_update_properties'];
async function setup() { const host = createFakePluginHost({ pluginId: 'obsidian' }); const catalog = new CatalogFake(); const files = new FilesFake(); const repository = new MemoryState(); await plugin(host.bb, { catalog, files, repository }); return { ...host, catalog, files, repository }; }
test('registers the ordinary tools and starts with no connected vault', async () => {
  const { harness } = await setup();
  try { const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext()); assert.deepEqual(config.tools.map(t => t.name), names); assert.equal(settingsSchema.parse(await harness.behavior.callRpc('status', null)).vaults.length, 0); assert.match(config.instructions ?? '', /untrusted evidence/); }
  finally { await harness.lifecycle.dispose(); }
});
test('Connect and Remove are client-only; schemas reject forged input identities and host paths', async () => {
  const { harness } = await setup();
  try { const context = { experimental_caller: { kind: 'plugin' as const, pluginId: 'icloud' } }; for (const method of ['connect', 'remove']) await assert.rejects(harness.behavior.callRpc(method, { vaultId: 'one' }, context), /settings/); await assert.rejects(harness.behavior.callRpc('connect', { vaultId: 'one', caller: 'client' })); await assert.rejects(harness.behavior.callRpc('connect', { vaultId: '/host/path' })); await harness.behavior.callRpc('connect', { vaultId: 'one' }); }
  finally { await harness.lifecycle.dispose(); }
});

test('Desktop publishes its referring filenames without attributing occurrences from stale target evidence', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' });
    const root = 'Nested';
    const path = root + '/Alpha/Tie.md';
    const explicit = root + '/Notes/Explicit.md', tie = root + '/Notes/TieRef.md', stale = root + '/Notes/Stale.md';
    const targetText = '# target\n[[Notes/Explicit]]\n';
    const notes = [[path, targetText], [explicit, '[[Alpha/Tie|one]]'], [tie, '[[Tie]]']];
    files.notes.set('one/' + path, targetText);
    files.notes.set('one/' + root + '/Bravo/Tie.md', '# Competing target absent from the index');
    files.notes.set('one/' + explicit, '# Added line\n\n[[Alpha/Tie|one]]\n');
    files.notes.set('one/' + tie, '[[Tie]]');
    const parser = new MarkdownNotes();
    const read = files.read.bind(files);
    const reads: string[] = [];
    files.read = async (...args) => { reads.push(args[2]); return read(...args); };
    files.list = files.vaultRoots = async () => { throw new Error('Desktop metadata must not walk the live vault'); };
    let nativeCalls = 0, checked = 0, accessChecks = 0;
    const native: Pick<VaultFiles, 'desktopLink' | 'publishedIndex'> = {
      async desktopLink(target, operation, _signal, assertSelected) {
        nativeCalls++;
        assert.deepEqual(target, { mirrorId: 'one', revision: 1 });
        assert.deepEqual(operation, { kind: 'backlinks', path });
        assertSelected?.();
        return { route: 'desktop', root, result: { kind: 'backlinks', sources: [explicit, tie, stale] },
          async checkAccess() { accessChecks++; } };
      },
      async publishedIndex() {
        return { view: { directories: [root, root + '/.obsidian'], omissions: [], notes: notes.map(([path, text]) => ({
          path, hash: hash(text), readAt: 'observed', properties: {}, linkData: parseLinks(text, parser),
        })) }, async check() { checked++; }, assertValid() {}, close() {} };
      },
    };
    Object.assign(files, native);
    const result = await harness.behavior.callAgentTool('obsidian_get_note_metadata', { vaultId: 'one', path, backlinks: true });
    assert.ok(typeof result !== 'string'); assert.equal(result.isError, undefined);
    const data = JSON.parse((result.content[0] as { text: string }).text);
    assert.deepEqual(data.backlinkSources, [explicit, tie, stale]);
    assert.equal(data.backlinkSourcesTruncated, false);
    assert.equal(data.backlinksIncomplete, true);
    assert.equal(data.backlinksBackend, 'desktop');
    assert.deepEqual(data.backlinks, []);
    assert.equal(data.links[0].resolution.target, explicit);
    assert.deepEqual(reads, [path]);
    assert.equal(nativeCalls, 1); assert.equal(checked, 1); assert.equal(accessChecks, 1);
  } finally { await harness.lifecycle.dispose(); }
});

test('Desktop filenames survive unavailable index evidence, while revocation and cancellation refuse publication', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' });
    const target = { vaultId: 'one', path: 'Launch.md', backlinks: true };
    const sources = ['Ref.md'];
    let failure = '', revoked = false, checks = 0, newBuilds = 0;
    const native: Pick<VaultFiles, 'desktopLink' | 'publishedIndex' | 'index'> = {
      async desktopLink() {
        return { route: 'desktop', root: '', result: { kind: 'backlinks', sources },
          async checkAccess() {
            checks++;
            if (revoked) throw new VaultError('source_unavailable');
          } };
      },
      async publishedIndex() { if (failure) throw new VaultError(failure); return undefined; },
      async index() { newBuilds++; throw new VaultError('unavailable'); },
    };
    Object.assign(files, native);
    const run = async () => {
      const result = await harness.behavior.callAgentTool('obsidian_get_note_metadata', target);
      assert.ok(typeof result !== 'string');
      return { isError: result.isError, data: JSON.parse((result.content[0] as { text: string }).text) };
    };
    for (failure of ['', 'unavailable', 'index_incomplete']) {
      const partial = await run();
      assert.equal(partial.isError, undefined);
      assert.deepEqual(partial.data.backlinkSources, sources);
      assert.deepEqual(partial.data.backlinks, []);
      assert.equal(partial.data.backlinksIncomplete, true);
      assert.equal(partial.data.linksIncomplete, true);
    }
    assert.equal(checks, 3);
    assert.equal(newBuilds, 0);
    revoked = true;
    assert.equal((await run()).data.category, 'source_unavailable');
    revoked = false;
    for (failure of ['source_unavailable', 'cancelled']) {
      const refused = await run();
      assert.equal(refused.isError, true);
      assert.equal(refused.data.category, failure);
      assert.equal(refused.data.backlinkSources, undefined);
    }
  } finally { await harness.lifecycle.dispose(); }
});

test('Desktop rename is an explicit public mode separate from complete-read moves and GTD plans', async () => {
  const { harness, files, repository } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' });
    const endpoints = { vaultId: 'one', path: 'Launch.md', destination: 'Renamed.md' };
    const request = { ...endpoints, mode: 'desktop_rename' };
    const schema = tools.obsidian_move_note.parameters;
    assert.equal(schema.safeParse(request).success, true);
    assert.equal(schema.safeParse(endpoints).success, false);
    for (const extra of [{ expectedHash: 'a'.repeat(64) }, { dryRun: false }, { project: 'standalone' }, { root: 'Projects' },
      { operationId: '12345678-1234-7123-8123-123456789abc' }]) assert.equal(schema.safeParse({ ...request, ...extra }).success, false);
    const normal = await harness.behavior.callAgentTool('obsidian_move_note', { ...endpoints, expectedHash: 'a'.repeat(64) });
    assert.ok(typeof normal !== 'string'); assert.match(JSON.stringify(normal), /complete_read_required/);
    let calls = 0, outcome: 'confirmed' | 'lost' | 'existing' = 'confirmed';
    const adapter: Pick<VaultFiles, 'desktopLink'> = {
      async desktopLink(target, operation, _signal, assertSelected) {
        calls++;
        assert.deepEqual(target, { mirrorId: 'one', revision: 1 });
        assert.deepEqual(operation, { kind: 'rename', path: endpoints.path, destination: endpoints.destination });
        assertSelected?.();
        if (outcome === 'lost') throw desktopRenameUncertain();
        if (outcome === 'existing') return { route: 'existing' };
        return { route: 'desktop', root: '', result: { kind: 'rename', destination: endpoints.destination } };
      },
    };
    Object.assign(files, adapter);
    files.read = files.list = files.vaultRoots = async () => { throw new Error('Desktop rename must bypass the BB planner'); };
    const renamed = await harness.behavior.callAgentTool('obsidian_move_note', request);
    assert.ok(typeof renamed !== 'string'); assert.equal(renamed.isError, undefined);
    assert.deepEqual(JSON.parse((renamed.content[0] as { text: string }).text),
      { backend: 'desktop', outcome: 'renamed_locally_pending_sync', ...endpoints });
    assert.equal(calls, 1); assert.equal(repository.value.moves, undefined);
    outcome = 'lost';
    const lost = await harness.behavior.callAgentTool('obsidian_move_note', request);
    assert.ok(typeof lost !== 'string'); assert.equal(lost.isError, true);
    assert.match(JSON.stringify(lost), /uncertain.*Do not repeat/);
    assert.equal(calls, 2); assert.equal(repository.value.moves, undefined);
    outcome = 'existing';
    const unavailable = await harness.behavior.callAgentTool('obsidian_move_note', request);
    assert.ok(typeof unavailable !== 'string'); assert.match(JSON.stringify(unavailable), /Desktop rename is unavailable/);
    const otherFolder = await harness.behavior.callAgentTool('obsidian_move_note', { ...request, destination: 'Folder/Renamed.md' });
    assert.ok(typeof otherFolder !== 'string'); assert.match(JSON.stringify(otherFolder), /same folder/);
    assert.equal(calls, 3);
  } finally { await harness.lifecycle.dispose(); }
});
test('tools create, read, edit and update properties without a confirmation', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' });
    const run = async (name: string, input: unknown) => { const result = await harness.behavior.callAgentTool(name, input); assert.ok(typeof result !== 'string'); assert.equal(result.isError, undefined); return JSON.parse((result.content[0] as any).text); };
    const created = await run('obsidian_create_note', { vaultId: 'one', path: 'Meeting.md', text: '# Meeting\r\n' }); assert.equal(created.receipt.outcome, 'saved_locally_pending_sync');
    const note = await run('obsidian_read_note', { vaultId: 'one', path: 'Meeting.md' }); await run('obsidian_edit_note', { vaultId: 'one', path: 'Meeting.md', expectedHash: note.hash, append: 'Decision\r\n' });
    const updated = await run('obsidian_read_note', { vaultId: 'one', path: 'Meeting.md' }); await run('obsidian_update_properties', { vaultId: 'one', path: 'Meeting.md', expectedHash: updated.hash, set: { status: 'done' } });
    assert.match(files.notes.get('one/Meeting.md')!, /status: "done"\r\n/); assert.match(files.notes.get('one/Meeting.md')!, /Decision\r\n/);
  } finally { await harness.lifecycle.dispose(); }
});
test('handled tool failures and partial scans diagnose safely without private error details', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' }); files.read = async () => { throw new Error('sentinel-private /secret/account note-body token'); };
    const result = await harness.behavior.callAgentTool('obsidian_read_note', { vaultId: 'one', path: 'Launch.md' }); assert.ok(typeof result !== 'string'); assert.equal(result.isError, true);
    const partial = await harness.behavior.callAgentTool('obsidian_search_notes', { text: 'Launch' }); assert.ok(typeof partial !== 'string'); assert.equal(partial.isError, undefined); assert.equal(JSON.parse((partial.content[0] as any).text).incomplete, true);
    const logs = JSON.stringify(harness.inspection.logEntries); assert.match(logs, /Obsidian tool unavailable/); assert.match(logs, /Obsidian parse unavailable/); assert.doesNotMatch(logs + JSON.stringify(result), /sentinel|secret|account|note-body|token|Launch.md/);
    files.read = async () => { throw new VaultError('source_unavailable'); }; const known = await harness.behavior.callAgentTool('obsidian_read_note', { vaultId: 'one', path: 'Launch.md' }); assert.ok(typeof known !== 'string'); assert.equal(known.isError, true);
  } finally { await harness.lifecycle.dispose(); }
});
test('client recovery RPC is narrow, caller-restricted, and agent tools expose guarded conflict without adding tool names', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' }); const logical = files.notes.get('one/Launch.md')!;
    const { hash } = await import('./fakes.ts'); const token = '12345678-1234-7123-8123-123456789abc';
    files.conflicts.set('one/Launch.md', { inspection: { token, logicalHash: hash(logical), incomingHash: null, incomingAbsent: true }, incoming: null });
    const run = async (name: string, input: unknown) => { const result = await harness.behavior.callAgentTool(name, input); assert.ok(typeof result !== 'string'); assert.equal(result.isError, undefined); return JSON.parse((result.content[0] as any).text); };
    const status = await run('obsidian_status', { vaultId: 'one', path: 'Launch.md' }); assert.equal(status.conflict.inspection.incomingAbsent, true);
    const incoming = await run('obsidian_read_note', { vaultId: 'one', path: 'Launch.md', selector: { version: 'incoming', token } }); assert.equal(incoming.absent, true); assert.equal(incoming.hash, null);
    const request = { vaultId: 'one', path: 'Launch.md', token, expectedLogicalHash: hash(logical), expectedIncomingHash: null, choice: 'accept_incoming' };
    await assert.rejects(harness.behavior.callRpc('recovery', request, { experimental_caller: { kind: 'plugin', pluginId: 'icloud' } }), /settings/);
    await assert.rejects(harness.behavior.callRpc('recovery', { ...request, text: 'forged', caller: 'client' }));
    const recovered = await harness.behavior.callRpc('recovery', request) as any; assert.equal(recovered.receipt.kind, 'resolution'); assert.equal(recovered.receipt.hash, null);
    assert.equal((await run('obsidian_status', { vaultId: 'one', path: 'Launch.md', operationId: recovered.operationId })).receipts[0].outcome, 'adopted_absence');
  } finally { await harness.lifecycle.dispose(); }
});
test('unknown conflict and recovery errors cannot echo content/path to tools or logs', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' }); files.inspect = async () => { throw new Error('sentinel-private-content /private/path secret'); };
    const result = await harness.behavior.callAgentTool('obsidian_status', { vaultId: 'one', path: 'Launch.md' }); assert.ok(typeof result !== 'string'); assert.equal(JSON.parse((result.content[0] as any).text).conflictFailure, 'unavailable');
    const combined = JSON.stringify(result) + JSON.stringify(harness.inspection.logEntries); assert.doesNotMatch(combined, /sentinel|private-content|private\/path|secret/);
    files.resolve = async () => { throw new Error('sentinel-private-content /private/path secret'); };
    const error = await harness.behavior.callRpc('recovery', { vaultId: 'one', path: 'Launch.md', token: '12345678-1234-7123-8123-123456789abc', expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'keep_local' }).catch(e => e);
    assert.doesNotMatch(JSON.stringify(error) + JSON.stringify(harness.inspection.logEntries), /sentinel|private-content|private\/path|secret/);
  } finally { await harness.lifecycle.dispose(); }
});
test('paged native tool reads stay bounded, bind proof to the reader and diagnose failed continuations without leaking content', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' });
    const target = { vaultId: 'one', path: 'Long.md' }; const text = '\\'.repeat(40000); files.notes.set('one/Long.md', text);
    const call = async (input: unknown, threadId = 'reader-a') => {
      const result = await harness.behavior.callAgentTool('obsidian_read_note', input, { threadId }); assert.ok(typeof result !== 'string');
      const encoded = (result.content[0] as any).text; assert.ok(encoded.length <= 64000); return { result, page: JSON.parse(encoded) };
    };
    let { page } = await call(target); let delivered = '';
    while (page.nextCursor) { assert.equal(page.complete, false); delivered += page.text; page = (await call({ ...target, cursor: page.nextCursor })).page; }
    assert.equal(delivered, text); assert.equal(page.text, ''); assert.equal(page.editReady, true);
    const wrong = await harness.behavior.callAgentTool('obsidian_edit_note', { ...target, expectedHash: page.hash, append: 'bad' }, { threadId: 'reader-b' });
    assert.ok(typeof wrong !== 'string'); assert.equal(wrong.isError, true); assert.match((wrong.content[0] as any).text, /complete_read_required/);
    // No existing proof on this new path. A lost/failed continuation cannot grant one.
    const failed = { ...target, path: 'Failed.md' }; files.notes.set('one/Failed.md', text);
    const first = (await call(failed)).page;
    files.read = async () => { throw new Error('sentinel-private-body secret /private/path'); };
    const failure = await call({ ...failed, cursor: first.nextCursor }); assert.equal(failure.result.isError, true); assert.equal(failure.page.category, 'unavailable');
    const replay = await call({ ...failed, cursor: first.nextCursor }); assert.equal(replay.page.category, 'cursor_expired');
    const logs = JSON.stringify(harness.inspection.logEntries); assert.match(logs, /Obsidian tool unavailable/); assert.match(logs, /Obsidian tool cursor_expired/);
    assert.doesNotMatch(logs + JSON.stringify(failure) + JSON.stringify(replay), /sentinel|secret|private\/path|private-body/);
  } finally { await harness.lifecycle.dispose(); }
});
test('an oversized read envelope cannot issue a proof before tool serialization fails', async () => {
  const { harness, files, catalog } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' });
    const { hash } = await import('./fakes.ts'); const original = files.notes.get('one/Launch.md')!;
    catalog.value.sources[0].name = 'sentinel-private'.repeat(6000);
    const read = await harness.behavior.callAgentTool('obsidian_read_note', { vaultId: 'one', path: 'Launch.md' });
    assert.ok(typeof read !== 'string'); assert.equal(read.isError, true); assert.match((read.content[0] as any).text, /output_limit/);
    catalog.value.sources[0].name = 'Launch';
    const edit = await harness.behavior.callAgentTool('obsidian_edit_note', { vaultId: 'one', path: 'Launch.md', expectedHash: hash(original), append: 'bad' });
    assert.ok(typeof edit !== 'string'); assert.equal(edit.isError, true); assert.match((edit.content[0] as any).text, /complete_read_required/);
    assert.equal(files.saved.length, 0); assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /sentinel-private/);
  } finally { await harness.lifecycle.dispose(); }
});
test('obsidian_edit_note resolves a guarded conflict but rejects mixed ordinary-edit and resolution inputs', async () => {
  const { harness, files } = await setup();
  try {
    await harness.behavior.callRpc('connect', { vaultId: 'one' }); const { hash } = await import('./fakes.ts'); const text = files.notes.get('one/Launch.md')!;
    const token = '12345678-1234-7123-8123-123456789abc';
    files.conflicts.set('one/Launch.md', { inspection: { token, logicalHash: hash(text), incomingHash: hash('Incoming'), incomingAbsent: false }, incoming: 'Incoming' });
    const resolution = { vaultId: 'one', path: 'Launch.md', resolution: { token, expectedLogicalHash: hash(text), expectedIncomingHash: hash('Incoming'), choice: 'keep_local' } };
    await assert.rejects(harness.behavior.callAgentTool('obsidian_edit_note', { ...resolution, append: 'bad', expectedHash: hash(text) }));
    const value = await harness.behavior.callAgentTool('obsidian_edit_note', resolution); assert.ok(typeof value !== 'string'); assert.equal(value.isError, undefined);
    const result = JSON.parse((value.content[0] as any).text); assert.equal(result.receipt.kind, 'resolution'); assert.equal(result.receipt.outcome, 'saved_locally_pending_sync');
    assert.equal(files.notes.get('one/Launch.md'), text);
  } finally { await harness.lifecycle.dispose(); }
});
