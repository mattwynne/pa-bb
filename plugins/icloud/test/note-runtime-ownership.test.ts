// Opt-in generated subprocess proof: a surviving inherited CLI fd keeps the
// flock when its JS parent is SIGKILLed. No Apple/device or personal files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { emptyState } from '../core/ports.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_RUNTIME_NATIVE === '1';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('SIGKILL of parent cannot admit replacement migration/publication while inherited native child owns flock', { skip: !enabled, timeout: 40000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-owned-generated-'); const workerRoot = join(root, 'sync');
  const source = join(root, 'source'), target = join(root, 'target');
  let db: Database.Database | undefined, contender: RcloneProcess | undefined, parent: ReturnType<typeof spawn> | undefined; let nativePid: number | undefined;
  try {
    await mkdir(source); await mkdir(target); await writeFile(join(source, 'generated.bin'), Buffer.alloc(4 * 1024 * 1024, 65));
    db = new Database(join(root, 'data.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    const code = `import { RcloneProcess } from ${JSON.stringify(new URL('../adapters/rclone-process.ts', import.meta.url).href)};
      const worker = new RcloneProcess(${JSON.stringify(workerRoot)}, ${JSON.stringify(process.env.RCLONE_TEST_BINARY)}, '512k');
      await worker.ensure(); const native = worker.run(['copy', ${JSON.stringify(source)}, ${JSON.stringify(target)}]);
      await new Promise(resolve => setTimeout(resolve, 500)); process.stdout.write('RUNNING\\n'); await native; await worker.stop();`;
    parent = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] });
    const output = await new Promise<string>((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('child did not start')), 15000);
      parent!.stdout!.on('data', chunk => { text += chunk; if (text.includes('RUNNING')) { clearTimeout(timer); resolve(text); } });
      parent!.on('error', reject); parent!.on('exit', () => reject(new Error('child exited before marker')));
    });
    assert.match(output, /RUNNING/);
    const children = (await readFile(`/proc/${parent.pid}/task/${parent.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const child of children) {
      const argv = await readFile(`/proc/${child}/cmdline`, 'utf8').catch(() => '');
      if (argv.includes('\0copy\0')) nativePid = Number(child);
    }
    assert.ok(nativePid, 'inherited native CLI must actually be running');
    parent.kill('SIGKILL');
    await new Promise(resolve => parent!.once('close', resolve));
    contender = new RcloneProcess(workerRoot, process.env.RCLONE_TEST_BINARY!);
    const runtime = new NoteRuntime(workerRoot, db, contender, new NoteStore(join(workerRoot, 'note-operations')), emptyState);
    await assert.rejects(runtime.start(), (error: any) => error.category === 'busy');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'icloud_note_overlay_%'").all();
    assert.equal(tables.length, 0, 'replacement must not migrate before flock takeover');
    assert.equal((await stat(join(source, 'generated.bin'))).size, 4 * 1024 * 1024);
    await contender.stop();
    let replacement: NoteRuntime | undefined;
    for (let i = 0; i < 120 && !replacement; i++) {
      contender = new RcloneProcess(workerRoot, process.env.RCLONE_TEST_BINARY!);
      const candidate = new NoteRuntime(workerRoot, db, contender, new NoteStore(join(workerRoot, 'note-operations')), emptyState);
      try { await candidate.start(); replacement = candidate; }
      catch (error) { assert.equal((error as any).category, 'busy'); await contender.stop(); await pause(100); }
    }
    assert.ok(replacement, 'native child eventually releases inherited flock');
    await replacement.stop();
    assert.equal((await stat(join(target, 'generated.bin'))).size, 4 * 1024 * 1024);
  } finally {
    parent?.kill('SIGKILL');
    if (nativePid) { try { process.kill(nativePid, 'SIGINT'); } catch {} }
    await contender?.stop(); db?.close();
    await rm(root, { recursive: true, force: true });
  }
});
