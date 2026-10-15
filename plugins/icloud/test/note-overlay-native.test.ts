// Explicit opt-in: disposable generated alias remote only. This is not a
// provider/device test and does not prove inherited-flock generation takeover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { NoteOverlay } from '../adapters/note-overlay.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_OVERLAY_NATIVE === '1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const op = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
test('stock bisync both-side edit preserves numbered copies as inspectable incoming evidence', { skip: !enabled, timeout: 30000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-overlay-conflict-generated-'); const remote = join(root, 'remote'), local = join(root, 'local'), baseline = join(root, 'baseline'), config = join(root, 'alias.conf');
  let db: Database.Database | undefined; let stage = 'setup';
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', GOMEMLIMIT: '256MiB' };
  try {
    for (const dir of [remote, local, baseline]) await mkdir(dir);
    await writeFile(config, `[icloud]\ntype = alias\nremote = ${remote}\n`, { mode: 0o600 });
    await writeFile(join(remote, 'Note.md'), 'A'); await writeFile(join(remote, 'unchanged.md'), 'unchanged');
    const command = (initial: boolean) => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.env.RCLONE_TEST_BINARY!, [...syncArguments('icloud:', local, baseline, initial), '--config', config], { env, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve(code); });
    });
    stage = 'initial'; assert.equal(await command(true), 0);
    db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    const files = new NoteStore(join(root, 'legacy')); const store = new NoteOverlay(join(root, 'overlay'), db, files); await store.start(); await store.indexLegacy('generated', local);
    stage = 'apply'; await store.commit(local, { operationId: op(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    assert.equal(await store.apply(local, 'generated', 'Note.md'), 'applied'); const eligible = store.beforeRun('generated');
    await writeFile(join(remote, 'Note.md'), 'Remote C'); const future = new Date(Date.now() + 10000); await utimes(join(remote, 'Note.md'), future, future);
    stage = 'conflict_run'; assert.equal(await command(false), 0);
    const copies = await files.conflictCopies(local, 'Note.md');
    assert.ok(copies.some(c => c.side === 'icloud' && c.observation.hash === hash('Remote C')));
    assert.ok(copies.some(c => c.side === 'bb' && c.observation.hash === hash('B')));
    assert.equal(await store.afterRun(local, 'generated', eligible, true), 0);
    const collision = (await store.inspect('generated', 'Note.md'))!;
    assert.equal(collision.incomingHash, hash('Remote C'));
    assert.equal(await store.readIncoming('generated', 'Note.md', collision.token), 'Remote C');
    stage = 'resolve_first';
    await store.resolve(local, 'generated', 'Note.md', { operationId: op(), token: collision.token, expectedLogicalHash: hash('B'), expectedIncomingHash: hash('Remote C'), choice: 'accept_incoming' });
    assert.equal(await store.apply(local, 'generated', 'Note.md'), 'applied');
    const settle = store.beforeRun('generated'); assert.equal(await command(false), 0); await store.afterRun(local, 'generated', settle, true);
    const extra = await store.inspect('generated', 'Note.md');
    if (extra) {
      assert.equal(extra.incomingHash, hash('Remote C'));
      await store.resolve(local, 'generated', 'Note.md', { operationId: op(), token: extra.token, expectedLogicalHash: hash('Remote C'), expectedIncomingHash: hash('Remote C'), choice: 'accept_incoming' });
      await store.apply(local, 'generated', 'Note.md');
    }
    const historical = await files.conflictCopies(local, 'Note.md');
    assert.ok(historical.some(c => c.observation.hash === hash('Remote C')));
    stage = 'second_conflict';
    await store.commit(local, { operationId: op(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('Remote C'), text: 'Local D' });
    assert.equal(await store.apply(local, 'generated', 'Note.md'), 'applied');
    const nextEligible = store.beforeRun('generated');
    await writeFile(join(remote, 'Note.md'), 'Remote E'); const nextFuture = new Date(Date.now() + 20000); await utimes(join(remote, 'Note.md'), nextFuture, nextFuture);
    assert.equal(await command(false), 0);
    const nextCopies = await files.conflictCopies(local, 'Note.md');
    assert.ok(nextCopies.some(c => c.side === 'icloud' && c.number > Math.max(...historical.filter(old => old.side === 'icloud').map(old => old.number)) && c.observation.hash === hash('Remote E')));
    await store.afterRun(local, 'generated', nextEligible, true);
    const second = (await store.inspect('generated', 'Note.md'))!;
    assert.equal(second.incomingHash, hash('Remote E'));
    assert.equal(await store.readIncoming('generated', 'Note.md', second.token), 'Remote E');
    assert.ok((await files.conflictCopies(local, 'Note.md')).some(c => c.observation.hash === hash('Remote C')));
  } catch (error) { console.error('OVERLAY_CONFLICT_NATIVE_FAILED', stage, error instanceof assert.AssertionError ? 'assertion' : 'execution'); throw new Error(`overlay conflict fixture failed at ${stage}`); }
  finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});
test('real >=40s native transfer permits a promptly durable local save, then application, retirement and remote edit', { skip: !enabled, timeout: 120000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-overlay-native-generated-'); const remote = join(root, 'remote'); const local = join(root, 'local'); const baseline = join(root, 'baseline'); const config = join(root, 'alias.conf');
  let child: ReturnType<typeof spawn> | undefined; let db: Database.Database | undefined;
  let stage = 'setup';
  try {
    for (const folder of [remote, local, baseline]) await mkdir(folder);
    await writeFile(config, `[icloud]\ntype = alias\nremote = ${remote}\n`, { mode: 0o600 });
    await writeFile(join(remote, 'Note.md'), 'A'); await writeFile(join(remote, 'unchanged.md'), 'unchanged');
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', GOMEMLIMIT: '256MiB' };
    const command = (initial: boolean, limit = '8M') => new Promise<{ duration: number; code: number | null }>((resolve, reject) => {
      const started = performance.now();
      const args = [...syncArguments('icloud:', local, baseline, initial), '--config', config, '--transfers', '1', '--checkers', '1', '--bwlimit', limit];
      child = spawn(process.env.RCLONE_TEST_BINARY!, args, { env, stdio: 'ignore' });
      const timer = setTimeout(() => child?.kill('SIGKILL'), 100000);
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); child = undefined; resolve({ duration: performance.now() - started, code }); });
    });
    stage = 'initial'; assert.equal((await command(true)).code, 0);
    db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    const overlay = new NoteOverlay(join(root, 'overlay'), db, new NoteStore(join(root, 'legacy'))); await overlay.start(); await overlay.indexLegacy('generated', local);
    await writeFile(join(remote, 'generated-transfer.bin'), Buffer.alloc(24 * 1024 * 1024, 65));
    stage = 'long_transfer';
    const active = command(false, '512k'); await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(child && child.exitCode === null, 'native process must be active during save');
    const started = performance.now();
    const b = await overlay.commit(local, { operationId: op(), mirrorId: 'generated', path: 'Note.md', kind: 'replace', expectedHash: hash('A'), text: 'B' });
    const saveMs = performance.now() - started;
    assert.equal(b.outcome, 'saved_locally_pending_sync');
    assert.equal((await overlay.read(local, 'generated', 'Note.md')).text, 'B');
    assert.equal(await readFile(join(local, 'Note.md'), 'utf8'), 'A');
    assert.ok(child && child.exitCode === null, 'native child still active after local commit');
    const long = await active; assert.equal(long.code, 0); assert.ok(long.duration >= 40000);
    stage = 'application'; assert.equal(await overlay.apply(local, 'generated', 'Note.md'), 'applied');
    const eligible = overlay.beforeRun('generated'); const following = await command(false);
    assert.equal(following.code, 0); assert.equal(await overlay.afterRun(local, 'generated', eligible, true), 1);
    await writeFile(join(remote, 'Note.md'), 'Remote C');
    const when = new Date(Date.now() + 10000); await utimes(join(remote, 'Note.md'), when, when);
    stage = 'later_remote'; assert.equal((await command(false)).code, 0);
    assert.equal((await overlay.read(local, 'generated', 'Note.md')).text, 'Remote C');
    console.log(JSON.stringify({ outcome: 'pass', nativeDurationMs: Math.round(long.duration), localSaveMs: Math.round(saveMs), retired: 1, laterRemoteVisible: true }));
  } catch (e) { console.error('OVERLAY_NATIVE_FAILED', stage, e instanceof assert.AssertionError ? 'assertion' : 'execution'); throw new Error(`overlay native fixture failed at ${stage}`); }
  finally { child?.kill('SIGKILL'); db?.close(); await rm(root, { recursive: true, force: true }); }
});
