import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };
async function setup() {
  const host = createFakePluginHost({ pluginId: 'obsidian' }); const files = new FilesFake();
  await plugin(host.bb, { catalog: new CatalogFake(), files, repository: new MemoryState() });
  await host.harness.behavior.callRpc('connect', { vaultId: 'one' }); return { ...host, files };
}
test('GTD title rename drains a long whole note and preserves path, body, links and unrelated YAML bytes', async () => {
  const f = await setup();
  try {
    let reads = 0; const read = f.files.read.bind(f.files); f.files.read = async (...args) => { reads++; return read(...args); };
    const body = '\r\n# Original heading\r\n[[Projects/Woodworking]]\r\n' + 'Synthetic detail. '.repeat(3000);
    f.files.notes.set('one/Projects/Woodworking.md', '---\r\ntitle: Old\r\ncustom: keep # comment\r\naliases: [Original]\r\n---' + body);
    const result = await f.harness.behavior.callRpc('renameTitle', { vaultId: 'one', path: 'Projects/Woodworking.md', title: 'Learn woodworking' }, caller) as any;
    assert.equal(result.outcome, 'saved_locally_pending_sync'); assert.equal(f.files.saved.length, 1); assert.ok(reads >= 4, 'all content pages, final acknowledgement and CAS reread were required');
    const text = f.files.notes.get('one/Projects/Woodworking.md')!;
    assert.ok(text.endsWith(body)); assert.match(text, /custom: keep # comment\r\naliases: \[Original\]/); assert.match(text, /title: "Learn woodworking"/);
    assert.equal(f.files.saved[0].path, 'Projects/Woodworking.md'); assert.deepEqual(Object.keys(result).sort(), ['operationId', 'outcome']);
  } finally { await f.harness.lifecycle.dispose(); }
});
test('only GTD plugin may rename; failures and uncertain results never trigger retries or leak content', async () => {
  const f = await setup();
  try {
    const input = { vaultId: 'one', path: 'Launch.md', title: 'New' };
    await assert.rejects(f.harness.behavior.callRpc('renameTitle', input));
    await assert.rejects(f.harness.behavior.callRpc('renameTitle', input, { experimental_caller: { kind: 'plugin', pluginId: 'other' } }));
    let calls = 0; f.files.commit = async () => { calls++; throw Object.assign(new Error('sentinel-secret-body'), { cause: 'sentinel-token' }); };
    await assert.rejects(f.harness.behavior.callRpc('renameTitle', input, caller), /not confirmed/);
    assert.equal(calls, 1); const logs = JSON.stringify(f.harness.inspection.logEntries); assert.doesNotMatch(logs, /sentinel/); assert.match(logs, /Obsidian/);
    for (const path of ['../Launch.md', '/Launch.md']) await assert.rejects(f.harness.behavior.callRpc('renameTitle', { ...input, path }, caller));
    assert.equal(calls, 1);
  } finally { await f.harness.lifecycle.dispose(); }
});
