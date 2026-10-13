import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';

const binary = process.env.RCLONE_TEST_BINARY;
type Result = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
function command(args: string[], options: { stdout?: 'pipe' | 'ignore'; stderr?: 'pipe' | 'ignore' } = {}) {
  const child = spawn(binary!, args, { stdio: ['ignore', options.stdout ?? 'pipe', options.stderr ?? 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; }); child.stderr?.on('data', chunk => { stderr += chunk; });
  const done = new Promise<Result>((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, done };
}
async function run(args: string[]) { return command(args).done; }
async function eventually<T>(read: () => Promise<T | null>, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value !== null) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('timed out waiting for generated fixture state');
}
async function find(root: string, suffix: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name); if (entry.isDirectory()) { const nested = await find(path, suffix); if (nested) return nested; }
    else if (entry.name.endsWith(suffix)) return path;
  }
  return null;
}
async function setup() {
  const root = await mkdtemp('/tmp/icloud-native-recovery-');
  const cloud = join(root, 'cloud'); const local = join(root, 'local'); const work = join(root, 'work'); const cache = join(root, 'cache'); const config = join(root, 'rclone.conf');
  for (const path of [cloud, local, work, cache]) await mkdir(path);
  assert.equal((await run(['config', 'create', 'icloud', 'alias', 'remote', cloud, '--config', config])).code, 0);
  const args = (initial = false, extra: string[] = []) => [...syncArguments('icloud:', local, work, initial), '--config', config, '--cache-dir', cache, '--transfers', '1', '--checkers', '1', ...extra];
  return { root, cloud, local, work, args };
}
async function put(path: string, content: string | Buffer, offset = 0) {
  await writeFile(path, content); const when = new Date(Date.now() + 5_000 + offset); await utimes(path, when, when);
}
async function contents(root: string) {
  const result: string[] = [];
  for (const name of await readdir(root)) result.push(await readFile(join(root, name), 'utf8'));
  return result.sort();
}

test('stock rclone retries transfers three times but lsjson has no whole-command retry loop', { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-native-retries-'); const source = join(root, 'source'); const target = join(root, 'target'); await mkdir(source); await mkdir(target);
  try {
    const note = join(source, 'note'); await writeFile(note, 'generated'); await chmod(note, 0o000);
    const restore = setTimeout(() => { void chmod(note, 0o600); }, 500);
    const copied = await run(['copy', source, target, '--retries-sleep', '1s', '-vv']); clearTimeout(restore);
    assert.equal(copied.code, 0); assert.match(copied.stderr, /Attempt 1\/3 failed/); assert.match(copied.stderr, /Attempt 2\/3 succeeded/);
    await chmod(source, 0o000); const listed = await run(['lsjson', source, '--recursive', '-vv']); await chmod(source, 0o700);
    assert.notEqual(listed.code, 0); assert.doesNotMatch(listed.stderr, /Attempt 2\/3/);
  } finally { await chmod(source, 0o700).catch(() => {}); await rm(root, { recursive: true }); }
});

test('stock resilient bisync preserves conflicts, refuses excessive deletion, and reports critical transfer exit 7', { skip: !binary, timeout: 30_000 }, async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 6; i++) await put(join(f.cloud, `note-${i}.md`), `original-${i}`, i);
    assert.equal((await run(f.args(true))).code, 0);
    await put(join(f.cloud, 'note-0.md'), 'cloud-conflict', 20); await put(join(f.local, 'note-0.md'), 'local-conflict', 30);
    assert.equal((await run(f.args(false))).code, 0);
    assert.deepEqual(await contents(f.cloud), await contents(f.local));
    assert.ok((await contents(f.local)).includes('cloud-conflict')); assert.ok((await contents(f.local)).includes('local-conflict'));
    for (let i = 1; i < 6; i++) await rm(join(f.cloud, `note-${i}.md`));
    const deletion = await run(f.args(false)); assert.equal(deletion.code, 1, deletion.stderr);
    assert.ok((await readdir(f.local)).some(name => name.includes('note-5.md')));
    assert.equal((await run(f.args(false))).code, 1);
    for (let i = 1; i < 6; i++) await put(join(f.cloud, `note-${i}.md`), `original-${i}`, i);
    assert.equal((await run(f.args(false))).code, 0);
    await put(join(f.cloud, 'critical.md'), 'must-not-be-lost'); await chmod(f.local, 0o500);
    const critical = await run(f.args(false)); await chmod(f.local, 0o700); assert.equal(critical.code, 7, critical.stderr);
    assert.match(critical.stderr, /Bisync critical error/); assert.match(critical.stderr, /Must run --resync to recover/);
    await assert.rejects(readFile(join(f.local, 'critical.md')));
  } finally { await rm(f.root, { recursive: true }); }
});

