import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { experimental_PluginRpcCallError, type BbPluginApi } from '@get-bb/plugin-sdk';
import { plugin } from '../server.ts';
import { LocalNotes } from '../adapters/local-notes.ts';
import { hash } from './fakes.ts';
import { plugin as gtdPlugin } from '../../gtd/server.ts';
import { ObsidianBackend } from '../../gtd/adapters/obsidian.ts';

async function fixture(t: TestContext, initialMode = 'ready', prepare?: (root: string) => Promise<void>, indexLookup?: (signal: AbortSignal) => Promise<void>, grantVersion: 1 | null = 1) {
  const owner = await mkdtemp(join(tmpdir(), 'sentinel-private-mirror-'));
  const directory = join(owner, 'vault');
  await mkdir(directory);
  await prepare?.(directory);
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  const { bb, harness } = host;
  const state = {
    noteAccessVersion: 2, mirrorAccessVersion: 3, available: true, connected: false, challenge: null,
    mirrors: [{ id: 'one', folder: { name: 'Selected vault' }, initialized: true, enabled: false, phase: 'paused',
      lastSuccess: '2026-01-01T00:00:00Z', failure: null, filesystem: initialMode,
      local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } }],
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  const controls: { fallbackDirectory?: string; onLookup?: () => Promise<void>; deny?: boolean; denyGrant?: boolean; malformedGrant?: boolean; capabilityError?: unknown; capabilityReply?: unknown; afterAreaConfigure?: () => void; failFinish?: boolean } = {};
  const legacyReceipts = [{
    kind: 'save', path: 'Old.md', mirrorId: 'one', operationId: randomUUID(), at: '2026-01-01T00:00:00Z',
    hash: hash('saved previously'), previousHash: null, outcome: 'saved_locally_pending_sync',
  }];
  const sdk = { ...bb.sdk, plugins: {
    async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
    async callRpc({ method, input, outputSchema, signal }: { method: string; input: any; outputSchema: { parse(value: unknown): unknown }; signal?: AbortSignal }) {
      calls.push({ method, input });
      switch (method) {
        case 'status': return outputSchema.parse({ ...state, localFolder: directory });
        case 'noteConfigure':
          if (signal) controls.afterAreaConfigure?.();
          return outputSchema.parse({ ok: true, value: { revision: input.revision } });
        case 'mirrorDirectoryCapabilities':
          assert.equal(input, null);
          if (controls.capabilityError) throw controls.capabilityError;
          if (controls.capabilityReply !== undefined) return outputSchema.parse(controls.capabilityReply);
          if (grantVersion === null) throw new experimental_PluginRpcCallError({ code: 'unknown_method', message: 'Synthetic older producer' });
          return outputSchema.parse({ mirrorDirectoryGrantVersion: grantVersion });
        case 'mirrorDirectory':
          assert.deepEqual(input, { mirrorId: 'one', revision: 7 });
          if (controls.deny) throw new Error(`sentinel-private-failure ${directory}`);
          if (!signal) await controls.onLookup?.();
          return outputSchema.parse({ directory: controls.fallbackDirectory ?? directory });
        case 'mirrorDirectoryGrant': {
          assert.deepEqual(input, { mirrorId: 'one', revision: 7 });
          if (controls.deny || controls.denyGrant) throw new Error(`sentinel-private-grant ${directory}`);
          const info = await stat(directory, { bigint: true });
          if (signal) await indexLookup?.(signal);
          return outputSchema.parse({ directory, rootDev: controls.malformedGrant ? '01' : info.dev.toString(), rootIno: info.ino.toString() });
        }
        case 'noteReceipts': return outputSchema.parse({
          ok: true, value: legacyReceipts.filter(row => (!input.path || row.path === input.path) && (!input.operationId || row.operationId === input.operationId)),
        });
        case 'noteRead': return outputSchema.parse({ ok: true, value: { text: 'legacy', hash: hash('legacy'), complete: true, readAt: new Date().toISOString() } });
        default: throw new Error(`Unexpected iCloud RPC: ${method}`);
      }
    },
  } } as unknown as BbPluginApi['sdk'];
  const hostStorage = bb.storage;
  const storage = {
    ...hostStorage, kv: {
      ...hostStorage.kv,
      async set(key: string, value: unknown) {
        if (controls.failFinish && key === 'filesystem-note-receipts' && Array.isArray(value) &&
          value.some(row => row.outcome === 'saved_locally_pending_sync')) {
          throw new Error(`sentinel-private-receipt ${directory}`);
        }
        await hostStorage.kv.set(key, value);
      },
    },
  };
  await storage.kv.set('connected-vaults', { revision: 7, vaultIds: ['one'], pending: [] });
  const start = () => plugin({ ...bb, sdk, storage });
  await start();
  t.after(async () => { await harness.lifecycle.dispose(); await rm(owner, { recursive: true, force: true }); });
  const tool = async (name: string, input: unknown, expectedError?: string) => {
    const r = await harness.behavior.callAgentTool(`obsidian_${name}`, input, { threadId: 'reader' });
    assert.ok(typeof r !== 'string');
    const result = JSON.parse((r.content[0] as { text: string }).text);
    if (expectedError) {
      assert.equal(r.isError, true);
      assert.equal(result.category, expectedError);
      assert.doesNotMatch(JSON.stringify(result), /sentinel-private/);
    } else assert.equal(r.isError, undefined, JSON.stringify(result));
    return result;
  };
  return { ...host, tool, calls, controls, state, owner, directory, legacyReceipts };
}
const target = { vaultId: 'one', path: 'Notes/Agenda: July.md' };

