// Stock rclone against a generated local "cloud": a pushed change followed by
// an ordinary bisync scan must settle without conflict copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { DirectPush } from '../adapters/direct-push.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
import type { Mirror } from '../core/ports.ts';

const linux = process.platform === 'linux';
const keep = ['Keep 1.md', 'Keep 2.md'];
const mirror: Mirror = { id: 'one', folder: { id: Buffer.from('Vault').toString('base64url'), name: 'Vault', ancestors: [] },
  initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null };

async function fixture() {
  const root = await mkdtemp('/tmp/icloud-push-');
  const cloud = join(root, 'cloud'), local = join(root, 'mirrors', 'one'), workdir = join(root, 'baselines', 'one');
  for (const dir of [join(cloud, 'Vault'), local, workdir]) await mkdir(dir, { recursive: true });
  // bisync aborts a scan in which every file changed; a real vault has untouched notes.
  for (const name of ['Keep 1.md', 'Keep 2.md']) await writeFile(join(local, name), 'unchanged\n');
  const worker = new RcloneProcess(join(root, 'sync'), process.env.RCLONE_TEST_BINARY);
  await worker.ensure();
  await worker.call('config/create', { name: 'icloud', type: 'alias', parameters: { remote: cloud }, opt: { nonInteractive: true } });
  const outcomes: string[] = [];
  const push = new DirectPush((method, body) => worker.call(method, body), root, () => mirror, outcome => outcomes.push(outcome));
  const scan = (initial = false) => worker.run(syncArguments('icloud:Vault', local, workdir, initial));
  const files = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1)).sort();
  return { root, cloud: join(cloud, 'Vault'), local, worker, push, scan, outcomes, files,
    close: async () => { await worker.stop(); await rm(root, { recursive: true, force: true }); } };
}

test('pushed edits, creates and moves settle in the next scan without conflicts', { skip: !linux, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.local, 'Projects'), { recursive: true });
    await writeFile(join(f.local, 'Projects', 'Plan.md'), 'one\n');
    await f.scan(true);

    await writeFile(join(f.local, 'Projects', 'Plan.md'), 'two\n');
    await f.push.push('one', { kind: 'write', path: 'Projects/Plan.md' });
    // A second edit before any scan still goes straight through.
    await writeFile(join(f.local, 'Projects', 'Plan.md'), 'three\n');
    await f.push.push('one', { kind: 'write', path: 'Projects/Plan.md' });
    await writeFile(join(f.local, 'Projects', 'New.md'), 'new\n');
    await f.push.push('one', { kind: 'write', path: 'Projects/New.md' });
    assert.equal(await readFile(join(f.cloud, 'Projects', 'Plan.md'), 'utf8'), 'three\n');

    await rename(join(f.local, 'Projects', 'New.md'), join(f.local, 'Projects', 'Renamed.md'));
    await f.push.push('one', { kind: 'move', path: 'Projects/New.md', destination: 'Projects/Renamed.md' });
    await rename(join(f.local, 'Projects'), join(f.local, 'Archive'));
    await f.push.push('one', { kind: 'move', path: 'Projects', destination: 'Archive', directory: true });
    assert.deepEqual(f.outcomes, ['sent', 'sent', 'sent', 'sent', 'sent']);
    assert.deepEqual(await f.files(f.cloud), [...keep, 'Archive/Plan.md', 'Archive/Renamed.md'].sort());

    await f.scan();
    assert.deepEqual(await f.files(f.local), [...keep, 'Archive/Plan.md', 'Archive/Renamed.md'].sort());
    assert.deepEqual(await f.files(f.cloud), [...keep, 'Archive/Plan.md', 'Archive/Renamed.md'].sort());
  } finally { await f.close(); }
});

test('a note changed in the cloud since the last scan is not overwritten; the scan keeps both', { skip: !linux, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.local, 'Note.md'), 'base\n');
    await f.scan(true);
    await writeFile(join(f.cloud, 'Note.md'), 'from the mac\n');
    const later = new Date(Date.now() + 5000);
    await utimes(join(f.cloud, 'Note.md'), later, later);
    await writeFile(join(f.local, 'Note.md'), 'from bb\n');

    await f.push.push('one', { kind: 'write', path: 'Note.md' });
    assert.deepEqual(f.outcomes, ['skipped']);
    assert.equal(await readFile(join(f.cloud, 'Note.md'), 'utf8'), 'from the mac\n');

    await f.scan();
    const copies = await f.files(f.local);
    assert.deepEqual(copies, [...keep, 'Note.md.bb-conflict1', 'Note.md.icloud-conflict1'].sort());
    assert.deepEqual(await f.files(f.cloud), copies);
  } finally { await f.close(); }
});

test('a move whose destination already exists in the cloud is left to the scan', { skip: !linux, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.local, 'A.md'), 'a\n');
    await f.scan(true);
    await writeFile(join(f.cloud, 'B.md'), 'mac\n');
    await rename(join(f.local, 'A.md'), join(f.local, 'B.md'));
    await f.push.push('one', { kind: 'move', path: 'A.md', destination: 'B.md' });
    assert.deepEqual(f.outcomes, ['skipped']);
    assert.deepEqual(await f.files(f.cloud), [...keep, 'A.md', 'B.md'].sort());
  } finally { await f.close(); }
});
