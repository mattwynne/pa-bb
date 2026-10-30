import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, unlink, access, chmod } from 'node:fs/promises';
import { RcloneProcess, safeEnvironment, COMMAND_TIMEOUTS, FLOCK_BINARY } from '../adapters/rclone-process.ts';
import { CloudError } from '../core/ports.ts';
import type { TransferProgress } from '../core/ports.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
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
  await assert.rejects(exit(7, 'bisync'), (error: unknown) => error instanceof CloudError && error.category === 'recovery_required' && error.evidence?.kind === 'command_exit' && error.evidence.native === 'unknown_fatal');
  await assert.rejects(exit(2, 'generic'), (error: unknown) => error instanceof CloudError && error.category === 'configuration');
  await assert.rejects(exit(8, 'generic'), (error: unknown) => error instanceof CloudError && error.category === 'capacity');
  await assert.rejects(exit(1, 'generic'), (error: unknown) => error instanceof CloudError && error.category === 'sync_failed');
});
test('run without progress still requests native JSON for bisync, without stats or generic flag changes', async () => {
  const root = await mkdtemp('/tmp/icloud-run-json-'); const executable = root + '/fake-rclone.cjs';
  const retry = { time: '2026-01-01T00:00:00Z', level: 'error', msg: 'Bisync aborted. Error is retryable without --resync due to --resilient mode.', source: 'bisync/operations.go:201' };
  const script = `#!/usr/bin/env node\nconst args=process.argv.slice(2); if (args[0]==='bisync') { if (!args.includes('--use-json-log') || args.includes('--stats') || args.includes('--stats-log-level') || !args.includes('DEBUG')) process.exit(1); process.stderr.write(${JSON.stringify(JSON.stringify(retry) + '\n')}); process.exit(7); } if (args[0]==='lsjson') { if (args.includes('--use-json-log') || args.includes('--stats')) process.exit(1); process.stdout.write('[]'); process.exit(0); } process.exit(1);\n`;
  try {
    await writeFile(executable, script, { mode: 0o700 }); await chmod(executable, 0o700);
    const runner = new RcloneProcess(root) as any; runner.ensure = async () => {}; runner.binary = executable;
    await assert.rejects(runner.run(['bisync', 'synthetic:']), error => { assert.ok(error instanceof CloudError); assert.equal(error.category, 'sync_failed'); assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: 7, native: 'retryable_abort' }); return true; });
    assert.equal(await runner.run(['lsjson', 'synthetic:'], true), '[]');
  } finally { await rm(root, { recursive: true }); }
});
test('only complete, native-sourced pinned bisync records permit ordinary exit-7 retry', async () => {
  const runner = new RcloneProcess('/tmp/unused-native-markers') as unknown as { execute(binary: string, args: string[], capture: boolean, timeout: number, report?: (stats: TransferProgress) => void, context?: 'bisync' | 'generic'): Promise<string> };
  const retry = { time: '2026-01-01T00:00:00Z', level: 'error', msg: 'Bisync aborted. Error is retryable without --resync due to --resilient mode.', source: 'bisync/operations.go:201' };
  const lockout = { ...retry, msg: 'Bisync aborted. Must run --resync to recover.', source: 'bisync/operations.go:210' };
  const listing = { ...retry, msg: 'There were errors while building listings. Aborting as it is too dangerous to continue.', source: 'bisync/operations.go:313' };
  const payloads: Array<[unknown[], string, string | undefined]> = [
    [[retry, listing], 'retryable_abort', 'listing_failure'], [[{ ...retry, msg: `\x1b[33m${retry.msg}\x1b[0m` }], 'retryable_abort', undefined], [[lockout], 'resync_required_abort', undefined],
    [[retry, lockout], 'unknown_fatal', undefined], [[{ ...retry, source: 'icloud/provider.go:201' }], 'unknown_fatal', undefined],
    [[{ ...retry, msg: `sentinel-provider-body ${retry.msg}` }], 'unknown_fatal', undefined],
    [[{ ...retry, msg: `sentinel-provider-body ${JSON.stringify(retry)}`, source: 'icloud/provider.go:1' }], 'unknown_fatal', undefined],
    [[{ ...retry, object: 'sentinel-private-file' }], 'unknown_fatal', undefined],
  ];
  for (const [records, expected, reason] of payloads) {
    const json = records.map(record => JSON.stringify(record) + '\n').join('');
    // Single-byte writes exercise chunk boundaries within the JSON envelope.
    // Drain the synthetic pipe: process.exit() can truncate otherwise valid
    // records under load, which must (correctly) fail closed in production.
    const script = `const s=${JSON.stringify(json)}; for (const c of s) process.stderr.write(c); process.stderr.end(() => { process.exitCode = 7; });`;
    const progress: TransferProgress[] = [];
    await assert.rejects(runner.execute(process.execPath, ['-e', script], false, 3000, stats => progress.push(stats), 'bisync'), error => {
      assert.ok(error instanceof CloudError); assert.equal(error.category, expected === 'retryable_abort' ? 'sync_failed' : 'recovery_required');
      assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: 7, native: expected, ...(reason ? { reason } : {}) });
      assert.doesNotMatch(JSON.stringify(error), /sentinel|provider-body|private-file/); return true;
    });
    assert.deepEqual(progress, []);
  }
  for (const json of [JSON.stringify(retry), JSON.stringify(retry) + '\n\n', JSON.stringify(retry) + '\nnot-json\n', JSON.stringify(retry) + '\n' + 'x'.repeat(65 * 1024) + '\n', JSON.stringify(retry) + '\n' + JSON.stringify({ msg: 'sentinel-private' }).slice(0, -2)]) {
    await assert.rejects(runner.execute(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(json)}); process.exit(7)`], false, 3000, undefined, 'bisync'), error => {
      assert.ok(error instanceof CloudError); assert.equal(error.category, 'recovery_required'); assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: 7, native: 'unknown_fatal' }); return true;
    });
  }
  for (const exit of [1, 42]) await assert.rejects(runner.execute(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(JSON.stringify(retry) + '\n')}); process.exit(${exit})`], false, 3000, undefined, 'bisync'), error => {
    assert.ok(error instanceof CloudError); assert.equal(error.category, 'sync_failed'); assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: exit === 1 ? 1 : null }); return true;
  });
});
test('bisync trace preserves sanitized native evidence and the exact timeout boundary', async () => {
  const root = await mkdtemp('/tmp/icloud-trace-process-'); const runner = new RcloneProcess(root);
  const records = [
    { level: 'debug', source: 'bisync/listing.go:10', msg: 'Reading current listings PRIVATE_SENTINEL' },
    { level: 'error', msg: 'PRIVATE_SENTINEL i/o timeout', object: 'PRIVATE_SENTINEL.md' },
    { stats: { bytes: 0, transfers: 0, checks: 10, errors: 1, lastError: 'PRIVATE_SENTINEL', retryError: true } },
  ].map(record => JSON.stringify(record) + '\n').join('');
  try {
    await runner.trace.start();
    await assert.rejects((runner as any).execute(process.execPath, ['-e', `process.on('SIGINT',()=>process.exit(0)); process.stderr.write(${JSON.stringify(records)}); setInterval(()=>{}, 1000);`], false, 500, undefined, 'bisync'), (error: unknown) => error instanceof CloudError && error.evidence?.kind === 'command_timeout');
    const result = await runner.trace.snapshot();
    assert.equal(result.available, true);
    assert.deepEqual(result.entries.map(e => e.event), ['command_start', 'listing', 'message', 'stats', 'command_timeout', 'command_end']);
    assert.equal(result.entries.at(-1)?.outcome, 'failed'); assert.equal(result.entries.at(-1)?.evidence, 'command_timeout');
    assert.equal(result.entries.find(e => e.category)?.category, 'timeout');
    assert.equal(new Set(result.entries.map(e => e.commandId)).size, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
    const before = result.entries.length;
    await (runner as any).execute(process.execPath, ['-e', `process.stderr.write('PRIVATE_SENTINEL');`], false, 3000);
    assert.equal((await runner.trace.snapshot()).entries.length, before, 'generic and account setup commands are not traced');
  } finally { await runner.stop(); await rm(root, { recursive: true }); }
});
test('unavailable trace storage neither fails a successful command nor changes native retry classification', async () => {
  const root = await mkdtemp('/tmp/icloud-trace-failure-'); let warnings = 0;
  const runner = new RcloneProcess(root, undefined, undefined, () => warnings++);
  const retry = { time: '2026-01-01T00:00:00Z', level: 'error', msg: 'Bisync aborted. Error is retryable without --resync due to --resilient mode.', source: 'bisync/operations.go:201' };
  try {
    await runner.trace.start(); await rm(root + '/rclone-logs', { recursive: true }); await writeFile(root + '/rclone-logs', 'PRIVATE_SENTINEL');
    const execute = (code: number) => (runner as any).execute(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(JSON.stringify(retry) + '\n')}); process.exit(${code});`], false, 5000, undefined, 'bisync');
    assert.equal(await execute(0), '');
    await assert.rejects(execute(7), (error: unknown) => error instanceof CloudError && error.category === 'sync_failed' && error.evidence?.kind === 'command_exit' && error.evidence.native === 'retryable_abort');
    assert.equal(warnings, 1); assert.equal((await runner.trace.snapshot()).available, false);
    assert.equal(await readFile(root + '/rclone-logs', 'utf8'), 'PRIVATE_SENTINEL');
  } finally { await runner.stop(); await rm(root, { recursive: true }); }
});
test('real stock bisync emits bounded debug activity into the private rotating trace', { skip: !binary, timeout: 30000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-trace-native-'); const runner = new RcloneProcess(root + '/worker', binary);
  try {
    for (const name of ['cloud', 'local', 'baseline']) await mkdir(root + '/' + name);
    await writeFile(root + '/cloud/PRIVATE_SENTINEL.md', 'PRIVATE_SENTINEL');
    await runner.run(syncArguments(root + '/cloud', root + '/local', root + '/baseline', true), false, () => {});
    const trace = await runner.trace.snapshot(500);
    assert.equal(trace.available, true); assert.ok(trace.entries.length > 3);
    assert.ok(trace.entries.some(e => e.level === 'debug'));
    assert.ok(trace.entries.some(e => e.component === 'bisync'));
    assert.equal(trace.entries.at(-1)?.outcome, 'succeeded');
    assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_SENTINEL|\/tmp\/|password|token|cookie/);
    assert.equal(await readFile(root + '/local/PRIVATE_SENTINEL.md', 'utf8'), 'PRIVATE_SENTINEL');
  } finally { await runner.stop(); await rm(root, { recursive: true }); }
});
test('real Linux run without progress classifies native retryable listing exit and ordinary retry', { skip: !binary || process.platform !== 'linux', timeout: 40_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-run-no-progress-'); const worker = new RcloneProcess(root + '/worker', binary);
  const cloud = root + '/cloud'; const local = root + '/local'; const baseline = root + '/baseline';
  try {
    await mkdir(cloud); await mkdir(local); await mkdir(baseline); await writeFile(cloud + '/generated.txt', 'generated');
    await worker.ensure();
    await worker.run(syncArguments(cloud, local, baseline, true));
    await chmod(cloud, 0o000);
    try {
      await assert.rejects(worker.run(syncArguments(cloud, local, baseline, false)), error => {
        assert.ok(error instanceof CloudError); assert.equal(error.category, 'sync_failed');
        assert.deepEqual(error.evidence, { kind: 'command_exit', exitCode: 7, native: 'retryable_abort', reason: 'listing_failure' }); return true;
      });
    } finally { await chmod(cloud, 0o700); }
    await worker.run(syncArguments(cloud, local, baseline, false));
    assert.equal(await readFile(local + '/generated.txt', 'utf8'), 'generated');
  } finally { await chmod(cloud, 0o700).catch(() => {}); await worker.stop(); await rm(root, { recursive: true }); }
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