test('public GTD lists use only owner evidence on a warm nested-root index and fail closed on rollback', async t => {
  const f = await fixture(t, 'ready', async root => {
    for (const path of ['Life/.obsidian', 'Life/Projects/Pilot', 'Life/Projects/Empty', 'Life/Projects/Attachments', 'Life/Projects/Pair', 'Life/Projects/Done', 'Life/Areas/Empty', 'Other']) await mkdir(join(root, path), { recursive: true });
    for (const [path, text] of Object.entries({
      'Life/Projects/Plan.md': '---\narea: ' + JSON.stringify(Array.from({ length: 8 }, () => '[[Areas/Finance|' + 'x'.repeat(980) + ']]')) + '\n---\n',
      'Life/Projects/Pilot/README.md': '---\ntitle: Pilot title\narea: Areas/Empty\n---\n',
      'Life/Projects/Pilot/Notes.md': '---\ntitle: PRIVATE_SENTINEL\narea: Other/Wrong\n---',
      'Life/Projects/Pair.md': '---\narea: Areas/Finance\n---',
      'Life/Projects/Pair/README.md': '---\ntitle: Wrong\n---',
      'Life/Projects/Done/Finished.md': '---\nstatus: active\n---',
      'Life/Projects/Attachments/image.bin': 'attachment',
      'Life/Areas/Finance.md': '# Budget\nTarget section', 'Other/Finance.md': 'foreign collision',
    })) await writeFile(join(root, path), text);
  });
  await f.harness.behavior.callRpc('inventoryChildren', { vaultId: 'one', root: 'Life', folder: 'Life/Projects' }, gtdCaller);
  const forbidden = ['read', 'list', 'children', 'indexDirectory', 'searchReader'] as const;
  const spies = forbidden.map(method => t.mock.method(LocalNotes.prototype, method, () => { throw new Error('PRIVATE_SENTINEL unexpected live I/O'); }));
  const requests: Array<{ method: string; input: any }> = []; let rollback = false;
  const gtd = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one/Life' }, sdk: { plugins: { callRpc: async (args: any) => {
    requests.push({ method: args.method, input: args.input });
    // Nested-root discovery is setup work, not an inventory data operation.
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Life' }], incomplete: false };
    if (rollback && args.method === 'inventoryProperties') throw new Error('PRIVATE_SENTINEL rolled back');
    return f.harness.behavior.callRpc(args.method, args.input, gtdCaller);
  } } } });
  t.after(() => gtd.harness.lifecycle.dispose());
  // The two packages pin independent SDK/Hono installs; the fake host implements
  // the same runtime API, while Hono's private request symbols are nominal.
  await gtdPlugin(gtd.bb as unknown as Parameters<typeof gtdPlugin>[0]);
  const page: any = await gtd.harness.behavior.callRpc('listProjects', {});
  assert.equal(page.coverage, 'complete');
  const rows = page.projects;
  assert.equal(rows.length, 6);
  assert.equal(rows.find((p: any) => p.id.endsWith('/Plan.md')).areaId, 'Life/Areas/Finance.md');
  assert.equal(rows.find((p: any) => p.id.endsWith('/Pilot/')).areaId, 'Life/Areas/Empty/');
  assert.equal(rows.find((p: any) => p.id.endsWith('/Pilot/')).notePath, 'Life/Projects/Pilot/README.md');
  assert.equal(rows.find((p: any) => p.id.endsWith('/Finished.md')).status, 'done');
  assert.ok(rows.some((p: any) => p.id.endsWith('/Attachments/')));
  assert.ok(requests.filter(r => r.method === 'inventoryProperties').every(r => !r.input.path.endsWith('/Notes.md') && r.input.path !== 'Life/Projects/Pair/README.md'));
  assert.ok(!requests.some(r => ['listProperties', 'projectAreasFromFrontmatter'].includes(r.method)));
  const areas: any = await gtd.harness.behavior.callRpc('listAreas', {});
  assert.equal(areas.coverage, 'complete'); assert.equal(areas.areas.length, 2);
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  rollback = true;
  await assert.rejects(gtd.harness.behavior.callRpc('listProjects', {}));
  assert.doesNotMatch(JSON.stringify(gtd.harness.inspection.logEntries), /PRIVATE_SENTINEL/);
});

test('declaration trace and candidate-policy parity across both adapter boundaries', async t => {
  for (const grant of [1, null] as const) await t.test(String(grant), async t => {
    const declarations: Record<string, unknown> = {
      Bare: 'Finance', Missing: 'Areas/Missing', Empty: 'Areas/Empty', Alias: '[[Areas/Finance|X]]', Fragment: '[[Life/Areas/Finance#Budget]]',
      Relative: '../Areas/Finance', Nested: 'Areas/Work/Nested', Pair: 'Areas/Pair/', Foreign: 'Shared',
      Duplicate: ['Areas/Finance', '[[Areas/Finance|Again]]'], Disagree: ['Areas/Empty', 'Areas/Finance'], Embed: '![[Areas/Finance]]',
    };
    const f = await fixture(t, 'ready', async root => {
      for (const path of ['Life/Projects', 'Life/Other', 'Life/Areas/Empty', 'Life/Areas/Work/Nested', 'Life/Areas/Pair', 'Life/Areas/Shared', 'Other']) await mkdir(join(root, path), { recursive: true });
      for (const path of ['Life/Areas/Finance.md', 'Life/Other/Finance.md', 'Other/Finance.md', 'Life/Other/Shared.md', 'Life/Areas/Pair.md']) await writeFile(join(root, path), '# Budget\nTarget');
      for (const [name, area] of Object.entries(declarations)) await writeFile(join(root, `Life/Projects/${name}.md`), '---\narea: ' + JSON.stringify(area) + '\n---');
    }, undefined, grant);
    const snapshots = [];
    for (const modern of [false, true]) {
      const host = createFakePluginHost({ pluginId: 'gtd', sdk: { plugins: { callRpc: async (args: any) => {
        if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Synthetic' }], incomplete: false };
        const value: any = await f.harness.behavior.callRpc(args.method, args.input, gtdCaller);
        if (args.method === 'status' && !modern) delete value.inventoryEvidenceVersion;
        return value;
      } } } });
      try {
        const snapshot = await new ObsidianBackend(host.bb.sdk as unknown as ConstructorParameters<typeof ObsidianBackend>[0], { vaultId: 'one', root: 'Life', folder: 'Projects', areasFolder: 'Areas' }).readProjects(new AbortController().signal);
        assert.equal(snapshot.complete, true);
        const assignments = Object.fromEntries(snapshot.projects.map(p => [p.id.split('/').at(-1)!.replace('.md', ''), p.areaId]));
        assert.deepEqual(assignments, { Bare: undefined, Missing: undefined, Empty: 'Life/Areas/Empty/', Alias: 'Life/Areas/Finance.md', Fragment: undefined, Relative: 'Life/Areas/Finance.md', Nested: 'Life/Areas/Work/Nested/', Pair: 'Life/Areas/Pair.md', Foreign: undefined, Duplicate: 'Life/Areas/Finance.md', Disagree: undefined, Embed: undefined });
        snapshots.push(snapshot.projects.sort((a, b) => a.id.localeCompare(b.id)));
      } finally { await host.harness.lifecycle.dispose(); }
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
    const followed = await f.tool('resolve_link', { vaultId: 'one', path: 'Life/Projects/Alias.md', link: '[[Life/Areas/Finance#Budget]]' });
    assert.match(followed.text, /Target/); assert.equal(followed.editReady, false);
  });
});

test('indexed target uniqueness is compromised only by intersecting omitted trees', async t => {
  for (const omitted of ['Life/Hidden', 'Life', 'Other/Hidden']) await t.test(omitted, async t => {
    const f = await fixture(t, 'ready', async root => {
      await mkdir(join(root, 'Life/Projects'), { recursive: true });
      await mkdir(join(root, 'Life/Areas')); await mkdir(join(root, 'Other'));
      await writeFile(join(root, 'Life/Projects/Plan.md'), '---\narea: Areas/Target\n---');
      await writeFile(join(root, 'Life/Areas/Target.md'), 'target');
      // A symlink at Life itself omits the selected root rather than traversing it.
      if (omitted === 'Life') { await rename(join(root, 'Life'), join(root, 'Saved')); await symlink('Saved', join(root, 'Life')); }
      else await symlink('.', join(root, omitted));
    });
    const result: any = await f.harness.behavior.callRpc('inventoryTarget', { vaultId: 'one', root: 'Life', path: 'Life/Projects/Plan.md', reference: 'Areas/Target' }, gtdCaller);
    assert.equal(result.incomplete, omitted !== 'Other/Hidden');
  });
});

test('51-owner sparse/dense inventories match the previous consumer on indexed and direct routes', async t => {
  for (const grant of [1, null] as const) for (const dense of [false, true]) await t.test(`${grant ? 'indexed' : 'direct'} ${dense ? 'dense' : 'sparse'}`, async t => {
    const f = await fixture(t, 'ready', async root => {
      await mkdir(join(root, 'Projects')); await mkdir(join(root, 'Areas'));
      await writeFile(join(root, 'Areas/Target.md'), 'target');
      for (let i = 0; i < 51; i++) await writeFile(join(root, `Projects/P${i}.md`), dense || i === 0 ? '---\narea: Areas/Target\n---' : 'plain');
    }, undefined, grant);
    const snapshots: any[] = [];
    for (const modern of [false, true]) {
      const counts = new Map<string, number>();
      const gtd = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one' }, sdk: { plugins: { callRpc: async (args: any) => {
        counts.set(args.method, (counts.get(args.method) ?? 0) + 1);
        if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: '', name: 'Synthetic' }], incomplete: false };
        const result: any = await f.harness.behavior.callRpc(args.method, args.input, gtdCaller);
        if (args.method === 'status' && !modern) delete result.inventoryEvidenceVersion;
        return result;
      } } } });
      try {
        await gtdPlugin(gtd.bb as unknown as Parameters<typeof gtdPlugin>[0]);
        const start = performance.now();
        const page: any = await gtd.harness.behavior.callRpc('listProjects', {});
        snapshots.push(page.projects); assert.equal(page.coverage, 'complete');
        if (modern) {
          assert.equal(counts.get('inventoryProperties'), 51);
          assert.equal(counts.get('inventoryTarget'), dense ? 51 : 1);
          assert.equal(counts.has('listProperties'), false);
        }
        t.diagnostic(JSON.stringify({ modern, calls: Object.fromEntries(counts), elapsedMs: Math.round(performance.now() - start) }));
      } finally { await gtd.harness.lifecycle.dispose(); }
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  });
});

