import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { experimental_PluginRpcCallError, type BbPluginApi } from '@get-bb/plugin-sdk';
import { plugin } from '../server.ts';
import { LocalNotes } from '../adapters/local-notes.ts';
import { hash } from './fakes.ts';

async function fixture(t: TestContext, initialMode = 'ready', prepare?: (root: string) => Promise<void>, indexLookup?: (signal: AbortSignal) => Promise<void>, grantVersion: 1 | null = 1, reactivationClock?: () => number) {
  const owner = await mkdtemp(join(tmpdir(), 'sentinel-private-mirror-'));
  const directory = join(owner, 'vault');
  await mkdir(directory);
  await prepare?.(directory);
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  const { bb, harness } = host;
  const state = {
    mirrorFileAccessVersion: 1, mirrorAccessVersion: 3, available: true, connected: false, challenge: null,
    mirrors: [{ id: 'one', folder: { name: 'Selected vault' }, initialized: true, enabled: false, phase: 'paused',
      lastSuccess: '2026-01-01T00:00:00Z', failure: null, filesystem: initialMode,
      local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } }],
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  const controls: { fallbackDirectory?: string; onLookup?: () => Promise<void>; deny?: boolean; denyGrant?: boolean; malformedGrant?: boolean; capabilityError?: unknown; capabilityReply?: unknown; afterAreaConfigure?: () => void; beforeStatus?: () => Promise<void>; failFinish?: boolean } = {};
  const legacyReceipts = [{
    kind: 'save', path: 'Old.md', mirrorId: 'one', operationId: randomUUID(), at: '2026-01-01T00:00:00Z',
    hash: hash('saved previously'), previousHash: null, outcome: 'saved_locally_pending_sync',
  }];
  const sdk = { ...bb.sdk, plugins: {
    async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
    async callRpc({ method, input, outputSchema, signal }: { method: string; input: any; outputSchema: { parse(value: unknown): unknown }; signal?: AbortSignal }) {
      calls.push({ method, input });
      switch (method) {
        case 'status':
          await controls.beforeStatus?.();
          return outputSchema.parse({ ...state, localFolder: directory });
        case 'mirrorConfigure':
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
        case 'fileReceipts': return outputSchema.parse({
          ok: true, value: legacyReceipts.filter(row => (!input.path || row.path === input.path) && (!input.operationId || row.operationId === input.operationId)),
        });
        case 'fileRead': return outputSchema.parse({ ok: true, value: { base64: Buffer.from('legacy').toString('base64'), hash: hash('legacy'), complete: true, readAt: new Date().toISOString() } });
        default: throw new Error(`Unexpected iCloud RPC: ${method}`);
      }
    },
  } } as unknown as BbPluginApi['sdk'];
  const storage = bb.storage;
  const db = storage.database();
  db.function('synthetic_receipt_failure', () => {
    if (controls.failFinish) throw new Error(`sentinel-private-receipt ${directory}`);
    return null;
  });
  await storage.kv.set('connected-vaults', { revision: 7, vaultIds: ['one'], pending: [] });
  const start = (hostApi: BbPluginApi) => plugin({ ...hostApi, sdk });
  await start(bb);
  db.exec(`CREATE TEMP TRIGGER synthetic_fail_terminal BEFORE INSERT ON obsidian_receipt_events
    WHEN NEW.event = 'terminal' BEGIN SELECT synthetic_receipt_failure(); END`);
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

test('no-follow paths, exclusive create and commit-time authorization protect surrounding files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.owner, 'Secret.md'), 'Private');
  await symlink(f.owner, join(f.directory, 'Escape'));
  const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'verifier' } };
  const evidence = (input: { vaultId: string; path: string }) => f.harness.behavior.callRpc('noteEvidence', input, caller) as Promise<{ hash: string }>;
  await assert.rejects(evidence({ ...target, path: 'Escape/Secret.md' }));
  await f.tool('create_note', { ...target, path: 'Escape/Secret.md', text: 'Bad' }, 'invalid_path');
  assert.equal(await readFile(join(f.owner, 'Secret.md'), 'utf8'), 'Private');
  const loose = { vaultId: 'one', path: 'Single.md' };
  await f.tool('create_note', { ...loose, text: 'Exact' });
  await f.tool('create_note', { ...loose, text: 'Overwrite' }, 'conflict');
  const note = await evidence(loose);
  let count = 0;
  f.controls.onLookup = async () => { if (++count === 4) throw new Error('authorization revoked'); };
  const checked = (value: string) => f.harness.behavior.callRpc('writeProperties',
    { ...loose, expectedHash: note.hash, set: { value, other: true } }, caller);
  const refused = await checked('Unauthorized') as { outcome: string };
  assert.equal(refused.outcome, 'uncertain');
  assert.equal(await readFile(join(f.directory, loose.path), 'utf8'), 'Exact');
  count = 0;
  f.controls.onLookup = async () => { if (++count === 4) await writeFile(join(f.directory, loose.path), 'Disk wins'); };
  const stale = await checked('Stale') as { outcome: string };
  assert.equal(stale.outcome, 'not_saved');
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

