// Opt-in wall-clock evidence: two genuine one-minute scheduled native runs.
// ICLOUD_SCHEDULED_REVIEW=1 RCLONE_TEST_BINARY=<stock-rclone> node --experimental-transform-types --test test/note-scheduled.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
const enabled = process.platform === 'linux' && !!process.env.RCLONE_TEST_BINARY && process.env.ICLOUD_SCHEDULED_REVIEW === '1';
test('routine access during two real minute-based native bisync runs has bounded busy and returns to editing', { skip: !enabled, timeout: 145000 }, async () => {
  const root = await mkdtemp('/tmp/icloud-note-scheduled-'); const remote = root + '/remote'; const local = root + '/local'; const baseline = root + '/baseline';
  const worker = new RcloneProcess(root + '/worker', process.env.RCLONE_TEST_BINARY); const notes = new NoteStore(root + '/note-operations');
  const measurements: Array<{ busy: boolean; ms: number }> = []; const runs: number[] = []; let timer: ReturnType<typeof setInterval> | undefined; let running: Promise<unknown> | undefined;
  try {
    await mkdir(remote); await mkdir(local); await mkdir(baseline); await mkdir(remote + '/.hidden');
    for (let i = 0; i < 250; i++) await writeFile(remote + `/Generated-${i}.md`, '# Generated\n' + 'x'.repeat(1024));
    await writeFile(remote + '/.hidden/Note.md', '# Synthetic\n');
    await worker.run(syncArguments(remote, local, baseline, true));
    const finished = new Promise<void>((resolve, reject) => {
      timer = setInterval(() => {
        if (running) { reject(new Error('A run exceeded the one-minute synthetic schedule')); return; }
        running = (async () => { const at = performance.now(); await writeFile(remote + '/scheduled.md', `Run ${runs.length + 1}\n`); await worker.run(syncArguments(remote, local, baseline, false)); runs.push(performance.now() - at); if (runs.length === 2) { clearInterval(timer); resolve(); } })().catch(reject).finally(() => { running = undefined; });
      }, 60000);
    });
    const started = performance.now();
    while (runs.length < 2 && performance.now() - started < 135000) {
      const at = performance.now();
      try { await worker.withFiles(() => notes.read(local, '.hidden/Note.md')); measurements.push({ busy: false, ms: performance.now() - at }); }
      catch (e) { assert.match((e as Error).message, /busy/); measurements.push({ busy: true, ms: performance.now() - at }); }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await finished; await running;
    const note = await worker.withFiles(() => notes.read(local, '.hidden/Note.md'));
    const receipt = await worker.withFiles(signal => notes.commit(local, { operationId: (() => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; })(), mirrorId: 'generated', path: '.hidden/Note.md', expectedHash: note.hash, text: note.text + 'Local decision\n', kind: 'replace' }, signal));
    assert.equal(receipt.outcome, 'saved_locally_pending_sync'); assert.match(await readFile(local + '/.hidden/Note.md', 'utf8'), /Local decision/);
    const busy = measurements.filter(m => m.busy); const available = measurements.filter(m => !m.busy);
    assert.equal(runs.length, 2); assert.ok(available.length > measurements.length * 0.9); assert.ok(Math.max(...measurements.map(m => m.ms)) < 1000);
    console.log(JSON.stringify({ synthetic: true, noteCount: 252, scheduleMs: 60000, nativeRunMs: runs, samples: measurements.length, available: available.length, busy: busy.length, maxAccessMs: Math.max(...measurements.map(m => m.ms)), maxBusyMs: busy.length ? Math.max(...busy.map(m => m.ms)) : 0, localCommit: receipt.outcome }));
  } finally { clearInterval(timer); await running?.catch(() => {}); await worker.stop(); await rm(root, { recursive: true, force: true }); }
});
