import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Baselines, baselineCacheSchema } from '../adapters/baseline.ts';
import type { BaselineStore } from '../adapters/baseline.ts';
import { ApplicationError, integrationId } from '../core/application-model.ts';
import type { IntegrationId } from '../core/application-model.ts';
const exec = promisify(execFile);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(ids: IntegrationId[] = ['google-calendar']) {
  const root = await mkdtemp(join(tmpdir(), 'pa-baseline-cache-')), repo = join(root, 'published'), tools = join(root, 'tools');
  const cli = join(tools, 'host-daemon', 'dist', 'bb'); let saved: unknown;
  const env = { PATH: process.env.PATH, HOME: root };
  await mkdir(repo); await mkdir(join(tools, 'host-daemon', 'dist'), { recursive: true }); await mkdir(join(tools, 'node_modules', 'npm', 'bin'), { recursive: true });
  // Unit fixture only: a deterministic local builder reconstructs from Git,
  // never the installed tree. Real BB builders are exercised by native gates.
  await writeFile(join(tools, 'package.json'), JSON.stringify({ name: 'bb-app', version: '999.0.0', type: 'module' }));
  await writeFile(join(tools, 'node_modules', 'npm', 'package.json'), JSON.stringify({ name: 'npm', version: '0.0.0' }));
  await writeFile(join(tools, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// fixture has no package dependencies\n');
  await writeFile(cli, `import {mkdir,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const root=process.argv.at(-1);await mkdir(join(root,'dist'),{recursive:true});await writeFile(join(root,'dist/server.js'),await readFile(join(root,'server.ts')));await writeFile(join(root,'dist/server.meta.json'),JSON.stringify({builtWith:{bbVersion:'999.0.0'}}));`);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env })).stdout.trim();
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid');
  for (const id of ids) {
    const source = join(repo, 'plugins', id); await mkdir(source, { recursive: true });
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: `bb-plugin-${id}`, version: '0.1.1' }));
    await writeFile(join(source, 'server.ts'), 'independently published original\n');
  }
  await git('add', '.'); await git('commit', '-qm', 'published originals'); const commit = await git('rev-parse', 'HEAD');
  const installed = (id: IntegrationId = ids[0]) => join(root, 'managed', commit, 'plugins', id);
  for (const id of ids) { await cp(join(repo, 'plugins', id), installed(id), { recursive: true }); await exec(process.execPath, [cli, 'plugin', 'build', installed(id)], { env }); }
  const store: BaselineStore = { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  return { root, repo, tools, cli, commit, installed, store, saved: () => baselineCacheSchema.parse(saved), baseline: () => new Baselines(repo, cli, undefined, store), clean: () => rm(root, { recursive: true, force: true }) };
}
test('trusted originals survive reload and later builder pruning without blessing customized installed bytes', async () => {
  const f = await fixture(); const first = f.baseline();
  try {
    await writeFile(join(f.installed(), 'dist/server.js'), 'customized runtime\n');
    assert.equal((await first.inspect('google-calendar', f.installed(), f.commit)).local, 'custom');
    assert.equal(f.saved().records[0].files['dist/server.js'], hash('independently published original\n'));
    assert.notEqual(f.saved().records[0].files['dist/server.js'], hash('customized runtime\n'));
    await first.close(); await rm(f.tools, { recursive: true, force: true }); // Simulate native retention after later BB upgrades.
    const reloaded = f.baseline();
    try {
      assert.equal((await reloaded.inspect('google-calendar', f.installed(), f.commit)).local, 'custom');
      await writeFile(join(f.installed(), 'dist/server.js'), 'independently published original\n');
      assert.equal((await reloaded.inspect('google-calendar', f.installed(), f.commit)).local, 'stock');
      await writeFile(join(f.installed(), 'server.ts'), 'new local source\n');
      assert.equal((await reloaded.inspect('google-calendar', f.installed(), f.commit)).local, 'custom');
      await writeFile(join(f.installed(), 'dist/server.meta.json'), JSON.stringify({ builtWith: { bbVersion: '999.0.1' } }));
      await assert.rejects(reloaded.inspect('google-calendar', f.installed(), f.commit), (error: unknown) => error instanceof ApplicationError && error.category === 'baseline_unknown');
      assert.equal(f.saved().records.length, 0, 'Never reuse a different artifact key or bless new installed bytes');
    } finally { await reloaded.close(); }
  } finally { await first.close(); await f.clean(); }
});
test('cache retains at most one active key per integration and drops removed integrations', async () => {
  const f = await fixture(integrationId.options), baseline = f.baseline();
  try {
    for (const id of integrationId.options) await baseline.inspect(id, f.installed(id), f.commit);
    assert.equal(f.saved().records.length, 5); assert.equal(new Set(f.saved().records.map(row => row.id)).size, 5);
    await baseline.retain(['google-calendar']); assert.deepEqual(f.saved().records.map(row => row.id), ['google-calendar']);
    assert.equal(baselineCacheSchema.safeParse({ ...f.saved(), records: Array(6).fill(f.saved().records[0]) }).success, false);
  } finally { await baseline.close(); await f.clean(); }
});
test('failed persistence never authorizes a baseline from memory or exposes storage details', async () => {
  const f = await fixture(); f.store.save = async () => { throw new Error('PRIVATE_SENTINEL'); }; const baseline = f.baseline();
  try {
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(baseline.inspect('google-calendar', f.installed(), f.commit), (error: unknown) => error instanceof ApplicationError && error.category === 'storage' && !error.message.includes('PRIVATE_SENTINEL'));
  } finally { await baseline.close(); await f.clean(); }
});
test('baseline disposal drains only issued KV writes and fences the old inspection continuation', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entering = new Promise<void>(resolve => { entered = resolve; });
  const save = f.store.save; f.store.save = async value => { entered(); await gate; await save(value); };
  const baseline = f.baseline();
  try {
    const inspect = baseline.inspect('google-calendar', f.installed(), f.commit);
    const rejected = assert.rejects(inspect, (error: unknown) => error instanceof ApplicationError && error.category === 'interrupted');
    await entering; let stopped = false; const stopping = baseline.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false); release(); await stopping; await rejected;
    assert.equal(f.saved().records.length, 1);
  } finally { release?.(); await baseline.close(); await f.clean(); }
});
