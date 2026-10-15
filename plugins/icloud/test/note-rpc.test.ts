import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { FakeCloudProvider, MemoryState } from './fakes.ts';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
async function setup() {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  await plugin(host.bb, { provider: new FakeCloudProvider(), repository: new MemoryState() });
  return host.harness;
}
test('v2 routes refuse clients, forged identities and mixed-version inputs before accessing notes', async () => {
  const harness = await setup();
  try {
    for (const method of ['noteConfigure', 'noteList', 'noteRead', 'noteCommit', 'noteReceipts', 'noteInspectConflict', 'noteResolveConflict'] as const) {
      const input = { version: 2, revision: 1, mirrorId: 'one', mirrorIds: ['one'], path: 'Note.md', operationId: '12345678-1234-7123-8123-123456789abc', kind: 'replace', expectedHash: 'a'.repeat(64), text: 'sentinel-private-content', token: '12345678-1234-7123-8123-123456789abc', expectedLogicalHash: 'a'.repeat(64), expectedIncomingHash: null, choice: 'keep_local' };
      const fields: Record<string, string[]> = {
        noteConfigure: ['version', 'revision', 'mirrorIds'], noteList: ['version', 'revision', 'mirrorId'], noteRead: ['version', 'revision', 'mirrorId', 'path'], noteCommit: ['version', 'revision', 'mirrorId', 'path', 'operationId', 'kind', 'expectedHash', 'text'], noteReceipts: ['version', 'revision', 'mirrorId'], noteInspectConflict: ['version', 'revision', 'mirrorId', 'path'], noteResolveConflict: ['version', 'revision', 'mirrorId', 'path', 'operationId', 'token', 'expectedLogicalHash', 'expectedIncomingHash', 'choice'],
      };
      const value = Object.fromEntries(fields[method].map(field => [field, (input as any)[field]]));
      for (const context of [undefined, { experimental_caller: { kind: 'plugin' as const, pluginId: 'fastmail' } }]) await assert.rejects(harness.behavior.callRpc(method, value, context), /Obsidian/);
      await assert.rejects(harness.behavior.callRpc(method, { ...value, version: 1 }, caller), /input validation/);
      await assert.rejects(harness.behavior.callRpc(method, { ...value, pluginId: 'obsidian' }, caller), /input validation/);
    }
  } finally { await harness.lifecycle.dispose(); }
});
test('missing native owner returns bounded failure without reflecting raw content or paths', async () => {
  const harness = await setup();
  try {
    const result = await harness.behavior.callRpc('noteConfigure', { version: 2, revision: 1, mirrorIds: ['one'] }, caller) as any;
    assert.equal(result.category, 'unavailable');
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /iCloud note_configure unavailable/);
    assert.doesNotMatch(logs + JSON.stringify(result), /sentinel|Note.md|one|\/tmp\//);
  } finally { await harness.lifecycle.dispose(); }
});
