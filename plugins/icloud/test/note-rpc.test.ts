import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
import { NoteStore } from '../adapters/note-store.ts';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
async function setup() {
  const host = createFakePluginHost({ pluginId: 'icloud' }); const provider = new FakeCloudProvider(); const repository = new MemoryState();
  repository.value.connected = true;
  repository.value.mirrors.push({ id: 'one', folder: { id: 'one', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: '2026-01-01T00:00:00.000Z', failure: null, blocker: null });
  const notes = { read: async () => ({ text: 'Synthetic', hash: 'a'.repeat(64), readAt: '2026-01-01T00:00:00Z', complete: true }), list: async () => ({ paths: ['Note.md'], incomplete: false, warnings: [] }), reconcile: async () => {}, receipts: async () => [], commit: async () => { throw new Error('sentinel-private'); } } as unknown as NoteStore;
  (provider as any).withMirrorFiles = async (_mirror: unknown, operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal);
  await plugin(host.bb, { provider, repository, notes }); return { ...host, provider, repository };
}
test('note RPCs reject clients and other plugins even with a forged input identity', async () => {
  const { harness } = await setup();
  try {
    for (const context of [undefined, { experimental_caller: { kind: 'plugin' as const, pluginId: 'fastmail' } }]) await assert.rejects(harness.behavior.callRpc('noteConfigure', { revision: 1, mirrorIds: ['one'] }, context), /Obsidian/);
    await assert.rejects(harness.behavior.callRpc('noteConfigure', { revision: 1, mirrorIds: ['one'], pluginId: 'obsidian' }, caller));
  } finally { await harness.lifecycle.dispose(); }
});
test('configuration revision revokes tools and receipt exposure without touching mirror state', async () => {
  const { harness, repository, provider } = await setup();
  try {
    const before = structuredClone(repository.value);
    assert.equal((await harness.behavior.callRpc('noteRead', { mirrorId: 'one', revision: 0, path: 'Note.md' }, caller) as any).category, 'not_connected');
    await harness.behavior.callRpc('noteConfigure', { revision: 1, mirrorIds: ['one'] }, caller);
    assert.equal((await harness.behavior.callRpc('noteRead', { mirrorId: 'one', revision: 1, path: 'Note.md' }, caller) as any).value.text, 'Synthetic');
    await harness.behavior.callRpc('noteConfigure', { revision: 2, mirrorIds: [] }, caller);
    for (const method of ['noteRead', 'noteReceipts']) assert.equal((await harness.behavior.callRpc(method, { mirrorId: 'one', revision: 1, ...(method === 'noteRead' ? { path: 'Note.md' } : {}) }, caller) as any).category, 'not_connected');
    assert.equal((await harness.behavior.callRpc('noteConfigure', { revision: 1, mirrorIds: ['one'] }, caller) as any).category, 'not_connected');
    assert.deepEqual(repository.value, before); assert.equal(provider.synced, 0);
  } finally { await harness.lifecycle.dispose(); }
});
test('handled note failures log a fixed bounded stage/category, never raw exceptions', async () => {
  const { harness } = await setup();
  try {
    await harness.behavior.callRpc('noteConfigure', { revision: 1, mirrorIds: ['one'] }, caller);
    const result = await harness.behavior.callRpc('noteCommit', { mirrorId: 'one', revision: 1, path: 'Note.md', operationId: '12345678-1234-4123-8123-123456789abc', kind: 'replace', expectedHash: 'a'.repeat(64), text: 'sentinel-private-content' }, caller);
    const logs = JSON.stringify(harness.inspection.logEntries); assert.match(logs, /iCloud note_commit unavailable/); assert.doesNotMatch(logs + JSON.stringify(result), /sentinel|Note.md|one|\/tmp\//);
  } finally { await harness.lifecycle.dispose(); }
});