test('new evidence has indexed/direct parity and revalidates authority before release', async t => {
  for (const grant of [1, null] as const) await t.test(String(grant), async t => {
    const f = await fixture(t, 'ready', async root => {
      await mkdir(join(root, 'Projects')); await mkdir(join(root, 'Areas/Empty'), { recursive: true });
      await writeFile(join(root, 'Projects/Plan.md'), '---\ntitle: Plan\narea: Areas/Empty\n---');
    }, undefined, grant);
    const call = (method: string, input: object) => f.harness.behavior.callRpc(method, { vaultId: 'one', root: '', ...input }, gtdCaller) as Promise<any>;
    const first = await call('inventoryChildren', { folder: 'Projects' });
    assert.equal(first.authority.route, grant ? 'index' : 'direct');
    const continuity = { expectedAuthority: first.authority, ...(first.publication ? { publication: first.publication } : {}) };
    const props = await call('inventoryProperties', { path: 'Projects/Plan.md', fields: ['title', 'area'], ...continuity });
    assert.deepEqual(props.properties, { title: 'Plan', area: 'Areas/Empty' });
    assert.equal(props.status, 'observed');
    assert.equal((await call('inventoryProperties', { path: 'Projects/Missing.md', fields: ['area'], ...continuity })).status, 'missing');
    const target = await call('inventoryTarget', { path: 'Projects/Plan.md', reference: 'Areas/Empty', ...continuity });
    assert.deepEqual(target.matches, [{ path: 'Areas/Empty', kind: 'directory' }]); assert.equal(target.incomplete, false);
    await assert.rejects(call('inventoryTarget', { path: 'Projects/Plan.md', reference: 'Areas/Empty', expectedAuthority: { ...first.authority, epoch: randomUUID() } }));
    await assert.rejects(f.harness.behavior.callRpc('inventoryProperties', { vaultId: 'one', root: '', path: 'Projects/Plan.md', fields: ['area'] }));
    f.controls.afterAreaConfigure = () => { f.state.mirrors[0].local.available = false; };
    await assert.rejects(call('inventoryProperties', { path: 'Projects/Plan.md', fields: ['area'], ...continuity }));
    assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
  });
});

test('keeps selections and finds current disk notes while cloud sync is paused and disconnected', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'Notes', '.obsidian'), { recursive: true });
  const path = join(f.directory, target.path);
  await writeFile(path, '# Disk arrival\r\n');
  const read = await f.tool('read_note', target);
  assert.equal(read.text, '# Disk arrival\r\n');
  assert.equal(read.editReady, true);
  const children = await f.harness.behavior.callRpc('listChildren', { vaultId: 'one', folder: 'Notes' });
  assert.deepEqual(children, { entries: [{ name: '.obsidian', kind: 'directory' }, { name: 'Agenda: July.md', kind: 'markdown' }], incomplete: false });
  const locations = await f.harness.behavior.callRpc('vaultLocations', null);
  assert.deepEqual(locations, { vaults: [{ id: 'one', name: 'Notes', root: 'Notes' }], incomplete: false });
  await writeFile(path, '# External edit\r\n');
  await f.tool('edit_note', { ...target, expectedHash: read.hash, append: 'Stale' }, 'conflict');
  assert.equal(await readFile(path, 'utf8'), '# External edit\r\n');
  const reread = await f.tool('read_note', target);
  const edit = await f.tool('edit_note', { ...target, expectedHash: reread.hash, append: 'Decision\r\n' });
  assert.equal(edit.receipt.outcome, 'saved_locally_pending_sync');
  assert.equal(await readFile(path, 'utf8'), '# External edit\r\nDecision\r\n');
  assert.deepEqual(await readdir(join(f.directory, 'Notes')), ['.obsidian', 'Agenda: July.md']);
  const status = await f.tool('status', { vaultId: 'one' });
  assert.equal(status.vaults[0].vaultId, 'one');
  assert.deepEqual(status.receipts.map((r: { operationId: string }) => r.operationId), [edit.operationId, f.legacyReceipts[0].operationId]);
  assert.doesNotMatch(JSON.stringify(status), /sentinel-private|localFolder|directory/);
  assert.ok(f.calls.every(c => ['status', 'noteConfigure', 'mirrorDirectoryCapabilities', 'mirrorDirectory', 'mirrorDirectoryGrant', 'noteReceipts'].includes(c.method)));
});

