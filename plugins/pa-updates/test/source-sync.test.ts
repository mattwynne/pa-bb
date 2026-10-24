import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { componentIds } from '../core/workspace.ts';
import { inspectCanonicalWorkspace } from '../adapters/development.ts';
import { syncWorkspace } from '../adapters/sync-workspace.ts';
const exec = promisify(execFile);
async function fixture(run: (f: { root: string; seed: string; owner: string; remote: string; git(cwd: string, ...args: string[]): Promise<string> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pa-source-sync-')), seed = join(root, 'seed'), owner = join(root, 'working copy'), remote = join(root, 'origin.git');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env })).stdout.trim();
  try {
    await mkdir(seed); await git(root, 'init', '--bare', '--initial-branch=main', remote); await git(seed, 'init', '-b', 'main');
    for (const id of componentIds) {
      await mkdir(join(seed, 'plugins', id), { recursive: true });
      await writeFile(join(seed, 'plugins', id, 'server.ts'), 'export const code = "A";');
    }
    await writeFile(join(seed, '.gitignore'), 'node_modules/\ndist/\nprivate.txt\n');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'initial'); await git(seed, 'push', remote, 'HEAD:main');
    await git(root, 'clone', remote, owner);
    await writeFile(join(seed, 'plugins/google-calendar/server.ts'), 'export const code = "B";');
    await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'origin update'); await git(seed, 'push', remote, 'HEAD:main');
    await run({ root, seed, owner, remote, git });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('source update fast-forwards the working copy without hooks or a push', async () => fixture(async f => {
  const signal = new AbortController().signal;
  const review = await inspectCanonicalWorkspace(signal, f.remote, f.owner); assert.ok(review);
  assert.equal(review.behind, true); assert.equal(review.dirty, false);
  const origin = await f.git(f.seed, 'rev-parse', 'HEAD'), marker = join(f.root, 'hook-ran');
  await writeFile(join(f.owner, '.git/hooks/post-merge'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const result = await syncWorkspace(f.owner, review, signal, f.remote);
  assert.equal(result.state, 'updated');
  if (result.state !== 'updated') return;
  assert.equal(result.workspace.head, origin); assert.equal(result.workspace.behind, false);
  assert.equal(result.workspace.components['google-calendar'].working, review.components['google-calendar'].origin);
  assert.equal(await f.git(f.owner, 'status', '--porcelain'), '');
  assert.equal(await f.git(f.seed, 'rev-parse', 'HEAD'), origin);
  await assert.rejects(readFile(marker));
}));
for (const kind of ['untracked-root', 'staged-root', 'local-commit'] as const) test(`${kind} work holds source synchronization`, async () => fixture(async f => {
  const signal = new AbortController().signal, head = await f.git(f.owner, 'rev-parse', 'HEAD');
  await writeFile(join(f.owner, 'local-work.txt'), 'LOCAL_WORK');
  if (kind !== 'untracked-root') await f.git(f.owner, 'add', 'local-work.txt');
  if (kind === 'local-commit') await f.git(f.owner, 'commit', '-m', 'local');
  const before = await f.git(f.owner, 'rev-parse', 'HEAD');
  const review = await inspectCanonicalWorkspace(signal, f.remote, f.owner); assert.ok(review);
  assert.equal(kind === 'local-commit' ? review.ahead : review.dirty, true);
  assert.deepEqual(await syncWorkspace(f.owner, review, signal, f.remote), { state: 'held', reason: 'local_work' });
  assert.equal(await f.git(f.owner, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(f.owner, 'local-work.txt'), 'utf8'), 'LOCAL_WORK');
  if (kind !== 'local-commit') assert.equal(before, head);
}));
test('new work after review is held, not overwritten', async () => fixture(async f => {
  const signal = new AbortController().signal, review = await inspectCanonicalWorkspace(signal, f.remote, f.owner); assert.ok(review);
  await writeFile(join(f.owner, 'new-work.txt'), 'KEEP_ME');
  assert.deepEqual(await syncWorkspace(f.owner, review, signal, f.remote), { state: 'held', reason: 'local_work' });
  assert.equal(await f.git(f.owner, 'rev-parse', 'HEAD'), review.head);
}));
test('ignored private files are not overwritten by a fast-forward', async () => fixture(async f => {
  await writeFile(join(f.owner, 'private.txt'), 'PRIVATE_SENTINEL');
  await writeFile(join(f.seed, 'private.txt'), 'incoming'); await f.git(f.seed, 'add', '-f', 'private.txt');
  await f.git(f.seed, 'commit', '-m', 'add conflicting ignored path'); await f.git(f.seed, 'push', f.remote, 'HEAD:main');
  const signal = new AbortController().signal, review = await inspectCanonicalWorkspace(signal, f.remote, f.owner); assert.ok(review); assert.equal(review.dirty, false);
  await assert.rejects(syncWorkspace(f.owner, review, signal, f.remote));
  assert.equal(await readFile(join(f.owner, 'private.txt'), 'utf8'), 'PRIVATE_SENTINEL');
  assert.equal(await f.git(f.owner, 'rev-parse', 'HEAD'), review.head);
}));
test('offline local inspection does not contact origin or change the working copy', async () => fixture(async f => {
  await writeFile(join(f.owner, 'plugins/icloud/server.ts'), 'LOCAL_CODE');
  const state = await inspectCanonicalWorkspace(new AbortController().signal, '/DO_NOT_CONTACT', f.owner, 'HEAD');
  assert.ok(state); assert.equal(state.components.icloud.local, true); assert.equal(state.behind, false);
  assert.equal(await readFile(join(f.owner, 'plugins/icloud/server.ts'), 'utf8'), 'LOCAL_CODE');
}));
