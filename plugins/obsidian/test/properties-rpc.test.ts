import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
import { VaultError } from '../core/ports.ts';
async function setup() {
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  const catalog = new CatalogFake(), files = new FilesFake(), repository = new MemoryState();
  await plugin(host.bb, { catalog, files, repository });
  await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
  return { ...host, files, catalog };
}
test('consumer RPC lists only selected frontmatter in an exact folder, in compact pages without body/edit proofs', async () => {
  const f = await setup(); let reads = 0;
  try {
    f.files.notes.clear();
    for (let i = 0; i < 225; i++) f.files.notes.set(`one/Projects/P${i}.md`, `---\ntype: project\nstatus: active\nprivate: sentinel-frontmatter\n---\n${'sentinel-body'.repeat(10000)}`);
    f.files.notes.set('one/Projects-copy/Other.md', '---\nstatus: done\n---\n');
    const search = f.files.search.bind(f.files); f.files.search = async (input, signal) => { assert.deepEqual(input.folders, ['Projects']); assert.equal(input.projection, 'frontmatter'); reads++; return search(input, signal); };
    const input = { vaultId: 'one', folder: 'Projects', fields: ['type', 'status'] };
    let page = await f.harness.behavior.callRpc('listProperties', input) as any; const paths: string[] = [];
    do {
      assert.doesNotMatch(JSON.stringify(page), /sentinel|bodyText|snippet|editReady/);
      assert.equal(page.incomplete, false); paths.push(...page.notes.map((n: any) => n.path));
      if (!page.nextCursor) break;
      page = await f.harness.behavior.callRpc('listProperties', { ...input, cursor: page.nextCursor }) as any;
    } while (true);
    assert.equal(paths.length, 225); assert.equal(new Set(paths).size, 225); assert.ok(reads <= 6);
    assert.equal((await f.harness.behavior.callRpc('status', null) as any).propertiesAccessVersion, 1);
    const changed = await f.harness.behavior.callAgentTool('obsidian_edit_note', { vaultId: 'one', path: 'Projects/P0.md', expectedHash: 'a'.repeat(64), append: 'bad' });
    assert.ok(typeof changed !== 'string'); assert.equal(changed.isError, true); assert.match((changed.content[0] as any).text, /complete_read_required/);
  } finally { await f.harness.lifecycle.dispose(); }
});
test('malformed YAML is partial; explicit close, source revocation and forged scopes cannot return cached data', async () => {
  const f = await setup();
  try {
    f.files.notes.set('one/Projects/Bad.md', '---\nstatus: [\n---\n');
    let page = await f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] }) as any;
    assert.equal(page.incomplete, true); assert.ok(page.warnings.length);
    for (let i = 0; i < 205; i++) f.files.notes.set(`one/Projects/P${i}.md`, '---\nstatus: active\n---\n');
    const input = { vaultId: 'one', folder: 'Projects', fields: ['status'] };
    page = await f.harness.behavior.callRpc('listProperties', input) as any; assert.ok(page.nextCursor);
    await f.harness.behavior.callRpc('closeProperties', { cursor: page.nextCursor });
    await assert.rejects(f.harness.behavior.callRpc('listProperties', { ...input, cursor: page.nextCursor }));
    page = await f.harness.behavior.callRpc('listProperties', input) as any;
    f.catalog.value.sources[0].local.available = false;
    await assert.rejects(f.harness.behavior.callRpc('listProperties', { ...input, cursor: page.nextCursor }));
    for (const folder of ['../Projects', '/Projects', 'Projects\\Other']) await assert.rejects(f.harness.behavior.callRpc('listProperties', { ...input, folder }));
  } finally { await f.harness.lifecycle.dispose(); }
});
test('explicit producer cleanup failures are safely diagnosed instead of silently confirmed', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 500; i++) f.files.notes.set(`one/Projects/P${i}.md`, '---\nstatus: active\n---\n');
    const page = await f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] }) as any;
    assert.ok(page.nextCursor);
    f.files.closeSearch = async () => { throw new Error('sentinel-private-cleanup'); };
    await assert.rejects(f.harness.behavior.callRpc('closeProperties', { cursor: page.nextCursor }), /cleanup was not confirmed/);
    const logs = JSON.stringify(f.harness.inspection.logEntries); assert.match(logs, /Obsidian rpc unavailable/); assert.doesNotMatch(logs, /sentinel/);
  } finally { await f.harness.lifecycle.dispose(); }
});
test('RPC failures are safely diagnosed without raw provider messages', async () => {
  const f = await setup();
  try {
    f.files.search = async () => { throw Object.assign(new Error('sentinel-secret-private-body'), { code: 'sentinel-private-code' }); };
    const result = await f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] }) as any;
    assert.equal(result.incomplete, true); assert.match(JSON.stringify(f.harness.inspection.logEntries), /Obsidian rpc unavailable/);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(f.harness.inspection.logEntries), /sentinel/);
    f.files.search = async () => { throw new VaultError('capacity'); };
    await assert.rejects(f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] }), /Property listing/);
  } finally { await f.harness.lifecycle.dispose(); }
});