test('routes pending/conflicted mirrors to legacy and never falls back after a direct lookup refusal', async t => {
  const f = await fixture(t, 'legacy_pending');
  for (const mode of ['legacy_pending', 'legacy_conflict']) {
    f.state.mirrors[0].filesystem = mode;
    assert.equal((await f.tool('read_note', target)).text, 'legacy');
  }
  assert.equal(f.calls.filter(c => c.method === 'mirrorDirectory').length, 0);
  f.state.mirrors[0].filesystem = 'ready';
  f.controls.deny = true;
  await f.tool('read_note', target, 'source_unavailable');
  assert.equal(f.calls.filter(c => c.method === 'noteRead').length, 2);
  const lookups = f.calls.filter(c => c.method === 'mirrorDirectory').length;
  assert.ok(lookups >= 1); // startup indexing may also attempt the ready lane
  f.controls.deny = false;
  f.controls.fallbackDirectory = 'relative/sentinel-private';
  await f.tool('read_note', target, 'source_unavailable');
  const refused = f.calls.filter(c => c.method === 'mirrorDirectory').length;
  assert.ok(refused > lookups);
  f.state.mirrors[0].filesystem = 'unavailable';
  await f.tool('read_note', target, 'source_unavailable');
  assert.equal(f.calls.filter(c => c.method === 'noteRead').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'mirrorDirectory').length, refused);
  assert.match(JSON.stringify(f.harness.inspection.logEntries), /Obsidian rpc source_unavailable/);
  assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
});

test('conflict discovery observes exact copies on disk and rejects a stale token', async t => {
  const f = await fixture(t);
  const note = { vaultId: 'one', path: 'Conflict.md' };
  await writeFile(join(f.directory, 'Conflict.md.bb-conflict1'), 'Local');
  const incoming = join(f.directory, 'Conflict.md.icloud-conflict1');
  await writeFile(incoming, 'Incoming');
  const inspect = () => f.tool('status', note).then(status => status.conflict.inspection);
  const first = await inspect();
  assert.equal(first.logicalHash, hash('Local'));
  assert.equal(first.incomingAbsent, false);
  assert.equal((await f.tool('read_note', { ...note, selector: { version: 'incoming', token: first.token } })).text, 'Incoming');
  await writeFile(incoming, 'New incoming');
  await f.tool('read_note', { ...note, selector: { version: 'incoming', token: first.token } }, 'conflict');
  await f.tool('create_note', { ...note, text: 'Cannot bypass copies' }, 'conflict');
  const duplicate = join(f.directory, 'Conflict.md.icloud-conflict2');
  await writeFile(duplicate, 'Ambiguous');
  assert.equal((await f.tool('status', note)).conflictFailure, 'conflict');
  assert.equal(await readFile(duplicate, 'utf8'), 'Ambiguous');
  await rm(duplicate);
  const current = await inspect();
  const result = await f.tool('edit_note', { ...note, resolution: {
    token: current.token, expectedLogicalHash: current.logicalHash, expectedIncomingHash: current.incomingHash, choice: 'accept_incoming',
  } });
  assert.equal(result.receipt.outcome, 'adopted_content');
  assert.equal(await readFile(join(f.directory, note.path), 'utf8'), 'New incoming');
  assert.deepEqual(await readdir(f.directory), [note.path]);
  assert.equal(await inspect(), null);
});

test('search, metadata and physical moves observe disk and preserve bounded link repairs', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'Notes'));
  await writeFile(join(f.directory, target.path), '---\ntitle: Agenda\n---\n#search/topic\nFind me\n');
  await writeFile(join(f.directory, 'Reference.md'), '[[Notes/Agenda: July]]\n');
  let page = await f.tool('search_notes', { text: 'find me', tag: 'search', folders: ['Notes'], limit: 1 });
  const paths: string[] = [];
  for (;;) {
    paths.push(...page.results.map((r: { path: string }) => r.path));
    if (!page.nextCursor) break;
    page = await f.tool('search_notes', { cursor: page.nextCursor });
  }
  assert.deepEqual(paths, [target.path]);
  assert.equal(page.totalMatches, 1);
  const metadata = await f.tool('get_note_metadata', target);
  assert.equal(metadata.properties.title, 'Agenda');
  const note = await f.tool('read_note', target);
  const moved = await f.tool('move_note', { ...target, expectedHash: note.hash, destination: 'Notes/New.md' });
  assert.equal(moved.outcome, 'moved_supported_links_updated');
  assert.equal(moved.physical, 'moved_locally_pending_sync');
  assert.equal(await readFile(join(f.directory, 'Notes/New.md'), 'utf8'), note.text);
  await assert.rejects(readFile(join(f.directory, target.path)), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.directory, 'Reference.md'), 'utf8'), '[[Notes/New]]\n');
});

test('no-follow paths, exclusive create and commit-time authorization protect surrounding files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.owner, 'Secret.md'), 'Private');
  await symlink(f.owner, join(f.directory, 'Escape'));
  await f.tool('read_note', { ...target, path: 'Escape/Secret.md' }, 'invalid_path');
  await f.tool('create_note', { ...target, path: 'Escape/Secret.md', text: 'Bad' }, 'invalid_path');
  assert.equal(await readFile(join(f.owner, 'Secret.md'), 'utf8'), 'Private');
  const loose = { vaultId: 'one', path: 'Single.md' };
  await f.tool('create_note', { ...loose, text: 'Exact' });
  await f.tool('create_note', { ...loose, text: 'Overwrite' }, 'conflict');
  const note = await f.tool('read_note', loose);
  let count = 0;
  f.controls.onLookup = async () => { if (++count === 3) throw new Error('authorization revoked'); };
  await f.tool('edit_note', { ...loose, append: 'Unauthorized', expectedHash: note.hash }, 'source_unavailable');
  assert.equal(await readFile(join(f.directory, loose.path), 'utf8'), 'Exact');
  count = 0;
  f.controls.onLookup = async () => { if (++count === 3) await writeFile(join(f.directory, loose.path), 'Disk wins'); };
  await f.tool('edit_note', { ...loose, append: 'Stale', expectedHash: note.hash }, 'conflict');
  assert.equal(await readFile(join(f.directory, loose.path), 'utf8'), 'Disk wins');
  assert.deepEqual((await readdir(f.directory)).sort(), ['Escape', 'Single.md']);
});

test('uncertain receipt persistence is inspected from disk without replaying the atomic save', async t => {
  const f = await fixture(t);
  const note = { vaultId: 'one', path: 'After crash.md' };
  f.controls.failFinish = true;
  await f.tool('create_note', { ...note, text: 'One version' }, 'uncertain');
  const status = await f.tool('status', note);
  assert.equal(status.uncertainOperations.length, 1);
  const { operationId } = status.uncertainOperations[0];
  f.controls.failFinish = false;
  const confirmed = await f.tool('status', { ...note, operationId });
  assert.equal(confirmed.receipts[0].outcome, 'saved_locally_pending_sync');
  assert.equal(confirmed.uncertainOperations.length, 0);
  assert.equal(await readFile(join(f.directory, note.path), 'utf8'), 'One version');
  assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
});

