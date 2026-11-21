import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

test('unoffered legacy selections fail closed during unavailable discovery rather than silently selecting a different vault', async () => {
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one', projectsFolder: 'Life/Projects' }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') throw new Error('sentinel-private-catalog');
    if (args.method === 'status') return { propertiesAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Container', source: { local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null } }] };
    assert.equal(args.input.folder, 'Life/Projects');
    return { notes: [], nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' };
  } } } });
  await plugin(host.bb);
  try {
    const result = JSON.parse((await host.harness.behavior.runCli(['projects', '--json'])).stdout!);
    assert.equal(result.error.code, 'unconfigured'); assert.equal(result.source, undefined);
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /sentinel/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('vault selector offers discovered roots, scopes folders relative to the vault, and preserves source references', async () => {
  let present = true; const folders: string[] = [];
  const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: present ? [{ id: 'one', root: 'Life', name: 'Life' }] : [], incomplete: false };
    if (args.method === 'status') return { propertiesAccessVersion: 1, vaults: [{ vaultId: 'one', name: 'Container', source: { local: { available: true }, cloudConnected: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null } }] };
    if (args.method === 'listProperties') { folders.push(args.input.folder); return { notes: [{ path: 'Life/Projects/Launch.md', properties: { status: 'active' } }], nextCursor: null, incomplete: false, warnings: [], observedAt: 'now' }; }
    throw new Error('Unexpected method');
  } } } });
  await plugin(host.bb);
  try {
    await assert.rejects(host.harness.behavior.setSettings({ vaultId: 'unoffered' }));
    await host.harness.behavior.setSettings({ vaultId: 'one/Life', projectsFolder: 'Projects' });
    const result = JSON.parse((await host.harness.behavior.runCli(['projects', '--json'])).stdout!);
    assert.equal(result.source.name, 'Life'); assert.equal(result.source.scope, 'Projects');
    assert.deepEqual(folders, ['Life/Projects']);
    assert.equal(result.projects[0].id, 'Life/Projects/Launch.md');
    present = false;
    const missing = await host.harness.behavior.runCli(['projects', '--json']);
    assert.notEqual(missing.exitCode, 0); assert.match(missing.stdout!, /source_unavailable/);
  } finally { await host.harness.lifecycle.dispose(); }
});
