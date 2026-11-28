// Opt-in generated alias remote only: exercise the production BB wiring from
// fresh selection through initial download, local note admission and normal sync.
import test from 'node:test';
const decode = (base64: string) => Buffer.from(base64, 'base64').toString();

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { MemoryState } from './fakes.ts';

const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_RUNTIME_NATIVE === '1';
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'obsidian' } };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const operationId = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };

test('fresh wired selections complete native initial download, register locally and use ordinary subsequent sync', { skip: !enabled, timeout: 60000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const root = join(dirname(host.bb.storage.database().name), 'sync');
  const generated = await mkdtemp('/tmp/icloud-initial-generated-');
  const remote = join(generated, 'remote');
  const repository = new MemoryState(); repository.value.connected = true;
  const worker = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!);
  const commands: string[][] = [];
  const run = worker.run.bind(worker);
  worker.run = async (args, capture, report) => { commands.push([...args]); return run(args, capture, report); };
  let started = false;
  try {
    for (const name of ['Downloads', 'Desktop']) {
      await mkdir(join(remote, name), { recursive: true });
      await writeFile(join(remote, name, 'Generated.md'), `Initial ${name}`);
      // Keep a stable file so changing the note is not rclone's deliberate
      // "all files changed" safety abort for a one-file fixture.
      await writeFile(join(remote, name, 'Unchanged.md'), 'Stable generated fixture');
    }
    await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote }, opt: { nonInteractive: true } });
    // No initialized fixtures, handcrafted marker or injected runtime/provider:
    // server.ts constructs the exact production callback chain.
    await plugin(host.bb, { repository, worker }); started = true;
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<any>;
    // Drain startup connection verification without racing the exclusive enable.
    for (let i = 0; i < 100; i++) {
      if ((await rpc('status', null)).connectionCheck !== 'unknown') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await rpc('status', null)).connectionCheck, 'verified');
    const folders = await rpc('browse', { parent: null });
    const ids: string[] = [];
    for (const name of ['Downloads', 'Desktop']) {
      const selection = await rpc('select', { folderId: folders.find((folder: any) => folder.name === name).id });
      const selected = selection.mirrors.find((mirror: any) => mirror.folder.name === name);
      assert.equal(selected.initialized, false); assert.equal(selected.enabled, false);
      assert.equal(selected.local.available, false);
      const result = await rpc('enable', { id: selected.id });
      const mirror = result.mirrors.find((item: any) => item.id === selected.id);
      assert.equal(await readFile(join(root, 'mirrors', mirror.id, 'Generated.md'), 'utf8'), `Initial ${name}`);
      assert.equal(await readFile(join(root, 'baselines', mirror.id, 'initialized'), 'utf8'), '1');
      assert.equal(mirror.failure, null, 'a successful native download must not fail registration at verifying');
      assert.equal(mirror.initialized, true); assert.equal(mirror.enabled, true);
      assert.equal(mirror.blocker, null); assert.equal(mirror.phase, 'ready');
      assert.equal(mirror.local.available, true); assert.ok(mirror.lastSuccess);
      ids.push(mirror.id);
    }
    const note = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input, caller) as Promise<any>;
    assert.equal((await note('mirrorConfigure', { version: 1, revision: 1, mirrorIds: ids })).ok, true);
    for (const [index, id] of ids.entries()) {
      const name = ['Downloads', 'Desktop'][index];
      const target = { version: 1, revision: 1, mirrorId: id, path: 'Generated.md' };
      assert.equal(decode((await note('fileRead', target)).value.base64), `Initial ${name}`);
      const text = `Saved locally in ${name}`;
      assert.equal((await note('fileCommit', { ...target, operationId: operationId(), kind: 'replace', expectedHash: hash(`Initial ${name}`), base64: Buffer.from(text).toString("base64") })).value.hash, hash(text));
      assert.equal(decode((await note('fileRead', target)).value.base64), text);
    }
    // Local publication is asynchronous; a save receipt is not a claim that
    // native bisync has already enumerated those bytes.
    for (const [index, id] of ids.entries()) {
      const expected = `Saved locally in ${['Downloads', 'Desktop'][index]}`;
      for (let i = 0; i < 100; i++) {
        if (await readFile(join(root, 'mirrors', id, 'Generated.md'), 'utf8') === expected) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(await readFile(join(root, 'mirrors', id, 'Generated.md'), 'utf8'), expected);
    }
    await host.harness.behavior.runSchedule('selected-folder-sync');
    for (const name of ['Downloads', 'Desktop']) assert.equal(await readFile(join(remote, name, 'Generated.md'), 'utf8'), `Saved locally in ${name}`);
    for (const name of ['Downloads', 'Desktop']) await writeFile(join(remote, name, 'Generated.md'), `A subsequent remote change in ${name}`);
    await host.harness.behavior.runSchedule('selected-folder-sync');
    for (const [index, id] of ids.entries()) assert.equal(decode((await note('fileRead', { version: 1, revision: 1, mirrorId: id, path: 'Generated.md' })).value.base64), `A subsequent remote change in ${['Downloads', 'Desktop'][index]}`);
    assert.equal(commands.length, 6);
    assert.equal(commands.filter(args => args.includes('--resync')).length, 2, 'only fresh initial enables may resync');
    assert.ok(commands.every(args => args[0] === 'bisync' && args.includes('--recover')));
    const diagnostics = await rpc('diagnostics', {});
    assert.equal(diagnostics.runs.length, 6);
    assert.ok(diagnostics.runs.every((item: any) => item.outcome === 'succeeded'));
    assert.doesNotMatch(JSON.stringify(host.harness.inspection.logEntries), /Generated\.md|Saved locally|Initial Downloads/);
  } finally {
    if (started) await host.harness.lifecycle.dispose();
    else { await worker.stop(); await host.harness.lifecycle.dispose(); }
    await rm(generated, { recursive: true, force: true });
  }
});
