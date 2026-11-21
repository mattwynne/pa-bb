import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
import { Projects } from '../core/projects.ts';
const state = { propertiesAccessVersion: 1, childrenAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Synthetic', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
const directory = (name: string) => ({ name, kind: 'directory' });
const markdown = (name: string) => ({ name, kind: 'markdown' });
const notes = [{ path: 'Projects/Plan.md', properties: { title: 'Travel', status: 'deferred' } }, { path: 'Projects/Plan/Notes.md', properties: { title: 'Wrong', status: 'bad' } }, { path: 'Projects/Active/Ship/Transcript.md', properties: { status: 'done' } }];
test('directory contract includes empty and attachment-only projects, pairs notes, preserves grouping, and confirms paged/filter counts', async () => {
  const scopes: string[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'status') return state;
    if (args.method === 'listProperties') return { notes, nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
    assert.equal(args.method, 'listChildren'); scopes.push(args.input.folder);
    return { entries: args.input.folder === 'Projects' ? [directory('Empty'), directory('Attachments'), directory('Plan'), markdown('Plan.md'), directory('Active'), directory('Someday')] : args.input.folder.endsWith('Active') ? [directory('Ship')] : [directory('Learn')], incomplete: false };
  } } } });
  try {
    const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' });
    const inventory = new Projects(async () => ({ key: 'one', backend }));
    const first = await inventory.list({ limit: 2 }, new AbortController().signal, 'owner');
    assert.equal(first.coverage, 'complete'); assert.equal(first.totalProjects, 5); assert.deepEqual(first.counts, { active: 3, deferred: 1, someday: 1, done: 0 });
    const projects = [...first.projects]; let cursor = first.nextCursor;
    while (cursor) { const page = await inventory.list({ cursor }, new AbortController().signal, 'owner'); projects.push(...page.projects); cursor = page.nextCursor; }
    assert.deepEqual(projects.map(p => p.id).sort(), ['Projects/Active/Ship/', 'Projects/Attachments/', 'Projects/Empty/', 'Projects/Plan.md', 'Projects/Someday/Learn/']);
    assert.deepEqual(scopes, ['Projects', 'Projects/Active', 'Projects/Someday']);
    const deferred = await inventory.list({ status: 'deferred' }, new AbortController().signal, 'owner');
    assert.equal(deferred.matchedProjects, 1); assert.equal(deferred.projects[0].title, 'Travel');
  } finally { await host.harness.lifecycle.dispose(); }
});
test('failed, partial or omitted child metadata never establishes complete counts; Areas shares bounded directory enumeration', async () => {
  for (const mode of ['failure', 'partial', 'missing-metadata', 'areas']) {
    let reads = 0;
    const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'status') return state;
      if (args.method === 'listProperties') return { notes: [], nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
      reads++; if (mode === 'failure') throw new Error('private-sentinel');
      return { entries: mode === 'missing-metadata' ? [markdown('Omitted.md')] : [], incomplete: mode === 'partial' };
    } } } });
    try {
      const backend = new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' });
      if (mode === 'areas') { assert.equal((await backend.readAreas(new AbortController().signal)).complete, true); assert.equal(reads, 1); }
      else { const snapshot = await backend.readProjects(new AbortController().signal); assert.equal(snapshot.complete, false); assert.deepEqual(snapshot.warnings, ['source_partial']); assert.doesNotMatch(JSON.stringify(snapshot), /sentinel/); }
    } finally { await host.harness.lifecycle.dispose(); }
  }
});