test('a mirror replaced during a search cursor is not a complete traversal', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 65; i++) await writeFile(join(f.directory, `Note ${i}.md`), 'Search');
  const started = await f.tool('search_notes', { text: 'Search', limit: 50 });
  assert.ok(started.nextCursor);
  await rename(f.directory, join(f.owner, 'old-vault'));
  await mkdir(f.directory);
  await f.tool('search_notes', { cursor: started.nextCursor }, 'cursor_expired');
});

async function waitFor<T>(poll: () => Promise<T | undefined>) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await poll(); if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error('Synthetic vaulted observation did not arrive');
}

test('native agent tool and GTD share the index; a GTD cursor keeps old properties and closes explicitly', async t => {
  const folder = 'Projects';
  const f = await fixture(t, 'ready', async root => {
    await mkdir(join(root, folder, '.hidden'), { recursive: true });
    await mkdir(join(root, 'Other'));
    for (let i = 0; i < 205; i++) await writeFile(join(root, folder, `P${String(i).padStart(3, '0')}.md`), '---\nstatus: active\nrank: 2\n---\n# Synthetic body\n');
    await writeFile(join(root, folder, '.hidden/Note.md'), '---\nstatus: active\nrank: "2"\n---\n');
    await writeFile(join(root, 'Other/Malformed.md'), '---\nx: [\n---\n');
  });
  const counted = await f.tool('search_notes', { pathGlob: 'Projects/**/*.md', properties: [{ key: 'rank', equals: 2 }], mode: 'count' });
  assert.equal(counted.totalMatches, 205); assert.match(counted.coverage.consistency, /pinned local index/);
  const first = await f.tool('search_notes', { pathGlob: 'Projects/P000.md' });
  assert.equal(first.results[0].snippet, '');
  await f.tool('edit_note', { vaultId: 'one', path: 'Projects/P000.md', expectedHash: first.results[0].hash, append: 'refuse' }, 'complete_read_required');
  const params = { vaultId: 'one', folder, fields: ['status', 'rank'] };
  const list = (cursor?: string) => f.harness.behavior.callRpc('listProperties', { ...params, ...(cursor ? { cursor } : {}) }) as Promise<{ notes: { path: string; properties: Record<string, unknown> }[]; nextCursor: string | null; incomplete: boolean }>;
  const page = await list(); assert.equal(page.notes.length, 200); assert.ok(page.nextCursor);
  assert.doesNotMatch(JSON.stringify(page), /Synthetic body|snippet|editReady/);
  await writeFile(join(f.directory, folder, 'P204.md'), '---\nstatus: changed\n---\nCurrent disk');
  await waitFor(async () => {
    const updated = await f.tool('search_notes', { pathGlob: 'Projects/P204.md', properties: [{ key: 'status', equals: 'changed' }], mode: 'count' });
    if (updated.totalMatches === 1) return true;
  });
  const tail = await list(page.nextCursor);
  assert.equal(tail.incomplete, false); assert.equal(tail.nextCursor, null);
  assert.equal(tail.notes.find(row => row.path === 'Projects/P204.md')?.properties.status, 'active');
  const abandoned = await list(); assert.ok(abandoned.nextCursor);
  assert.equal(await f.harness.behavior.callRpc('closeProperties', { cursor: abandoned.nextCursor }), null);
  await assert.rejects(list(abandoned.nextCursor), /Property listing did not complete/);
});

const gtdCaller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };

test('warm indexed project relationships read neither notes nor directories, across batches', async t => {
  let revokeAtFinalCheck = false, grantChecks = 0;
  const f = await fixture(t, 'ready', async root => {
    for (const path of ['Life/Projects/Pilot', 'Life/Areas/Work/Nested', 'Life/Areas/Finance', 'Other/Areas'])
      await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, 'Life/Areas/Finance.md'), 'target');
    await writeFile(join(root, 'Other/Areas/Finance.md'), 'different vault');
    await symlink('.', join(root, 'Other/Areas/Skipped'));
    await writeFile(join(root, 'Life/Projects/Plan.md'), '---\nareaId: Areas/Stale.md\narea: "[[Areas/Finance|Budget]]"\n---\n' + 'x'.repeat(70000));
    await writeFile(join(root, 'Life/Projects/Body.md'), '## Area\n- [[Areas/Finance]]');
    await writeFile(join(root, 'Life/Projects/OldOnly.md'), '---\nareaId: Areas/Finance.md\n---\n');
    await writeFile(join(root, 'Life/Projects/Pilot/README.md'), '---\narea: "[[Areas/Work/Nested]]"\n---\n');
    await writeFile(join(root, 'Life/Projects/Invalid.md'), '---\narea: [\n---\n## Area\n- [[Areas/Finance]]');
  }, async () => {
    if (revokeAtFinalCheck && ++grantChecks === 2) throw new Error('sentinel-private-revoked-final-grant');
  });
  const warmed = await f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Life/Projects', fields: ['title'] });
  assert.match(JSON.stringify(warmed), /Plan\.md/);
  const status = await f.harness.behavior.callRpc('status', null) as { projectAreasFrontmatterOnly?: boolean; projectAreasDeclarationKey?: string };
  assert.equal(status.projectAreasFrontmatterOnly, true);
  assert.equal(status.projectAreasDeclarationKey, 'area');
  const forbidden = ['read', 'list', 'children', 'indexDirectory', 'searchReader'] as const;
  const spies = forbidden.map(method => t.mock.method(LocalNotes.prototype, method, () => { throw new Error(`Unexpected warm ${method}`); }));
  const start = f.calls.length;
  const lookup = (paths: string[], areaFolder = 'Life/Areas', expectedAuthority?: { route: string; revision: number; epoch: string }) => f.harness.behavior.callRpc('projectAreasFromFrontmatter', { vaultId: 'one', root: 'Life', areaFolder, paths, declarationKey: 'area', ...(expectedAuthority ? { expectedAuthority } : {}) }, gtdCaller);
  const first = await lookup(['Life/Projects/Plan.md', 'Life/Projects/Body.md', 'Life/Projects/OldOnly.md']) as { authority: { route: string; revision: number; epoch: string } };
  const { authority } = first;
  assert.equal(authority.route, 'index'); assert.equal(authority.revision, 7);
  assert.match(authority.epoch, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first, { rows: [
    { path: 'Life/Projects/Plan.md', status: 'resolved', areaId: 'Life/Areas/Finance.md' },
    { path: 'Life/Projects/Body.md', status: 'none' },
    { path: 'Life/Projects/OldOnly.md', status: 'none' },
  ], incomplete: false, authority });
  assert.deepEqual(await lookup(['Life/Projects/Pilot/README.md'], 'Life/Areas', authority), { rows: [
    { path: 'Life/Projects/Pilot/README.md', status: 'resolved', areaId: 'Life/Areas/Work/Nested/' },
  ], incomplete: false, authority });
  assert.deepEqual(await lookup(['Life/Projects/Invalid.md', 'Life/Projects/Absent.md']), { rows: [
    { path: 'Life/Projects/Invalid.md', status: 'unresolved' },
    { path: 'Life/Projects/Absent.md', status: 'unresolved' },
  ], incomplete: true, authority });
  await assert.rejects(lookup(['Life/Projects/Plan.md'], 'Life/Areas', { ...authority, revision: 6 }), /Project Area evidence did not complete/);
  await assert.rejects(lookup(['Life/Projects/Plan.md'], 'Other/Areas'), /Project Area evidence did not complete/);
  revokeAtFinalCheck = true;
  await assert.rejects(lookup(['Life/Projects/Plan.md']), /Project Area evidence did not complete/);
  assert.equal(grantChecks, 2);
  revokeAtFinalCheck = false;
  f.controls.capabilityReply = { mirrorDirectoryGrantVersion: 2 };
  await assert.rejects(lookup(['Life/Projects/Plan.md']), /Project Area evidence did not complete/);
  assert.ok(f.calls.slice(start).every(call => ['status', 'noteConfigure', 'mirrorDirectoryCapabilities', 'mirrorDirectoryGrant'].includes(call.method)));
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
});

