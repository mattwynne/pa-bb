import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
import { Projects } from '../core/projects.ts';
import type { ProjectBackend } from '../core/model.ts';

test('a Desktop response above the GTD row bound yields only confirmed partial rows', async () => {
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    assert.equal(args.method, 'vaultInventory');
    return {
      source: { vaultId: 'one', name: 'Example', cloudConnected: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null },
      folders: ['Projects'], incomplete: false,
      notes: Array.from({ length: 5010 }, (_, i) => ({ path: 'Projects/Project ' + i + '.md', properties: {}, malformed: false })) };
  } } } });
  try {
    const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' }).readProjects(new AbortController().signal);
    assert.equal(result.projects.length, 5000);
    assert.equal(result.complete, false);
    assert.deepEqual(result.warnings, ['scan_limit']);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('invalid adapter models are refused at the core boundary, without publishing raw validation details', async () => {
  const backend: ProjectBackend = { readProjects: async () => ({ private: 'sentinel' }) as any, async checkAccess() {} };
  const service = new Projects(async () => ({ key: 'test', backend }));
  await assert.rejects(service.list({}, new AbortController().signal, 'reader'), error => error instanceof Error && error.message === 'GTD invalid source.');
});
