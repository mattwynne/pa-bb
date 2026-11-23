import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { threadActions } from '../core/threads.ts';
const ref = { source: 'one', id: 'Projects/Woodworking.md' };
const snapshot = { source: { backend: 'fake', id: 'one', name: 'Synthetic', scope: 'Projects', observedAt: 'now', lastSuccessfulSync: null, sync: null }, projects: [{ id: ref.id, title: 'Learn woodworking', status: 'active' as const }], complete: true, warnings: [] };
const selectAreas = async () => ({ key: 'one', backend: { checkAccess: async () => {}, readAreas: async () => ({ source: snapshot.source, areas: [], complete: true, warnings: [] }) } });
test('pre-spawn source and destination failures are diagnosed and redacted, with no thread mutation', async () => {
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { projects: { list: async () => { throw new Error('sentinel-destination-private'); } } } });
  try {
    let broken = true;
    const actions = threadActions(host.bb, async () => ({ key: 'one', backend: { checkAccess: async () => {}, readProjects: async () => { if (broken) throw new Error('sentinel-source-private'); return snapshot; } } }), selectAreas);
    for (const state of [true, false]) { broken = state; await assert.rejects(actions.newThread({ ...ref, requestId: randomUUID() }, new AbortController().signal), error => error instanceof Error && /not confirmed/.test(error.message) && !/sentinel/.test(error.message)); }
    assert.equal(host.harness.inspection.sdk.callsTo('threads.spawn').length, 0);
    const logs = JSON.stringify(host.harness.inspection.logEntries); assert.match(logs, /GTD thread_create unconfirmed/); assert.doesNotMatch(logs, /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('concurrent repeated creation requests claim one durable spawn only', async () => {
  let entered!: () => void, release!: () => void;
  const inSpawn = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { projects: { list: async () => [{ id: 'personal', kind: 'personal' }] as any }, threads: { spawn: async () => { entered(); await gate; return { id: 'created' } as any; } } } });
  try {
    const actions = threadActions(host.bb, async () => ({ key: 'one', backend: { checkAccess: async () => {}, readProjects: async () => snapshot } }), selectAreas);
    const input = { ...ref, requestId: randomUUID() }, signal = new AbortController().signal;
    const first = actions.newThread(input, signal); await inSpawn;
    await assert.rejects(actions.newThread(input, signal)); release();
    assert.deepEqual(await first, { threadId: 'created' }); assert.deepEqual(await actions.newThread(input, signal), { threadId: 'created' });
    assert.equal(host.harness.inspection.sdk.callsTo('threads.spawn').length, 1);
  } finally { release(); await host.harness.lifecycle.dispose(); }
});