test('same-revision route restoration cannot reuse an indexed Area batch authority', async t => {
  for (const revoke of ['catalog', 'grant']) await t.test(revoke, async t => {
    const paths = Array.from({ length: 51 }, (_, i) => `Projects/P${i}.md`);
    const f = await fixture(t, 'ready', async root => {
      await mkdir(join(root, 'Projects')); await mkdir(join(root, 'Areas'));
      await writeFile(join(root, 'Areas/Old.md'), 'old target');
      await writeFile(join(root, 'Areas/New.md'), 'new target');
      for (const path of paths) await writeFile(join(root, path), '---\narea: Areas/Old.md\n---');
    });
    type Authority = { revision: number; route: string; epoch: string };
    type Page = { rows: Array<{ areaId?: string }>; authority: Authority; incomplete: boolean };
    const lookup = (paths: string[], expectedAuthority?: Authority) => f.harness.behavior.callRpc('projectAreasFromFrontmatter', {
      vaultId: 'one', root: '', areaFolder: 'Areas', paths, ...(expectedAuthority ? { expectedAuthority } : {}),
    }, gtdCaller) as Promise<Page>;
    const first = await lookup(paths.slice(0, 50));
    assert.equal(first.incomplete, false);
    assert.equal(first.rows.length, 50);
    assert.ok(first.rows.every(row => row.areaId === 'Areas/Old.md'));

    // A content-only refresh does not interrupt authorization.
    const last = paths.slice(50);
    await writeFile(join(f.directory, last[0]), '---\narea: Areas/New.md\n---');
    const refreshed = await waitFor(async () => {
      const page = await lookup(last, first.authority);
      return page.rows[0]?.areaId === 'Areas/New.md' ? page : undefined;
    });
    assert.deepEqual(refreshed.authority, first.authority);

    // Another operation observes the loss. Restore the same route/revision
    // before the waiting consumer dispatches its second relationship batch.
    if (revoke === 'catalog') f.state.mirrors[0].local.available = false;
    else f.controls.denyGrant = true;
    const lost = await f.tool('search_notes', { pathGlob: '*.md', mode: 'count' });
    assert.deepEqual(lost.failures, [{ vaultId: 'one', category: 'source_unavailable' }]);
    assert.equal(lost.totalMatches, null);
    f.state.mirrors[0].local.available = true;
    f.controls.denyGrant = false;
    const restored = await lookup(last);
    assert.equal(restored.incomplete, false);
    assert.equal(restored.rows[0]?.areaId, 'Areas/New.md');
    assert.equal(restored.authority.revision, first.authority.revision);
    assert.equal(restored.authority.route, first.authority.route);
    assert.notEqual(restored.authority.epoch, first.authority.epoch);
    await assert.rejects(lookup(last, first.authority), /Project Area evidence did not complete/);
    assert.ok(!f.calls.some(call => ['mirrorDirectory', 'noteList', 'noteChildren', 'noteRead'].includes(call.method)));
  });
});

test('a direct Area batch refuses an unconfirmed or changed route before live dispatch', async t => {
  for (const change of ['unconfirmed', 'legacy', 'indexed']) await t.test(change, async t => {
    const f = await fixture(t, 'ready', undefined, undefined, null);
    const start = f.calls.length;
    let changed = false;
    f.controls.afterAreaConfigure = () => {
      changed = true;
      if (change === 'unconfirmed') f.controls.capabilityReply = { mirrorDirectoryGrantVersion: 2 };
      if (change === 'legacy') f.state.mirrors[0].filesystem = 'legacy_pending';
      if (change === 'indexed') f.controls.capabilityReply = { mirrorDirectoryGrantVersion: 1 };
    };
    await assert.rejects(f.harness.behavior.callRpc('projectAreasFromFrontmatter', { vaultId: 'one', root: '', areaFolder: 'Areas', paths: ['Projects/Plan.md'] }, gtdCaller), /Project Area evidence did not complete/);
    assert.equal(changed, true);
    assert.ok(!f.calls.slice(start).some(call => ['mirrorDirectory', 'noteList', 'noteChildren', 'noteRead'].includes(call.method)));
  });
});

test('a live Area batch reauthorizes after its last read and withholds buffered rows on revocation', async t => {
  for (const change of ['local-status', 'route', 'direct-handoff']) await t.test(change, async t => {
    const f = await fixture(t, 'ready', async root => {
      await mkdir(join(root, 'Projects')); await mkdir(join(root, 'Areas'));
      await writeFile(join(root, 'Areas/Example.md'), 'area');
      for (const name of ['First', 'Last']) await writeFile(join(root, `Projects/${name}.md`), '---\narea: Areas/Example.md\n---');
    }, undefined, null);
    const read = LocalNotes.prototype.read;
    const observed: string[] = [];
    t.mock.method(LocalNotes.prototype, 'read', async function (this: LocalNotes, root: string, path: string) {
      const value = await read.call(this, root, path);
      observed.push(path);
      if (path.endsWith('/Last.md')) {
        if (change === 'local-status') f.state.mirrors[0].local.available = false;
        if (change === 'route') f.state.mirrors[0].filesystem = 'legacy_pending';
        if (change === 'direct-handoff') f.controls.deny = true;
      }
      return value;
    });
    const paths = ['Projects/First.md', 'Projects/Last.md'];
    await assert.rejects(f.harness.behavior.callRpc('projectAreasFromFrontmatter', { vaultId: 'one', root: '', areaFolder: 'Areas', paths }, gtdCaller), /Project Area evidence did not complete/);
    assert.deepEqual(observed, paths);
    assert.ok(!f.calls.some(call => ['noteList', 'noteChildren', 'noteRead'].includes(call.method)));
  });
});

