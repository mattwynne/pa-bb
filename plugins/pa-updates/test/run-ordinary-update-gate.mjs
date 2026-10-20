// Current iteration-018 feasibility proof. No exact-target promise: a newer
// compatible candidate is allowed. Generated data only; never connects to live BB.
// node test/run-ordinary-update-gate.mjs /absolute/path/to/bb-app
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
const host = await createGateHost(process.argv[2]);
const { pkg, npm, root, repo, baseline, command, git, cli, request } = host;
const identity = async id => {
  const response = await request(`plugins/${id}/rpc/identity`, null);
  assert.equal(response.body.ok, true, 'fixture identity RPC must succeed'); return response.body.result;
};
const inventory = async () => JSON.parse(await cli('plugin', 'list', '--json')).plugins;
const ids = ['gate-clean', 'gate-replace', 'gate-keep', 'gate-disabled'];
const sourceFiles = ['package.json', 'package-lock.json', 'server.ts', 'app.tsx', 'app.css', 'assets/icon.svg'];
const runtimeFiles = ['dist/server.js', 'dist/server.meta.json', 'dist/app.js', 'dist/app.meta.json', 'dist/app.css'];
const fixture = async (id, marker, version) => {
  const dir = join(repo, 'plugins', id); await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `bb-plugin-${id}`, version, type: 'module', dependencies: { zod: '4.6.5' },
    engines: { bb: '>=0.45.0', bbPluginSdk: '>=0.6.15 <1' },
    bb: { name: `Synthetic ${id}`, description: 'Disposable ordinary-update proof.', branding: { icon: './assets/icon.svg' }, server: './server.ts', app: './app.tsx' } }));
  await writeFile(join(dir, 'server.ts'), `import { z } from 'zod';
export default async function(bb) {
  const settings=bb.settings.define({note:{type:'string',label:'Synthetic setting',default:''},credential:{type:'string',label:'Synthetic secret',secret:true}});
  if (${JSON.stringify(marker)}==='original' && await bb.storage.kv.get('sentinel')==null) await bb.storage.kv.set('sentinel','SYNTHETIC_STATE');
  bb.rpc.register({identity:{input:z.null(),output:z.object({marker:z.string(),state:z.boolean(),setting:z.boolean(),secret:z.boolean()})}}, {
    identity:async()=>{const s=await settings.get();return {marker:${JSON.stringify(marker)},state:await bb.storage.kv.get('sentinel')==='SYNTHETIC_STATE',setting:s.note==='SYNTHETIC_SETTING',secret:s.credential==='SYNTHETIC_SECRET'};}
  });
}
`);
  await writeFile(join(dir, 'app.tsx'), `import './app.css';\nexport default function(){return null;}\n`);
  await writeFile(join(dir, 'app.css'), '.synthetic{color:var(--text-primary)}\n');
  await writeFile(join(dir, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor"/></svg>\n');
  await command(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
};
let completed = false;
try {
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid');
  for (const id of ids) await fixture(id, 'original', '1.0.0');
  await git('add', '.'); await git('commit', '-qm', 'original'); const original = await git('rev-parse', 'HEAD');
  await host.start();
  for (const id of ids) {
    const result = JSON.parse(await cli('plugin', 'install', `git:${repo}@main`, '--subdirectory', `plugins/${id}`, '--yes', '--json'));
    assert.equal(result.plugin.status, 'running');
    await cli('plugin', 'config', id, 'set', 'note', 'SYNTHETIC_SETTING');
    await cli('plugin', 'config', id, 'set', 'credential', 'SYNTHETIC_SECRET');
    assert.deepEqual(await identity(id), { marker: 'original', state: true, setting: true, secret: true });
  }
  const initial = await inventory(), installed = new Map(initial.filter(p => ids.includes(p.id)).map(p => [p.id, p]));
  const roots = ids.map(id => installed.get(id).rootDir);
  for (const dir of roots) assert.ok(dir.startsWith(join(root, 'data') + '/'), 'only touch disposable code');
  assert.equal(new Set(roots.map(dir => resolve(dir, '../..'))).size, 1, 'shared managed checkout');
  // Reconstruct originals from committed fixture objects, NEVER current installed
  // bytes. Public npm + bb build only, no private server imports or DB edits.
  await git('archive', '--format=tar', '-o', join(root, 'baseline.tar'), original);
  await command('tar', ['-xf', join(root, 'baseline.tar'), '-C', baseline]);
  const compare = async id => {
    const expected = join(baseline, 'plugins', id), actual = installed.get(id).rootDir;
    const changed = [];
    for (const file of [...sourceFiles, ...runtimeFiles]) {
      if (!(await readFile(join(expected, file))).equals(await readFile(join(actual, file)))) changed.push(file);
    }
    return changed;
  };
  for (const id of ids) {
    const dir = join(baseline, 'plugins', id);
    await command(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
    await cli('plugin', 'build', dir);
    assert.deepEqual(await compare(id), [], `clean source/runtime/asset baseline for ${id}`);
  }
  const runtimeOnly = join(installed.get('gate-clean').rootDir, 'dist/server.js');
  const originalRuntime = await readFile(runtimeOnly, 'utf8');
  assert.ok(originalRuntime.includes('marker:"original"'), 'fixture marker exists in executable bundle');
  await writeFile(runtimeOnly, originalRuntime.replace('marker:"original"', 'marker:"runtime-only"'));
  await cli('plugin', 'reload', 'gate-clean');
  assert.equal((await identity('gate-clean')).marker, 'runtime-only');
  assert.deepEqual(await compare('gate-clean'), ['dist/server.js'], 'runtime-only drift is not blessed by clean source');
  await writeFile(runtimeOnly, originalRuntime); await cli('plugin', 'reload', 'gate-clean');
  assert.equal((await identity('gate-clean')).marker, 'original');
  for (const id of ['gate-replace', 'gate-keep']) {
    const dir = installed.get(id).rootDir;
    await writeFile(join(dir, 'server.ts'), (await readFile(join(dir, 'server.ts'), 'utf8')).replaceAll('"original"', '"local-custom"'));
    await writeFile(join(dir, 'app.css'), '.synthetic{color:orange}\n');
    await writeFile(join(dir, 'assets/icon.svg'), (await readFile(join(dir, 'assets/icon.svg'), 'utf8')).replace('M4 4h16v16H4z', 'M2 2h20v20H2z'));
    await cli('plugin', 'build', dir); await cli('plugin', 'reload', id);
    assert.equal((await identity(id)).marker, 'local-custom');
    const drift = await compare(id);
    for (const file of ['server.ts', 'app.css', 'assets/icon.svg', 'dist/server.js', 'dist/app.css']) assert.ok(drift.includes(file), 'detect actual source/runtime/asset customization');
  }
  assert.deepEqual(await compare('gate-clean'), [], 'unrelated sibling edits do not mark clean plugin customized');
  const treeDigest = async dir => {
    const hash = createHash('sha256');
    const visit = async (path, relative = '') => {
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const name = relative + '/' + entry.name; hash.update(name + '\0');
        if (entry.isDirectory()) await visit(join(path, entry.name), name);
        else if (entry.isFile()) { const bytes = await readFile(join(path, entry.name)); hash.update(String(bytes.length) + '\0'); hash.update(bytes); }
        else throw new Error('unsupported fixture entry');
      }
    };
    await visit(dir); return hash.digest('hex');
  };
  const keptRoot = installed.get('gate-keep').rootDir, keptBytes = await treeDigest(keptRoot);
  const keptIdentity = await identity('gate-keep');
  await cli('plugin', 'disable', 'gate-disabled');
  const unaffected = (await inventory()).filter(p => !ids.includes(p.id)).map(p => ({ id: p.id, version: p.version, enabled: p.enabled, status: p.status }));
  for (const id of ids) await fixture(id, 'preview-A', '1.0.1');
  await git('add', '.'); await git('commit', '-qm', 'publish A'); const preview = await git('rev-parse', 'HEAD');
  const checked = await request('plugins/updates/check', {});
  assert.equal(checked.status, 200); assert.ok(JSON.stringify(checked.body).includes(preview));
  for (const id of ids) await fixture(id, 'released-B', '1.0.2');
  await git('add', '.'); await git('commit', '-qm', 'publish newer B'); const newer = await git('rev-parse', 'HEAD');
  const reportedTargets = [];
  for (const id of ['gate-clean', 'gate-replace', 'gate-disabled']) {
    const result = await request(`plugins/${id}/update`, {});
    assert.equal(result.status, 200); assert.equal(result.body.outcome, 'updated');
    assert.equal(result.body.to.version, newer);
    reportedTargets.push({ id, reportedCommit: result.body.to.version });
  }
  const after = await inventory();
  for (const id of ['gate-clean', 'gate-replace', 'gate-disabled']) assert.equal(after.find(p => p.id === id).version, '1.0.2');
  const disabled = after.find(p => p.id === 'gate-disabled'); assert.equal(disabled.enabled, false); assert.equal(disabled.status, 'disabled');
  // Verify disabled code only after observing preservation; then restore disabled.
  await cli('plugin', 'enable', 'gate-disabled');
  for (const id of ['gate-clean', 'gate-replace', 'gate-disabled']) assert.deepEqual(await identity(id), { marker: 'released-B', state: true, setting: true, secret: true });
  await cli('plugin', 'disable', 'gate-disabled');
  assert.deepEqual(await identity('gate-keep'), keptIdentity); assert.equal(await treeDigest(keptRoot), keptBytes);
  assert.deepEqual(after.filter(p => !ids.includes(p.id)).map(p => ({ id: p.id, version: p.version, enabled: p.enabled, status: p.status })), unaffected);
  const result = { proof: 'ordinary synthetic managed updates', bb: pkg.version, node: process.version, platform: process.platform,
    original, preview, expectedRemoteCommit: newer, reportedTargets, actualVersion: '1.0.2', executedMarker: 'released-B', advancedChannelAllowed: true,
    reconstructedCleanSourceRuntimeAssets: true, sourceRuntimeAssetCustomizationsDetected: true, activeRuntimeOnlyDriftDetected: true,
    authorizedCustomReplacement: true, keptSiblingBytesUnchanged: true, settingsSecretsStatePreserved: true,
    disabledStatePreserved: true, unrelatedPluginsUnchanged: true,
    notProven: ['real PA integration baselines', 'review/edit reservation', 'iCloud/Obsidian quiescence', 'BB/Pi/Codex update lifecycle', 'live BB UI'] };
  console.log(JSON.stringify(result, null, 2)); completed = true;
} catch {
  console.error('Ordinary-update proof failed; inspect the isolated evidence privately.'); process.exitCode = 1;
} finally {
  await host.finish(completed);
}
