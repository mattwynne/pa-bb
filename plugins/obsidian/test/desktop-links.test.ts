import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { DesktopLinks } from '../adapters/desktop-links.ts';
import { diagnosticLogger } from '../adapters/diagnostic-log.ts';
import { plugin } from '../server.ts';

test('Desktop shares one private process, cleans it up, and redacts transport failures', async t => {
  const owner = await mkdtemp('/tmp/pa-desktop-test-');
  t.after(() => rm(owner, { recursive: true, force: true }));
  const trace = join(owner, 'trace');
  const desktop = join(owner, 'desktop'), cli = join(owner, 'cli');
  const shared = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const profile = path.join(process.env.XDG_CONFIG_HOME, 'obsidian');
const config = JSON.parse(fs.readFileSync(path.join(profile, 'obsidian.json')));
const trace = ${JSON.stringify(trace)};
assert.deepEqual(Object.keys(config.vaults), ['fixture']);
assert.equal(fs.statSync(process.cwd()).mode & 0o777, 0o700);
assert.equal(process.env.ELECTRON_DISABLE_SANDBOX, undefined);
`;
  await writeFile(desktop, shared + `
assert.ok(!process.argv.some(arg => arg.includes('no-sandbox')));
fs.appendFileSync(trace, JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + '\\n');
require('node:net').createServer().listen(path.join(process.env.XDG_RUNTIME_DIR, '.obsidian-cli.sock'));
`, { mode: 0o700 });
  await writeFile(cli, shared + `
const [selector, command, ...args] = process.argv.slice(2);
assert.equal(selector, 'vault=fixture');
if (command === 'eval' && args[0].includes('window.close')) {
  const row = fs.readFileSync(trace, 'utf8').trim().split('\\n').map(JSON.parse).at(-1);
  process.kill(row.pid, 'SIGTERM');
  console.log('=> closing');
} else if (command === 'eval') {
  console.log('=> ' + JSON.stringify({ directory: config.vaults.fixture.path, restricted: true, updateLinks: true }));
} else if (args.includes('path=Lost.md')) {
  console.error('sentinel-private path/token'); process.exitCode = 1;
} else console.log(JSON.stringify([{ file: 'Source.md' }]));
`, { mode: 0o700 });
  const logs: string[] = [];
  const runner = new DesktopLinks({ desktop, cli }, diagnosticLogger(message => logs.push(message)));
  t.after(() => runner.stop());
  const target = { id: 'fixture', directory: owner, identity: 'fixture-directory' };
  const check = async () => {};
  await runner.run(target, { kind: 'start' }, check);
  assert.deepEqual(await runner.run(target, { kind: 'backlinks', path: 'Target.md' }, check),
    { kind: 'backlinks', value: [{ file: 'Source.md' }] });
  await assert.rejects(runner.run(target, { kind: 'backlinks', path: 'Lost.md' }, check), /unavailable/);
  assert.deepEqual(logs, ['Obsidian desktop_command unavailable']);
  assert.doesNotMatch(JSON.stringify(logs), /sentinel|token/);
  const first = JSON.parse((await readFile(trace, 'utf8')).trim());
  process.kill(first.pid, 'SIGTERM');
  for (let i = 0; runner.running && i < 50; i++) await delay(20);
  await runner.run(target, { kind: 'start' }, check);
  const rows = (await readFile(trace, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].cwd, rows[1].cwd);
  await assert.rejects(lstat(rows[0].cwd), /ENOENT/);
  const replacement = new DesktopLinks({ desktop, cli }, () => {});
  t.after(() => replacement.stop());
  const activating = replacement.run(target, { kind: 'start' }, check);
  await delay(50);
  assert.equal(replacement.running, false);
  assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 2);
  await runner.stop();
  await assert.rejects(lstat(rows[1].cwd), /ENOENT/);
  await activating;
  assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, 3);
});

const managed = process.env.PA_OBSIDIAN_TEST_MANAGED === '1';
const binaries = { desktop: process.env.PA_OBSIDIAN_TEST_DESKTOP, cli: process.env.PA_OBSIDIAN_TEST_CLI };
test('normal tools use native Desktop against a disposable vault', {
  skip: !managed && (!binaries.desktop || !binaries.cli), timeout: managed ? 220_000 : 40_000,
}, async t => {
  const owner = await mkdtemp('/tmp/pa-native-desktop-');
  const root = join(owner, 'vault');
  await Promise.all(['.obsidian', 'Active', 'Done', 'OldFolder', 'Elsewhere', 'Active/Support/Nested'].map(folder => mkdir(join(root, folder), { recursive: true })));
  await writeFile(join(root, '.obsidian/app.json'), '{"alwaysUpdateLinks":true}');
  const original = '\r\n# Target\r\n\r\n- [ ] item\r\n';
  await writeFile(join(root, 'Active/Target.md'), original);
  const longPath = 'Active/Long.md';
  const longFile = join(root, longPath);
  const longNote = '---\r\nstatus: ready # keep this\r\nlabel: \'café\'\r\n---\r\n\r\n' +
    'sentinel-unchanged 🌲 ' + 'a'.repeat(61_000) + '\r\n\r\n- [ ] long task\r\n';
  assert.ok(2 * Buffer.byteLength(JSON.stringify(longNote)) > 100_000);
  await writeFile(longFile, longNote);
  await writeFile(join(root, 'Elsewhere/Target.md'), '# Separate namesake');
  await writeFile(join(root, 'Occupied.md'), 'sentinel-occupied');
  await writeFile(join(root, 'OldFolder/Child.md'), '# Child\n');
  await writeFile(join(root, 'Active/Support/Visible.md'), '# Visible');
  await writeFile(join(root, 'Active/Support/Nested/Deep.md'), '---\nstatus: [invalid\n---\n# Deep');
  await writeFile(join(root, 'Malformed.md'), '---\nstatus: [invalid\n---\n# Malformed');
  await writeFile(join(root, 'Reference.md'), '[[Active/Target]] and [[OldFolder/Child]]\n');
  const id = 'fixture';
  const cli = join(owner, 'observe-cli');
  const fault = join(owner, 'next-write-fault');
  if (!managed) await writeFile(cli, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, unlinkSync, appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let loseReply = false;
if (args[2]?.includes('app.vault.process(file') && args[2].includes(${JSON.stringify(longPath)})) {
  if (Buffer.byteLength(args[2]) > 4096 || args[2].includes('sentinel-unchanged')) process.exit(2);
  const fault = ${JSON.stringify(fault)};
  if (existsSync(fault)) {
    const mode = readFileSync(fault, 'utf8');
    unlinkSync(fault);
    if (mode === 'stale') appendFileSync(${JSON.stringify(longFile)}, 'Concurrent change.\\r\\n');
    loseReply = mode === 'lost-reply';
  }
}
const result = spawnSync(${JSON.stringify(binaries.cli)}, args);
if (loseReply && result.status === 0) {
  console.error('sentinel-private transport output');
  process.exit(1);
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`, { mode: 0o700 });
  const { bb, harness } = createFakePluginHost({ pluginId: 'obsidian', settings: managed ? {} : {
    desktopBinary: binaries.desktop!, desktopCli: cli, desktopVaultId: id,
  } });
  let denyGrant = false, denyAfter = Infinity, configureCount = 0, grantCount = 0;
  const sdk = { ...bb.sdk, plugins: {
    async list() { return { plugins: [{ id: 'icloud', enabled: true, status: 'running' }] }; },
    async callRpc({ method, input, outputSchema }: { method: string; input: { revision: number }; outputSchema: { parse(value: unknown): unknown } }) {
      const info = await lstat(root, { bigint: true });
      if (method === 'mirrorConfigure') configureCount++;
      if (method === 'mirrorDirectoryGrant') {
        grantCount++;
        if (denyGrant || grantCount >= denyAfter) throw new Error('sentinel denied grant');
      }
      const replies: Record<string, unknown> = {
        status: { mirrorFileAccessVersion: 1, mirrorAccessVersion: 3, available: true, connected: false, challenge: null, mirrors: [
          { id, folder: { name: 'Fixture' }, initialized: true, enabled: false, phase: 'paused', lastSuccess: null, failure: null, filesystem: 'ready',
            local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } },
        ] },
        mirrorConfigure: { ok: true, value: { revision: input?.revision } },
        mirrorDirectory: { directory: root },
        mirrorDirectoryGrant: { directory: root, rootDev: String(info.dev), rootIno: String(info.ino) },
        fileReceipts: { ok: true, value: [] },
      };
      return outputSchema.parse(replies[method]);
    },
  } } as unknown as BbPluginApi['sdk'];
  await plugin({ ...bb, sdk });
  t.after(async () => { await harness.lifecycle.dispose(); await rm(owner, { recursive: true, force: true }); });
  const connected = await harness.behavior.callRpc('connect', { vaultId: id }) as any;
  assert.equal(connected.desktop.mode, managed ? 'managed' : 'manual');
  const tool = async (name: string, input: object, category?: string) => {
    if (name === 'move_note' || name === 'move_folder') input = { operationId: randomUUID(), ...input };
    const result = await harness.behavior.callAgentTool('obsidian_' + name,
      name === 'recover_receipts' ? input : { vaultId: id, ...input }, { threadId: 'test' });
    assert.notEqual(typeof result, 'string');
    if (typeof result === 'string') throw new Error('bad test reply');
    const row = JSON.parse((result.content[0] as { text: string }).text);
    if (category) assert.equal(row.category, category);
    else assert.equal(result.isError, undefined, JSON.stringify(row));
    return row;
  };
  const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'inventory-test' } };
  const vaultInventory = async () => harness.behavior.callRpc('vaultInventory', { vaultId: id, root: '', fields: ['status', 'title'] }, caller) as Promise<any>;
  const first = await tool('read_note', { path: 'Active/Target.md' });
  assert.equal(first.text, original);
  assert.equal(first.hash, createHash('sha256').update(original).digest('hex'));
  const admitted = await vaultInventory();
  assert.equal(admitted.notes.find((row: any) => row.path === 'Malformed.md').malformed, true);
  assert.deepEqual(admitted.source, { vaultId: id, name: 'Fixture', lastSuccess: null, cloudConnected: false, enabled: false, phase: 'paused', failure: null });
  const grantsBefore = grantCount;
  const scoped = await harness.behavior.callRpc('vaultInventory',
    { vaultId: id, root: '', metadataFolders: ['Active'], metadataDepth: 2, fields: ['status'] }, caller) as typeof admitted;
  assert.ok(grantCount >= grantsBefore + 2, 'the metadata query reauthorized the exact directory before and after the read');
  assert.equal(configureCount, 1, 'unchanged configuration is already confirmed');
  assert.equal(scoped.notes.find((row: any) => row.path === 'Active/Support/Nested/Deep.md').malformed, false);
  assert.equal(scoped.incomplete, false);
  const watchInput = { vaultId: id, folders: ['Active', 'Done'] };
  await assert.rejects(harness.behavior.callRpc('inventoryRevision', watchInput, caller), /Only GTD/);
  const probe = () => harness.behavior.callRpc('inventoryRevision', watchInput, {
    experimental_caller: { kind: 'plugin', pluginId: 'gtd' },
  }) as Promise<string | null>;
  let revision = await probe();
  assert.match(revision ?? '', /^[a-f0-9-]{36}:0$/);
  const observed = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const next = await probe();
      if (next && next !== revision) { revision = next; return; }
      await delay(100);
    }
    assert.fail('Desktop did not publish an indexed inventory change');
  };
  const added = join(root, 'Active/Watched.md');
  await writeFile(added, '---\nstatus: active\ntitle: Before\n---\n# Watched\n');
  await observed();
  assert.equal((await vaultInventory()).notes.find((note: any) => note.path === 'Active/Watched.md')?.properties.status, 'active');
  await writeFile(added, '---\nstatus: active\ntitle: After\n---\n# Watched\n');
  await observed();
  assert.equal((await vaultInventory()).notes.find((note: any) => note.path === 'Active/Watched.md')?.properties.title, 'After');
  await rename(added, join(root, 'Elsewhere/Watched.md'));
  await observed();
  assert.equal((await vaultInventory()).notes.some((note: any) => note.path === 'Active/Watched.md'), false);
  const returned = join(root, 'Done/Renamed.md');
  await rename(join(root, 'Elsewhere/Watched.md'), returned);
  await observed();
  assert.equal((await vaultInventory()).notes.find((note: any) => note.path === 'Done/Renamed.md')?.properties.title, 'After');
  await unlink(returned);
  await observed();
  assert.equal((await vaultInventory()).notes.some((note: any) => note.path === 'Done/Renamed.md'), false);
  await rename(join(root, 'Active/Support/Visible.md'), join(root, 'Active/Support/Arrived.md'));
  const refreshed = await harness.behavior.callRpc('vaultInventory',
    { vaultId: id, root: '', metadataFolders: ['Active'], metadataDepth: 2, fields: ['status'] }, caller) as typeof admitted;
  const paths = refreshed.notes.map((row: any) => row.path);
  assert.ok(refreshed.incomplete || paths.includes('Active/Support/Arrived.md'));
  assert.ok(refreshed.incomplete || !(paths.includes('Active/Support/Visible.md') && paths.includes('Active/Support/Arrived.md')));
  assert.equal((await tool('resolve_link', { path: 'Reference.md', link: '[[Target]]' })).status, 'ambiguous');
  assert.deepEqual((await tool('get_note_metadata', { path: 'Active/Target.md', backlinks: true })).backlinkSources, ['Reference.md']);
  assert.deepEqual((await tool('search_notes', { text: 'missing-unique-native-search-query' })).results, []);
  assert.equal((await tool('search_notes', { text: 'item' })).results.find((row: any) => row.path === 'Active/Target.md').lineStart, 4);
  assert.equal((await tool('list_tasks', { path: 'Active/Target.md' })).results[0].marker, ' ');
  const task = await tool('edit_note', { path: 'Active/Target.md', expectedHash: first.hash, task: { line: 4, marker: 'x' } });
  assert.equal(task.receipt.outcome, 'saved_locally_pending_sync');
  const updated = await tool('read_note', { path: 'Active/Target.md' });
  await tool('update_properties', { path: 'Active/Target.md', expectedHash: updated.hash,
    set: { status: Array(7).fill('\\'.repeat(4000)) } }, 'capacity');
  assert.deepEqual(await readFile(join(root, 'Active/Target.md')), Buffer.from(original.replace('[ ]', '[x]')));
  const properties = await tool('update_properties', { path: 'Active/Target.md', expectedHash: updated.hash, set: { status: 'active' } });
  assert.equal(properties.receipt.outcome, 'saved_locally_pending_sync');
  assert.equal((await tool('search_notes', { pathGlob: 'Active/Target.md', properties: [{ key: 'status', equals: 'active' }], mode: 'count' })).totalMatches, 1);
  assert.equal((await tool('move_note', { path: 'Active/Target.md', destination: 'Occupied.md' })).outcome, 'not_moved');
  assert.equal(await readFile(join(root, 'Occupied.md'), 'utf8'), 'sentinel-occupied');
  const moved = await tool('move_note', { path: 'Active/Target.md', destination: 'Done/Target.md' });
  assert.equal(moved.outcome, 'moved_locally_pending_sync');
  const folder = await tool('move_folder', { path: 'OldFolder', destination: 'Done/NewFolder' });
  assert.equal(folder.outcome, 'moved_locally_pending_sync');
  assert.match(await readFile(join(root, 'Reference.md'), 'utf8'), /\[\[Done\/Target\]\].*\[\[(?:Done\/NewFolder\/)?Child\]\]/);
  assert.equal((await tool('resolve_link', { path: 'Reference.md', link: '[[Child]]' })).target, 'Done/NewFolder/Child.md');
  const before = await tool('read_note', { path: 'Done/Target.md' });
  const checkedSave = await tool('update_properties', { path: 'Done/Target.md', expectedHash: before.hash, set: { status: 'done', done: true } });
  assert.equal(checkedSave.receipt.outcome, 'saved_locally_pending_sync');
  assert.equal((await tool('move_status', { operationId: moved.operationId })).outcome, 'moved_locally_pending_sync');
  await rename(join(root, 'Done/Target.md'), join(root, 'Done/Substituted.md'));
  await writeFile(join(root, 'Done/Target.md'), original);
  assert.equal((await tool('move_status', { operationId: moved.operationId })).outcome, 'uncertain');
  const page = await tool('search_notes', { pathGlob: '**/*.md', limit: 1 });
  assert.ok(page.nextCursor);
  denyGrant = true;
  await tool('search_notes', { cursor: page.nextCursor }, 'cursor_expired');
  denyGrant = false;
  denyAfter = grantCount + 2;
  await tool('read_note', { path: 'Reference.md' }, 'source_unavailable');
  denyAfter = Infinity;
  assert.equal((await tool('read_note', { path: 'Reference.md' })).complete, true);

  const readLong = async (expected: string) => {
    let page = await tool('read_note', { path: longPath });
    assert.equal(page.editReady, false);
    assert.ok(page.nextCursor);
    let text = page.text;
    while (page.nextCursor) {
      page = await tool('read_note', { path: longPath, cursor: page.nextCursor });
      text += page.text;
    }
    assert.equal(page.text, '');
    assert.equal(page.editReady, true);
    assert.equal(text, expected);
    return page.hash as string;
  };
  const firstPage = await tool('read_note', { path: longPath });
  await tool('update_properties', { path: longPath, expectedHash: firstPage.hash,
    set: { status: 'active' } }, 'complete_read_required');
  const longHash = await readLong(longNote);
  await tool('update_properties', { path: longPath, expectedHash: longHash,
    set: { extra: Array(2).fill('b'.repeat(4000)) } }, 'parser_limit');
  const longProperties = await tool('update_properties', { path: longPath, expectedHash: longHash, set: { status: 'active' } });
  const changed = longNote.replace('status: ready', 'status: "active"');
  assert.equal(longProperties.receipt.outcome, 'saved_locally_pending_sync');
  assert.deepEqual(await readFile(longFile), Buffer.from(changed));
  const changedHash = await readLong(changed);
  const longTask = await tool('edit_note', { path: longPath, expectedHash: changedHash, task: { line: 8, marker: 'x' } });
  const finished = changed.replace('[ ]', '[x]');
  assert.equal(longTask.receipt.outcome, 'saved_locally_pending_sync');
  assert.deepEqual(await readFile(longFile), Buffer.from(finished));

  if (!managed) {
    const patch = (expectedHash: string, status: string) => harness.behavior.callRpc('writeProperties', {
      vaultId: id, path: longPath, expectedHash, set: { status }, operationId: randomUUID(),
    }, { experimental_caller: { kind: 'plugin', pluginId: 'gtd' } }) as Promise<{ operationId: string; outcome: string }>;
    await writeFile(fault, 'stale');
    const stale = await patch(longTask.receipt.hash, 'stale edit');
    assert.equal(stale.outcome, 'not_saved');
    const current = finished + 'Concurrent change.\r\n';
    assert.deepEqual(await readFile(longFile), Buffer.from(current));
    assert.equal((await tool('recover_receipts', { request: { action: 'inspect', operationId: stale.operationId } })).status, 'not_applied');

    await writeFile(fault, 'lost-reply');
    const interrupted = await patch(await readLong(current), 'lost reply');
    assert.equal(interrupted.outcome, 'uncertain');
    await assert.rejects(lstat(fault), { code: 'ENOENT' });
    const applied = current.replace('status: "active"', 'status: "lost reply"');
    assert.deepEqual(await readFile(longFile), Buffer.from(applied));
    assert.deepEqual(await tool('recover_receipts', { request: { action: 'inspect', operationId: interrupted.operationId } }), {
      operationId: interrupted.operationId, kind: 'save', status: 'unresolved', checks: [], blocker: 'missing_operation_specific_evidence',
    });
    await tool('update_properties', { path: longPath, expectedHash: await readLong(applied), set: { status: 'retry' } }, 'busy');
    assert.deepEqual(await readFile(longFile), Buffer.from(applied));
  }
  assert.doesNotMatch(JSON.stringify(harness.inspection.logEntries), /sentinel/);
});