test('an indexed omission within the selected root makes relationship resolution partial', async t => {
  const f = await fixture(t, 'ready', async root => {
    await mkdir(join(root, 'Life/Projects'), { recursive: true });
    await mkdir(join(root, 'Life/Areas'));
    await writeFile(join(root, 'Life/Projects/Plan.md'), '---\narea: Finance\n---');
    await writeFile(join(root, 'Life/Areas/Finance.md'), 'target');
    await symlink('.', join(root, 'Life/Skipped'));
  });
  const path = 'Life/Projects/Plan.md';
  assert.deepEqual(await f.harness.behavior.callRpc('projectAreas', { vaultId: 'one', root: 'Life', areaFolder: 'Life/Areas', paths: [path] }, gtdCaller), {
    rows: [{ path, status: 'unresolved' }], incomplete: true,
  });
  assert.ok(!f.calls.some(call => call.method === 'mirrorDirectory' || call.method === 'noteRead' || call.method === 'noteList'));
});

test('denied native root cannot leak buffered snapshot rows or fall back to the legacy route', async t => {
  const f = await fixture(t, 'ready', async root => {
    await writeFile(join(root, 'A.md'), 'sample'); await writeFile(join(root, 'B.md'), 'sample');
  });
  const page = await f.tool('search_notes', { pathGlob: '*.md', limit: 1 }); assert.ok(page.nextCursor);
  f.controls.deny = true;
  await f.tool('search_notes', { cursor: page.nextCursor }, 'source_unavailable');
  await f.tool('search_notes', { cursor: page.nextCursor }, 'cursor_expired');
  assert.ok(!f.calls.some(c => c.method === 'noteSearch' || c.method === 'noteRead'));
  assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
});

test('five-minute timer publishes new observations without a watcher flush', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const f = await fixture(t, 'ready', root => writeFile(join(root, 'Start.md'), 'initial'));
  const count = () => f.tool('search_notes', { pathGlob: '*.md', mode: 'count' });
  assert.equal((await count()).totalMatches, 1);
  t.mock.timers.tick(299_999);
  await writeFile(join(f.directory, 'Missed.md'), 'not in published view');
  assert.equal((await count()).totalMatches, 1);
  // Do not advance the watcher debounce; only the five-minute timer is due.
  t.mock.timers.tick(1);
  await waitFor(async () => (await count()).totalMatches === 2 ? true : undefined);
});

test('plugin startup does not wait for the first scan; disposal aborts the grant and drains a cold query', async t => {
  let entered = false, cancelled = false;
  const f = await fixture(t, 'ready', undefined, signal => new Promise((_, reject) => {
    entered = true;
    const abort = () => { cancelled = true; reject(new Error('synthetic cancellation')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }));
  await waitFor(async () => entered || undefined);
  const hanging = f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] });
  const expected = assert.rejects(hanging, /Property listing did not complete/);
  await f.harness.lifecycle.dispose();
  await expected; assert.equal(cancelled, true);
});

test('unsupported notes and symlinks affect only intersecting folder/glob scopes, not GTD in another folder', async t => {
  const f = await fixture(t, 'ready', async root => {
    await mkdir(join(root, 'Archive')); await mkdir(join(root, 'Projects'));
    await writeFile(join(root, 'Projects/Good.md'), '---\nstatus: active\n---\n');
    await writeFile(join(root, 'Archive/Oversized.md'), Buffer.alloc(1024 * 1024 + 1, 65));
    await writeFile(join(root, 'Archive/Invalid.md'), Buffer.from([0xff, 0xfe]));
    await symlink('Archive', join(root, 'Unrelated.pdf'));
    await symlink('.', join(root, 'Archive/Link'));
  });
  const params = { vaultId: 'one', folder: 'Projects', fields: ['status'] };
  const gtd = await f.harness.behavior.callRpc('listProperties', params) as { notes: unknown[]; incomplete: boolean; warnings: string[] };
  assert.deepEqual(gtd.notes, [{ path: 'Projects/Good.md', properties: { status: 'active' } }]);
  assert.equal(gtd.incomplete, false); assert.deepEqual(gtd.warnings, []);
  const count = (query: { pathGlob?: string; folders?: string[]; excludeFolders?: string[] }) => f.tool('search_notes', { mode: 'count', ...query });
  assert.equal((await count({ pathGlob: 'Projects/**/*.md' })).totalMatches, 1);
  assert.equal((await count({ pathGlob: 'Archive/Nomatch*.md' })).totalMatches, 0);
  assert.equal((await count({ pathGlob: '*.md' })).totalMatches, 0);
  assert.equal((await count({ excludeFolders: ['Archive', 'Unrelated.pdf'], pathGlob: '**/*.md' })).totalMatches, 1);
  for (const glob of ['Archive/Oversized.md', 'Archive/Invalid.md', 'Unrelated.pdf/**/*.md', 'Archive/Link/**/*.md']) {
    const overlap = await count({ pathGlob: glob });
    assert.equal(overlap.totalMatches, null, glob); assert.deepEqual(overlap.warnings, ['unsupported']);
  }
  const scope = { folders: ['Unrelated.pdf'], excludeFolders: ['Unrelated.pdf/X'] };
  const excluded = await count({ ...scope, pathGlob: 'Unrelated.pdf/X/**/*.md' });
  assert.equal(excluded.totalMatches, 0); assert.deepEqual(excluded.warnings, []);
  const sibling = await count({ ...scope, pathGlob: 'Unrelated.pdf/Y/**/*.md' });
  assert.equal(sibling.totalMatches, null); assert.deepEqual(sibling.warnings, ['unsupported']);
  const undecidable = await count({ ...scope, pathGlob: 'Unrelated.pdf/*/**/*.md' });
  assert.equal(undecidable.totalMatches, null);
  const legacyEvidence = await f.harness.behavior.callRpc('listProperties', { ...params, folder: 'Archive' }) as { incomplete: boolean };
  assert.equal(legacyEvidence.incomplete, true);
});

