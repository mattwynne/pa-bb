// Opt-in disposable Linux BB 0.45.0 installation. Only generated /tmp aliases.
// Supply BB_FIXTURE_BB_ROOT, BB_FIXTURE_DEPENDENCIES (read-only package node_modules),
// BB_FIXTURE_SOURCE (this repository snapshot), BB_FIXTURE_PORT, BB_FIXTURE_ARTIFACTS.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, rm, open, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const bb = resolve(process.env.BB_FIXTURE_BB_ROOT ?? '');
const source = resolve(process.env.BB_FIXTURE_SOURCE ?? '');
const deps = resolve(process.env.BB_FIXTURE_DEPENDENCIES ?? '');
const port = Number(process.env.BB_FIXTURE_PORT ?? 43887);
const artifacts = resolve(process.env.BB_FIXTURE_ARTIFACTS ?? '');
assert.ok(bb !== resolve('.') && source !== resolve('.') && deps !== resolve('.') && artifacts !== resolve('.'));
assert.ok(artifacts.startsWith('/tmp/') && Number.isInteger(port) && port >= 1024 && port <= 65533);
for (const candidate of [port, port + 1]) await new Promise((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(candidate, '127.0.0.1', () => s.close(ok)); });
const root = await mkdtemp('/tmp/pa-installed-bb-');
await mkdir(artifacts, { recursive: true });
const base = `http://127.0.0.1:${port}`;
const env = { HOME: join(root, 'home'), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_URL: base, BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_PORT: String(port), BB_HOST_DAEMON_PORT: String(port + 1), BB_GENERATED_ALIAS_ROOT: join(root, 'alias') };
await mkdir(env.HOME); await mkdir(env.BB_DATA_DIR);
for (const name of ['generated', 'other']) { await mkdir(join(env.BB_GENERATED_ALIAS_ROOT, name), { recursive: true }); await writeFile(join(env.BB_GENERATED_ALIAS_ROOT, name, 'Note.md'), `# ${name}\n- [ ] Generated task\n[[Note]]\n`); }
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 180000, maxBuffer: 2e6 })).stdout;
const check = async (url, input) => { const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) }); const body = await response.json(); assert.equal(body.ok, true, `${url}: ${JSON.stringify(body).slice(0, 500)}`); return body.result; };
const rpc = (id, method, input = null) => check(`/api/v1/plugins/${id}/rpc/${method}`, input);
const invoke = async (name, input) => { const at = performance.now(); const result = await rpc('obsidian', 'fixtureInvoke', { name, input }); return { ...result, ms: performance.now() - at, value: JSON.parse(result.text) }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = async (predicate, ms, stage) => { const until = performance.now() + ms; while (performance.now() < until) { if (await predicate()) return; await delay(200); } throw new Error(`fixture wait expired: ${stage}`); };
const record = { root, port, packages: {}, tools: [], phases: [], saves: [], native: [], observations: [], ui: false, driver: 'fixture-only client-restricted RPC -> captured original registered execute -> actual BB SDK caller', providerConversation: false };
const save = async () => writeFile(join(artifacts, 'result.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
const processes = [];
let stage = 'package';
try {
  for (const id of ['icloud', 'obsidian']) {
    const dir = join(root, 'packages', id); await mkdir(dir, { recursive: true });
    // Source is a disposable snapshot, never a symlink into a writable host package.
    for (const item of await readdir(join(source, 'plugins', id))) {
      if (['server.ts', 'test', 'dist', 'node_modules'].includes(item)) continue;
      if (!/\.(?:ts|tsx|css|json)$/.test(item) && !['core', 'adapters'].includes(item)) continue;
      await cp(join(source, 'plugins', id, item), join(dir, item), { recursive: true });
    }
    await cp(join(source, 'plugins', id, 'server.ts'), join(dir, 'production.ts'));
    await cp(join(source, 'fixtures/installed-bb', `${id}-server.ts`), join(dir, 'server.ts'));
    await symlink(join(deps, id, 'node_modules'), join(dir, 'node_modules'));
    const built = await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), 'plugin', 'build', dir], { env, cwd: root, timeout: 180000, maxBuffer: 2e6 });
    record.packages[id] = { build: built.stdout.slice(-350) };
  }
  stage = 'start';
  for (const [name, command] of [['server', 'server/dist/index.js']]) {
    const log = await open(join(root, `${name}.log`), 'w', 0o600);
    const child = spawn(process.execPath, [join(bb, command)], { cwd: root, env, stdio: ['ignore', log.fd, log.fd] });
    processes.push(child); await log.close();
  }
  await wait(async () => { if (processes.some(p => p.exitCode !== null || p.signalCode !== null)) throw new Error('BB process exited'); try { return (await fetch(base + '/', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 30000, 'BB host');
  assert.equal((await cli('--version')).trim(), '0.45.0');
  assert.equal(JSON.parse(await cli('plugin', 'list', '--json')).plugins.some(p => ['icloud', 'obsidian'].includes(p.id)), false);
  stage = 'install';
  for (const id of ['icloud', 'obsidian']) {
    const installed = JSON.parse(await cli('plugin', 'install', join(root, 'packages', id), '--yes', '--json'));
    assert.equal(installed.ok, true); record.packages[id].status = installed.plugin.status;
    assert.equal(installed.plugin.status, 'running');
  }
  record.tools = JSON.parse(await rpc('obsidian', 'fixtureCatalog'));
  assert.equal(record.tools.length, 9); assert.ok(record.tools.every(t => t.inputSchema.type === 'object'));
  await save(); await writeFile(join(artifacts, 'ready'), String(port));
  console.log('INSTALLED_READY', port);
  stage = 'native UI';
  await wait(async () => { try { await stat(join(artifacts, 'ui-ready')); return true; } catch { return false; } }, 180000, 'Mac UI picker opened');
  await writeFile(join(env.BB_GENERATED_ALIAS_ROOT, 'generated', 'transfer.bin'), Buffer.alloc(24 * 1024 * 1024, 65));
  await wait(async () => (await rpc('icloud', 'status')).mirrors.some(m => m.id === 'one' && m.phase === 'running'), 90000, 'minute schedule started native transfer');
  const uiAt = performance.now();
  await wait(async () => { try { await stat(join(artifacts, 'ui-done')); return true; } catch { return false; } }, 65000, 'Mac UI during native command');
  record.ui = true; record.phases.push({ name: 'native-ui', ms: performance.now() - uiAt }); await save();
  await wait(async () => !(await rpc('icloud', 'status')).mirrors.some(m => m.phase === 'running'), 130000, 'first native pass');
  stage = 'tools';
  // The second vault is connected explicitly by the fixture client (the first
  // was connected using the real UI). No direct configuration/admission write.
  const connection = await rpc('obsidian', 'connect', { vaultId: 'two' });
  assert.equal(connection.vaults.length, 2);
  const successes = [
    ['obsidian_status', {}], ['obsidian_create_note', { vaultId: 'one', path: 'Fixture.md', text: '# Fixture\n- [ ] Task\n[[Note]]\n' }],
    ['obsidian_read_note', { vaultId: 'one', path: 'Fixture.md' }],
    ['obsidian_get_note_metadata', { vaultId: 'one', path: 'Fixture.md' }],
    ['obsidian_search_notes', { vaultId: 'one', text: 'Fixture' }],
    ['obsidian_resolve_link', { vaultId: 'one', path: 'Fixture.md', link: 'Note' }],
    ['obsidian_list_tasks', { vaultId: 'one', path: 'Fixture.md' }],
  ];
  for (const [name, input] of successes) { const result = await invoke(name, input); assert.equal(result.isError, false, name); record.observations.push({ name, ms: result.ms }); }
  let read = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Fixture.md' });
  assert.equal(read.value.complete, true);
  for (const [name, extra] of [['obsidian_edit_note', { append: 'Edited\n' }], ['obsidian_update_properties', { set: { fixture: true } }]]) {
    const result = await invoke(name, { vaultId: 'one', path: 'Fixture.md', expectedHash: read.value.hash, ...extra });
    assert.equal(result.isError, false, `${name}: ${result.text}`); record.observations.push({ name, ms: result.ms });
    read = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Fixture.md' }); assert.equal(read.isError, false);
  }
  assert.match(read.value.text, /Edited/);
  const bad = await invoke('obsidian_edit_note', { vaultId: 'one', path: 'Fixture.md', expectedHash: '0'.repeat(64), append: 'bad' });
  assert.equal(bad.isError, true); record.observations.push({ name: 'controlled-cas-error', category: bad.value.category });
  await save();
  stage = 'workload';
  const { workload } = await import('./workload.mjs');
  await workload({ root, env, record, save, rpc, invoke, wait, delay, serverPid: processes[0].pid });
  if (process.env.BB_FIXTURE_PROVIDER_GATE === '1') {
    stage = 'provider handoff'; await save(); console.log('DRAINED_PROVIDER_READY', port);
    // The owner authorizes ONE separate provider conversation only after this
    // exact workload/drain gate. Never time out into an unverified "success".
    await wait(async () => { try { await stat(join(artifacts, 'provider-done')); return true; } catch { return false; } }, 600000, 'provider evidence handoff');
  }
  stage = 'complete'; await save(); console.log('INSTALLED_COMPLETE', join(artifacts, 'result.json'));
} catch (error) {
  record.failure = { stage, kind: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 600) };
  await save(); console.error('INSTALLED_FAILED', stage, record.failure); process.exitCode = 1;
} finally {
  // Never remove a live owner's root. Kill only children this fixture spawned,
  // wait for them to exit, retain failure roots for bounded investigation.
  for (const child of processes.slice().reverse()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(processes.map(child => new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve))));
  // Native children inherit ownership across server exit; never erase their
  // root while an orphaned fixture process still references its paths.
  const ownedChildren = async () => {
    const ids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    const matches = await Promise.all(ids.map(async id => { try { return (await readFile(`/proc/${id}/cmdline`, 'utf8')).includes(root); } catch { return false; } }));
    return matches.some(Boolean);
  };
  if (!process.exitCode) {
    try { await wait(async () => !await ownedChildren(), 10000, 'fixture children exit'); }
    catch { process.exitCode = 1; record.failure = { stage: 'cleanup', kind: 'OwnedChildLive' }; await save(); }
  }
  if (process.exitCode) console.error('Retained failed generated root', root);
  else await rm(root, { recursive: true, force: true });
}
