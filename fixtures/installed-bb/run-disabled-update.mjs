// Opt-in, isolated BB 0.45.0 managed-update rehearsal; generated /tmp data only.
// Two Git commits contain actual old/current plugin implementations and fixture-only entries.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, symlink, unlink, writeFile, readFile, rm, open, stat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bb = resolve(process.env.BB_FIXTURE_BB_ROOT ?? '.');
const old = resolve(process.env.BB_FIXTURE_OLD ?? '.');
const next = resolve(process.env.BB_FIXTURE_SOURCE ?? '.');
const deps = resolve(process.env.BB_FIXTURE_DEPENDENCIES ?? '.');
const artifacts = resolve(process.env.BB_FIXTURE_ARTIFACTS ?? '.');
const port = Number(process.env.BB_FIXTURE_PORT ?? 43929);
assert.ok([bb, old, next, deps, artifacts].every(p => p !== resolve('.')));
assert.ok(artifacts.startsWith('/tmp/') && Number.isInteger(port) && port > 1024 && port < 65534);
for (const candidate of [port, port + 1]) await new Promise((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(candidate, '127.0.0.1', () => s.close(ok)); });
await mkdir(artifacts, { recursive: true });
assert.equal((await readdir(artifacts)).length, 0, 'fixture requires an empty, fresh artifacts directory');
const root = await mkdtemp('/tmp/pa-disabled-update-');
const repo = join(root, 'source'), base = `http://127.0.0.1:${port}`, events = join(artifacts, 'events.jsonl');
const env = { HOME: join(root, 'home'), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production', BB_DATA_DIR: join(root, 'data'), BB_SERVER_URL: base, BB_SERVER_BIND_HOST: '127.0.0.1', BB_SERVER_PORT: String(port), BB_HOST_DAEMON_PORT: String(port + 1), BB_GENERATED_ALIAS_ROOT: join(root, 'alias'), BB_FIXTURE_EVENTS: events, BB_TELEMETRY: 'false' };
await mkdir(env.HOME); await mkdir(env.BB_DATA_DIR); await mkdir(repo);
for (const name of ['generated', 'other']) { await mkdir(join(env.BB_GENERATED_ALIAS_ROOT, name), { recursive: true }); await writeFile(join(env.BB_GENERATED_ALIAS_ROOT, name, 'Note.md'), `# ${name}\n- [ ] Generated task\n`); }
await writeFile(events, '', { mode: 0o600 });
const cli = async (...args) => (await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), ...args], { env, cwd: root, timeout: 180000, maxBuffer: 2e6 })).stdout;
const git = async (...args) => (await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { env, timeout: 60000 })).stdout.trim();
const http = async (url, input, timeout = 120000) => { const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(timeout) }); const body = await response.json(); assert.equal(body.ok, true, `${url}: ${JSON.stringify(body).slice(0, 400)}`); return body.result; };
const rpc = (id, method, input = null) => http(`/api/v1/plugins/${id}/rpc/${method}`, input);
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
const invoke = async (name, input) => { const start = monotonic(); const value = JSON.parse((await rpc('obsidian', 'fixtureInvoke', { name, input })).text); return { value, start, end: monotonic() }; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = async (predicate, ms, label) => { const until = performance.now() + ms; while (performance.now() < until) { if (await predicate()) return; await delay(300); } throw new Error(`timed out: ${label}`); };
const require = createRequire(import.meta.url);
const SQLite = require(join(deps, 'icloud/node_modules/better-sqlite3'));
const overlayTables = () => { const db = new SQLite(join(env.BB_DATA_DIR, 'plugins/icloud/data.db'), { readonly: true, fileMustExist: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'icloud_note_overlay_%' ORDER BY name").all().map(r => r.name); } finally { db.close(); } };
const files = async (path, prefix = '') => { const out = []; for (const entry of await readdir(path, { withFileTypes: true }).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) { const relative = join(prefix, entry.name); if (entry.isDirectory()) out.push(...await files(join(path, entry.name), relative)); else if (entry.isFile()) out.push([relative, sha(await readFile(join(path, entry.name)))]); else throw new Error('unexpected private symlink'); } return out.sort((a,b) => a[0].localeCompare(b[0])); };
const snapshot = async () => ({ syncStore: await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync')), legacy: await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync/note-operations')), baselines: await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync/baselines')), config: await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync/state')), secrets: await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync/secrets')), sentinel: await files(join(env.BB_DATA_DIR, 'plugins/sentinel')) });
const list = async () => JSON.parse(await cli('plugin', 'list', '--json')).plugins;
const rows = async () => (await list()).filter(p => ['icloud', 'obsidian', 'sentinel'].includes(p.id)).map(({ id, enabled, status, version, source }) => ({ id, enabled, status, version, source }));
const packageCopy = async (src, id, target, entry, version) => {
  await mkdir(target, { recursive: true });
  for (const item of await readdir(join(src, 'plugins', id))) {
    if (['server.ts', 'test', 'features', 'dist', 'node_modules'].includes(item)) continue;
    if (!/\.(?:ts|tsx|css|json)$/.test(item) && !['core', 'adapters'].includes(item)) continue;
    await cp(join(src, 'plugins', id, item), join(target, item), { recursive: true });
  }
  await cp(join(src, 'plugins', id, 'server.ts'), join(target, 'production.ts'));
  await cp(join(next, 'fixtures/installed-bb', entry), join(target, 'server.ts'));
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')); manifest.version = version;
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await symlink(join(deps, id, 'node_modules'), join(target, 'node_modules'));
  try { await exec(process.execPath, [join(bb, 'host-daemon/dist/bb'), 'plugin', 'build', target], { env, cwd: root, timeout: 180000, maxBuffer: 2e6 }); }
  finally { await unlink(join(target, 'node_modules')); }
};
const installCommit = async (src, oldVersion) => {
  for (const id of ['icloud', 'obsidian']) {
    const target = join(repo, 'plugins', id);
    await rm(target, { recursive: true, force: true });
    await packageCopy(src, id, target, id === 'icloud' ? oldVersion ? 'legacy-icloud-server.ts' : 'timed-icloud-server.ts' : 'update-obsidian-server.ts', id === 'icloud' ? oldVersion ? '0.1.12' : '0.1.13-fixture' : oldVersion ? '0.1.0' : '0.1.1-fixture');
  }
  await git('add', '-f', 'plugins'); await git('commit', '-m', oldVersion ? 'Fixture legacy packages' : 'Fixture candidate packages');
  return git('rev-parse', 'HEAD');
};
const result = { stage: 'package', root, port, update: [], timing: null, states: [] };
const save = () => writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
let child;
try {
  await git('init', '-b', 'main');
  const initial = await installCommit(old, true); result.initial = initial;
  const sentinel = join(root, 'sentinel'); await mkdir(join(sentinel, 'dist'), { recursive: true });
  await writeFile(join(sentinel, 'package.json'), JSON.stringify({ name: 'bb-plugin-sentinel', version: '1.0.0', type: 'module', engines: { node: '>=22', bb: '>=0.45.0', bbPluginSdk: '>=0.6.15 <1' }, bb: { name: 'Sentinel', description: 'Generated fixture sentinel.', branding: { icon: 'Circle' }, server: './server.ts' } }));
  // Inert dependency-free ESM needs no bundler. Match BB's packaged server
  // metadata shape from a package built in THIS fixture with the actual CLI.
  const sentinelCode = `export default async function fixture(bb) { bb.storage.database().exec(${JSON.stringify("CREATE TABLE IF NOT EXISTS fixture_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT OR IGNORE INTO fixture_sentinel VALUES (1, 'sentinel-untouched')")}); }\n`;
  await writeFile(join(sentinel, 'server.ts'), sentinelCode);
  await writeFile(join(sentinel, 'dist/server.js'), sentinelCode);
  const meta = JSON.parse(await readFile(join(repo, 'plugins/obsidian/dist/server.meta.json'), 'utf8'));
  meta.pluginId = 'sentinel'; meta.pluginVersion = '1.0.0';
  await writeFile(join(sentinel, 'dist/server.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  result.stage = 'start'; const log = await open(join(root, 'server.log'), 'w', 0o600);
  child = spawn(process.execPath, [join(bb, 'server/dist/index.js')], { cwd: root, env, stdio: ['ignore', log.fd, log.fd] }); await log.close();
  await wait(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('server exited'); try { return (await fetch(base + '/', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 30000, 'server');
  assert.equal((await cli('--version')).trim(), '0.45.0');
  assert.equal((await list()).some(p => ['icloud', 'obsidian', 'sentinel'].includes(p.id)), false);
  result.stage = 'install';
  for (const id of ['icloud', 'obsidian']) {
    const installed = JSON.parse(await cli('plugin', 'install', `git:${repo}@ref:main`, '--subdirectory', `plugins/${id}`, '--yes', '--json'));
    assert.equal(installed.plugin.status, 'running');
  }
  assert.equal(JSON.parse(await cli('plugin', 'install', sentinel, '--yes', '--json')).plugin.status, 'running');
  result.states.push({ at: 'legacy-running', plugins: await rows() });
  assert.equal((await rpc('icloud', 'status')).noteAccessVersion, 1);
  const oldStatus = await rpc('icloud', 'status');
  assert.deepEqual(oldStatus.mirrors.map(m => m.id), ['one', 'two'], JSON.stringify(oldStatus).slice(0, 700));
  await rpc('obsidian', 'connect', { vaultId: 'one' }); await rpc('obsidian', 'connect', { vaultId: 'two' });
  const beforeVaults = (await rpc('obsidian', 'status')).vaults.map(v => v.vaultId).sort();
  assert.deepEqual(beforeVaults, ['one', 'two']);
  // The second source is explicitly selected/connected but paused, so it must NOT be resumed.
  await rpc('icloud', 'pause', { id: 'two' });
  result.previouslyEnabled = (await rpc('icloud', 'status')).mirrors.filter(m => m.enabled).map(m => m.id);
  assert.deepEqual(result.previouslyEnabled, ['one']);
  result.stage = 'seed';
  const created = await invoke('obsidian_create_note', { vaultId: 'one', path: 'Legacy.md', text: '# Generated old\n' });
  assert.equal(created.value.receipt.outcome, 'saved_locally_pending_sync');
  const read = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Legacy.md' });
  assert.equal(read.value.complete, true);
  const edited = await invoke('obsidian_edit_note', { vaultId: 'one', path: 'Legacy.md', expectedHash: read.value.hash, append: 'Generated second version\n' });
  assert.equal(edited.value.receipt.outcome, 'saved_locally_pending_sync');
  result.legacyIds = [created.value.receipt.operationId, edited.value.receipt.operationId];
  result.legacyHash = (await invoke('obsidian_read_note', { vaultId: 'one', path: 'Legacy.md' })).value.hash;
  assert.equal(result.legacyHash, sha('# Generated old\nGenerated second version\n'));
  result.stage = 'quiesce';
  // Stop consumer admission first, then supported producer Pause and worker disposal.
  assert.equal(JSON.parse(await cli('plugin', 'disable', 'obsidian', '--json')).plugin.enabled, false);
  await rpc('icloud', 'pause', { id: 'one' });
  await wait(async () => (await rpc('icloud', 'status')).mirrors.every(m => m.phase !== 'running'), 120000, 'native idle after Pause');
  assert.equal(JSON.parse(await cli('plugin', 'disable', 'icloud', '--json')).plugin.enabled, false);
  await wait(async () => (await rows()).filter(p => p.id !== 'sentinel').every(p => !p.enabled && p.status === 'disabled'), 30000, 'both stopped');
  const quiescent = await snapshot(); result.before = quiescent;
  const baselineRoot = join(env.BB_DATA_DIR, 'plugins/icloud/sync/baselines');
  const baselineIdentity = async () => Promise.all(['one', 'two'].map(async id => ({ id, inode: (await stat(join(baselineRoot, id))).ino, marker: sha(await readFile(join(baselineRoot, id, 'initialized'))) })));
  result.baselineIdentityBefore = await baselineIdentity();
  assert.deepEqual(overlayTables(), [], 'new overlay schema present in legacy installation');
  assert.ok(quiescent.legacy.length >= 3 && quiescent.legacy.some(([path]) => path.endsWith('/previous')));
  assert.ok(quiescent.baselines.length >= 4 && quiescent.config.length > 0 && quiescent.sentinel.length > 0);
  const factoriesBefore = (await readFile(events, 'utf8')).trim().split('\n').length;
  result.states.push({ at: 'both-disabled', plugins: await rows(), factoriesBefore }); await save();
  result.stage = 'candidate'; const candidate = await installCommit(next, false); result.candidate = candidate;
  // Import a prepared candidate bundle without calling its factory in a separate process.
  // The package store must be unchanged by this import and the disabled updates.
  for (const id of ['icloud', 'obsidian']) {
    const prepared = join(repo, `plugins/${id}/dist/server.js`);
    await symlink(join(deps, `${id}/node_modules`), join(repo, `plugins/${id}/node_modules`));
    try { await exec(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', prepared], { env, cwd: root, timeout: 30000, maxBuffer: 2e6 }); }
    finally { await unlink(join(repo, `plugins/${id}/node_modules`)); }
    assert.deepEqual(await snapshot(), quiescent, `${id} candidate import changed private stores`);
  }
  assert.deepEqual(overlayTables(), [], 'import produced overlay schema');
  for (const id of ['icloud', 'obsidian']) {
    result.stage = `update-${id}`;
    const checks = JSON.parse(await cli('plugin', 'outdated', '--json'));
    const target = checks.find(p => p.id === id);
    assert.equal(target?.outcome, 'update-available', JSON.stringify(target));
    assert.equal(target.candidate.version, candidate);
    const samples = [], started = performance.now();
    let monitoring = true, observedProblem = null;
    const monitor = (async () => { while (monitoring) {
      try {
        const body = await (await fetch(base + '/api/v1/plugins', { signal: AbortSignal.timeout(5000) })).json();
        const affected = body.plugins.filter(p => ['icloud', 'obsidian'].includes(p.id));
        if (affected.length !== 2 || affected.some(p => p.enabled || p.status !== 'disabled')) throw new Error('plugin enabled inside update window');
        samples.push({ atMs: Math.round(performance.now() - started), states: affected.map(p => [p.id, p.enabled, p.status]) });
      } catch (error) { observedProblem = error; break; }
      await delay(450);
    } })();
    let applied;
    try {
      // Direct BB 0.45.0 managed-update endpoint returns the unabridged
      // applyUpdate result (the CLI prints only its human summary).
      const response = await fetch(base + `/api/v1/plugins/${id}/update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(180000) });
      applied = await response.json();
      assert.equal(response.ok, true, JSON.stringify(applied).slice(0, 450));
    } finally { monitoring = false; await monitor; }
    const elapsedMs = Math.round(performance.now() - started);
    assert.ifError(observedProblem);
    assert.ok(samples.length >= 10 && samples.at(-1).atMs >= 29000, 'did not observe disabled registrations through stabilization');
    assert.equal(applied.applied, true); assert.equal(applied.outcome, 'updated');
    assert.equal(applied.to.version, candidate);
    assert.ok(elapsedMs >= 30000, `host stabilization not awaited: ${elapsedMs}ms`);
    const registration = (await rows()).find(p => p.id === id);
    assert.equal(registration.enabled, false); assert.equal(registration.status, 'disabled');
    const source = JSON.parse(await cli('plugin', 'source', id, '--json'));
    assert.ok(source.resolved.includes(candidate.slice(0, 12)) && source.history.some(h => h.version === candidate), 'candidate exact Git resolution missing');
    const factories = (await readFile(events, 'utf8')).trim().split('\n').length;
    assert.equal(factories, factoriesBefore, 'disabled candidate factory invoked');
    assert.deepEqual(await snapshot(), quiescent, 'disabled update changed private stores');
    assert.deepEqual(overlayTables(), [], 'disabled update published overlay schema');
    assert.equal((await rows()).filter(p => p.id !== 'sentinel').every(p => !p.enabled && p.status === 'disabled'), true);
    result.update.push({ id, elapsedMs, applyResult: applied, checked: target.outcome, from: target.installed.display, to: target.candidate.display, resolved: source.resolved, bothDisabledSamples: samples.length, firstSampleMs: samples[0].atMs, lastSampleMs: samples.at(-1).atMs, factoriesUnchanged: true, storeUnchanged: true, overlaySchemaAbsent: true });
    await save();
  }
  result.stage = 'restore';
  assert.equal((await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync/overlay'))).length, 0, 'new overlay appeared while disabled');
  assert.deepEqual(overlayTables(), [], 'overlay schema present before candidate startup');
  assert.equal(JSON.parse(await cli('plugin', 'enable', 'icloud', '--json')).plugin.status, 'running');
  await wait(async () => (await rpc('icloud', 'status')).mirrors.every(m => m.local.available), 30000, 'owned local readiness');
  assert.ok(overlayTables().includes('icloud_note_overlay_legacy'), 'startup did not index legacy receipts');
  const current = await rpc('icloud', 'status');
  assert.deepEqual(current.mirrors.map(m => [m.id, m.enabled]), [['one', false], ['two', false]]);
  assert.equal(JSON.parse(await cli('plugin', 'enable', 'obsidian', '--json')).plugin.status, 'running');
  assert.deepEqual((await rpc('obsidian', 'status')).vaults.map(v => v.vaultId).sort(), beforeVaults);
  for (const id of result.legacyIds) {
    const legacy = await invoke('obsidian_status', { vaultId: 'one', path: 'Legacy.md', operationId: id });
    assert.equal(legacy.value.receipts?.find(r => r.operationId === id)?.outcome, 'saved_locally_pending_sync', JSON.stringify(legacy.value).slice(0, 500));
  }
  const legacyRead = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Legacy.md' });
  assert.equal(legacyRead.value.hash, result.legacyHash);
  assert.deepEqual(await files(join(env.BB_DATA_DIR, 'plugins/icloud/sync/note-operations')), quiescent.legacy);
  result.states.push({ at: 'restored-disabled-sources', plugins: await rows(), mirrors: current.mirrors.map(m => ({ id: m.id, enabled: m.enabled, local: m.local.available })), vaults: beforeVaults });
  // Ordinary v2 work while sources remain paused; no native/cloud delivery claim.
  const newer = await invoke('obsidian_create_note', { vaultId: 'one', path: 'After.md', text: '# Generated v2\n' });
  assert.equal(newer.value.receipt.outcome, 'saved_locally_pending_sync');
  assert.equal((await invoke('obsidian_read_note', { vaultId: 'one', path: 'After.md' })).value.text, '# Generated v2\n');
  result.v2 = { id: newer.value.receipt.operationId, hash: sha('# Generated v2\n') };
  // Resume exactly those originally enabled, leaving the other selected source paused.
  for (const id of result.previouslyEnabled) await rpc('icloud', 'enable', { id });
  await wait(async () => (await rpc('icloud', 'status')).mirrors.find(m => m.id === 'one')?.lastSuccess !== current.mirrors.find(m => m.id === 'one')?.lastSuccess, 180000, 'ordinary scheduled completion');
  const restored = await rpc('icloud', 'status');
  const runs = (await rpc('icloud', 'diagnostics', {})).runs;
  assert.ok(runs.some(run => run.kind === 'sync' && run.outcome === 'succeeded' && run.finishedAt >= restored.mirrors.find(m => m.id === 'one').lastSuccess), 'ordinary following scheduled run missing');
  result.baselineIdentityAfter = await baselineIdentity();
  assert.deepEqual(result.baselineIdentityAfter, result.baselineIdentityBefore, 'baseline recreated during ordinary run');
  assert.deepEqual(restored.mirrors.filter(m => m.enabled).map(m => m.id), result.previouslyEnabled);
  assert.equal(restored.mirrors.find(m => m.id === 'two').phase, 'paused');
  assert.deepEqual(await files(join(env.BB_DATA_DIR, 'plugins/sentinel')), quiescent.sentinel);
  result.states.push({ at: 'exact-restoration', plugins: await rows(), mirrors: restored.mirrors.map(m => ({ id: m.id, enabled: m.enabled, phase: m.phase, lastSuccess: m.lastSuccess })) });
  result.stage = 'timing';
  // Short, real client saves while the unchanged scheduler performs actual maintenance.
  const intervals = [];
  for (let i = 0; i < 28; i++) {
    const id = i % 2 ? 'one' : 'two', path = `Timed-${i % 4}.md`;
    const prior = i >= 4 ? await invoke('obsidian_read_note', { vaultId: id, path }) : null;
    const text = `# Generated timing ${i}\n`;
    const call = await invoke(i >= 4 ? 'obsidian_edit_note' : 'obsidian_create_note', i >= 4 ? { vaultId: id, path, expectedHash: prior.value.hash, append: text } : { vaultId: id, path, text });
    assert.equal(call.value.receipt.outcome, 'saved_locally_pending_sync'); intervals.push({ start: call.start, end: call.end, id, path });
  }
  // Maintenance is scheduled by normal commits. No forged rows or sleeps.
  await delay(1000);
  const observations = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  const commits = observations.filter(e => e.event === 'commit'), maint = observations.filter(e => e.event === 'maintain'), fsync = observations.filter(e => e.event === 'file-fsync'), dirs = observations.filter(e => e.event === 'directory-fsync');
  const overlap = (a,b) => a.start < b.end && b.start < a.end;
  const round = n => Math.round(n * 1000) / 1000;
  result.timing = { client: intervals.length, commits: commits.length, maintenance: maint.length, maintenanceWork: maint.map(e => e.work), fileFsync: fsync.length, directoryFsync: dirs.length, clientMaintenanceOverlaps: intervals.flatMap((c,i) => maint.filter(m => overlap(c,m)).map(m => { const commit = commits.find(k => overlap(k,c)); return { client: i, phase: commit && overlap(m,commit) ? 'commit' : commit && m.end <= commit.start ? 'before-commit' : commit && m.start >= commit.end ? 'after-commit-before-ack' : 'outside-observed-commit', overlapMs: round(Math.min(c.end,m.end)-Math.max(c.start,m.start)) }; })), commitMaintenanceOverlaps: commits.flatMap((c,i) => maint.filter(m => overlap(c,m)).map(() => i)), wholeCommitMs: commits.map(e => round(e.end-e.start)), explicitFileFsyncMs: fsync.map(e => round(e.end-e.start)), explicitDirectoryFsyncMs: dirs.map(e => round(e.end-e.start)), clientMs: intervals.map(e => round(e.end-e.start)), clock: 'Linux OS monotonic process.hrtime.bigint across client/server; SQLite FULL included only in whole commit' };
  assert.ok(commits.length >= 28 && fsync.length > 0 && dirs.length > 0);
  assert.ok(maint.length >= 2 && result.timing.clientMaintenanceOverlaps.length >= 2, 'real maintenance/client overlap unobserved');
  result.stage = 'complete'; await save(); console.log('DISABLED_UPDATE_COMPLETE', join(artifacts, 'result.json'));
} catch (error) {
  result.failure = { stage: result.stage, kind: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 700) }; await save();
  console.error('DISABLED_UPDATE_FAILED', result.failure); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (child) await new Promise(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done));
  const ownedChildren = async () => (await Promise.all((await readdir('/proc')).filter(s => /^\d+$/.test(s)).map(async pid => { try { return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(root); } catch { return false; } }))).some(Boolean);
  if (!process.exitCode) { try { await wait(async () => !await ownedChildren(), 10000, 'owned native children'); } catch { process.exitCode = 1; result.failure = { stage: 'cleanup', kind: 'OwnedChildLive' }; await save(); } }
  if (process.exitCode) console.error(await ownedChildren() ? 'Retained generated root; native child still live' : 'Retained stopped generated root', root);
  else await rm(root, { recursive: true, force: true });
}