test('older iCloud producer has no index grant, but the direct live routes remain available', async t => {
  const f = await fixture(t, 'ready', async root => {
    await mkdir(join(root, 'Projects')); await writeFile(join(root, 'Projects/One.md'), '---\nstatus: active\nareaId: Areas/Stale.md\narea: Areas/Example.md\n---\nneedle');
    await mkdir(join(root, 'Areas')); await writeFile(join(root, 'Areas/Example.md'), 'synthetic target');
    await writeFile(join(root, 'Projects/Body.md'), '---\nareaId: Areas/Example.md\n---\n## Area\n- [[Areas/Example]]');
  }, undefined, null);
  assert.equal((await f.tool('search_notes', { mode: 'count', properties: [{ key: 'status', equals: 'active' }] })).totalMatches, 1);
  assert.equal((await f.tool('search_notes', { mode: 'count', text: 'needle' })).totalMatches, 1);
  const rpc = await f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] }) as { notes: unknown[] };
  assert.deepEqual(rpc.notes, [{ path: 'Projects/Body.md', properties: {} }, { path: 'Projects/One.md', properties: { status: 'active' } }]);
  const { authority, ...relationships } = await f.harness.behavior.callRpc('projectAreasFromFrontmatter', {
    vaultId: 'one', root: '', areaFolder: 'Areas', paths: ['Projects/One.md', 'Projects/Body.md'], declarationKey: 'area',
  }, gtdCaller) as { authority: { route: string }; rows: unknown[]; incomplete: boolean };
  assert.equal(authority.route, 'direct');
  assert.deepEqual(relationships, {
    rows: [{ path: 'Projects/One.md', status: 'resolved', areaId: 'Areas/Example.md' }, { path: 'Projects/Body.md', status: 'none' }], incomplete: false,
  });
  const glob = await f.tool('search_notes', { pathGlob: '**/*.md' });
  assert.deepEqual(glob.failures, [{ vaultId: 'one', category: 'unsupported' }]);
  assert.ok(f.calls.some(c => c.method === 'mirrorDirectoryCapabilities'));
  assert.ok(!f.calls.some(c => c.method === 'mirrorDirectoryGrant'));
  assert.ok(f.calls.some(c => c.method === 'mirrorDirectory'));
});

test('advertised grant denial and malformed identity never downgrade an indexed query to a path-only lookup', async t => {
  const f = await fixture(t, 'ready', root => writeFile(join(root, 'Only.md'), 'synthetic'));
  assert.equal((await f.tool('search_notes', { pathGlob: '*.md' })).totalMatches, 1);
  const expectUnavailable = async () => {
    const page = await f.tool('search_notes', { pathGlob: '*.md' });
    assert.deepEqual(page.failures, [{ vaultId: 'one', category: 'source_unavailable' }]);
    assert.deepEqual(page.results, []); assert.equal(page.totalMatches, null);
  };
  f.controls.denyGrant = true; await expectUnavailable();
  f.controls.denyGrant = false; f.controls.malformedGrant = true; await expectUnavailable();
  assert.ok(!f.calls.some(c => c.method === 'mirrorDirectory' || c.method === 'noteSearch'));
  assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
});

test('capability refusal, malformed response and untyped missing-method errors do not downgrade metadata queries', async t => {
  const f = await fixture(t, 'ready', async root => {
    await mkdir(join(root, 'Projects'));
    for (const name of ['One', 'Two']) await writeFile(join(root, `Projects/${name}.md`), '---\nstatus: active\n---\nneedle');
  });
  const query = { properties: [{ key: 'status', equals: 'active' }] };
  const first = await f.tool('search_notes', { ...query, limit: 1 });
  assert.ok(first.nextCursor);
  const expectUnavailable = async () => {
    const page = await f.tool('search_notes', query);
    assert.deepEqual(page.results, []);
    assert.equal(page.totalMatches, null);
    assert.deepEqual(page.failures, [{ vaultId: 'one', category: 'source_unavailable' }]);
    const projection = await f.harness.behavior.callRpc('listProperties', { vaultId: 'one', folder: 'Projects', fields: ['status'] });
    assert.deepEqual(projection, { notes: [], nextCursor: null, incomplete: true, warnings: ['source_unavailable'], observedAt: (projection as { observedAt: string }).observedAt });
  };
  for (const code of ['forbidden', 'not_found', 'transport_error', 'invalid_output'] as const) {
    f.controls.capabilityError = new experimental_PluginRpcCallError({ code, message: 'sentinel-private-capability-error' });
    await expectUnavailable();
  }
  await f.tool('search_notes', { cursor: first.nextCursor }, 'cursor_expired');
  f.controls.capabilityError = { code: 'unknown_method', message: 'sentinel-private-untyped' };
  await expectUnavailable();
  f.controls.capabilityError = undefined;
  for (const reply of [{ mirrorDirectoryGrantVersion: 2 }, { secret: 'sentinel-private-malformed' }]) {
    f.controls.capabilityReply = reply; await expectUnavailable();
  }
  assert.ok(!f.calls.some(c => c.method === 'mirrorDirectory' || c.method === 'noteSearch'));
  assert.equal((await f.tool('search_notes', { text: 'needle', mode: 'count' })).totalMatches, 2);
  assert.doesNotMatch(JSON.stringify(f.harness.inspection.logEntries), /sentinel-private/);
});

test('a valid empty capability reply keeps live properties without touching the index grant', async t => {
  const f = await fixture(t, 'ready', root => writeFile(join(root, 'One.md'), '---\nstatus: active\n---\n'), undefined, null);
  f.controls.capabilityReply = {};
  assert.equal((await f.tool('search_notes', { mode: 'count', properties: [{ key: 'status', equals: 'active' }] })).totalMatches, 1);
  assert.ok(f.calls.some(c => c.method === 'mirrorDirectory'));
  assert.ok(!f.calls.some(c => c.method === 'mirrorDirectoryGrant'));
});

test('an Obsidian archive appears in the connected GTD Done inventory', async t => {
  const path = 'Life/Projects/Active/Service a heater.md';
  const destination = 'Life/Projects/Done/Service a heater.md';
  const f = await fixture(t, 'ready', async root => {
    for (const folder of ['Life/.obsidian', 'Life/Areas', 'Life/Projects/Active', 'Life/Projects/Done']) {
      await mkdir(join(root, folder), { recursive: true });
    }
    await writeFile(join(root, path), '---\nstatus: active\n---\n- [x] Service\n');
  });
  const gtd = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one/Life' }, sdk: { plugins: { callRpc: async (args: any) => {
    if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Synthetic' }], incomplete: false };
    return f.harness.behavior.callRpc(args.method, args.input, gtdCaller);
  },
  } } });
  t.after(() => gtd.harness.lifecycle.dispose());
  await gtdPlugin(gtd.bb as unknown as Parameters<typeof gtdPlugin>[0]);

  const list = async (status: 'active' | 'done') => {
    const page: any = await gtd.harness.behavior.callRpc('listProjects', { status });
    return page.coverage === 'complete' ? page.projects.map((project: { id: string }) => project.id) as string[] : undefined;
  };
  assert.deepEqual(await list('active'), [path]);

  const input = { vaultId: 'one', path };
  const source = await f.tool('read_note', input);
  const result = await f.tool('move_note', { ...input, destination, expectedHash: source.hash });
  assert.equal(result.outcome, 'moved_supported_links_updated');
  // The indexed client can see the previous generation or a transient
  // unavailable response while processing both sides of the rename.
  const after = await waitFor(async () => {
    try {
      const done = await list('done');
      const active = await list('active');
      return done?.includes(destination) && active && !active.includes(path) ? { done, active } : undefined;
    } catch (error) {
      if (!(error instanceof experimental_PluginRpcCallError) || error.code !== 'handler_error' || error.message !== 'GTD source unavailable.') throw error;
      return undefined;
    }
  });
  assert.deepEqual(after.done, [destination]);
  assert.deepEqual(after.active, []);
});
