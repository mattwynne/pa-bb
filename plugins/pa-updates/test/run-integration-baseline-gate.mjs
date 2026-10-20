// Rebuild original PA integration artifacts independently of installed bytes.
// No accounts, provider writes, production server or private host modules.
// Usage: node test/run-integration-baseline-gate.mjs BB_APP PACKAGE_SOURCE_TAR SOURCE_COMMIT
// PACKAGE_SOURCE_TAR: git archive <SOURCE_COMMIT> plugins/{five integration dirs}.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
const archive = resolve(process.argv[3]);
const suppliedSourceLabel = process.argv[4];
assert.match(suppliedSourceLabel, /^[0-9a-f]{40}$/);
const archiveSha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const host = await createGateHost(process.argv[2]);
const { pkg, npm, root, repo, baseline, command, git, cli, request } = host;
const ids = ['google-calendar', 'fastmail', 'google-drive', 'icloud', 'obsidian'];
const runtime = ['dist/server.js', 'dist/server.meta.json', 'dist/app.js', 'dist/app.meta.json', 'dist/app.css'];
let completed = false;
try {
  await command('tar', ['-xf', archive, '-C', repo]);
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid');
  await git('add', '.'); await git('commit', '-qm', 'published integration source snapshot');
  const original = await git('rev-parse', 'HEAD');
  await git('archive', '--format=tar', '-o', join(root, 'baseline.tar'), original);
  await command('tar', ['-xf', join(root, 'baseline.tar'), '-C', baseline]);
  await host.start();
  const results = [];
  for (const id of ids) {
    const installed = JSON.parse(await cli('plugin', 'install', `git:${repo}@main`, '--subdirectory', `plugins/${id}`, '--yes', '--json')).plugin;
    assert.equal(installed.status, 'running', 'unconfigured real integration must start');
    assert.ok(installed.rootDir.startsWith(join(root, 'data') + '/'));
    const expected = join(baseline, 'plugins', id);
    await command(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], expected);
    await cli('plugin', 'build', expected);
    // All tracked package bytes (including docs/tests here) must survive a normal
    // install; this is evidence collection, not the production scope classifier.
    const tracked = (await git('ls-files', `plugins/${id}`)).split('\n').map(path => path.slice(`plugins/${id}/`.length));
    const changed = [];
    for (const file of [...tracked, ...runtime]) {
      if (!(await readFile(join(expected, file))).equals(await readFile(join(installed.rootDir, file)))) changed.push(file);
    }
    assert.deepEqual(changed, [], `independent original baseline for ${id}`);
    const meta = JSON.parse(await readFile(join(expected, 'dist/server.meta.json'), 'utf8'));
    assert.equal(meta.builtWith.bbVersion, pkg.version);
    const listed = JSON.parse(await cli('plugin', 'list', '--json')).plugins.find(p => p.id === id);
    assert.equal(listed.app.bundle.sdkVersion, meta.sdkVersion);
    // The actual served app bundle must match the independently built artifact.
    const appUrl = listed.app.bundle.jsUrl;
    const served = await fetch(new URL(appUrl, host.env.BB_SERVER_URL), { signal: AbortSignal.timeout(10000) });
    assert.equal(served.status, 200);
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(await readFile(join(expected, 'dist/app.js'))), 'active app bytes equal expected artifact');
    const sourceDigest = createHash('sha256').update(await readFile(join(installed.rootDir, 'server.ts'))).digest('hex');
    const actualServer = join(installed.rootDir, 'dist/server.js');
    const originalServer = await readFile(actualServer);
    await writeFile(actualServer, Buffer.concat([originalServer, Buffer.from('\n// synthetic runtime-only edit\n')]));
    assert.equal(createHash('sha256').update(await readFile(join(installed.rootDir, 'server.ts'))).digest('hex'), sourceDigest, 'runtime-only edit leaves source unchanged');
    assert.ok(!(await readFile(actualServer)).equals(await readFile(join(expected, 'dist/server.js'))), 'runtime-only drift visible without Git source changes');
    await writeFile(actualServer, originalServer); // Restore only our generated test edit.
    const status = await request(`plugins/${id}/rpc/status`, null);
    assert.equal(status.status, 200, 'real read-only status handler succeeds');
    assert.equal(status.body.ok, true, 'real status RPC succeeds');
    results.push({ id, version: installed.version, sdk: meta.sdkVersion, comparedFiles: tracked.length + runtime.length,
      originalBaselineReproduced: true, activeAppBytesVerified: true, runtimeOnlyDriftDetected: true, readOnlyStatus: true });
  }
  console.log(JSON.stringify({ proof: 'real PA integration baseline reconstruction', bb: pkg.version, node: process.version,
    platform: process.platform, suppliedSourceLabel, archiveSha256, results,
    limits: ['same builder version only', 'no custom-source deployment or concurrency reservation', 'no generated sync activity', 'no BB/Pi/Codex update lifecycle', 'no live BB UI approval'] }, null, 2));
  completed = true;
} catch {
  console.error('Integration baseline proof failed; inspect the isolated evidence privately.'); process.exitCode = 1;
} finally { await host.finish(completed); }
