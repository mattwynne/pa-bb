import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import childProcess, { execFile, type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectDevelopment, inspectCanonicalDevelopment, inspectCanonicalWorkspace, canonicalCheckout, DevelopmentError } from '../adapters/development.ts';
import { integrationId } from '../core/application-model.ts';
import { originUrl } from '../core/workspace.ts';
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
    assert.deepEqual(result, { 'google-calendar': 'clean', fastmail: 'clean', 'google-drive': 'clean', icloud: 'unpublished', obsidian: 'unpublished', 'pa-updates': 'clean' });
    assert.deepEqual(await fingerprint(f.owner), before); assert.equal(await f.git(f.owner, 'rev-parse', 'origin/main'), stale);
    await writeFile(join(f.owner, 'plugins/google-calendar/server.ts'), 'unstaged work\n');
    await writeFile(join(f.owner, 'plugins/fastmail/server.ts'), 'staged work\n'); await f.git(f.owner, 'add', 'plugins/fastmail/server.ts');
    await writeFile(join(f.owner, 'plugins/google-drive/new.ts'), 'untracked work\n');
    await writeFile(join(f.owner, 'plugins/pa-updates/new.ts'), 'untracked updater work\n');
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
test('workspace inspection reports local/upstream differences and content identity without mutating Git', async () => {
  const f = await fixture();
  try {
    const before = await fingerprint(f.owner);
    const initial = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(initial); assert.equal(initial.ahead, false); assert.equal(initial.behind, false);
    assert.ok(Object.values(initial.components).every(row => !row.local && !row.upstream && row.working === row.origin));
    assert.deepEqual(await fingerprint(f.owner), before);
    await writeFile(join(f.owner, 'plugins/icloud/server.ts'), 'local edits without a version bump\n');
    await writeFile(join(f.seed, 'plugins/obsidian/server.ts'), 'someone else changed this\n');
    await f.commit(f.seed, 'remote update'); await f.git(f.seed, 'push', f.remote, 'HEAD:main');
    const changed = await fingerprint(f.owner), state = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(state); assert.equal(state.dirty, true); assert.equal(state.behind, true);
    assert.equal(state.components.icloud.local, true); assert.equal(state.components.icloud.upstream, false);
    assert.equal(state.components.obsidian.local, false); assert.equal(state.components.obsidian.upstream, true);
    assert.notEqual(state.components.icloud.working, state.components.icloud.origin);
    assert.notEqual(state.components.obsidian.working, state.components.obsidian.origin);
    assert.deepEqual(await fingerprint(f.owner), changed);
    await f.commit(f.owner, 'local changes');
    await f.git(f.owner, 'pull', '--no-rebase', f.remote, 'main');
    await f.git(f.owner, 'push', f.remote, 'HEAD:refs/heads/main');
    const pushed = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(pushed); assert.equal(pushed.components.icloud.local, false);
    assert.equal(pushed.components.icloud.working, pushed.components.icloud.origin);
  } finally { await f.close(); }
});
test('workspace keeps edited files and unpushed comparison commits independent', async () => {
  const f = await fixture();
  try {
    await f.git(f.owner, 'remote', 'set-url', 'origin', 'git@github.com:Example/Workspace.git');
    await writeFile(join(f.owner, 'plugins/icloud/server.ts'), 'edited only\n');
    const before = await fingerprint(f.owner);
    const edited = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(edited); assert.equal(edited.dirty, true); assert.equal(edited.ahead, false);
    assert.equal(edited.configuredOrigin, 'https://github.com/example/workspace.git');
    assert.equal(edited.originComparisonMatches, false); // Fixture source is not this origin.
    assert.deepEqual(await fingerprint(f.owner), before);
    await f.commit(f.owner, 'local commit only');
    const committed = await fingerprint(f.owner);
    const ahead = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(ahead); assert.equal(ahead.dirty, false); assert.equal(ahead.ahead, true);
    assert.equal(ahead.components.icloud.local, true); assert.equal(ahead.originComparisonMatches, false);
    assert.deepEqual(await fingerprint(f.owner), committed);
  } finally { await f.close(); }
});
test('configured origin comes from isolated owner config, not the supplied comparison source', async () => {
  const f = await fixture();
  try {
    for (const origin of ['https://github.com/Example/Workspace.git', 'git@github.com:Example/Workspace.git',
      'ssh://git@github.com/Example/Workspace.git']) {
      await f.git(f.owner, 'remote', 'set-url', 'origin', origin);
      const before = await fingerprint(f.owner);
      const state = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
      assert.ok(state); assert.equal(state.configuredOrigin, 'https://github.com/example/workspace.git');
      assert.equal(state.originComparisonMatches, false);
      assert.ok(!JSON.stringify(state).includes(f.root));
      assert.deepEqual(await fingerprint(f.owner), before);
    }
    // Even a matching source string cannot verify origin when no fetch occurred.
    await f.git(f.owner, 'remote', 'set-url', 'origin', 'git@github.com:mattwynne/pa-bb.git');
    for (const reference of ['HEAD', await f.git(f.owner, 'rev-parse', 'HEAD')]) {
      const state = await inspectCanonicalWorkspace(new AbortController().signal, originUrl, f.owner, reference);
      assert.ok(state); assert.equal(state.configuredOrigin, originUrl);
      assert.equal(state.originComparisonMatches, false);
    }
  } finally { await f.close(); }
});
test('a fetched source matching normalized configured origin explicitly verifies the comparison', async () => {
  const f = await fixture();
  const spawn = childProcess.spawn;
  let fetches = 0;
  try {
    await f.git(f.owner, 'remote', 'set-url', 'origin', 'ssh://git@github.com/mattwynne/pa-bb.git');
    const before = await fingerprint(f.owner);
    // Substitute only the transport at the process boundary: no live GitHub
    // request, config rewrite, or production fetch/isolation change is needed.
    const transport = mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: SpawnOptions) => {
      const actual = [...args];
      if (actual.includes('fetch')) {
        assert.equal(command, 'git'); assert.ok(actual.includes(originUrl)); fetches++;
        actual[actual.indexOf(originUrl)] = f.remote;
        actual.unshift('-c', 'protocol.file.allow=always');
      }
      return spawn(command, actual, options);
    });
    syncBuiltinESMExports();
    try {
      const state = await inspectCanonicalWorkspace(new AbortController().signal, originUrl, f.owner);
      assert.ok(state); assert.equal(state.configuredOrigin, originUrl); assert.equal(state.originComparisonMatches, true);
      assert.equal(fetches, 1); assert.ok(!JSON.stringify(state).includes(f.root));
    } finally { transport.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(await fingerprint(f.owner), before);
  } finally { await f.close(); }
});
test('unknown, ambiguous, credentialed and local origins never escape workspace metadata', async () => {
  const f = await fixture();
  try {
    for (const origin of [f.remote, '/PRIVATE_SENTINEL/not-used', 'file:///PRIVATE_SENTINEL/not-used',
      'https://PRIVATE_SENTINEL@github.com/example/workspace.git',
      'https://user:PRIVATE_SENTINEL@github.com/example/workspace.git',
      'https://github.com/example/workspace.git?token=PRIVATE_SENTINEL',
      'https://github.com/example/workspace.git#PRIVATE_SENTINEL',
      'ssh://PRIVATE_SENTINEL@github.com/example/workspace.git',
      'https://other.invalid/PRIVATE_SENTINEL/workspace.git']) {
      await f.git(f.owner, 'remote', 'set-url', 'origin', origin);
      const before = await fingerprint(f.owner);
      const state = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
      assert.ok(state); assert.equal(state.configuredOrigin, undefined); assert.equal(state.originComparisonMatches, false);
      assert.equal(Object.hasOwn(state, 'configuredOrigin'), false, 'BB RPC requires unknown origin to be absent, not undefined');
      const rpc = JSON.stringify(state);
      assert.ok(!rpc.includes('PRIVATE_SENTINEL')); assert.ok(!rpc.includes(f.root));
      assert.deepEqual(await fingerprint(f.owner), before);
    }
    await f.git(f.owner, 'remote', 'remove', 'origin');
    const missing = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(missing); assert.equal(missing.configuredOrigin, undefined); assert.equal(missing.originComparisonMatches, false);
    await f.git(f.owner, 'config', '--add', 'remote.origin.url', originUrl);
    await f.git(f.owner, 'config', '--add', 'remote.origin.url', 'https://github.com/other/workspace.git');
    const ambiguous = await inspectCanonicalWorkspace(new AbortController().signal, f.remote, f.owner);
    assert.ok(ambiguous); assert.equal(ambiguous.configuredOrigin, undefined); assert.equal(ambiguous.originComparisonMatches, false);
  } finally { await f.close(); }
});
test('credentialed origin cannot leak through a failed comparison diagnostic', async () => {
  const f = await fixture();
  try {
    await f.git(f.owner, 'remote', 'set-url', 'origin', 'https://user:PRIVATE_SENTINEL@github.com/example/workspace.git');
    const before = await fingerprint(f.owner);
    await assert.rejects(inspectCanonicalWorkspace(new AbortController().signal, join(f.root, 'missing'), f.owner), error => {
      assert.ok(error instanceof DevelopmentError); assert.equal(error.category, 'unavailable');
      assert.equal(error.message, 'unavailable'); assert.ok(!String(error).includes('PRIVATE_SENTINEL'));
      assert.ok(!JSON.stringify(error).includes('PRIVATE_SENTINEL')); return true;
    });
    assert.deepEqual(await fingerprint(f.owner), before);
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
test('canonical workspace absence is ordinary, but an existing invalid workspace is not clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pa-canonical-'));
  try {
    const checkout = canonicalCheckout(root); assert.equal(checkout, join(root, 'src', 'pa-bb'));
    assert.equal(await inspectCanonicalDevelopment(new AbortController().signal, '/PRIVATE_SENTINEL', checkout), null);
    await mkdir(checkout, { recursive: true });
    await assert.rejects(inspectCanonicalDevelopment(new AbortController().signal, '/PRIVATE_SENTINEL', checkout));
    const server = await readFile(new URL('../server.ts', import.meta.url), 'utf8');
    assert.ok(!server.includes('bb.settings.define')); assert.ok(!server.includes('PA_UPDATES_CALENDAR_CHECKOUT'));
    const agents = await readFile(new URL('../../../AGENTS.md', import.meta.url), 'utf8');
    const guide = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(agents.includes('$HOME/src/pa-bb')); assert.ok(agents.includes('not source workspaces'));
    assert.ok(guide.includes('$HOME/src/pa-bb')); assert.ok(!guide.includes('developmentCheckout'));
  } finally { await rm(root, { recursive: true, force: true }); }
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
