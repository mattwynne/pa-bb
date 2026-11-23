import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import type { ProjectBackend, ProjectSnapshot } from '../core/model.ts';
const data = (): ProjectSnapshot => ({ source: { backend: 'fake', id: 'one', name: 'Synthetic source', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null }, projects: [{ id: 'one', title: 'Test project', status: 'active' }], complete: true, warnings: [] });
async function setup(backend?: ProjectBackend) {
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'], sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Test vault' }], incomplete: false };
    throw new Error('source unavailable');
  } } } });
  await plugin(host.bb, backend ? { select: async () => ({ key: 'test', backend }) } : undefined); return host;
}
test('host registers the GTD tools and CLI help, validation, listing and RPC share the same contract', async () => {
  const { harness } = await setup({ async readProjects() { return data(); }, async checkAccess() {} });
  try {
    const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext()); assert.deepEqual(config.tools.map(t => t.name), ['gtd_browse_area_targets', 'gtd_prepare_project_change', 'gtd_check_project_change', 'gtd_defer_project', 'gtd_list_projects', 'gtd_list_areas', 'gtd_create_project_thread', 'gtd_rename_project', 'gtd_rename_area']); assert.match(config.instructions!, /untrusted evidence/);
    const help = await harness.behavior.runCli(['projects', '--help']); assert.equal(help.exitCode, 0); assert.match(help.stdout!, /--status/);
    for (const args of [['projects', '--status', 'bogus', '--json'], ['projects', '--limit', '201', '--json'], ['projects', '--limti', '1', '--json']]) assert.notEqual((await harness.behavior.runCli(args)).exitCode, 0);
    const cli = await harness.behavior.runCli(['projects', '--json']); assert.equal(cli.exitCode, 0); assert.equal(JSON.parse(cli.stdout!).totalProjects, 1);
    const text = await harness.behavior.runCli(['projects']); assert.match(text.stdout!, /Active \(1\)/); assert.match(text.stdout!, /Test project/);
    const tool = await harness.behavior.callAgentTool('gtd_list_projects', {}); assert.ok(typeof tool !== 'string'); assert.equal(tool.isError, undefined); assert.equal(JSON.parse((tool.content[0] as any).text).totalProjects, 1);
    const rpc = await harness.behavior.callRpc('listProjects', {}) as any; assert.equal(rpc.totalProjects, 1);
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
  // This disposable contract fixture intentionally exercises both real plugin
  // factories. No exception for production imports or any other test module.
  assert.deepEqual(scan.violations.filter(v => !(v.file === 'test/project-changes.test.ts' && v.reason === 'outside-package' && ['../../obsidian/server.ts', '../../obsidian/test/fakes.ts'].includes(v.specifier))), []);
  assert.deepEqual(scan.privateDependencies, []);
});
