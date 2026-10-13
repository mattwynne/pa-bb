import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, unlink, access } from 'node:fs/promises';
import { RcloneProcess, safeEnvironment, COMMAND_TIMEOUTS, FLOCK_BINARY } from '../adapters/rclone-process.ts';
import { CloudError } from '../core/ports.ts';
import type { TransferProgress } from '../core/ports.ts';
const binary = process.env.RCLONE_TEST_BINARY;
function rcNoop(socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: '/rc/noop', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('rc unavailable')));
    });
    req.on('error', reject); req.end('{}');
  });
}
async function eventually(operation: () => Promise<void>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { await operation(); return; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  throw new Error('timed out waiting for generated native fixture');
}
test('subprocess environment excludes credentials and provider overrides', () => {
  process.env.RCLONE_CONFIG_PASS = 'sentinel-secret'; process.env.BB_TOKEN = 'sentinel-token';
  assert.equal(safeEnvironment().RCLONE_CONFIG_PASS, undefined); assert.equal(safeEnvironment().BB_TOKEN, undefined);
  delete process.env.RCLONE_CONFIG_PASS; delete process.env.BB_TOKEN;
});
test('commands retain stock retry defaults and bounded category-specific timeouts', () => {
  const runner = new RcloneProcess('/tmp/unused-defaults') as unknown as { flags(): string[] };
  const flags = runner.flags(); assert.ok(!flags.includes('--retries')); assert.ok(!flags.includes('--low-level-retries'));
  assert.deepEqual(COMMAND_TIMEOUTS, { listing: 300_000, transfer: 900_000, bisync: 1_200_000 });
  assert.equal(FLOCK_BINARY, '/usr/bin/flock');
});
test('real stock rclone uses a private socket, encrypted config and survives a clean restart', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-process-'); let process = new RcloneProcess(root, binary);
  try {
    await process.ensure();
    await process.call('config/create', { name: 'proof', type: 'local', parameters: { description: 'sentinel-private' }, opt: { nonInteractive: true } });
    assert.equal((await stat(root + '/control.sock')).mode & 0o777, 0o600);
    const encrypted = await readFile(root + '/state/rclone.conf', 'utf8');
    assert.match(encrypted, /RCLONE_ENCRYPT_V0:/); assert.doesNotMatch(encrypted, /sentinel-private/);
    await process.stop(); process = new RcloneProcess(root, binary); await process.ensure();
    assert.equal((await process.call('config/get', { name: 'proof' })).description, 'sentinel-private');
  } finally { await process.stop(); await rm(root, { recursive: true }); }
});
test('timeout cannot count a graceful zero exit as a successful operation', async () => {
  const runner = new RcloneProcess('/tmp/unused-synthetic-root') as unknown as { execute(binary: string, args: string[], capture: boolean, timeout: number): Promise<string> };
  await assert.rejects(runner.execute(process.execPath, ['-e', 'process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000)'], true, 300), error => { assert.ok(error instanceof CloudError); assert.equal(error.category, 'interrupted'); assert.deepEqual(error.evidence, { kind: 'command_timeout' }); return true; });
});
test('an encrypted config with a missing key is refused without generating a replacement', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-process-'); let runner = new RcloneProcess(root, binary);
  try {
    await runner.ensure(); await runner.stop(); await unlink(root + '/secrets/config.key');
    runner = new RcloneProcess(root, binary); await assert.rejects(runner.ensure());
    await assert.rejects(access(root + '/secrets/config.key'));
  } finally { await runner.stop(); await rm(root, { recursive: true }); }
});
test('real command-local stats stream measured progress without leaking raw records', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-stats-'); const runner = new RcloneProcess(root + '/worker', binary);
  const progress: TransferProgress[] = [];
  try {
    await mkdir(root + '/source'); await mkdir(root + '/target');
    await writeFile(root + '/source/sentinel-private-file', Buffer.alloc(24 * 1024 * 1024, 42));
    await runner.run(['copy', root + '/source', root + '/target', '--disable', 'Copy'], false, stats => progress.push(stats));
    assert.ok(progress.some(stats => stats.bytes > 0 && stats.totalBytes !== null && stats.bytes < stats.totalBytes));
    assert.ok(progress.length >= 2);
    assert.ok(progress.some(stats => stats.totalFiles === 1));
    assert.equal((await stat(root + '/target/sentinel-private-file')).size, 24 * 1024 * 1024);
    assert.doesNotMatch(JSON.stringify(progress), /sentinel|password|object|checking|transferring/);
  } finally { await runner.stop(); await rm(root, { recursive: true }); }
});
test('stats on a failed command never leak raw errors or turn failure into success', async () => {
  const runner = new RcloneProcess('/tmp/unused-stats-proof') as unknown as { execute(binary: string, args: string[], capture: boolean, timeout: number, report: (stats: TransferProgress) => void): Promise<string> };
  const progress: TransferProgress[] = [];
  const record = { msg: 'sentinel-private-error', object: 'sentinel-file', stats: { bytes: 4, totalBytes: 4, transfers: 1, totalTransfers: 1, lastError: 'sentinel-password' } };
  await assert.rejects(runner.execute(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(JSON.stringify(record) + '\n')}); process.exit(7);`], false, 5000, stats => progress.push(stats)), /recovery_required/);
  assert.equal(progress.length, 1); assert.doesNotMatch(JSON.stringify(progress), /sentinel/);
});
test('command exit codes, output limits, signals and spawn failures retain only bounded evidence', async () => {
  const runner = new RcloneProcess('/tmp/unused-evidence') as unknown as { execute(binary: string, args: string[], capture: boolean, timeout: number): Promise<string> };
  for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 42]) {
    await assert.rejects(runner.execute(process.execPath, ['-e', `process.stderr.write('sentinel-account-body'); process.exit(${code});`], false, 3000), error => { assert.ok(error instanceof CloudError); assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: code <= 10 ? code : null }); assert.doesNotMatch(JSON.stringify(error.evidence), /sentinel/); return true; });
  }
  for (const [script, kind] of [['process.stdout.write("x".repeat(5 * 1024 * 1024))', 'command_output_limit'], ['process.kill(process.pid, "SIGTERM")', 'command_signal']] as const) {
    await assert.rejects(runner.execute(process.execPath, ['-e', script], true, 3000), error => { assert.ok(error instanceof CloudError); assert.deepEqual(error.evidence, { kind }); return true; });
  }
  await assert.rejects(runner.execute('/tmp/nonexistent-sentinel-private-command', [], false, 3000), error => { assert.ok(error instanceof CloudError); assert.deepEqual(error.evidence, { kind: 'command_start' }); assert.doesNotMatch(JSON.stringify(error), /sentinel/); return true; });
});
test('bisync and generic exit codes use their documented command contexts', async () => {
  const runner = new RcloneProcess('/tmp/unused-context') as unknown as { execute(binary: string, args: string[], capture: boolean, timeout: number, report?: undefined, context?: 'bisync' | 'generic'): Promise<string> };
  const exit = (code: number, context: 'bisync' | 'generic') => runner.execute(process.execPath, ['-e', `process.exit(${code})`], false, 3000, undefined, context);
  await assert.rejects(exit(1, 'bisync'), (error: unknown) => error instanceof CloudError && error.category === 'sync_failed');
  await assert.rejects(exit(7, 'bisync'), (error: unknown) => error instanceof CloudError && error.category === 'recovery_required');
  await assert.rejects(exit(2, 'generic'), (error: unknown) => error instanceof CloudError && error.category === 'configuration');
  await assert.rejects(exit(8, 'generic'), (error: unknown) => error instanceof CloudError && error.category === 'capacity');
  await assert.rejects(exit(1, 'generic'), (error: unknown) => error instanceof CloudError && error.category === 'sync_failed');
});
test('real stock-rclone missing-directory failure provides an exit code without disclosing paths', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-exit-proof-'); const runner = new RcloneProcess(root + '/worker', binary);
  try {
    await assert.rejects(runner.run(['lsjson', root + '/sentinel-missing-private-directory'], true), error => { assert.ok(error instanceof CloudError); assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: 3 }); assert.doesNotMatch(JSON.stringify(error), /sentinel/); return true; });
  } finally { await runner.stop(); await rm(root, { recursive: true }); }
});
test('an unlocked worker lock file is harmless but a live worker is exclusive', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-process-'); const process = new RcloneProcess(root, binary);
  const contender = new RcloneProcess(root, binary);
  try { await writeFile(root + '/worker.lock', ''); await process.ensure(); await assert.rejects(contender.ensure(), /busy/); await contender.stop(); await process.call('rc/noop', {}); }
  finally { await contender.stop(); await process.stop(); await rm(root, { recursive: true }); }
});
test('the same contender retries OS acquisition after the live owner exits', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-process-retry-'); const owner = new RcloneProcess(root, binary); const contender = new RcloneProcess(root, binary);
  try {
    await owner.ensure(); await assert.rejects(contender.ensure(), /busy/);
    await owner.stop(); await contender.ensure(); await contender.call('rc/noop', {});
  } finally { await contender.stop(); await owner.stop(); await rm(root, { recursive: true }); }
});
test('a candidate defers to a live same-parent legacy daemon without killing or rebinding it', { skip: !binary }, async () => {
  const root = await mkdtemp('/tmp/icloud-process-legacy-'); const worker = root + '/worker'; const socket = worker + '/control.sock';
  await mkdir(worker); await writeFile(worker + '/worker.lock', '');
  const legacy = spawn(binary!, ['rcd', '--rc-addr', `unix://${socket}`, '--rc-no-auth', '--config', '/dev/null'], { stdio: 'ignore' });
  const candidate = new RcloneProcess(worker, binary);
  try {
    await eventually(() => rcNoop(socket));
    const markerBefore = await stat(worker + '/worker.lock'); const socketBefore = await stat(socket);
    await assert.rejects(candidate.ensure(), /busy/);
    await rcNoop(socket); assert.equal(legacy.exitCode, null);
    const markerAfter = await stat(worker + '/worker.lock'); const socketAfter = await stat(socket);
    assert.deepEqual([markerAfter.dev, markerAfter.ino], [markerBefore.dev, markerBefore.ino]);
    assert.deepEqual([socketAfter.dev, socketAfter.ino], [socketBefore.dev, socketBefore.ino]);
    legacy.kill('SIGINT'); await new Promise(resolve => legacy.once('close', resolve));
    await unlink(socket).catch(() => {}); await unlink(worker + '/worker.lock');
    await candidate.ensure(); await candidate.call('rc/noop', {});
  } finally { legacy.kill('SIGKILL'); await candidate.stop(); await rm(root, { recursive: true }); }
});
test('a command child retains OS exclusivity after its parent crashes', { skip: !binary, timeout: 15_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-process-crash-'); const helper = root + '/parent.mts';
  const module = new URL('../adapters/rclone-process.ts', import.meta.url).href;
  await writeFile(helper, `import { RcloneProcess } from ${JSON.stringify(module)};\nconst runner = new RcloneProcess(process.argv[2], process.argv[3]);\nawait runner.ensure(); process.stdout.write('ready\\n');\nawait runner.execute(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], false, 10000);\n`);
  const parent = spawn(process.execPath, ['--import', 'tsx', helper, root + '/worker', binary!], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise<void>((resolve, reject) => { parent.stdout!.once('data', chunk => String(chunk).includes('ready') ? resolve() : reject(new Error('not ready'))); parent.once('exit', () => reject(new Error('parent exited'))); });
    await new Promise(resolve => setTimeout(resolve, 200)); parent.kill('SIGKILL');
    await new Promise(resolve => parent.once('close', resolve));
    const blocked = new RcloneProcess(root + '/worker', binary); await assert.rejects(blocked.ensure(), /busy/); await blocked.stop();
    await new Promise(resolve => setTimeout(resolve, 3200));
    const recovered = new RcloneProcess(root + '/worker', binary); await recovered.ensure(); await recovered.stop();
  } finally { parent.kill('SIGKILL'); await rm(root, { recursive: true }); }
});
