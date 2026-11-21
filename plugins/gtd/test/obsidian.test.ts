import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend, areaFromNote, projectFromNote, relativeFolder } from '../adapters/obsidian.ts';
import { GtdError } from '../core/model.ts';
const cursor = '12345678-1234-4123-8123-123456789abc';
const state = () => ({ propertiesAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Example', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] });
const controller = () => new AbortController();
test('folder membership defines projects; folder status wins and root defaults active', () => {
  assert.deepEqual(projectFromNote('Projects', 'Projects/Deep/Plan.md', { type: 'project', title: 'New title', status: 'completed' }), { id: 'Projects/Deep/', title: 'Deep', status: 'active' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Done/Plan.md', { status: 'active' }), { id: 'Projects/Done/Plan.md', title: 'Plan', status: 'done' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Plan.md', { status: 'deferred' }), { id: 'Projects/Plan.md', title: 'Plan', status: 'deferred' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Active/Plan/Minutes.md', { status: 'done' }), { id: 'Projects/Active/Plan/', title: 'Plan', status: 'active' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Minutes.md', { type: 'meeting', status: 'done' }), { id: 'Projects/Minutes.md', title: 'Minutes', status: 'done' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Plan.md', {}), { id: 'Projects/Plan.md', title: 'Plan', status: 'active' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Plan.md', { areaId: 'Areas/Learning.md' }), { id: 'Projects/Plan.md', title: 'Plan', status: 'active', areaId: 'Areas/Learning.md' });
  assert.deepEqual(projectFromNote('Projects', 'Projects/Plan.md', { areaId: null }), { id: 'Projects/Plan.md', title: 'Plan', status: 'active' });
  assert.equal(projectFromNote('Projects', 'Projects/Plan.md', { areaId: '../Areas/Learning.md' }), 'invalid');
  assert.equal(projectFromNote('Projects', 'Projects/Plan.md', { type: 'project', status: 'blocked' }), 'invalid');
  assert.equal(projectFromNote('Projects', 'Projects/Plan.md', { type: 'project', status: 'active', title: 'bad\nheading' }), 'invalid');
});
test('exact folder confinement rejects traversal, absolute paths, prefix siblings, controls and backslashes', () => {
  for (const path of ['../Projects', '/Projects', 'Projects/', 'Projects/..', 'Projects\\Active', 'Projects\nOther']) assert.equal(relativeFolder.safeParse(path).success, false);
  assert.equal(relativeFolder.safeParse('Life/Projects').success, true);
  for (const path of ['Projects-copy/Plan.md', 'Projects/../Plan.md', 'Projects\\Plan.md']) assert.equal(projectFromNote('Projects', path, { type: 'project', status: 'active' }), 'invalid');
});
test('adapter drains empty continuation pages, scopes every RPC, excludes bodies, and keeps paused local access', async () => {
  const calls: Array<{ method: string; input: any }> = []; let pages = 0;
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    calls.push(args); if (args.method === 'status') return state();
    assert.equal(args.method, 'listProperties'); assert.deepEqual(args.input.fields, ['type', 'status', 'title', 'areaId']); assert.equal(args.input.folder, 'Life/Projects'); assert.equal(args.input.vaultId, 'one');
    return ++pages === 1 ? { notes: [], nextCursor: cursor, incomplete: false, warnings: [], observedAt: 'now' } : { notes: [{ path: 'Life/Projects/Active/Ship.md', properties: { status: 'active' } }], nextCursor: null, incomplete: false, warnings: [], observedAt: 'later' };
  } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Life/Projects' });
    const result = await backend.readProjects(controller().signal); await backend.checkAccess(controller().signal);
    assert.equal(result.complete, false); assert.deepEqual(result.warnings, ['directory_enumeration_unavailable']); assert.equal(result.projects.length, 1); assert.equal(result.source.sync?.phase, 'paused'); assert.equal(result.source.lastSuccessfulSync, null);
    assert.deepEqual(calls.map(c => c.method), ['status', 'listProperties', 'listProperties', 'status']); assert.equal(calls[2].input.cursor, cursor);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('partial metadata, invalid projects, and unsupported API version cannot claim a complete inventory', async () => {
  let version = 1;
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => args.method === 'status' ? { ...state(), propertiesAccessVersion: version } : { notes: [{ path: 'Projects/Bad.md', properties: { type: 'project', status: 'nonsense' } }], nextCursor: null, incomplete: true, warnings: ['parser_limit'], observedAt: 'now' } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' });
    const result = await backend.readProjects(controller().signal); assert.equal(result.complete, false); assert.deepEqual(result.warnings, ['directory_enumeration_unavailable', 'source_partial', 'invalid_project']);
    version = 0; await assert.rejects(backend.readProjects(controller().signal), /incompatible/);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('interrupted reads close their cursor and never expose provider errors; cleanup failure is diagnosed', async () => {
  const abort = controller(); const calls: string[] = []; let cleanups = 0;
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    calls.push(args.method); if (args.method === 'status') return state();
    if (args.method === 'closeProperties') throw new Error('sentinel-secret-body');
    if (args.input.cursor) { abort.abort(); throw new Error('sentinel-secret-body'); }
    return { notes: [], nextCursor: cursor, incomplete: false, warnings: [], observedAt: 'now' };
  } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' }, () => cleanups++);
    await assert.rejects(backend.readProjects(abort.signal), error => error instanceof GtdError && error.code === 'cancelled' && !JSON.stringify(error).includes('sentinel'));
    assert.equal(calls.at(-1), 'closeProperties'); assert.equal(cleanups, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});
