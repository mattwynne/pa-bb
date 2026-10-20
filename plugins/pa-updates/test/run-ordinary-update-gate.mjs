// Integration executor acceptance: the ORIGINAL updater handlers and native
// plugins.applyUpdate against generated managed installations. No live accounts.
// node test/run-ordinary-update-gate.mjs /path/to/bb-app /path/to/updater-source.tar
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createGateHost } from './gate-host.mjs';
const archive = resolve(process.argv[3]);
const host = await createGateHost(process.argv[2], { nativeRuntime: true });
const { pkg, npm, root, repo, command, git, cli, request } = host;
const ids = ['google-calendar', 'google-drive', 'fastmail', 'icloud'];
let completed = false, stage = 'setup';
const rpc = async (id, method, input = null) => {
  const response = await request(`plugins/${id}/rpc/${method}`, input);
  assert.equal(response.body.ok, true, 'RPC must succeed'); return response.body.result;
};
const inventory = async () => JSON.parse(await cli('plugin', 'list', '--json')).plugins;
const fixture = async (id, marker, version) => {
  const dir = join(repo, 'plugins', id); await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `bb-plugin-${id}`, version, type: 'module', dependencies: { zod: '4.6.5' },
    engines: { bb: '>=0.45.0', bbPluginSdk: '>=0.6.15 <1' },
    bb: { name: `Synthetic ${id}`, description: 'Disposable executor test.', branding: { icon: './assets/icon.svg' }, server: './server.ts', app: './app.tsx' } }));
  await writeFile(join(dir, 'server.ts'), `import {z} from 'zod';
export default async function(bb){
 const settings=bb.settings.define({note:{type:'string',label:'Synthetic setting',default:''},credential:{type:'string',label:'Synthetic secret',secret:true}});
 if(${JSON.stringify(marker)}==='original'&&await bb.storage.kv.get('sentinel')==null)await bb.storage.kv.set('sentinel','SYNTHETIC_STATE');
 const schema={input:z.null(),output:z.object({marker:z.string(),state:z.boolean(),setting:z.boolean(),secret:z.boolean()})};
 const identity=async()=>{const s=await settings.get();return {marker:${JSON.stringify(marker)},state:await bb.storage.kv.get('sentinel')==='SYNTHETIC_STATE',setting:s.note==='SYNTHETIC_SETTING',secret:s.credential==='SYNTHETIC_SECRET'};};
 bb.rpc.register({identity:schema,status:schema},{identity,status:identity});
}`);
  await mkdir(join(dir, 'docs', 'TypeScript API'), { recursive: true });
  await writeFile(join(dir, 'docs', 'TypeScript API', '日本語.md'), 'Synthetic ignored documentation with a valid path.\n');
  await writeFile(join(dir, 'app.tsx'), "import './app.css';export default function(){return null;}\n");
  await writeFile(join(dir, 'app.css'), '.synthetic{color:var(--text-primary)}\n');
  await writeFile(join(dir, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor"/></svg>\n');
  await command(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
};
const digest = async root => {
  const hash = createHash('sha256');
  const visit = async (dir, prefix = '') => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name = `${prefix}/${entry.name}`; hash.update(name + '\0');
      if (entry.isDirectory()) await visit(join(dir, entry.name), name);
      else if (entry.isFile()) hash.update(await readFile(join(dir, entry.name)));
      else throw new Error('unsupported fixture entry');
    }
  }; await visit(root); return hash.digest('hex');
};
const settled = async () => {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const state = await rpc('pa-updates', 'applicationStatus');
    assert.equal(state.failure, null);
    if (state.review && !state.applying && !state.checking) return state;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('job deadline');
};
try {
  await host.assertNativeIsolation();
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid');
  for (const id of ids) await fixture(id, 'original', '0.3.1');
  await git('add', '.'); await git('commit', '-qm', 'original');
  await host.start(); stage = 'install';
  for (const id of ids) {
    await cli('plugin', 'install', `git:${repo}@main`, '--subdirectory', `plugins/${id}`, '--yes', '--json');
    await cli('plugin', 'config', id, 'set', 'note', 'SYNTHETIC_SETTING');
    await cli('plugin', 'config', id, 'set', 'credential', 'SYNTHETIC_SECRET');
  }
  const bridge = join(root, 'updater'); await mkdir(join(bridge, 'implementation'), { recursive: true });
  await command('tar', ['--no-same-owner', '-xf', archive, '-C', join(bridge, 'implementation')]);
  const manifest = JSON.parse(await readFile(join(bridge, 'implementation/package.json'), 'utf8'));
  manifest.bb.app = './implementation/app.tsx';
  await writeFile(join(bridge, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(bridge, 'package-lock.json'), await readFile(join(bridge, 'implementation/package-lock.json')));
  // Only the trusted source URL is substituted. Application, persistence,
  // fingerprints, original RPC handlers and native BB update adapter are real.
  await writeFile(join(bridge, 'server.ts'), `import plugin from './implementation/server.ts';import {applicationPorts} from './implementation/adapters/application.ts';
// This fixture exercises integration activation, never the machine's real CLIs or launcher.
export default bb=>{const ports=applicationPorts(bb,${JSON.stringify(repo)});delete ports.runtime;return plugin(bb,{feed:async()=>null,inventory:async()=>({installed:null,runtime:null})},ports);};`);
  await command(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], bridge);
  const updater = JSON.parse(await cli('plugin', 'install', bridge, '--yes', '--json'));
  assert.equal(updater.plugin.status, 'running');
  await settled(); // Finish initial unchanged-artifact seeding before fixture edits.
  const initial = await inventory(), installed = new Map(initial.map(plugin => [plugin.id, plugin]));
  for (const id of ids) assert.ok(installed.get(id).rootDir.startsWith(join(root, 'data') + '/'));
  assert.equal(new Set(ids.map(id=>resolve(installed.get(id).rootDir,'../..'))).size,1);
  for (const id of ['google-drive', 'fastmail']) {
    const dir = installed.get(id).rootDir;
    await writeFile(join(dir,'server.ts'),(await readFile(join(dir,'server.ts'),'utf8')).replaceAll('"original"','"local-custom"'));
    await writeFile(join(dir,'app.css'),'.synthetic{color:orange}\n');
    await writeFile(join(dir,'assets/icon.svg'),(await readFile(join(dir,'assets/icon.svg'),'utf8')).replace('M4 4h16v16H4z','M2 2h20v20H2z'));
    await cli('plugin','build',dir); await cli('plugin','reload',id);
  }
  await cli('plugin','disable','icloud');
  const keptRoot = installed.get('fastmail').rootDir, keptBytes = await digest(keptRoot), keptIdentity = await rpc('fastmail','identity');
  const unaffected = (await inventory()).filter(p=>!ids.includes(p.id)).map(p=>({id:p.id,version:p.version,enabled:p.enabled,status:p.status}));
  for (const id of ids) await fixture(id,'preview-A','0.3.2');
  await git('add','.'); await git('commit','-qm','publish A');
  stage = 'runtime-only-review';
  const runtimePath = join(installed.get('google-calendar').rootDir,'dist/server.js'), originalRuntime = await readFile(runtimePath,'utf8');
  assert.ok(originalRuntime.includes('marker:"original"'));
  await writeFile(runtimePath,originalRuntime.replace('marker:"original"','marker:"runtime-only"')); await cli('plugin','reload','google-calendar');
  assert.equal((await rpc('google-calendar','identity')).marker,'runtime-only');
  stage = 'runtime-only-classification';
  let reviewed = await rpc('pa-updates','review');
  assert.equal(reviewed.review?.rows.find(r=>r.id==='google-calendar')?.local,'custom');
  await writeFile(runtimePath,originalRuntime); await cli('plugin','reload','google-calendar');
  stage = 'review'; reviewed = await rpc('pa-updates','review');
  assert.deepEqual(Object.fromEntries(reviewed.review.rows.map(row=>[row.id,row.local])),{'google-calendar':'stock','google-drive':'custom',fastmail:'custom',icloud:'stock'});
  assert.ok(reviewed.review.rows.every(row=>row.available==='0.3.2'));
  stage = 'changed-authorization';
  const css = join(installed.get('google-drive').rootDir,'app.css'); await writeFile(css,'.synthetic{color:new-local-edit}\n');
  await rpc('pa-updates','apply',{reviewId:reviewed.review.id,choices:[{id:'google-drive',choice:'install'}]});
  assert.equal((await settled()).job.failure,'changed');
  assert.ok((await inventory()).filter(p=>ids.includes(p.id)).every(p=>p.version==='0.3.1'));
  await writeFile(css,'.synthetic{color:orange}\n'); reviewed = await rpc('pa-updates','review');
  for (const id of ids) await fixture(id,'released-B','0.3.3');
  await git('add','.'); await git('commit','-qm','publish newer B');
  stage = 'apply';
  const input = {reviewId:reviewed.review.id,choices:[{id:'google-drive',choice:'install'}]};
  await Promise.all([rpc('pa-updates','apply',input),rpc('pa-updates','apply',input)]);
  const final = await settled(); assert.equal(final.job.phase,'complete');
  stage = 'verify'; const after = await inventory();
  for (const id of ['google-calendar','google-drive','icloud']) assert.equal(after.find(p=>p.id===id).version,'0.3.3');
  assert.equal(after.find(p=>p.id==='icloud').enabled,false); assert.equal(after.find(p=>p.id==='icloud').status,'disabled');
  await cli('plugin','enable','icloud');
  for (const id of ['google-calendar','google-drive','icloud']) assert.deepEqual(await rpc(id,'identity'),{marker:'released-B',state:true,setting:true,secret:true});
  await cli('plugin','disable','icloud');
  assert.deepEqual(await rpc('fastmail','identity'),keptIdentity); assert.equal(await digest(keptRoot),keptBytes);
  assert.deepEqual(after.filter(p=>!ids.includes(p.id)).map(p=>({id:p.id,version:p.version,enabled:p.enabled,status:p.status})),unaffected);
  await cli('plugin','reload','pa-updates'); assert.deepEqual((await rpc('pa-updates','applicationStatus')).job,final.job);
  console.log(JSON.stringify({proof:'original updater handler application',bb:pkg.version,node:process.version,platform:process.platform,
    receipts:final.job.receipts,persistedAcrossReload:true,joinedApply:true,editsBeforeFinalCheckRequireNewReview:true,
    activeRuntimeOnlyDriftDetected:true,
    keptSiblingBytesUnchanged:true,settingsSecretsStatePreserved:true,disabledStatePreserved:true,unrelatedPluginsUnchanged:true,
    notProven:['legacy 0.45 builder selection','real iCloud/Obsidian generated activity','BB/Pi/Codex lifecycle','rendered BB UI']},null,2));
  completed=true;
} catch {
  console.error(`Executor acceptance failed at ${stage}; inspect isolated evidence privately.`); process.exitCode=1;
} finally { await host.finish(completed); }
