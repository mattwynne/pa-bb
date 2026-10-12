import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { RcloneCloudProvider, syncArguments } from '../adapters/rclone-cloud-provider.ts';
import { recoveryFixture } from './recovery-fixture.ts';
import type { Mirror, SyncProgress } from '../core/ports.ts';
const mirror: Mirror = { id: 'mirror-1', folder: { id: Buffer.from('Test Vault').toString('base64url'), name: 'Test Vault', ancestors: [] }, initialized: false, enabled: false, phase: 'paused', lastSuccess: null, failure: null };
function fixture(root = '/tmp/synthetic-root', limit?: number) {
  const calls: { method: string; body: any }[] = []; const commands: string[][] = [];
  let result: any = { State: 'sensitive-private-state', Option: { Name: 'config_2fa', Help: 'sentinel-password-and-phone', Default: 'sentinel-secret' }, Error: '' };
  const provider = new RcloneCloudProvider(root, async (method, body) => {
    calls.push({ method, body });
    if (method === 'config/listremotes') return { remotes: [] };
    if (method === 'operations/list') return { list: [{ IsDir: true, Name: 'Test Vault' }] };
    return result;
  }, async (args, _capture, report) => {
    commands.push(args);
    if (args[0] === 'lsjson') return '[{"Path":"note.md","Size":4,"ModTime":"2020-01-01T00:00:00Z","IsDir":false}]';
    if (args[0] === 'copy') { await writeFile(args[2].replace(/^:local,encoding=0x2018002:/, '') + '/note.md', 'note'); report?.({ bytes: 1, totalBytes: 4, files: 0, totalFiles: 1 }); }
    if (args[0] === 'bisync' && args.includes('--resync')) await writeFile(args[2] + '/note.md', 'note');
    return '';
  }, async () => {}, async () => {}, limit);
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
test('bisync preserves both conflicts and retains default deletion check without automatic recovery', () => {
  const normal = syncArguments('icloud:Test Vault', '/mirror', '/baseline', false);
  assert.ok(normal.includes('none')); assert.ok(normal.includes('num')); assert.ok(normal.includes('--max-delete'));
  for (const unsafe of ['--resync', '--force', '--max-lock', '--recover', '--resilient', '--inplace']) assert.ok(!normal.includes(unsafe));
  assert.ok(syncArguments('icloud:Test Vault', '/mirror', '/baseline', true).includes('--resync'));
});
test('preparation backs up both sides before establishing a fresh baseline and cannot repeat', async () => {
  const root = await mkdtemp('/tmp/icloud-backup-'); const f = fixture(root);
  try {
    await f.provider.prepareMirror(mirror);
    assert.deepEqual(f.commands.map(c => c[0]), ['lsjson', 'copy', 'lsjson', 'bisync']);
    assert.equal(await readFile(root + '/baselines/mirror-1/initialized', 'utf8'), '1');
    await assert.rejects(f.provider.prepareMirror(mirror), /recovery_required/);
    f.commands.length = 0; await f.provider.synchronize({ ...mirror, initialized: true });
    assert.deepEqual(f.commands.map(c => c[0]), ['lsjson', 'copy', 'lsjson', 'bisync']);
    assert.ok(!f.commands.at(-1)!.includes('--resync'));
    const snapshots = await Promise.all((await readdir(root + '/backups/snapshots')).map(name => readFile(root + '/backups/snapshots/' + name, 'utf8').then(JSON.parse)));
    assert.deepEqual(snapshots.map(s => s.entries.map((e: any) => e.side)).sort((a, b) => a.length - b.length), [['cloud'], ['cloud', 'local']]);
  } finally { await rm(root, { recursive: true }); }
});
test('capacity exhaustion pauses before bisync and never prunes unexpired recovery data', async () => {
  const root = await mkdtemp('/tmp/icloud-backup-'); const f = fixture(root, 8);
  try {
    const digest = 'a'.repeat(64); const previous = `${root}/backups/blobs/${digest}`;
    await mkdir(root + '/backups/blobs', { recursive: true }); await mkdir(root + '/backups/snapshots'); await writeFile(previous, '12345678');
    await writeFile(`${root}/backups/snapshots/${'b'.repeat(64)}.json`, JSON.stringify({ captured: Date.now(), mirror: 'mirror-1', entries: [{ side: 'local', path: 'note', blob: digest }] }));
    await assert.rejects(f.provider.prepareMirror(mirror), /capacity/);
    assert.equal(await readFile(previous, 'utf8'), '12345678'); assert.deepEqual(f.commands.map(c => c[0]), ['lsjson']);
  } finally { await rm(root, { recursive: true }); }
});
test('provider reports both recovery copies and only finishes after the sync command', async () => {
  const root = await mkdtemp('/tmp/icloud-progress-provider-'); const stages: SyncProgress[] = [];
  const provider = new RcloneCloudProvider(root, async () => ({}), async (args, _capture, report) => {
    if (args[0] === 'lsjson') return '[{"Path":"note.md","Size":4,"ModTime":"2020-01-01T00:00:00Z","IsDir":false}]';
    if (args[0] === 'copy') await writeFile(args[2].replace(/^:local,encoding=0x2018002:/, '') + '/note.md', 'note');
    report?.({ bytes: 1, totalBytes: 2, files: 0, totalFiles: 1 });
    if (args[0] === 'bisync') report?.({ bytes: 4, totalBytes: 4, files: 1, totalFiles: 1 });
    return '';
  }, async () => {}, async () => {});
  try {
    await provider.prepareMirror(mirror, value => stages.push(value));
    for (const stage of ['checking', 'backing_up_cloud', 'backing_up_local', 'saving_recovery', 'transferring', 'verifying']) assert.ok(stages.some(value => value.stage === stage), stage);
    assert.ok(stages.some(value => value.stage === 'backing_up_cloud' && value.bytes === 1 && value.totalBytes === 4));
    assert.equal(stages.at(-1)!.stage, 'verifying');
    assert.ok(stages.some(s => s.stage === 'transferring' && s.bytes === 4 && s.files === 1));
    assert.equal(await readFile(root + '/baselines/mirror-1/initialized', 'utf8'), '1');
  } finally { await rm(root, { recursive: true }); }
});
test('source changes during backup cannot start bisync or modify the existing baseline', async () => {
  const f = await recoveryFixture(); let bisyncs = 0;
  const provider = new RcloneCloudProvider(f.root + '/worker', async () => ({}), async (args, capture, report) => {
    if (args[0] === 'bisync') { bisyncs++; return ''; }
    return f.run(args.map(arg => arg === 'icloud:Test Vault' ? f.cloud : arg), capture, report);
  }, async () => {}, async () => {});
  try {
    await f.put('cloud', 'note.md', 'AA'); await mkdir(provider.localFolder(mirror), { recursive: true });
    await mkdir(f.root + '/worker/baselines/mirror-1', { recursive: true }); await writeFile(f.root + '/worker/baselines/mirror-1/initialized', '1');
    f.afterCopy(() => f.put('cloud', 'note.md', 'BB', 1_000_001));
    await assert.rejects(provider.synchronize({ ...mirror, initialized: true }), /source_changed/);
    assert.equal(bisyncs, 0); assert.equal(await readFile(f.root + '/worker/baselines/mirror-1/initialized', 'utf8'), '1');
  } finally { await rm(f.root, { recursive: true }); }
});
test('account binding prevents sending retained mirrors to a different Apple account', async () => {
  const methods: string[] = [];
  const provider = new RcloneCloudProvider('/tmp/proof', async method => { methods.push(method); return method === 'config/listremotes' ? { remotes: ['icloud'] } : { apple_id: 'original@example.test' }; }, async () => '', async () => {}, async () => {});
  await assert.rejects(provider.connect({ account: 'other@example.test', password: 'sentinel' }), /invalid_selection/);
  assert.deepEqual(methods, ['config/listremotes', 'config/get']);
});
