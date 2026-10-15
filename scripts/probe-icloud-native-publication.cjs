// Disposable Linux fixture only. RCLONE_TEST_BINARY must point to stock v1.75.2.
// Run with node scripts/probe-icloud-native-publication.cjs; no Apple account
// or BB state is touched. The generated transfer is rate-limited, not slept.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { watch } = require('node:fs');
const { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, utimes } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const binary = process.env.RCLONE_TEST_BINARY;
let stage = 'platform';
// Never let ambient RCLONE_* options turn the generated alias into a real account.
const commandEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', GOMEMLIMIT: '256MiB' };
function bound(child, timeout = 120_000) {
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  timer.unref(); child.once('close', () => clearTimeout(timer));
}

function command(args) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const child = spawn(binary, args, { env: commandEnvironment, stdio: ['ignore', 'ignore', 'pipe'] });
    bound(child);
    child.stderr.on('data', value => { if (stderr.length < 4096) stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

async function main() {
  assert.equal(process.platform, 'linux', 'native publication must run on Linux');
  stage = 'binary';
  assert.ok(binary, 'set RCLONE_TEST_BINARY to the pinned stock rclone');
  stage = 'version';
  const version = await new Promise((resolve, reject) => {
    const child = spawn(binary, ['version', '--config', '/dev/null'], { env: commandEnvironment, stdio: ['ignore', 'pipe', 'ignore'] });
    bound(child, 10_000);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error('rclone version failed')));
  });
  assert.match(version, /^rclone v1\.75\.2\r?\n/);
  const root = await mkdtemp(join(tmpdir(), 'icloud-native-publication-'));
  const cloud = join(root, 'remote');
  const local = join(root, 'mirror');
  const work = join(root, 'baseline');
  const cache = join(root, 'cache');
  const config = join(root, 'alias.conf');
  try {
    for (const path of [cloud, local, work, cache]) await mkdir(path, { mode: 0o700 });
    await writeFile(config, `[icloud]\ntype = alias\nremote = ${cloud}\n`, { mode: 0o600 });
    const path = join(local, 'generated.md');
    const remote = join(cloud, 'generated.md');
    const original = Buffer.from('generated original\n');
    const next = Buffer.concat([Buffer.from('generated replacement\n'), Buffer.alloc(24 * 1024 * 1024, 65)]);
    await writeFile(remote, original);
    // Avoid rclone's stock safety abort when all files on one side change.
    await writeFile(join(cloud, 'unchanged.md'), 'generated unchanged\n');
    const args = initial => ['bisync', 'icloud:', local, '--workdir', work, '--conflict-resolve', 'none', '--conflict-loser', 'num',
      '--conflict-suffix', 'icloud-conflict,bb-conflict', '--compare', 'size,modtime', '--max-delete', '50',
      '--check-sync=true', '--create-empty-src-dirs', '--max-transfer', '256M', '--cutoff-mode', 'hard',
      '--resilient', '--recover', '--max-lock', '2m', ...(initial ? ['--resync'] : []),
      '--config', config, '--cache-dir', cache, '--transfers', '1', '--checkers', '1', '--bwlimit', '512k'];
    stage = 'initial_sync';
    assert.equal((await command(args(true))).code, 0, 'generated initial bisync');
    assert.deepEqual(await readFile(path), original);
    const inodeBefore = (await stat(path)).ino;
    await writeFile(remote, next);
    const when = new Date(Date.now() + 10_000);
    await utimes(remote, when, when);

    const events = [];
    const watcher = watch(local, (event, name) => { if (events.length < 100) events.push([event, String(name)]); });
    let stderr = '';
    stage = 'replacement_sampling';
    const start = Date.now();
    const child = spawn(binary, args(false), { env: commandEnvironment, stdio: ['ignore', 'ignore', 'pipe'] });
    bound(child);
    child.stderr.on('data', value => { if (stderr.length < 4096) stderr += value; });
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
    let samples = 0, stableSamples = 0, oldSamples = 0, unexpectedSamples = 0, sawPartial = false;
    try {
      while (child.exitCode === null && child.signalCode === null) {
        const before = await stat(path);
        const bytes = await readFile(path);
        const after = await stat(path);
        samples++;
        if (before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs) {
          stableSamples++;
          if (!bytes.equals(original) && !bytes.equals(next)) unexpectedSamples++;
          if (bytes.equals(original)) oldSamples++;
        }
        if ((await readdir(local)).some(name => name.endsWith('.partial'))) sawPartial = true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const result = await done;
      const nativeDurationMs = Date.now() - start;
      stage = 'replacement_verification';
      assert.equal(result.code, 0, `generated follow-up bisync exit ${result.code}; diagnostics suppressed`);
      assert.ok(nativeDurationMs >= 40_000, `native process lasted only ${nativeDurationMs}ms`);
      assert.equal(unexpectedSamples, 0, 'stable native read was torn');
      assert.ok(oldSamples > 0 && sawPartial, 'old canonical inode and a partial download coexisted');
      assert.deepEqual(await readFile(path), next);
      const inodeChanged = inodeBefore !== (await stat(path)).ino;
      assert.ok(inodeChanged, 'native replacement did not publish a distinct inode');
      console.log(JSON.stringify({ result: 'pass', nativeDurationMs, samples, stableSamples, oldSamples, unexpectedSamples, sawPartial, inodeChanged,
        eventKinds: [...new Set(events.map(([event]) => event))] }));
    } finally { watcher.close(); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGINT'); await done; } }
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error('NATIVE_PUBLICATION_PROBE_FAILED', stage, error instanceof assert.AssertionError ? 'assertion' : 'execution'); process.exitCode = 1; });
