import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
import { settingsSchema } from '../contract.ts';
import { VaultError } from '../core/ports.ts';
const names = ['obsidian_status', 'obsidian_search_notes', 'obsidian_read_note', 'obsidian_get_note_metadata', 'obsidian_resolve_link', 'obsidian_list_tasks', 'obsidian_create_note', 'obsidian_edit_note', 'obsidian_update_properties'];
async function setup() { const host = createFakePluginHost({ pluginId: 'obsidian' }); const catalog = new CatalogFake(); const files = new FilesFake(); const repository = new MemoryState(); await plugin(host.bb, { catalog, files, repository }); return { ...host, catalog, files, repository }; }
test('exactly nine ordinary tools, no approval registration, and no default connected vault', async () => {
  const { harness } = await setup();
  try { const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext()); assert.deepEqual(config.tools.map(t => t.name), names); assert.equal(settingsSchema.parse(await harness.behavior.callRpc('status', null)).vaults.length, 0); assert.match(config.instructions ?? '', /untrusted evidence/); }
  finally { await harness.lifecycle.dispose(); }
});
test('Connect and Remove are client-only; schemas reject forged input identities and host paths', async () => {
  const { harness } = await setup();
  try { const context = { experimental_caller: { kind: 'plugin' as const, pluginId: 'icloud' } }; for (const method of ['connect', 'remove']) await assert.rejects(harness.behavior.callRpc(method, { vaultId: 'one' }, context), /settings/); await assert.rejects(harness.behavior.callRpc('connect', { vaultId: 'one', caller: 'client' })); await assert.rejects(harness.behavior.callRpc('connect', { vaultId: '/host/path' })); await harness.behavior.callRpc('connect', { vaultId: 'one' }); }
  finally { await harness.lifecycle.dispose(); }
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
