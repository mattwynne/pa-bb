import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, readlink, truncate, stat } from 'node:fs/promises';
import { RcloneCloudProvider, syncArguments } from '../adapters/rclone-cloud-provider.ts';
import { CloudError } from '../core/ports.ts';
import type { Mirror, SyncProgress } from '../core/ports.ts';
const mirror: Mirror = { id: 'mirror-1', folder: { id: Buffer.from('Test Vault').toString('base64url'), name: 'Test Vault', ancestors: [] }, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null, blocker: null };
function fixture(root = '/tmp/synthetic-root') {
  const calls: { method: string; body: any }[] = []; const commands: string[][] = [];
  let result: any = { State: 'sensitive-private-state', Option: { Name: 'config_2fa', Help: 'sentinel-password-and-phone', Default: 'sentinel-secret' }, Error: '' };
  const provider = new RcloneCloudProvider(root, async (method, body) => {
    calls.push({ method, body });
    if (method === 'config/listremotes') return { remotes: [] };
    if (method === 'operations/list') return { list: [{ IsDir: true, Name: 'Test Vault' }] };
    return result;
  }, async (args, capture) => {
    assert.equal(capture, false); commands.push(args);
    if (args[0] === 'bisync' && args.includes('--resync')) await writeFile(args[2] + '/note.md', 'note');
    return '';
  }, async () => {}, async () => {});
  return { provider, calls, commands, respond: (value: any) => { result = value; } };
}
test('Apple configuration maps to domain challenge and keeps secrets in private request bodies only', async () => {
  const f = fixture();
  assert.deepEqual(await f.provider.connect({ account: 'synthetic@example.test', password: 'sentinel-password' }), { connected: false, challenge: 'verification_code' });
  assert.equal(f.calls[1].body.type, 'iclouddrive'); assert.equal(f.calls[1].body.parameters.service, 'drive');
  f.respond({ State: '' }); assert.deepEqual(await f.provider.answerChallenge('123456'), { connected: true });
  const continuation = f.calls.find(c => c.method === 'config/update')!;
  assert.equal(continuation.body.opt.state, 'sensitive-private-state'); assert.equal(continuation.body.opt.result, '123456');
  assert.equal(f.calls.at(-1)!.method, 'operations/list'); assert.deepEqual(f.commands, []);
});
test('arbitrary provider error/help/defaults never escape the adapter', async () => {
  const f = fixture(); f.respond({ Error: 'sentinel-password', State: 'sentinel-state' });
  await assert.rejects(f.provider.connect({ account: 'synthetic@example.test', password: 'sentinel' }), error => { assert.equal((error as Error).message, 'authentication'); return true; });
  f.respond({ State: 'sentinel-state', Option: { Name: 'unexpected', Help: 'sentinel-password' } });
  await assert.rejects(f.provider.connect({ account: 'synthetic@example.test', password: 'sentinel' }), /unavailable/);
});
test('browse creates domain IDs and rejects path traversal before any provider request', async () => {
  const f = fixture(); const [folder] = await f.provider.listFolders(null); assert.equal(folder.name, 'Test Vault');
  const before = f.calls.length;
  await assert.rejects(f.provider.listFolders(Buffer.from('../secrets').toString('base64url')), /invalid_selection/);
  assert.equal(f.calls.length, before);
});
test('normal bisync preserves conflicts and deletion checks while enabling native recovery without forced resync or backups', () => {
  const normal = syncArguments('icloud:Test Vault', '/mirror', '/baseline', false);
  assert.ok(normal.includes('none')); assert.ok(normal.includes('num')); assert.ok(normal.includes('--max-delete'));
  assert.equal(normal[normal.indexOf('--max-delete') + 1], '50');
  for (const flag of ['--resilient', '--recover', '--max-lock', '--check-sync=true']) assert.ok(normal.includes(flag));
  assert.equal(normal[normal.indexOf('--max-lock') + 1], '2m');
  for (const unsafe of ['--resync', '--force', '--inplace', '--backup-dir1', '--backup-dir2']) assert.ok(!normal.includes(unsafe));
  assert.ok(syncArguments('icloud:Test Vault', '/mirror', '/baseline', true).includes('--resync'));
});
test('fresh initialization and normal sync each run only bisync, never an extra listing or recovery capture', async () => {
  const root = await mkdtemp('/tmp/icloud-native-provider-'); const f = fixture(root);
  try {
    await f.provider.prepareMirror(mirror);
    assert.deepEqual(f.commands.map(c => c[0]), ['bisync']); assert.ok(f.commands[0].includes('--resync'));
    assert.equal(await readFile(root + '/baselines/mirror-1/initialized', 'utf8'), '1');
    await assert.rejects(f.provider.prepareMirror(mirror), /recovery_required/);
    f.commands.length = 0; f.calls.length = 0; await f.provider.synchronize({ ...mirror, initialized: true });
    assert.deepEqual(f.commands.map(c => c[0]), ['bisync']); assert.ok(!f.commands[0].includes('--resync'));
    assert.deepEqual(f.calls, []); assert.ok(!(await readdir(root)).includes('backups'));
  } finally { await rm(root, { recursive: true }); }
});
test('opaque legacy recovery files, oversized blobs and ambiguous staging cannot block sync and are never pruned', async () => {
  const root = await mkdtemp('/tmp/icloud-legacy-archive-'); const f = fixture(root);
  try {
    await f.provider.prepareMirror(mirror); f.commands.length = 0;
    const backup = root + '/backups'; await mkdir(backup + '/staging-unknown', { recursive: true }); await mkdir(backup + '/snapshots'); await mkdir(backup + '/blobs');
    await writeFile(backup + '/snapshots/old.json', 'invalid legacy metadata');
    await writeFile(backup + '/staging-unknown/unique.partial', 'unique old bytes');
    await writeFile(backup + '/blobs/oversized', ''); await truncate(backup + '/blobs/oversized', 1024 * 1024 * 1024 + 1);
    await symlink('unique.partial', backup + '/staging-unknown/link');
    await f.provider.synchronize({ ...mirror, initialized: true });
    assert.deepEqual(f.commands.map(c => c[0]), ['bisync']);
    assert.equal(await readFile(backup + '/snapshots/old.json', 'utf8'), 'invalid legacy metadata');
    assert.equal(await readFile(backup + '/staging-unknown/unique.partial', 'utf8'), 'unique old bytes');
    assert.equal(await readlink(backup + '/staging-unknown/link'), 'unique.partial');
    assert.equal((await stat(backup + '/blobs/oversized')).size, 1024 * 1024 * 1024 + 1);
    assert.deepEqual((await readdir(backup)).sort(), ['blobs', 'snapshots', 'staging-unknown']);
  } finally { await rm(root, { recursive: true }); }
});
for (const marker of [null, '', 'not initialized']) test(`missing or invalid baseline marker (${JSON.stringify(marker)}) still blocks without commands or forced resync`, async () => {
  const root = await mkdtemp('/tmp/icloud-baseline-'); const f = fixture(root);
  try {
    if (marker !== null) { await mkdir(root + '/baselines/mirror-1', { recursive: true }); await writeFile(root + '/baselines/mirror-1/initialized', marker); }
    await assert.rejects(f.provider.synchronize({ ...mirror, initialized: true }), /recovery_required/);
    assert.deepEqual(f.commands, []); assert.deepEqual(f.calls, []);
  } finally { await rm(root, { recursive: true }); }
});
test('provider reports native sync progress, never backup stages, and finishes only after the command', async () => {
  const root = await mkdtemp('/tmp/icloud-progress-provider-'); const stages: SyncProgress[] = []; let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const provider = new RcloneCloudProvider(root, async () => ({}), async (args, capture, report) => {
    assert.equal(args[0], 'bisync'); assert.equal(capture, false);
    report?.({ bytes: 1, totalBytes: 2, files: 0, totalFiles: 1 });
    report?.({ bytes: 4, totalBytes: 4, files: 1, totalFiles: 1 });
    await waiting; return '';
  }, async () => {}, async () => {});
  try {
    const preparing = provider.prepareMirror(mirror, value => stages.push(value));
    while (!stages.some(s => s.stage === 'transferring')) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(readFile(root + '/baselines/mirror-1/initialized'));
    release(); await preparing;
    assert.deepEqual([...new Set(stages.map(s => s.stage))], ['checking', 'transferring', 'verifying']);
    assert.equal(stages.at(-1)!.stage, 'verifying');
    assert.ok(stages.some(s => s.stage === 'transferring' && s.bytes === 4 && s.files === 1));
    assert.equal(await readFile(root + '/baselines/mirror-1/initialized', 'utf8'), '1');
  } finally { release(); await rm(root, { recursive: true }); }
});
test('initial preparation acquires exclusive worker ownership before creating preparation records', async () => {
  const root = await mkdtemp('/tmp/icloud-worker-owner-'); let commands = 0;
  const provider = new RcloneCloudProvider(root, async method => {
    assert.equal(method, 'rc/noop'); throw new CloudError('busy');
  }, async () => { commands++; return ''; }, async () => {}, async () => {});
  try {
    await assert.rejects(provider.prepareMirror(mirror), /busy/);
    assert.deepEqual(await readdir(root), []); assert.equal(commands, 0);
  } finally { await rm(root, { recursive: true }); }
});
test('account binding prevents sending retained mirrors to a different Apple account', async () => {
  const methods: string[] = [];
  const provider = new RcloneCloudProvider('/tmp/proof', async method => { methods.push(method); return method === 'config/listremotes' ? { remotes: ['icloud'] } : { apple_id: 'original@example.test' }; }, async () => '', async () => {}, async () => {});
  await assert.rejects(provider.connect({ account: 'other@example.test', password: 'sentinel' }), /invalid_selection/);
  assert.deepEqual(methods, ['config/listremotes', 'config/get']);
});