test('stock bisync recovers graceful and abrupt interruption, renews and expires its 2m lock, and preserves post-partial conflicts', { skip: !binary, timeout: 260_000 }, async () => {
  const f = await setup();
  try {
    await put(join(f.cloud, 'seed.md'), 'seed'); assert.equal((await run(f.args(true))).code, 0);

    await put(join(f.cloud, 'graceful.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
    const graceful = command(f.args(false, ['--bwlimit', '1M']));
    await eventually(() => find(f.work, '.lck')); await new Promise(resolve => setTimeout(resolve, 300)); graceful.child.kill('SIGINT');
    await graceful.done; assert.equal((await run(f.args(false))).code, 0); assert.equal((await stat(join(f.local, 'graceful.bin'))).size, 4 * 1024 * 1024);

    await put(join(f.cloud, 'first.md'), 'first-before'); await put(join(f.cloud, 'slow.bin'), Buffer.alloc(40 * 1024 * 1024, 2));
    const abrupt = command(f.args(false, ['--bwlimit', '512k']));
    const lock = await eventually(() => find(f.work, '.lck')); const initialMtime = (await stat(lock)).mtimeMs;
    await eventually(async () => { try { return await readFile(join(f.local, 'first.md'), 'utf8') === 'first-before' ? true : null; } catch { return null; } });
    await eventually(async () => (await stat(lock)).mtimeMs > initialMtime ? true : null, 75_000);
    assert.notEqual((await run(f.args(false))).code, 0, 'a second native bisync overlapped the live process');
    abrupt.child.kill('SIGKILL'); await abrupt.done;
    assert.notEqual((await run(f.args(false))).code, 0, 'an unexpired abrupt lock was ignored');

    await put(join(f.cloud, 'first.md'), 'cloud-after-partial', 50); await put(join(f.local, 'first.md'), 'local-after-partial', 60);
    const lockRecord = JSON.parse(await readFile(lock, 'utf8')) as { TimeExpires?: unknown };
    assert.equal(typeof lockRecord.TimeExpires, 'string'); const expiresAt = Date.parse(lockRecord.TimeExpires as string); assert.ok(Number.isFinite(expiresAt));
    await eventually(async () => Date.now() > expiresAt + 250 ? true : null, Math.max(1, expiresAt - Date.now() + 10_000));
    const recovered = await run(f.args(false)); assert.equal(recovered.code, 0, recovered.stderr);
    const retainedPartials: string[] = [];
    for (const side of [f.cloud, f.local]) {
      const names = await readdir(side);
      const versions = await Promise.all(names.filter(name => name.startsWith('first')).map(name => readFile(join(side, name), 'utf8')));
      assert.deepEqual(versions.sort(), ['cloud-after-partial', 'local-after-partial'].sort());
      const partials = names.filter(name => name.endsWith('.partial'));
      assert.ok(partials.every(name => /^slow\.bin\.[a-f0-9]{8}\.partial$/.test(name)), `unexpected native partial artifact: ${partials.join(',')}`);
      for (const name of partials) {
        const size = (await stat(join(side, name))).size;
        assert.ok(size > 0 && size < 40 * 1024 * 1024, `invalid retained partial size: ${size}`);
        retainedPartials.push(join(side, name));
      }
    }
    assert.equal((await stat(join(f.cloud, 'slow.bin'))).size, 40 * 1024 * 1024);
    assert.equal((await stat(join(f.local, 'slow.bin'))).size, 40 * 1024 * 1024);
    assert.ok(retainedPartials.length > 0, 'abruptly interrupted native partial was not preserved');
  } finally { await rm(f.root, { recursive: true }); }
});
