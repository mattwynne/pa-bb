import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { localGit } from '../adapters/local-git.ts';
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'pa-git-')); const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  for (const path of ['plugins/google-calendar', 'plugins/obsidian', 'shared/connection-ui']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'plugins/google-calendar/server.ts'), 'baseline\n');
  await writeFile(join(root, 'plugins/obsidian/server.ts'), 'unrelated\n');
  await writeFile(join(root, 'shared/connection-ui/ui.tsx'), 'shared\n');
  await writeFile(join(root, '.gitignore'), 'dist/\nstate/\n'); git('add', '.'); git('commit', '-qm', 'baseline');
  const target = git('rev-parse', 'HEAD');
  return { root, git, target, inspect: localGit(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;
test('real Git: scoped dirty, staged, deleted, untracked and shared files; ignored outputs and unrelated work', async () => {
  const r = await repository();
  try {
    const index = await readFile(join(r.root, '.git/index'));
    await writeFile(join(r.root, 'plugins/obsidian/server.ts'), 'PRIVATE_SENTINEL unrelated edits\n');
    await mkdir(join(r.root, 'plugins/google-calendar/dist')); await writeFile(join(r.root, 'plugins/google-calendar/dist/output.js'), 'ignored');
    assert.equal((await r.inspect(r.target, signal())).outcome, 'clean');
    assert.deepEqual(await readFile(join(r.root, '.git/index')), index);
    for (const path of ['plugins/google-calendar/server.ts', 'plugins/google-calendar/new.ts', 'shared/connection-ui/ui.tsx']) {
      await writeFile(join(r.root, path), 'PRIVATE_SENTINEL local work\n');
      const bytes = await readFile(join(r.root, path)); const priorIndex = await readFile(join(r.root, '.git/index'));
      const status = await r.inspect(r.target, signal()); assert.equal(status.outcome, 'local_changes'); assert.ok(!JSON.stringify(status).includes('PRIVATE_SENTINEL'));
      assert.deepEqual(await readFile(join(r.root, path)), bytes); assert.deepEqual(await readFile(join(r.root, '.git/index')), priorIndex);
    }
    r.git('add', 'plugins/google-calendar');
    const staged = await readFile(join(r.root, '.git/index')); assert.equal((await r.inspect(r.target, signal())).outcome, 'local_changes'); assert.deepEqual(await readFile(join(r.root, '.git/index')), staged);
    await rm(join(r.root, 'plugins/google-calendar/server.ts')); assert.equal((await r.inspect(r.target, signal())).outcome, 'local_changes');
  } finally { await r.cleanup(); }
});
test('clean unpublished relevant commits block; unrelated commits do not; divergence and missing targets stay unknown', async () => {
  const r = await repository();
  try {
    await writeFile(join(r.root, 'plugins/obsidian/server.ts'), 'unrelated commit'); r.git('commit', '-qam', 'unrelated');
    assert.equal((await r.inspect(r.target, signal())).outcome, 'clean');
    await writeFile(join(r.root, 'shared/connection-ui/ui.tsx'), 'relevant commit'); r.git('commit', '-qam', 'shared work');
    assert.equal((await r.inspect(r.target, signal())).outcome, 'local_commits');
    const local = r.git('rev-parse', 'HEAD'); r.git('checkout', '-qb', 'candidate', r.target);
    await writeFile(join(r.root, 'plugins/google-calendar/server.ts'), 'candidate commit'); r.git('commit', '-qam', 'candidate');
    const candidate = r.git('rev-parse', 'HEAD'); r.git('checkout', '-q', local);
    assert.equal((await r.inspect(candidate, signal())).outcome, 'cannot_establish');
    assert.equal((await r.inspect('c'.repeat(40), signal())).reason, 'target_missing');
    assert.equal((await r.inspect(null, signal())).reason, 'no_candidate');
  } finally { await r.cleanup(); }
});
test('no mapping, unsupported config, cancellation and output limits never become clean', async () => {
  assert.equal((await localGit(undefined)(null, signal())).reason, 'mapping_missing');
  const r = await repository();
  try {
    r.git('config', 'filter.synthetic.clean', 'echo PRIVATE_SENTINEL');
    assert.equal((await r.inspect(r.target, signal())).reason, 'unsupported');
    r.git('config', '--remove-section', 'filter.synthetic');
    const aborted = new AbortController(); aborted.abort(); assert.notEqual((await r.inspect(r.target, aborted.signal)).outcome, 'clean');
    await writeFile(join(r.root, 'plugins/google-calendar/server.ts'), 'large change\n'.repeat(100000));
    assert.equal((await r.inspect(r.target, signal())).reason, 'limit');
  } finally { await r.cleanup(); }
});
test('cancellation kills and joins the actual Git child before inspection returns', async () => {
  const r = await repository(); const bin = await mkdtemp(join(tmpdir(), 'pa-git-child-')); const previous = process.env.PATH;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    const pidFile = join(bin, 'pid');
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`); await chmod(join(bin, 'git'), 0o700);
    const ready = new Promise<void>(resolve => { watcher = watch(bin, (_event, name) => { if (name === 'pid') resolve(); }); });
    process.env.PATH = `${bin}:${previous}`; const controller = new AbortController(); const pending = r.inspect(r.target, controller.signal);
    await ready; const pid = Number(await readFile(pidFile, 'utf8')); controller.abort();
    assert.equal((await pending).reason, 'cancelled'); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { watcher?.close(); process.env.PATH = previous; await r.cleanup(); await rm(bin, { recursive: true, force: true }); }
});
test('files changing during inspection produce unknown, with no index writes by the checker', async () => {
  const r = await repository(); const bin = await mkdtemp(join(tmpdir(), 'pa-git-bin-')); const previous = process.env.PATH;
  try {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const path = join(r.root, 'plugins/google-calendar/server.ts');
    // Deterministic race at the target-object boundary, after first snapshot.
    await writeFile(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = "cat-file" ]; then printf 'concurrent edit\\n' > '${path}'; fi\ndone\nexec '${realGit}' "$@"\n`); await chmod(join(bin, 'git'), 0o700);
    const index = await readFile(join(r.root, '.git/index')); process.env.PATH = `${bin}:${previous}`;
    const result = await r.inspect(r.target, signal()); assert.equal(result.reason, 'changed'); assert.equal(result.outcome, 'cannot_establish');
    assert.deepEqual(await readFile(join(r.root, '.git/index')), index);
  } finally { process.env.PATH = previous; await r.cleanup(); await rm(bin, { recursive: true, force: true }); }
});
