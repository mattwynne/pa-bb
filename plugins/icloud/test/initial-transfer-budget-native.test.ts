// Generated alias remote only. Reproduce a >256 MiB first download through
// supported fresh-mirror recovery, retaining the previous partial mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { MemoryState } from './fakes.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_RUNTIME_NATIVE === '1';

test('fresh recovery downloads more than 256 MiB, registers, and keeps the failed partial mirror unchanged', { skip: !enabled, timeout: 90000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'icloud' });
  const root = join(dirname(host.bb.storage.database().name), 'sync');
  const generated = await mkdtemp('/tmp/icloud-initial-budget-');
  const remote = join(generated, 'remote');
  const oldId = 'previous-partial'; const name = 'Generated Transcripts';
  const folder = { id: Buffer.from(name).toString('base64url'), name, ancestors: [] };
  const repository = new MemoryState(); repository.value.connected = true;
  repository.value.mirrors.push({ id: oldId, folder, initialized: false, enabled: false, phase: 'failed', failure: 'recovery_required', blocker: 'initialization', lastSuccess: null });
  // Faster test-only bandwidth; production remains limited to 8 MiB/s.
  const worker = new RcloneProcess(root, process.env.RCLONE_TEST_BINARY!, '64M');
  const commands: string[][] = []; const run = worker.run.bind(worker);
  worker.run = async (args, capture, report) => { commands.push([...args]); return run(args, capture, report); };
  let started = false;
  try {
    await mkdir(join(remote, name), { recursive: true });
    const bytes = 260 * 1024 * 1024;
    await writeFile(join(remote, name, 'generated.bin'), ''); await truncate(join(remote, name, 'generated.bin'), bytes);
    await writeFile(join(remote, name, 'Stable.md'), 'Stable generated fixture');
    const previous = join(root, 'mirrors', oldId); const baseline = join(root, 'baselines', oldId);
    await mkdir(previous, { recursive: true, mode: 0o700 }); await mkdir(baseline, { recursive: true, mode: 0o700 });
    await writeFile(join(previous, 'Unsent.md'), 'Preserve these previous local bytes');
    await writeFile(join(baseline, 'preparing'), '', { mode: 0o600 });
    const before = { local: await stat(previous), baseline: await stat(baseline) };
    await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote }, opt: { nonInteractive: true } });
    await plugin(host.bb, { repository, worker }); started = true;
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input) as Promise<any>;
    for (let i = 0; i < 100 && (await rpc('status', null)).connectionCheck === 'unknown'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await rpc('status', null)).connectionCheck, 'verified');
    const result = await rpc('rebuild', { id: oldId });
    const fresh = result.mirrors.find((m: any) => m.id !== oldId);
    assert.equal(fresh.failure, null, 'initial downloads larger than the ordinary 256 MiB allowance must finish');
    assert.equal(fresh.initialized, true); assert.equal(fresh.phase, 'ready'); assert.equal(fresh.local.available, true);
    assert.equal((await stat(join(root, 'mirrors', fresh.id, 'generated.bin'))).size, bytes);
    assert.equal(await readFile(join(root, 'baselines', fresh.id, 'initialized'), 'utf8'), '1');
    const retained = result.mirrors.find((m: any) => m.id === oldId);
    assert.equal(retained.phase, 'retained'); assert.equal(retained.enabled, false);
    assert.equal(await readFile(join(previous, 'Unsent.md'), 'utf8'), 'Preserve these previous local bytes');
    assert.equal((await stat(previous)).ino, before.local.ino); assert.equal((await stat(baseline)).ino, before.baseline.ino);
    assert.equal(await readFile(join(baseline, 'preparing'), 'utf8'), '');
    await assert.rejects(readFile(join(baseline, 'initialized')));
    await host.harness.behavior.runSchedule('selected-folder-sync');
    assert.equal(commands.length, 2);
    assert.equal(commands[0][commands[0].indexOf('--max-transfer') + 1], '2G');
    assert.equal(commands[1][commands[1].indexOf('--max-transfer') + 1], '256M');
    assert.equal(commands.filter(args => args.includes('--resync')).length, 1);
    assert.ok(commands.every(args => !args.includes('--force') && args[2] !== previous));
    assert.equal((await rpc('status', null)).mirrors.find((m: any) => m.id === fresh.id).failure, null);
  } finally {
    if (!started) await worker.stop();
    await host.harness.lifecycle.dispose(); await rm(generated, { recursive: true, force: true });
  }
});
