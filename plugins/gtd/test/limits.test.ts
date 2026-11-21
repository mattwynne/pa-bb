import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { ObsidianBackend } from '../adapters/obsidian.ts';
import { Projects } from '../core/projects.ts';
import type { ProjectBackend } from '../core/model.ts';

test('even a stalled producer yielding endless empty pages is bounded, partial and closed', async () => {
  let pages = 0, closed = false;
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'status') return { propertiesAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Example', source: { local: { available: true }, cloudConnected: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null } }] };
    if (args.method === 'closeProperties') { closed = true; return null; }
    pages++; return { notes: [], nextCursor: '12345678-1234-4123-8123-123456789abc', incomplete: false, warnings: [], observedAt: 'now' };
  } } } });
  try {
    const result = await new ObsidianBackend(host.bb.sdk, { vaultId: 'one', folder: 'Projects' }).readProjects(new AbortController().signal);
    assert.equal(pages, 128); assert.equal(closed, true); assert.equal(result.complete, false); assert.deepEqual(result.warnings, ['scan_limit']);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('invalid adapter models are refused at the core boundary, without publishing raw validation details', async () => {
  const backend: ProjectBackend = { readProjects: async () => ({ private: 'sentinel' }) as any, async checkAccess() {} };
  const service = new Projects(async () => ({ key: 'test', backend }));
  await assert.rejects(service.list({}, new AbortController().signal, 'reader'), error => error instanceof Error && error.message === 'GTD invalid source.');
});
