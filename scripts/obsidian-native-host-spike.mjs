// Run ONLY against a fresh isolated Linux BB, with generated local-to-local
// rclone sources. No Apple account, provider credentials, or cloud operations.
// BB_SPIKE_CLI=<bb host-daemon/dist/bb> node scripts/obsidian-native-host-spike.mjs http://127.0.0.1:<port>
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const base = process.argv[2];
if (process.platform !== 'linux' || !base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Supply a fresh isolated Linux BB loopback URL.');
const repo = fileURLToPath(new URL('../', import.meta.url)); const root = await mkdtemp('/tmp/obsidian-native-host-');
const cli = process.env.BB_SPIKE_CLI ?? join(repo, 'plugins/icloud/node_modules/bb-app/host-daemon/dist/bb');
const env = { ...process.env, BB_SERVER_URL: base };
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 }).toString();
const request = async (pluginId, method, input = null, headers = {}) => (await fetch(`${base}/api/v1/plugins/${pluginId}/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) })).json();
const existing = JSON.parse(run('plugin', 'list', '--json')).plugins;
assert.ok(!existing.some(p => ['icloud', 'obsidian'].includes(p.id)), 'Use a fresh isolated BB, never an account-bearing installation.');
async function install(id, server) {
  const path = join(root, id); await mkdir(path);
  await symlink(join(repo, 'plugins', id, 'node_modules'), join(path, 'node_modules'));
  await cp(join(repo, 'plugins', id), join(path, 'source'), { recursive: true, filter: p => !/(?:^|\/)(?:node_modules|dist|docs|\.bb)(?:\/|$)/.test(p) });
  const manifest = JSON.parse(await readFile(join(repo, 'plugins', id, 'package.json'), 'utf8'));
  manifest.version = '0.0.0'; manifest.bb.server = './server.ts'; manifest.bb.app = './source/app.tsx'; manifest.bb.description = 'Disposable generated local-to-local native integration test; no Apple account.';
  await writeFile(join(path, 'package.json'), JSON.stringify(manifest)); await writeFile(join(path, 'server.ts'), server);
  run('plugin', 'build', path); run('plugin', 'install', path, '--yes', '--json');
}
const installed = [];
try {
  await install('icloud', `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { plugin as icloud } from './source/server.ts';
import { RcloneProcess } from './source/adapters/rclone-process.ts';
import { RcloneCloudProvider, syncArguments } from './source/adapters/rclone-cloud-provider.ts';
import { NoteStore } from './source/adapters/note-store.ts';
import { MemoryState } from './source/test/fakes.ts';
export default async function(bb) {
  const root = ${JSON.stringify(root + '/files')}; const worker = new RcloneProcess(root + '/worker', ${JSON.stringify(process.env.RCLONE_TEST_BINARY ?? '/usr/local/bin/rclone')}); const notes = new NoteStore(root + '/note-operations'); const repository = new MemoryState(); repository.value.connected = true;
  for (const id of ['one', 'two']) {
    const remote = join(root, 'remote', id), local = join(root, 'mirrors', id), baseline = join(root, 'baselines', id);
    await mkdir(remote, { recursive: true }); await mkdir(remote + '/.hidden'); await mkdir(local, { recursive: true }); await mkdir(baseline, { recursive: true });
    await writeFile(remote + '/Launch.md', '---\\r\\naliases: [Existing]\\r\\n---\\r\\n# Launch\\r\\n- [ ] Ship\\r\\n[[Other]]\\r\\n'); await writeFile(remote + '/Other.md', '# Other\\nGenerated source evidence.\\n'); await writeFile(remote + '/.hidden/Hidden.md', '# Hidden\\nLaunch evidence.\\n');
    await worker.run(syncArguments(remote, local, baseline, true)); await writeFile(baseline + '/initialized', '1');
    repository.value.mirrors.push({ id, folder: { id: Buffer.from(id).toString('base64url'), name: 'Launch', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', lastSuccess: new Date().toISOString(), failure: null, blocker: null });
  }
  const provider = new RcloneCloudProvider(root, async () => ({ list: [] }), async (args, capture, report) => { const adjusted = [...args]; if (adjusted[1]?.startsWith('icloud:')) adjusted[1] = join(root, 'remote', adjusted[1].slice(7)); return worker.run(adjusted, capture, report); }, () => worker.checkAvailability(), () => worker.stop(), operation => worker.withFiles(operation), mirror => notes.reconcile(mirror.id, provider.localFolder(mirror)));
  await icloud(bb, { provider, repository, notes });
}`); installed.push('icloud');
  await install('obsidian', `
import { defineRpcContract } from '@get-bb/plugin-sdk'; import { z } from 'zod'; import { plugin as obsidian } from './source/server.ts';
export default async function(bb) {
  const registered = new Map();
  await obsidian({ ...bb, agents: { ...bb.agents, registerTool(tool) { registered.set(tool.name, tool); return bb.agents.registerTool(tool); } } });
  // Test-only driver through actual host/plugin identity, not a production RPC.
  bb.rpc.register(defineRpcContract({ invoke: { input: z.object({ name: z.string(), input: z.unknown() }).strict(), output: z.any() } }), { async invoke(value) { const tool = registered.get(value.name); if (!tool) throw new Error('Unknown synthetic test tool'); return tool.execute(tool.parameters.parse(value.input), { signal: new AbortController().signal, threadId: 'generated', projectId: 'generated' }); } });
}`); installed.push('obsidian');
  const status = await request('obsidian', 'status'); assert.equal(status.ok, true, JSON.stringify(status)); assert.equal(status.result.vaults.length, 0);
  for (const vaultId of ['one', 'two']) { const result = await request('obsidian', 'connect', { vaultId }); assert.equal(result.ok, true, JSON.stringify(result)); }
  const seen = new Set();
  async function invoke(name, input) { seen.add(name); const result = await request('obsidian', 'invoke', { name, input }); assert.equal(result.ok, true, JSON.stringify(result)); assert.notEqual(result.result.isError, true, JSON.stringify(result)); const value = JSON.parse(result.result.content[0].text); assert.doesNotMatch(JSON.stringify(value), /localFolder|\/tmp\/|note-operations/); return value; }
  await invoke('obsidian_status', {});
  const search = await invoke('obsidian_search_notes', { text: 'Launch' }); assert.deepEqual([...new Set(search.results.map(r => r.vaultId))].sort(), ['one', 'two']); assert.ok(search.results.some(r => r.path === '.hidden/Hidden.md'));
  await invoke('obsidian_get_note_metadata', { vaultId: 'one', path: 'Launch.md' }); await invoke('obsidian_resolve_link', { vaultId: 'one', path: 'Launch.md', link: 'Other' });
  const tasks = await invoke('obsidian_list_tasks', { vaultId: 'one', complete: false }); assert.equal(tasks.results.length, 1);
  let note = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Launch.md' }); const original = note.text;
  const append = await invoke('obsidian_edit_note', { vaultId: 'one', path: 'Launch.md', expectedHash: note.hash, append: 'Decision\\r\\n' }); assert.equal(append.receipt.outcome, 'saved_locally_pending_sync');
  note = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Launch.md' }); await invoke('obsidian_edit_note', { vaultId: 'one', path: 'Launch.md', expectedHash: note.hash, task: { line: 5, marker: 'x' } });
  note = await invoke('obsidian_read_note', { vaultId: 'one', path: 'Launch.md' }); await invoke('obsidian_update_properties', { vaultId: 'one', path: 'Launch.md', expectedHash: note.hash, addAliases: ['Added'], set: { status: 'done' } });
  const created = await invoke('obsidian_create_note', { vaultId: 'two', path: 'Meeting.md', text: '# Meeting\nGenerated meeting.\n' }); assert.equal(created.receipt.outcome, 'saved_locally_pending_sync');
  note = await invoke('obsidian_read_note', { vaultId: 'two', path: 'Launch.md' }); const linked = await invoke('obsidian_edit_note', { vaultId: 'two', path: 'Launch.md', expectedHash: note.hash, append: '[[Meeting]]\r\n' }); assert.notEqual(linked.operationId, created.operationId);
  const bytes = await readFile(join(root, 'files/mirrors/one/Launch.md'), 'utf8'); assert.match(bytes, /- \[x\] Ship\r\n/); assert.match(bytes, /Existing/); assert.match(bytes, /Added/); assert.equal((await readFile(join(root, 'files/mirrors/two/Launch.md'), 'utf8')).startsWith(original), true);
  assert.equal(seen.size, 9);
  const denied = await request('icloud', 'noteRead', { mirrorId: 'one', revision: 2, path: 'Launch.md' }); assert.equal(denied.ok, false);
  const forged = await request('icloud', 'noteRead', { mirrorId: 'one', revision: 2, path: 'Launch.md' }, { 'x-bb-plugin-caller': 'obsidian' }); assert.equal(forged.ok, false);
  await request('obsidian', 'remove', { vaultId: 'one' }); const removed = await request('obsidian', 'invoke', { name: 'obsidian_read_note', input: { vaultId: 'one', path: 'Launch.md' } }); assert.equal(removed.result.isError, true); assert.equal(await readFile(join(root, 'files/mirrors/one/Launch.md'), 'utf8'), bytes);
  console.log('PASS: actual Linux BB host, nine production tool handlers, validated caller-restricted RPC, real native owner, multi-vault hidden-note search, reads/links/tasks, separate local save receipts, task/property byte preservation and removal. No Apple/cloud access.');
  console.log('Provider-session execution is a separate gate; the test-only RPC driver does not claim that proof.'); console.log(`Disposable fixture directory: ${root}`);
} finally { if (process.env.OBSIDIAN_SPIKE_KEEP !== '1') for (const id of installed.reverse()) run('plugin', 'remove', id, '--yes'); }
