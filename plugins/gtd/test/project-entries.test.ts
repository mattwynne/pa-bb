import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend, projectFromNote } from '../adapters/obsidian.ts';
const cursor = '12345678-1234-4123-8123-123456789abc';
const state = { propertiesAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Synthetic', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
const row = (path: string, properties: Record<string, unknown> = {}) => ({ path: 'Projects/' + path, properties });
async function fixture(pages: ReturnType<typeof row>[][], action: (backend: ObsidianBackend, calls: string[]) => Promise<void>) {
  let offset = 0; const calls: string[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    calls.push(args.method); if (args.method === 'status') return state;
    if (args.method === 'renameTitle') throw new Error('Unexpected live-write path');
    return { notes: pages[offset++], nextCursor: offset < pages.length ? cursor : null, incomplete: false, warnings: [], observedAt: 'now' };
  } } } });
  try { await action(new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' }), calls); } finally { await host.harness.lifecycle.dispose(); }
}
test('one entry layer, root-note precedence across pages, exact-name pairing, distinct duplicate titles and status containers', async () => {
  const misleading = { title: 'Not a project', type: 'project', status: 'invalid', areaId: '../bad' };
  await fixture([
    [row('Plan Trip/Notes.md', misleading), row('Clear Inbox/Transcript.md', misleading), row('Active/Ship/Done/Notes.md', misleading)],
    [],
    [row('Plan Trip.md', { title: 'Travel', status: 'deferred' }), row('Standalone.md'), row('Done/Finished.md', { status: 'active' }), row('Twin.md', { title: 'Travel' })],
    [row('Plan Trip/Nested/Transcript.md', misleading), row('Active/Ship.md', { title: 'Release', status: 'done' })],
  ], async backend => {
    const result = await backend.readProjects(new AbortController().signal);
    assert.deepEqual(result.projects.sort((a,b) => a.id.localeCompare(b.id)), [
      { id: 'Projects/Active/Ship.md', title: 'Release', status: 'active' },
      { id: 'Projects/Clear Inbox/', title: 'Clear Inbox', status: 'active' },
      { id: 'Projects/Done/Finished.md', title: 'Finished', status: 'done' },
      { id: 'Projects/Plan Trip.md', title: 'Travel', status: 'deferred' },
      { id: 'Projects/Standalone.md', title: 'Standalone', status: 'active' },
      { id: 'Projects/Twin.md', title: 'Travel', status: 'active' },
    ]);
    assert.equal(result.complete, false);
    assert.deepEqual(result.warnings, ['directory_enumeration_unavailable']);
  });
});
test('all existing status containers preserve one entry layer; deeper status names are supporting material', () => {
  for (const [group, status] of Object.entries({ Active: 'active', Deferred: 'deferred', Someday: 'someday', Done: 'done', Completed: 'done' })) {
    assert.deepEqual(projectFromNote('Projects', `Projects/${group}/Plan/Done/Notes.md`, { status: 'bad', title: 'Wrong' }), { id: `Projects/${group}/Plan/`, title: 'Plan', status });
  }
  assert.deepEqual(projectFromNote('Projects', 'Projects/Plan/Done/Notes.md', { status: 'done' }), { id: 'Projects/Plan/', title: 'Plan', status: 'active' });
});
test('empty and attachment-only directories are a declared read-contract gap, never a confirmed zero', async () => {
  await fixture([[], []], async backend => {
    const result = await backend.readProjects(new AbortController().signal);
    assert.deepEqual(result.projects, []); assert.equal(result.complete, false);
    assert.deepEqual(result.warnings, ['directory_enumeration_unavailable']);
  });
});
test('folder-only IDs are deterministic and cannot invoke a title write, even a folder named *.md', async () => {
  await fixture([[row('Folder.md/Notes.md')]], async (backend, calls) => {
    const result = await backend.readProjects(new AbortController().signal);
    assert.equal(result.projects[0].id, 'Projects/Folder.md/');
    await assert.rejects(backend.rename(result.projects[0].id, 'New', new AbortController().signal), /invalid source/);
    assert.ok(!calls.includes('renameTitle'));
  });
});
test('an invalid explicit root never borrows supporting metadata, in either page order', async () => {
  for (const pages of [ [[row('Pair.md', { status: 'bad' })], [row('Pair/Notes.md')]], [[row('Pair/Notes.md')], [row('Pair.md', { status: 'bad' })]] ]) {
    await fixture(pages, async backend => { const result = await backend.readProjects(new AbortController().signal); assert.deepEqual(result.projects, []); assert.ok(result.warnings.includes('invalid_project')); });
  }
});

test('nested README metadata is ignored and sibling notes win across metadata pages', async () => {
  const ordinary = row('Pilot/Supporting/README.md', { title: 'Nested', status: 'done' });
  const readme = row('Pilot/README.md', { title: 'Pilot title', status: 'deferred' });
  const legacy = row('Pilot.md', { title: 'Legacy title', status: 'active' });
  await fixture([[ordinary]], async backend => {
    const result = await backend.readProjects(new AbortController().signal);
    assert.deepEqual(result.projects, [{ id: 'Projects/Pilot/', title: 'Pilot', status: 'active' }]);
  });
  await fixture([[ordinary], [readme, row('Done/Finished/README.md', { status: 'active' })]], async backend => {
    const result = await backend.readProjects(new AbortController().signal);
    assert.deepEqual(result.projects, [
      { id: 'Projects/Pilot/', title: 'Pilot', status: 'active' },
      { id: 'Projects/Done/Finished/', title: 'Finished', status: 'done' },
    ]);
  });
  for (const pages of [[[readme], [legacy]], [[legacy], [readme]]]) {
    await fixture(pages, async backend => {
      const result = await backend.readProjects(new AbortController().signal);
      assert.deepEqual(result.projects, [{ id: 'Projects/Pilot.md', title: 'Legacy title', status: 'active' }]);
    });
  }
});