test('GTD reads only the first open task in a top-level section, even when the section is large', async t => {
  const f = await fixture(t);
  const target = { vaultId: 'one', path: 'Bench.md', heading: 'TODO' };
  const file = join(f.directory, target.path);
  const gtd = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };
  const next = () => f.harness.behavior.callRpc('readSectionTask', target, gtd);
  const before = [
    '## Earlier notes', '### TODO', '- [ ] Outside the project list', '', '## TODO', '',
    'Long background '.repeat(1050), '', '- [x] Finished', '- [-] Cancelled', '  - [ ] Nested under cancelled', '',
    '````md', '```', '- [ ] Code example', '````', '',
    '<!--', '- [ ] Hidden HTML draft', '-->', '', '%%', '- [ ] Hidden Obsidian draft', '%%', '',
    '- [ ] Measure boards  ', '  Supporting detail', '- [ ] Cut boards', '', '## Waiting For', '- [ ] Delivery', '',
  ].join('\r\n');
  await writeFile(file, before);
  await assert.rejects(f.harness.behavior.callRpc('readSectionTask', target, { experimental_caller: { kind: 'client' } }), /Only GTD/);
  await assert.rejects(f.harness.behavior.callRpc('readNoteSection', target, gtd), /Keep one matching heading/);
  assert.deepEqual(await next(), { text: 'Measure boards' });
  assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(file, '## TODO\n' + 'Long background '.repeat(1050) + '\n\n- [ ] Measure boards\n');
  await assert.rejects(f.harness.behavior.callRpc('readNoteSection', target, gtd), /Open the section/);
  assert.deepEqual(await next(), { text: 'Measure boards' });
  await writeFile(file, '## TODO\n- [x] Finished\n\n## Waiting For\n- [ ] Delivery\n');
  assert.deepEqual(await next(), { text: null });
  await writeFile(file, '## Notes\n### TODO\n- [ ] Note to self\n');
  assert.deepEqual(await next(), { text: null });
  await writeFile(file, '## TODO\n- [ ] One\n\n## TODO\n- [ ] Two\n');
  await assert.rejects(next(), /Keep one matching heading/);
});

test('a section save preserves the rest of the Area note and checks the displayed version', async t => {
  const f = await fixture(t);
  const target = { vaultId: 'one', path: 'Learning.md', heading: 'Standard' };
  const file = join(f.directory, target.path);
  const client = { experimental_caller: { kind: 'client' as const } };
  const gtd = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };
  const call = (method: string, input: unknown = target) => f.harness.behavior.callRpc(method, input, gtd);
  const read = () => call('readNoteSection') as Promise<{ hash: string; text: string }>;
  const save = (expectedHash: string, text: string, operationId = randomUUID()) =>
    call('writeNoteSection', { ...target, expectedHash, text, operationId }) as Promise<{ outcome: string; reason?: string }>;
  const before = '---\r\ntags: [learning]\r\n---\r\n# Learning\r\n\r\n> ## Standard\r\n\r\n## Standard\r\n\r\nPractice weekly.\r\n\r\n### Notes\r\nUse scrap.\r\n\r\n## Projects\r\nKeep this.\r\n';
  const after = before.replace('Practice weekly.\r\n\r\n### Notes\r\nUse scrap.', 'Practice daily.\r\n\r\n- Use scrap.');
  await writeFile(file, before);
  await assert.rejects(f.harness.behavior.callRpc('readNoteSection', target, client), /Only BB plugins/);
  const version = await read();
  assert.equal(version.text, 'Practice weekly.\r\n\r\n### Notes\r\nUse scrap.');
  const operationId = randomUUID();
  assert.equal((await save(version.hash, 'Practice daily.\n\n- Use scrap.', operationId)).outcome, 'saved_locally_pending_sync');
  assert.equal(await readFile(file, 'utf8'), after);
  const receipt = await call('noteEvidence', { vaultId: target.vaultId, path: target.path, operationId }) as { receipt: string };
  assert.equal(receipt.receipt, 'saved_locally_pending_sync');
  const stale = await save(version.hash, 'Stale draft');
  assert.equal(stale.outcome, 'not_saved');
  assert.equal(stale.reason, 'changed');
  const latest = await read();
  const invalid = await save(latest.hash, 'Practice hard.\n\n## An outside heading');
  assert.equal(invalid.outcome, 'not_saved');
  assert.equal(invalid.reason, 'invalid_section');
  assert.equal(await readFile(file, 'utf8'), after);

  const noSection = '# Learning\n\nPrivate sentinel prose.\n';
  await writeFile(file, noSection);
  const empty = await read();
  assert.equal(empty.text, '');
  assert.equal((await save(empty.hash, 'Ask better questions.')).outcome, 'saved_locally_pending_sync');
  const added = await readFile(file, 'utf8');
  assert.equal(added, noSection + '\n## Standard\n\nAsk better questions.\n');
  await writeFile(file, added + '\n## Standard\nPrivate sentinel duplicate.\n');
  await assert.rejects(read(), /Keep one matching heading/);
  const logs = JSON.stringify(f.harness.inspection.logEntries);
  assert.match(logs, /Obsidian rpc invalid_section/);
  assert.match(logs, /Obsidian rpc ambiguous_link/);
  assert.doesNotMatch(logs, /sentinel|Learning\.md|Ask better/);
});
