import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

test('unoffered legacy selections fail closed during unavailable discovery rather than silently selecting a different vault', async () => {
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one', projectsFolder: 'Life/Projects' }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') throw new Error('sentinel-private-catalog');
    assert.equal(args.input.root, 'Life');
    assert.fail('Vault discovery failure must not try inventory');
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
    if (args.method === 'vaultInventory') {
      if (!present) throw new Error('Unavailable authorized root');
      const source = { vaultId: 'one', name: 'Container', cloudConnected: true, enabled: true, phase: 'ready', lastSuccess: null, failure: null };
      if (args.input.folders?.length === 0) return { source, notes: [], folders: [], incomplete: false };
      folders.push(args.input.root);
      return { source, notes: [{ path: 'Life/Projects/Launch.md', properties: { status: 'active' }, malformed: false }],
        folders: ['Life','Life/Projects','Life/Areas'], incomplete: false };
    }
    throw new Error('Unexpected method');
  } } } });
  await plugin(host.bb);
  try {
    await assert.rejects(host.harness.behavior.setSettings({ vaultId: 'unoffered' }));
    await host.harness.behavior.setSettings({ vaultId: 'one/Life', projectsFolder: 'Projects' });
    const result = JSON.parse((await host.harness.behavior.runCli(['projects', '--json'])).stdout!);
    assert.equal(result.source.name, 'Life'); assert.equal(result.source.scope, 'Projects');
    assert.deepEqual(folders, ['Life']);
    assert.equal(result.projects[0].id, 'Life/Projects/Launch.md');
    present = false;
    const missing = await host.harness.behavior.runCli(['projects', '--json']);
    assert.notEqual(missing.exitCode, 0); assert.match(missing.stdout!, /source_unavailable/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('the watch uses the configured scopes and redacts failed probe details', async () => {
  const revision = '12345678-1234-4123-8123-123456789abc:10';
  let available = true;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: {
    vaultId: 'one/Life', projectsFolder: 'Work/Projects', areasFolder: 'Areas',
  }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Life' }], incomplete: false };
    assert.equal(args.method, 'inventoryRevision');
    assert.deepEqual(args.input, { vaultId: 'one', folders: ['Life/Work/Projects', 'Life/Areas'] });
    if (!available) throw new Error('sentinel-private-watch-path');
    return revision;
  } } } });
  await plugin(host.bb);
  try {
    assert.equal(await host.harness.behavior.callRpc('inventoryRevision', null), revision);
    available = false;
    await assert.rejects(host.harness.behavior.callRpc('inventoryRevision', null), error => {
      assert.doesNotMatch(String(error), /sentinel/);
      return true;
    });
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /GTD watch/);
    assert.doesNotMatch(logs, /sentinel|Life/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('correspondence reads scoped landing-note links and looks up saved Gmail URLs', async () => {
  const gmail = 'https://mail.google.com/mail/?authuser=person%40example.com#all/beef';
  const fastmail = 'https://app.fastmail.com/mail/example';
  const ref = { source: 'one', id: 'Life/Projects/Active/Launch.md' };
  let mailReads = 0;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: {
    vaultId: 'one/Life', projectsFolder: 'Projects', areasFolder: 'Areas',
  }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Life' }], incomplete: false };
    if (args.method === 'readSectionLinks') {
      assert.equal(args.pluginId, 'obsidian');
      assert.deepEqual(args.input, { vaultId: 'one', path: ref.id, heading: 'Correspondence' });
      return { hash: 'a'.repeat(64), links: [
        { title: 'Workshop', url: gmail }, { title: 'Duplicate', url: gmail }, { title: 'Venue', url: fastmail },
      ], incomplete: false };
    }
    assert.equal(args.pluginId, 'google-workspace');
    assert.equal(args.method, 'gmailConversationStatus');
    assert.deepEqual(args.input, { url: gmail });
    mailReads++;
    return { status: 'ok', unread: 2, sender: null, latestAt: null };
  } } } });
  await plugin(host.bb);
  try {
    const rpc = host.harness.behavior.callRpc;
    await assert.rejects(rpc('readCorrespondence', { ...ref, id: 'Life/Areas/Workshop.md' }));
    assert.deepEqual(await rpc('readCorrespondence', ref), { links: [
      { title: 'Workshop', url: gmail }, { title: 'Venue', url: fastmail },
    ], incomplete: false });
    assert.equal(mailReads, 0);
    assert.deepEqual(await rpc('readCorrespondenceStatus', ref), [
      { url: gmail, mail: { status: 'ok', unread: 2, sender: null, latestAt: null } },
      { url: fastmail, mail: { status: 'unsupported' } },
    ]);
    assert.equal(mailReads, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test('Area mail only reads the selected Area and status, including nested Area assignments', async () => {
  const note = (path: string, properties: Record<string, string> = {}) => ({ path, properties, malformed: false });
  const notes = [
    note('Areas/Learning.md'), note('Areas/Learning/Nested.md'), note('Areas/Home.md'),
    note('Projects/Active/Matches.md', { area: 'Areas/Learning/Nested.md' }),
    note('Projects/Active/Other.md', { area: 'Areas/Home.md' }),
    note('Projects/Done/Finished.md', { area: 'Areas/Learning.md' }),
    note('Projects/Active/Unassigned.md'),
  ];
  const paths: string[] = [];
  let incomplete = false;
  const host = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one', projectsFolder: 'Projects', areasFolder: 'Areas' },
    sdk: { plugins: { callRpc: async (args: any) => {
      if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Example' }], incomplete: false };
      if (args.method === 'vaultInventory') return {
        source: { vaultId: 'one', name: 'Example', lastSuccess: null, cloudConnected: false, enabled: false, phase: 'paused', failure: null },
        notes, folders: ['Projects', 'Areas'], incomplete,
      };
      assert.equal(args.method, 'readSectionLinks');
      paths.push(args.input.path);
      return { hash: 'a'.repeat(64), links: [], incomplete: false };
    } } } });
  await plugin(host.bb);
  try {
    const rpc = host.harness.behavior.callRpc;
    const area = { source: 'one', areaId: 'Areas/Learning.md', status: 'active' };
    const first = await Promise.all([rpc('readAreaMailStatus', area), rpc('readAreaMailStatus', area)]);
    for (const rows of first) assert.deepEqual(rows, [{ id: 'Projects/Active/Matches.md', state: 'clear' }]);
    assert.deepEqual(await rpc('readAreaMailStatus', { ...area, areaId: null }), [{ id: 'Projects/Active/Unassigned.md', state: 'clear' }]);
    await assert.rejects(rpc('readAreaMailStatus', { ...area, source: 'wrong' }));
    incomplete = true;
    assert.deepEqual(await rpc('readAreaMailStatus', area), []);
    assert.deepEqual(paths, ['Projects/Active/Matches.md', 'Projects/Active/Unassigned.md']);
  } finally { await host.harness.lifecycle.dispose(); }
});
