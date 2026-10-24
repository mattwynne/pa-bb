// Native local-path development primitives. Synthetic data, disposable BB only.
// node test/run-local-path-gate.mjs /path/to/bb-app
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, cp, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGateHost } from './gate-host.mjs';
const host = await createGateHost(process.argv[2]);
const { root, command, npm, cli, request } = host;
const id = 'google-calendar', working = join(root, 'working'), moved = join(root, 'moved');
let completed = false;
const identity = async () => {
  const response = await request(`plugins/${id}/rpc/status`, null);
  assert.equal(response.body.ok, true); return response.body.result;
};
async function source(directory, marker) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `bb-plugin-${id}`, version: '1.0.0', type: 'module', dependencies: { zod: '4.6.5' },
    engines: { bb: '>=0.46.0', bbPluginSdk: '>=0.6.37 <1' }, bb: { name: 'Synthetic local development', description: 'Disposable local-path lifecycle test.', branding: { icon: 'Calendar' }, server: './server.ts' } }));
  await writeFile(join(directory, 'server.ts'), `import {z} from 'zod';
export default async function(bb){
 const settings=bb.settings.define({note:{type:'string',label:'Setting',default:''},credential:{type:'string',label:'Secret',secret:true}});
 if(await bb.storage.kv.get('sentinel')==null)await bb.storage.kv.set('sentinel','SYNTHETIC_STATE');
 bb.rpc.register({status:{input:z.null(),output:z.object({marker:z.string(),state:z.boolean(),setting:z.boolean(),secret:z.boolean()})}},{status:async()=>{const value=await settings.get();return{marker:${JSON.stringify(marker)},state:await bb.storage.kv.get('sentinel')==='SYNTHETIC_STATE',setting:value.note==='SYNTHETIC_SETTING',secret:value.credential==='SYNTHETIC_SECRET'}}});
}`);
}
try {
  await source(working, 'A');
  await command(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], working);
  await host.start();
  try { await promisify(execFile)(process.execPath, [join(host.bb, 'host-daemon/dist/bb'), 'plugin', 'install', `path:${working}`, '--yes', '--json'], { cwd: root, env: host.env, timeout: 120000 }); }
  catch (error) { await writeFile(join(root, 'install-error.txt'), String(error.stderr).slice(0, 12000), { mode: 0o600 }); throw new Error('local_install_failed'); }
  await cli('plugin', 'config', id, 'set', 'note', 'SYNTHETIC_SETTING');
  await cli('plugin', 'config', id, 'set', 'credential', 'SYNTHETIC_SECRET');
  assert.deepEqual(await identity(), { marker: 'A', state: true, setting: true, secret: true });
  await source(working, 'B');
  assert.equal((await identity()).marker, 'A', 'editing a source file does not replace the loaded code');
  await cli('plugin', 'build', working);
  assert.equal((await identity()).marker, 'A', 'building does not replace the loaded server code');
  await cli('plugin', 'reload', id);
  assert.deepEqual(await identity(), { marker: 'B', state: true, setting: true, secret: true });
  await source(working, 'C'); await cli('plugin', 'reload', id);
  const reloadRebuildsSource = (await identity()).marker === 'C';
  await cli('plugin', 'build', working); await cli('plugin', 'reload', id);
  assert.equal((await identity()).marker, 'C');
  const dataDirectory = join(host.env.BB_DATA_DIR, 'plugins', id), beforeData = await lstat(dataDirectory);
  await cli('plugin', 'disable', id);
  await cp(working, moved, { recursive: true });
  await cli('plugin', 'install', `path:${moved}`, '--yes', '--json');
  const entry = JSON.parse(await cli('plugin', 'list', '--json')).plugins.find(plugin => plugin.id === id);
  assert.equal(entry.rootDir, moved); assert.equal(entry.enabled, false); assert.equal(entry.status, 'disabled');
  const afterData = await lstat(dataDirectory); assert.equal(afterData.ino, beforeData.ino); assert.equal(afterData.dev, beforeData.dev);
  await cli('plugin', 'enable', id);
  assert.deepEqual(await identity(), { marker: 'C', state: true, setting: true, secret: true });
  console.log(JSON.stringify({ bb: host.pkg.version, localPathMode: true, sameVersionCodeApplied: true, editingDoesNotApply: true,
    buildingDoesNotReload: true, reloadRebuildsSource, settingsSecretsAndKvPreserved: true, dataDirectoryUnmoved: true,
    nativeLocalPathMovePreservesDisabledState: true, managedGitToPathNotProven: true }));
  completed = true;
} finally { await host.finish(completed); }
