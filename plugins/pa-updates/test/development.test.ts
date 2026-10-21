import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectDevelopment, DevelopmentError } from '../adapters/development.ts';
import { integrationId } from '../core/application-model.ts';
const exec = promisify(execFile), ids = integrationId.options;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pa-local-work-')), seed = join(root, 'seed'), owner = join(root, 'owner checkout'), remote = join(root, 'published.git');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, env, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
  await mkdir(seed); await git(seed, 'init', '-b', 'main'); await git(root, 'init', '--bare', '--initial-branch=main', remote);
  for (const id of ids) { await mkdir(join(seed, 'plugins', id), { recursive: true }); await writeFile(join(seed, 'plugins', id, 'server.ts'), 'original\n'); }
  await git(seed, 'add', '.'); await git(seed, 'commit', '-m', 'published base'); await git(seed, 'push', remote, 'HEAD:main');
  await git(root, 'clone', remote, owner);
  const commit = async (cwd: string, message: string) => { await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', message); };
  const inspect = () => inspectDevelopment(owner, new AbortController().signal, remote);
  return { root, seed, owner, remote, git, commit, inspect, close: () => rm(root, { recursive: true, force: true }) };
}
async function fingerprint(root: string) {
  const values: string[] = [];
  async function walk(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name), stat = await lstat(file);
      if (stat.isDirectory()) await walk(file);
      else values.push(relative(root, file) + ':' + createHash('sha256').update(await readFile(file)).digest('hex'));
    }
  }
  await walk(root); return values;
}
test('fresh published main detects a clean unpublished component commit on a diverged branch, without changing the owner repository', async () => {
  const f = await fixture();
  try {
    const stale = await f.git(f.owner, 'rev-parse', 'origin/main');
    await writeFile(join(f.owner, 'plugins/icloud/server.ts'), 'local cloud work\n');
    await writeFile(join(f.owner, 'plugins/obsidian/provenance.ts'), 'local note work\n'); await f.commit(f.owner, 'unpublished paired work');
    await writeFile(join(f.seed, 'plugins/google-calendar/server.ts'), 'new published calendar\n'); await f.commit(f.seed, 'remote ahead'); await f.git(f.seed, 'push', f.remote, 'HEAD:main');
    assert.notEqual(await f.git(f.seed, 'rev-parse', 'HEAD'), stale);
    await f.git(f.owner, 'remote', 'set-url', 'origin', '/PRIVATE_SENTINEL/not-used');
    const before = await fingerprint(f.owner), result = await f.inspect();
    assert.deepEqual(result, { 'google-calendar': 'clean', fastmail: 'clean', 'google-drive': 'clean', icloud: 'unpublished', obsidian: 'unpublished' });
    assert.deepEqual(await fingerprint(f.owner), before); assert.equal(await f.git(f.owner, 'rev-parse', 'origin/main'), stale);
    await writeFile(join(f.owner, 'plugins/google-calendar/server.ts'), 'unstaged work\n');
    await writeFile(join(f.owner, 'plugins/fastmail/server.ts'), 'staged work\n'); await f.git(f.owner, 'add', 'plugins/fastmail/server.ts');
    await writeFile(join(f.owner, 'plugins/google-drive/new.ts'), 'untracked work\n');
    const dirty = await fingerprint(f.owner); assert.ok(Object.values((await f.inspect())!).every(state => state === 'unpublished'));
    assert.deepEqual(await fingerprint(f.owner), dirty);
  } finally { await f.close(); }
});
test('being behind is not local work; already published component bytes are not flagged on divergent history', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.seed, 'plugins/google-calendar/server.ts'), 'remote only\n');
    await writeFile(join(f.seed, 'plugins/icloud/server.ts'), 'shared change\n'); await f.commit(f.seed, 'published changes'); await f.git(f.seed, 'push', f.remote, 'HEAD:main');
    assert.ok(Object.values((await f.inspect())!).every(state => state === 'clean'));
    await writeFile(join(f.owner, 'plugins/icloud/server.ts'), 'shared change\n'); await f.commit(f.owner, 'different commit, already published bytes');
    assert.ok(Object.values((await f.inspect())!).every(state => state === 'clean'));
  } finally { await f.close(); }
});
test('checkout filter attributes stay unknown even when their driver is only configured globally', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.owner, '.gitattributes'), 'plugins/icloud/*.ts filter=custom\n');
    const before = await fingerprint(f.owner);
    await assert.rejects(f.inspect(), error => error instanceof DevelopmentError && error.category === 'unsupported');
    assert.deepEqual(await fingerprint(f.owner), before);
  } finally { await f.close(); }
});
test('ordinary users need no checkout; failures stay bounded and owner hooks/config never execute', async () => {
  assert.equal(await inspectDevelopment(undefined, new AbortController().signal, '/PRIVATE_SENTINEL'), null);
  const f = await fixture();
  try {
    const marker = join(f.root, 'must-not-run');
    await f.git(f.owner, 'config', 'core.fsmonitor', `touch ${marker}`);
    await writeFile(join(f.owner, '.git/hooks/post-index-change'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const before = await fingerprint(f.owner); await f.inspect();
    await assert.rejects(lstat(marker)); assert.deepEqual(await fingerprint(f.owner), before);
    await assert.rejects(inspectDevelopment(f.owner, new AbortController().signal, '/PRIVATE_SENTINEL/missing'), error => error instanceof DevelopmentError && error.message === 'unavailable');
    assert.deepEqual(await fingerprint(f.owner), before);
    await f.git(f.owner, 'config', 'filter.custom.clean', `touch ${marker}`);
    await assert.rejects(f.inspect(), error => error instanceof DevelopmentError && error.category === 'unsupported'); await assert.rejects(lstat(marker));
  } finally { await f.close(); }
});
