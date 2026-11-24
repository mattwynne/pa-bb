import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { Areas } from '../core/areas.ts';
import { areaFromNote } from '../adapters/obsidian.ts';
import type { AreaSnapshot } from '../core/model.ts';
import { plugin } from '../server.ts';
const signal = () => new AbortController().signal;
const data = (): AreaSnapshot => ({ source: { backend: 'fake', id: 'one', name: 'Example', scope: 'Areas', observedAt: 'now', lastSuccessfulSync: null, sync: null }, areas: [{ id: 'Areas/Work.md', title: 'Work' }, { id: 'Areas/Family.md', title: 'Family' }], complete: true, warnings: [] });
test('top-level Area names come from filenames and stay within the exact scope', () => {
  assert.deepEqual(areaFromNote('Areas', 'Areas/Work/Clients.md'), null);
  assert.deepEqual(areaFromNote('Areas', 'Areas/🧰 Work.md'), { id: 'Areas/🧰 Work.md', title: '🧰 Work' });
  for (const path of ['Areas-copy/Work.md', 'Areas/../Work.md', 'Areas/Work.txt', 'Areas\\Work.md', 'Areas/.md'])
    assert.equal(areaFromNote('Areas', path), 'invalid');
});
test('area paging sorts, binds owners, checks access/settings and consumes cursors once', async () => {
  let key = 'one', reads = 0, now = 0, allowed = true;
  const service = new Areas(async () => ({ key, backend: { async readAreas() { reads++; return data(); }, async checkAccess() { if (!allowed) throw new Error('revoked'); } } }), () => now);
  const page = await service.list({ limit: 1 }, signal(), 'a');
  assert.equal(page.totalAreas, 2); assert.equal(page.areas[0].title, 'Family'); assert.ok(page.nextCursor);
  await assert.rejects(service.list({ cursor: page.nextCursor! }, signal(), 'b'), /cursor expired/);
  const last = await service.list({ cursor: page.nextCursor! }, signal(), 'a'); assert.equal(last.nextCursor, null); assert.equal(reads, 1);
  await assert.rejects(service.list({ cursor: page.nextCursor! }, signal(), 'a'), /cursor expired/);
  const next = await service.list({ limit: 1 }, signal(), 'a'); key = 'two';
  await assert.rejects(service.list({ cursor: next.nextCursor! }, signal(), 'a'), /cursor expired/);
  const expires = await service.list({ limit: 1 }, signal(), 'a'); now = 300001;
  await assert.rejects(service.list({ cursor: expires.nextCursor! }, signal(), 'a'), /cursor expired/);
  allowed = false; await assert.rejects(service.list({}, signal(), 'a'), /revoked/);
  service.stop(); await assert.rejects(service.list({}, signal(), 'a'), /cancelled/);
});
test('partial and duplicate inventories never confirm totals; capacity and output bounds hold', async () => {
  let snapshot = data();
  const service = new Areas(async () => ({ key: 'x', backend: { async readAreas() { return snapshot; }, async checkAccess() {} } }));
  snapshot.areas.push(snapshot.areas[0]);
  const duplicate = await service.list({}, signal(), 'a'); assert.equal(duplicate.coverage, 'partial'); assert.equal(duplicate.totalAreas, null); assert.deepEqual(duplicate.warnings, ['duplicate_id']);
  snapshot = data(); snapshot.complete = false; snapshot.warnings = ['source_partial'];
  assert.equal((await service.list({}, signal(), 'a')).totalAreas, null);
  snapshot = data(); snapshot.areas = Array.from({ length: 200 }, (_, i) => ({ id: `${i}${'a'.repeat(900)}`, title: 'b'.repeat(240) }));
  for (let i = 0; i < 4; i++) { const page = await service.list({}, signal(), 'a'); assert.ok(page.nextCursor); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48000); }
  await assert.rejects(service.list({}, signal(), 'a'), /capacity/);
  service.stop();
});
test('CLI, RPC and tool share area contracts and redact failing source diagnostics', async () => {
  let fail = false, snapshot = data();
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'] });
  await plugin(host.bb, { select: async () => { throw new Error('unused'); }, selectAreas: async () => ({ key: 'a', backend: { async readAreas() { if (fail) throw Object.assign(new Error('sentinel-token private@example.test'), { cause: 'sentinel-cause' }); return snapshot; }, async checkAccess() {} } }) });
  try {
    const cli = await host.harness.behavior.runCli(['areas', '--json']); assert.equal(cli.exitCode, 0); assert.equal(JSON.parse(cli.stdout!).totalAreas, 2);
    assert.match((await host.harness.behavior.runCli(['areas'])).stdout!, /Family/);
    assert.equal((await host.harness.behavior.runCli(['areas', '--help'])).exitCode, 0);
    for (const args of [['areas', '--status', 'active'], ['areas', '--limit', '201'], ['areas', '--cursor', 'bad']]) assert.notEqual((await host.harness.behavior.runCli(args)).exitCode, 0);
    assert.equal((await host.harness.behavior.callRpc('listAreas', {}) as any).totalAreas, 2);
    snapshot.complete = false; snapshot.warnings = ['source_partial']; assert.equal((await host.harness.behavior.runCli(['areas'])).exitCode, 2);
    fail = true; const tool = await host.harness.behavior.callAgentTool('gtd_list_areas', {}); assert.ok(typeof tool !== 'string'); assert.equal(tool.isError, true);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /GTD areas source_unavailable/); assert.match(logs, /GTD areas partial/); assert.doesNotMatch(logs + JSON.stringify(tool), /sentinel|example.test/);
    await assert.rejects(host.harness.behavior.setSettings({ areasFolder: '../Areas' }));
  } finally { await host.harness.lifecycle.dispose(); }
});
