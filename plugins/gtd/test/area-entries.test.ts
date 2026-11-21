import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
import { enclosingArea } from '../core/area-presentation.ts';
import { Areas } from '../core/areas.ts';
const state = { propertiesAccessVersion: 1, childrenAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Synthetic', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
test('Area root pairing spans empty continuations; empty/attachment folders and status-named Areas are entries', async () => {
  let page = 0; const scopes: string[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'status') return state;
    if (args.method === 'listChildren') { scopes.push(args.input.folder); return { entries: ['Community', 'Empty', 'Attachments', 'Done'].map(name => ({ name, kind: 'directory' })).concat([{ name: 'Community.md', kind: 'markdown' }]), incomplete: false }; }
    assert.equal(args.method, 'listProperties');
    const pages = [[{ path: 'Areas/Community/Example Committee/Meeting.md', properties: { title: 'Wrong', type: 'area', status: 'done' } }], [], [{ path: 'Areas/Community.md', properties: { title: 'Shared life' } }, { path: 'Areas/Done/Transcript.md', properties: { title: 'Wrong' } }]];
    return { notes: pages[page++], nextCursor: page < pages.length ? '12345678-1234-4123-8123-123456789abc' : null, incomplete: false, warnings: [], observedAt: 'now' };
  } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Areas' });
    const service = new Areas(async () => ({ key: 'one', backend }));
    const first = await service.list({ limit: 2 }, new AbortController().signal, 'owner');
    const second = await service.list({ cursor: first.nextCursor! }, new AbortController().signal, 'owner');
    const areas = [...first.areas, ...second.areas];
    assert.equal(first.coverage, 'complete'); assert.equal(first.totalAreas, 4);
    assert.deepEqual(areas.map(a => a.id).sort(), ['Areas/Attachments/', 'Areas/Community.md', 'Areas/Done/', 'Areas/Empty/']);
    assert.equal(areas.find(a => a.id === 'Areas/Community.md')!.title, 'Shared life');
    assert.deepEqual(scopes, ['Areas']);
    await assert.rejects(backend.rename('Areas/Empty/', 'New', new AbortController().signal));
  } finally { await host.harness.lifecycle.dispose(); }
});
test('nested areaId roll-up is exact-path presentation only, never display-title guessing or mutation', () => {
  const areas = [{ id: 'Life/Areas/Community.md', title: 'Renamed' }, { id: 'Life/Areas/Other/', title: 'Community' }];
  const project = { areaId: 'Life/Areas/Community/Example Committee/Meeting.md' };
  assert.equal(enclosingArea(areas, project.areaId)?.id, areas[0].id);
  assert.equal(project.areaId, 'Life/Areas/Community/Example Committee/Meeting.md');
  assert.equal(enclosingArea(areas, 'Life/Areas/Other/Meeting.md')?.id, areas[1].id);
  assert.equal(enclosingArea(areas, 'Life/Areas/Other/')?.id, areas[1].id);
  assert.equal(enclosingArea(areas, 'Life/Areas/Community-copy/Meeting.md'), undefined);
  assert.equal(enclosingArea(areas, 'Community'), undefined);
});
