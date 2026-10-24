import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeState } from '../core/workspace.ts';
import { sourceFingerprint, sourceDetails, treeFingerprint } from '../adapters/source-files.ts';
const exec = promisify(execFile);
const old = 'a'.repeat(64), next = 'b'.repeat(64);

test('Git agreement is not proof that code was applied', () => {
  const work = { local: false, upstream: false, working: next, origin: next };
  assert.equal(codeState(work, old), 'unapplied');
  assert.equal(codeState(work, next), 'current');
  assert.equal(codeState(work, null), 'unknown');
  assert.equal(codeState(null, next), 'unknown');
});
test('local, upstream and both-sided work remain distinct', () => {
  for (const [local, upstream, expected] of [[true, false, 'local'], [false, true, 'upstream'], [true, true, 'both']] as const)
    assert.equal(codeState({ local, upstream, working: next, origin: old }, next), expected);
});

async function fixture(run: (root: string, git: (...args: string[]) => Promise<Buffer>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pa-workspace-test-'));
  const git = async (...args: string[]) => (await exec('git', args, { cwd: root, encoding: 'buffer', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout;
  try {
    await git('init', '-q'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
    await mkdir(join(root, 'plugins/example'), { recursive: true });
    await writeFile(join(root, 'plugins/example/package.json'), JSON.stringify({ version: '1.0.0' }));
    await writeFile(join(root, 'plugins/example/server.ts'), 'export const message = "before";');
    await git('add', '.'); await git('commit', '-qm', 'initial');
    await run(root, git);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('raw working files match Git blobs, including spaces and Unicode', async () => fixture(async (root, git) => {
  await writeFile(join(root, 'plugins/example/a space é.ts'), 'export const value = 42;');
  await git('add', '.'); await git('commit', '-qm', 'unicode');
  const listing = await git('ls-tree', '-rz', 'HEAD', '--', 'plugins/example');
  assert.equal(await sourceFingerprint(join(root, 'plugins/example')), treeFingerprint(listing, 'plugins/example/'));
}));
test('same-version code edits change identity', async () => fixture(async (root, git) => {
  const before = treeFingerprint(await git('ls-tree', '-rz', 'HEAD', '--', 'plugins/example'), 'plugins/example/');
  await writeFile(join(root, 'plugins/example/server.ts'), 'export const message = "after";');
  assert.notEqual(await sourceFingerprint(join(root, 'plugins/example')), before);
}));
test('generated files and documentation do not pretend to be running-code changes', async () => fixture(async root => {
  const directory = join(root, 'plugins/example'), before = await sourceFingerprint(directory);
  await mkdir(join(directory, 'dist')); await writeFile(join(directory, 'dist/server.js'), 'generated');
  await writeFile(join(directory, 'README.md'), 'documentation');
  await writeFile(join(directory, '.env'), 'PRIVATE_SENTINEL');
  assert.equal(await sourceFingerprint(directory), before);
}));
test('deleted tracked files are absent from the working fingerprint', async () => fixture(async (root, git) => {
  const directory = join(root, 'plugins/example');
  await rm(join(directory, 'server.ts'));
  await git('add', '.'); await git('commit', '-qm', 'delete');
  const expected = treeFingerprint(await git('ls-tree', '-rz', 'HEAD', '--', 'plugins/example'), 'plugins/example/');
  assert.equal(await sourceFingerprint(directory, ['package.json', 'server.ts']), expected);
}));
test('restoring original bytes does not forge an unchanged source generation', async () => fixture(async root => {
  const directory = join(root, 'plugins/example'), file = join(directory, 'server.ts');
  const original = await sourceDetails(directory);
  await writeFile(file, 'export const message = "other loaded code";');
  await writeFile(file, 'export const message = "before";');
  const restored = await sourceDetails(directory);
  assert.equal(restored.fingerprint, original.fingerprint);
  assert.notEqual(restored.stamp, original.stamp);
}));
test('source inspection refuses symlinks instead of reading their targets', async () => fixture(async root => {
  const secret = join(root, 'secret'); await writeFile(secret, 'PRIVATE_SENTINEL');
  await symlink(secret, join(root, 'plugins/example/escape.ts'));
  await assert.rejects(sourceFingerprint(join(root, 'plugins/example')));
  await assert.rejects(sourceFingerprint(join(root, 'plugins/example'), ['escape.ts']));
}));
