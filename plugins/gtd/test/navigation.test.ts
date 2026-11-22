import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import type { ProjectSnapshot } from '../core/model.ts';
const ref = { source: 'one', id: 'Projects/Woodworking.md' };
const snapshot = (): ProjectSnapshot => ({ source: { backend: 'fake', id: 'one', name: 'Synthetic', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null }, projects: [{ id: ref.id, title: 'Learn woodworking', status: 'active', areaId: 'Areas/Learning.md' }, { id: 'Projects/Workbench.md', title: 'Build workbench', status: 'deferred' }], complete: true, warnings: [] });
async function setup(initial = snapshot()) {
  let data = initial, areaTitle = 'Learning'; const metadata: Record<string, any> = { t1: { unrelated: 'keep' }, t2: { project: ref } }; let spawns = 0; let fail = false;
  const host = createFakePluginHost({ pluginId: 'gtd', agentSkillIds: ['gtd-projects'], sdk: {
    plugins: { callRpc: async () => ({ vaults: [], incomplete: false }) },
    projects: { list: async () => [{ id: 'personal', kind: 'personal' }] as any },
    threads: {
      updatePluginMetadata: async (input: any) => { metadata[input.threadId] ??= {}; Object.assign(metadata[input.threadId], input.set); for (const key of input.remove ?? []) delete metadata[input.threadId][key]; return metadata[input.threadId]; },
      spawn: async (input: any) => { spawns++; if (fail) throw new Error('sentinel-private'); metadata.created = input.pluginMetadata; return makeThreadResponse({ id: 'created' }); },
    },
  } });
  const dependencies = {
    select: async () => ({ key: 'source', backend: { checkAccess: async () => {}, readProjects: async () => data, rename: async (id: string, title: string) => { data.projects.find(p => (p.notePath ?? p.id) === id)!.title = title; return { operationId: randomUUID(), outcome: 'saved_locally_pending_sync' as const }; } } }),
    selectAreas: async () => ({ key: 'areas', backend: { checkAccess: async () => {}, readAreas: async () => ({ source: data.source, areas: [{ id: 'Areas/Learning.md', title: areaTitle }], complete: true, warnings: [] }), rename: async (_id: string, title: string) => { areaTitle = title; return { operationId: randomUUID(), outcome: 'saved_locally_pending_sync' as const }; } } }),
  };
  await plugin(host.bb, dependencies);
  return { ...host, dependencies, metadata, spawns: () => spawns, fail: () => { fail = true; }, remove: () => { data.projects = []; } };
}
test('renames preserve IDs, area relationships, both linked threads and unrelated thread metadata; association touches no environment', async () => {
  const f = await setup(); let active = f.harness;
  try {
    await f.harness.behavior.callRpc('associate', { threadId: 't1', project: ref });
    for (const [tool, input] of [['gtd_rename_project', { ...ref, title: 'Woodwork' }], ['gtd_rename_area', { source: 'one', id: 'Areas/Learning.md', title: 'Skills' }]] as const) {
      const result = await f.harness.behavior.callAgentTool(tool, input); assert.equal((result as any).isError, undefined);
    }
    assert.deepEqual(f.metadata.t1, { unrelated: 'keep', project: ref }); assert.deepEqual(f.metadata.t2.project, ref);
    const projects = await f.harness.behavior.callRpc('listProjects', {}) as any; assert.equal(projects.projects[0].id, ref.id); assert.equal(projects.projects[0].areaId, 'Areas/Learning.md');
    await assert.rejects(f.harness.behavior.callRpc('associate', { threadId: 't1', project: { ...ref, source: 'other' } }));
    await f.harness.behavior.callRpc('associate', { threadId: 't1', project: { source: 'one', id: 'Projects/Workbench.md' } });
    assert.deepEqual(f.metadata.t1, { unrelated: 'keep', project: { source: 'one', id: 'Projects/Workbench.md' } });
    const reloaded = await f.harness.lifecycle.reload(bb => plugin(bb, f.dependencies)); active = reloaded.harness;
    assert.deepEqual(f.metadata.t1.project, { source: 'one', id: 'Projects/Workbench.md' });
    await reloaded.harness.behavior.callRpc('associate', { threadId: 't1', project: null }); assert.deepEqual(f.metadata.t1, { unrelated: 'keep' });
    const paths = f.harness.inspection.sdk.calls.map(c => c.path); assert.ok(!paths.includes('threads.update')); assert.ok(!paths.some(p => p.startsWith('environments.')));

  } finally { await active.lifecycle.dispose(); }
});
test('new thread has bounded untrusted context and stable reference, exactly once across duplicate calls and reload; absent projects cannot spawn', async () => {
  const f = await setup(); let active = f.harness;
  try {
    const input = { ...ref, requestId: randomUUID() };
    const first = await f.harness.behavior.callRpc('newThread', input); assert.deepEqual(first, { threadId: 'created' });
    await f.harness.behavior.callRpc('newThread', input); assert.equal(f.spawns(), 1);
    const call = f.harness.inspection.sdk.callsTo('threads.spawn')[0][0] as any;
    assert.equal(call.projectId, 'personal'); assert.deepEqual(call.pluginMetadata.project, ref); assert.ok(call.prompt.length < 4000); assert.match(call.prompt, /No task or account mutation/); assert.match(call.prompt, /obsidian_read_note/);
    const reloaded = await f.harness.lifecycle.reload(bb => plugin(bb, f.dependencies)); active = reloaded.harness;
    await reloaded.harness.behavior.callRpc('newThread', input); assert.equal(f.spawns(), 1);
    f.remove(); await assert.rejects(reloaded.harness.behavior.callRpc('newThread', { ...ref, requestId: randomUUID() }));
  } finally { await active.lifecycle.dispose(); }
});
test('uncertain creation is not retried, even after reload; diagnostics are bounded', async () => {
  const f = await setup(); f.fail();
  try {
    const input = { ...ref, requestId: randomUUID() };
    await assert.rejects(f.harness.behavior.callRpc('newThread', input)); await assert.rejects(f.harness.behavior.callRpc('newThread', input)); assert.equal(f.spawns(), 1);
    const logs = JSON.stringify(f.harness.inspection.logEntries); assert.match(logs, /GTD thread_create unconfirmed/); assert.doesNotMatch(logs, /sentinel/);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('rename routes a folder ID to its README and retains the folder ID', async () => {
  const initial = snapshot();
  const id = 'Projects/Pilot/', notePath = 'Projects/Pilot/README.md';
  initial.projects = [{ id, notePath, title: 'Pilot', status: 'active' }];
  const f = await setup(initial);
  try {
    await f.harness.behavior.callRpc('renameProject', { source: 'one', id, title: 'New title' });
    assert.deepEqual(initial.projects, [{ id, notePath, title: 'New title', status: 'active' }]);
  } finally { await f.harness.lifecycle.dispose(); }
});
