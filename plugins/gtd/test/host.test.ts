import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { panelHref, recordDestination } from '../app-routes.ts';
import type { AreaBackend, ProjectBackend, ProjectSnapshot } from '../core/model.ts';
const data = (): ProjectSnapshot => ({ source: { backend: 'fake', id: 'one', name: 'Synthetic source', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null }, projects: [{ id: 'one', title: 'Test project', status: 'active' }], complete: true, warnings: [] });
async function setup(backend?: ProjectBackend, areaBackend?: AreaBackend) {
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'], sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Test vault' }], incomplete: false };
    throw new Error('source unavailable');
  } } } });
  await plugin(host.bb, backend ? {
    select: async () => ({ key: 'test', backend }),
    selectAreas: areaBackend && (async () => ({ key: 'test', backend: areaBackend })),
  } : undefined);
  return host;
}
test('host registers the GTD tools and CLI help, validation, listing and RPC share the same contract', async () => {
  const { harness } = await setup({ async readProjects() { return data(); }, async checkAccess() {} });
  try {
    const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext()); assert.deepEqual(config.tools.map(t => t.name), ['gtd_browse_area_targets', 'gtd_prepare_project_change', 'gtd_check_project_change', 'gtd_defer_project', 'gtd_change_project', 'gtd_apply_project_change', 'gtd_rename_area', 'gtd_resolve_detail_link', 'gtd_list_projects', 'gtd_list_areas', 'gtd_create_project_thread']); assert.match(config.instructions!, /untrusted evidence/);
    const help = await harness.behavior.runCli(['projects', '--help']); assert.equal(help.exitCode, 0); assert.match(help.stdout!, /--status/);
    for (const args of [['projects', '--status', 'bogus', '--json'], ['projects', '--limit', '201', '--json'], ['projects', '--limti', '1', '--json']]) assert.notEqual((await harness.behavior.runCli(args)).exitCode, 0);
    const cli = await harness.behavior.runCli(['projects', '--json']); assert.equal(cli.exitCode, 0); assert.equal(JSON.parse(cli.stdout!).totalProjects, 1);
    const text = await harness.behavior.runCli(['projects']); assert.match(text.stdout!, /Active \(1\)/); assert.match(text.stdout!, /Test project/);
    const tool = await harness.behavior.callAgentTool('gtd_list_projects', {}); assert.ok(typeof tool !== 'string'); assert.equal(tool.isError, undefined); assert.equal(JSON.parse((tool.content[0] as any).text).totalProjects, 1);
    const rpc = await harness.behavior.callRpc('listProjects', {}) as any; assert.equal(rpc.totalProjects, 1);
  } finally { await harness.lifecycle.dispose(); }
});
test('Area mentions and detail links preserve exact hard-to-guess IDs and recheck availability', async () => {
  const snapshot = data();
  const project = { id: 'Projects/Active/Build a bench.md', title: 'Build a bench', status: 'active' as const };
  const learning = { id: 'Areas/Learning.md', title: 'Learning' };
  const folder = { id: 'Areas/Learning resources/', title: 'Learning resources' };
  let areaRows = [folder, learning];
  let sourceFailure = false;
  snapshot.projects = [project];
  const { harness } = await setup(
    { async readProjects() { return snapshot; }, async checkAccess() {} },
    { async readAreas() {
      if (sourceFailure) throw new Error('synthetic-private-inventory-error');
      return { source: snapshot.source, areas: areaRows, complete: true, warnings: [] };
    }, async checkAccess() {} },
  );
  const resolveLink = (kind: 'area' | 'project', id: string, source = 'one') =>
    harness.behavior.callAgentTool('gtd_resolve_detail_link', { kind, source, id });
  try {
    const provider = harness.inspection.registrations.mentionProviders.find(provider => provider.id === 'area')!;
    assert.equal(provider.label, 'GTD Areas');
    assert.deepEqual(provider.triggers, ['@']);
    const results = await provider.search({ trigger: '@', query: 'learn', projectId: null, threadId: null });
    assert.deepEqual(results.map(item => [item.title, item.subtitle, item.icon]),
      [[learning.title, learning.id, 'Layers'], [folder.title, folder.id, 'Layers']]);
    for (const [index, area] of [learning, folder].entries()) {
      const { context } = await provider.resolve(results[index].id);
      assert.match(context, /kind "area".*gtd_resolve_detail_link/);
      assert.deepEqual(JSON.parse(context.split('\n')[1]), { source: 'one', ...area });
    }
    for (const [kind, item] of [['project', project], ['area', learning], ['area', folder]] as const) {
      const tool = await resolveLink(kind, item.id);
      assert.ok(typeof tool !== 'string' && !tool.isError);
      assert.deepEqual(tool.content, [{ type: 'text', text: JSON.stringify({
        title: item.title, href: panelHref(recordDestination(kind === 'project' ? 'projects' : 'areas', 'one', item.id)),
      }) }]);
    }
    await assert.rejects(async () => provider.resolve(recordDestination('areas', 'other', learning.id).subPath), /unavailable/);
    areaRows = [folder];
    await assert.rejects(async () => provider.resolve(results[0].id), /unavailable/);
    for (const tool of [await resolveLink('area', learning.id), await resolveLink('area', folder.id, 'other'),
      await resolveLink('area', project.id), await resolveLink('project', 'Projects/Stale.md'),
      await resolveLink('project', project.id, 'other')]) {
      assert.ok(typeof tool !== 'string' && tool.isError);
      assert.doesNotMatch(JSON.stringify(tool), /\/plugins\/gtd\//);
    }
    sourceFailure = true;
    const failed = await resolveLink('area', folder.id);
    assert.ok(typeof failed !== 'string' && failed.isError);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /GTD areas source_unavailable/);
    assert.doesNotMatch(logs + JSON.stringify(failed), /synthetic-private-inventory-error/);
  } finally { await harness.lifecycle.dispose(); }
});
test('unconfigured, empty, partial and failing reads are distinguishable; diagnostics redact raw exceptions', async () => {
  const unconfigured = await setup();
  try { const cli = await unconfigured.harness.behavior.runCli(['projects', '--json']); assert.notEqual(cli.exitCode, 0); assert.match(cli.stdout!, /unconfigured/); } finally { await unconfigured.harness.lifecycle.dispose(); }
  let value = data(), fail = false;
  const host = await setup({ async readProjects() { if (fail) throw Object.assign(new Error('sentinel-secret-body token@example.test'), { code: 'sentinel-provider-code', cause: 'secret-cause' }); return value; }, async checkAccess() {} });
  try {
    value.projects = []; assert.equal(JSON.parse((await host.harness.behavior.runCli(['projects', '--json'])).stdout!).totalProjects, 0);
    value.complete = false; value.warnings = ['source_partial']; const partial = await host.harness.behavior.runCli(['projects', '--json']); assert.equal(partial.exitCode, 2); assert.equal(JSON.parse(partial.stdout!).totalProjects, null);
    fail = true; const result = await host.harness.behavior.callAgentTool('gtd_list_projects', {}); assert.ok(typeof result !== 'string'); assert.equal(result.isError, true);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /GTD list source_unavailable/); assert.match(logs, /GTD list partial/); assert.doesNotMatch(logs + JSON.stringify(result), /sentinel|example.test|secret-cause/);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('next action reads only the TODO section from a project landing note and safely reports read failures', async () => {
  const project = { source: 'one', id: 'Life/Projects/Active/Build a bench.md' };
  let text: string | null = 'Measure boards';
  let unavailable = false;
  const { bb, harness } = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one/Life' }, sdk: { plugins: {
    async callRpc(args: any) {
      if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Vault' }], incomplete: false };
      assert.equal(args.method, 'readSectionTask');
      assert.deepEqual(args.input, { vaultId: 'one', path: project.id, heading: 'TODO' });
      if (unavailable) throw new Error('synthetic-private-note-body');
      return { text };
    },
  } } });
  await plugin(bb);
  try {
    assert.deepEqual(await harness.behavior.callRpc('readNextAction', project), { text: 'Measure boards' });
    text = null;
    assert.deepEqual(await harness.behavior.callRpc('readNextAction', project), { text: null });
    for (const invalid of [{ ...project, source: 'different' }, { ...project, id: 'Life/Projects/Active/Build a bench/Support.md' }]) {
      await assert.rejects(() => harness.behavior.callRpc('readNextAction', invalid), /Could not read the next action/);
    }
    assert.equal(harness.inspection.sdk.callsTo('plugins.callRpc').length, 3);
    unavailable = true;
    await assert.rejects(() => harness.behavior.callRpc('readNextAction', project), /Could not read the next action/);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /GTD next_action_read source_unavailable/);
    assert.doesNotMatch(logs, /synthetic-private-note-body|Build a bench/);
  } finally { await harness.lifecycle.dispose(); }
});
test('project mentions rank name matches and resolve the exact available project', async () => {
  const snapshot = data();
  const project = { id: 'Projects/Done/Café % notes.md', title: 'Café notes', status: 'done' as const };
  snapshot.projects = [
    { id: 'Projects/Find café.md', title: 'Find café', status: 'active' },
    project,
    ...Array.from({ length: 12 }, (_, i) => ({ id: `Projects/Café ${i}.md`, title: `Visit café ${i}`, status: 'active' as const })),
  ];
  const { harness } = await setup({ async readProjects() { return snapshot; }, async checkAccess() {} });
  try {
    const [provider] = harness.inspection.registrations.mentionProviders;
    assert.equal(provider.label, 'GTD projects');
    assert.deepEqual(provider.triggers, ['@']);
    const search = (query: string) => provider.search({ trigger: '@', query, projectId: null, threadId: null });
    assert.deepEqual(await search('  '), []);
    assert.deepEqual(await search('unknown'), []);
    const results = await search(' CAFE\u0301 ');
    assert.equal(results.length, 10);
    const first = results[0];
    assert.equal(first.title, project.title);
    assert.equal(first.subtitle, project.id);
    const { context } = await provider.resolve(first.id);
    assert.deepEqual(JSON.parse(context.split('\n')[1]), { source: 'one', ...project });
    const wrongSource = recordDestination('projects', 'other', project.id).subPath;
    await assert.rejects(async () => provider.resolve(wrongSource), /unavailable/);
    snapshot.projects = snapshot.projects.filter(item => item !== project);
    await assert.rejects(async () => provider.resolve(first.id), /unavailable/);
    await assert.rejects(async () => provider.resolve(''), /Choose a GTD project/);
  } finally { await harness.lifecycle.dispose(); }
});
test('settings validation rejects traversal and survives reload; plugin imports public SDK only', async () => {
  let host = await setup();
  try {
    await assert.rejects(host.harness.behavior.setSettings({ projectsFolder: '../private' }));
    await host.harness.behavior.setSettings({ projectsFolder: 'Life/Projects', vaultId: 'one' });
    host = await host.harness.lifecycle.reload(plugin);
    const result = await host.harness.behavior.runCli(['projects', '--json']);
    assert.doesNotMatch(result.stdout!, /unconfigured/); assert.match(result.stdout!, /source_unavailable/);
  } finally { await host.harness.lifecycle.dispose(); }
  const scan = await experimental_scanPublicSdkOnly(new URL('../', import.meta.url).pathname, { allow: [/^react$/, /^@testing-library\/react$/, /^playwright$/, /^@get-bb\/plugin-sdk\/testing$/] });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});

test('reload leaves historical identity records intact and removes the rollout commands', async () => {
  let host = await setup();
  try {
    const db = host.bb.storage.database();
    db.exec(`CREATE TABLE identity_runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL, manifest TEXT NOT NULL);
      CREATE UNIQUE INDEX identity_active_scope ON identity_runs(scope) WHERE state != 'review';`);
    db.prepare('INSERT INTO identity_runs VALUES (?, ?, ?, ?)').run('prior-review', 'synthetic', 'review', '{"notes":{},"threads":{}}');
    const records = db.prepare('SELECT * FROM identity_runs').all();
    host = await host.harness.lifecycle.reload(plugin);
    assert.deepEqual(host.bb.storage.database().prepare('SELECT * FROM identity_runs').all(), records);
    const help = await host.harness.behavior.runCli(['--help']);
    assert.doesNotMatch(help.stdout!, /migration-(?:preview|apply|status)/);
  } finally { await host.harness.lifecycle.dispose(); }
});
