import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { plugin } from '../server.ts';
import { hash } from './fakes.ts';

async function fixture(t: TestContext) {
  const owner = await mkdtemp(join(tmpdir(), 'sentinel-private-mirror-'));
  const directory = join(owner, 'vault');
  await mkdir(directory);
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  const { bb, harness } = host;
  const state = {
    noteAccessVersion: 2, mirrorAccessVersion: 3, available: true, connected: false, challenge: null,
    mirrors: [{ id: 'one', folder: { name: 'Selected vault' }, initialized: true, enabled: false, phase: 'paused',
      lastSuccess: '2026-01-01T00:00:00Z', failure: null, filesystem: 'ready',
      local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } }],
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  const controls: { fallbackDirectory?: string; onLookup?: () => Promise<void>; deny?: boolean; failFinish?: boolean } = {};
  const legacyReceipts = [{
    kind: 'save', path: 'Old.md', mirrorId: 'one', operationId: randomUUID(), at: '2026-01-01T00:00:00Z',
    hash: hash('saved previously'), previousHash: null, outcome: 'saved_locally_pending_sync',
  }];
  const sdk = { ...bb.sdk, plugins: {
    async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
    async callRpc({ method, input, outputSchema }: { method: string; input: any; outputSchema: { parse(value: unknown): unknown } }) {
      calls.push({ method, input });
      switch (method) {
        case 'status': return outputSchema.parse({ ...state, localFolder: directory });
        case 'noteConfigure': return outputSchema.parse({ ok: true, value: { revision: input.revision } });
        case 'mirrorDirectory':
          assert.deepEqual(input, { mirrorId: 'one', revision: 7 });
          if (controls.deny) throw new Error(`sentinel-private-failure ${directory}`);
          await controls.onLookup?.();
          return outputSchema.parse({ directory: controls.fallbackDirectory ?? directory });
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
  assert.ok(f.calls.every(c => ['status', 'noteConfigure', 'mirrorDirectory', 'noteReceipts'].includes(c.method)));
});

test('routes pending/conflicted mirrors to legacy and never falls back after a direct lookup refusal', async t => {
  const f = await fixture(t);
  for (const mode of ['legacy_pending', 'legacy_conflict']) {
    f.state.mirrors[0].filesystem = mode;
    assert.equal((await f.tool('read_note', target)).text, 'legacy');
  }
  assert.equal(f.calls.filter(c => c.method === 'mirrorDirectory').length, 0);
  f.state.mirrors[0].filesystem = 'ready';
  f.controls.deny = true;
  await f.tool('read_note', target, 'source_unavailable');
  assert.equal(f.calls.filter(c => c.method === 'noteRead').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'mirrorDirectory').length, 1);
  f.controls.deny = false;
  f.controls.fallbackDirectory = 'relative/sentinel-private';
  await f.tool('read_note', target, 'source_unavailable');
  f.state.mirrors[0].filesystem = 'unavailable';
  await f.tool('read_note', target, 'source_unavailable');
  assert.equal(f.calls.filter(c => c.method === 'noteRead').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'mirrorDirectory').length, 2);
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
