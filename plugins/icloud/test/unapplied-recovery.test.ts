import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { diagnosticMessage } from '../adapters/diagnostic-log.ts';
import { NoteApplicationError } from '../adapters/note-overlay.ts';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { CloudError, emptyState } from '../core/ports.ts';

async function fixture() {
  const root = await mkdtemp('/tmp/unapplied-recovery-');
  const db = new Database(':memory:'); const state = emptyState(); state.connected = true;
  state.mirrors.push({ id: 'one', folder: { id: 'generated', name: 'Generated', ancestors: [] }, initialized: true, enabled: true, phase: 'ready', failure: null, blocker: null, lastSuccess: null });
  await mkdir(join(root, 'mirrors/one'), { recursive: true }); await mkdir(join(root, 'baselines/one'), { recursive: true });
  await writeFile(join(root, 'baselines/one/initialized'), '1', { mode: 0o600 });
  const file = join(root, 'mirrors/one/Example.md'); await writeFile(file, 'original');
  const worker = new RcloneProcess(root); worker.ensure = async () => {}; worker.call = async () => ({ type: 'alias', remote: 'generated' });
  worker.withFiles = async action => action(new AbortController().signal);
  const diagnostics: string[] = [];
  const runtime = new NoteRuntime(root, db, worker, new NoteStore(join(root, 'legacy')), () => state, undefined, (s, c) => diagnostics.push(s + ':' + c));
  await runtime.start(); runtime.configure(1, ['one']);
  worker.withFiles = async () => { throw new CloudError('busy'); };
  const time = Date.now().toString(16).padStart(12, '0'); const operationId = `${time.slice(0,8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;
  await runtime.commit(1, { operationId, mirrorId: 'one', path: 'Example.md', kind: 'replace', expectedHash: createHash('sha256').update('original').digest('hex'), text: 'pending' });
  await runtime.call('rc/noop', {});
  worker.withFiles = async action => action(new AbortController().signal);
  Object.assign(state.mirrors[0], { enabled: false, phase: 'failed', failure: 'interrupted' });
  assert.equal(runtime.applicationBlocker('one'), 'application_uncertain');
  return { root, db, state, worker, runtime, file, diagnostics, async close() { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const [fault, stage, outcome] of [
  ['before_apply_stage_fsync', 'stage_write', 'unapplied'],
  ['after_apply_journal', 'journal_write', 'unapplied'],
  ['after_apply_stage_cleanup', 'checkpoint', 'uncertain'],
  ['after_apply_checkpoint', 'checkpoint_complete', 'applied'],
]) test('application diagnostic boundary '+stage, async () => {
  const f = await fixture();
  try {
    (f.runtime.overlay as any).fault = async (at: string) => { if (at === fault) throw new Error('PRIVATE_SENTINEL', { cause: 'PRIVATE_SENTINEL' }); };
    await assert.rejects(f.runtime.overlay.apply(join(f.root, 'mirrors/one'), 'one', 'Example.md'), error => {
      assert(error instanceof NoteApplicationError);
      assert.equal(error.stage, stage); assert.equal(error.outcome, outcome);
      const message = diagnosticMessage('note_apply', error.category, { evidence: null, application: { stage: error.stage, outcome: error.outcome } });
      assert(message.includes('application_stage='+stage+' outcome='+outcome));
      assert(!message.includes('PRIVATE_SENTINEL')); assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM icloud_note_overlay_receipts').get() as any).n, 1);
  } finally { await f.close(); }
});

test('runtime activity covers a queued native turn until it finishes', async () => {
  const f = await fixture(); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  try {
    f.worker.run = async () => { entered(); await held; return ''; };
    const running = f.runtime.run(['synthetic']); await started;
    assert.equal(f.runtime.activity().busy, true); assert.equal(f.runtime.activity().nativeRunning, true);
    release(); await running;
    await new Promise(r => setImmediate(r));
    assert.equal(f.runtime.activity().busy, false);
  } finally { release(); await f.close(); }
});

test('explicit recovery proves and applies intact save, preserving receipt and service state', async () => {
  const f = await fixture();
  try {
    const receipt = f.db.prepare('SELECT * FROM icloud_note_overlay_receipts').all();
    assert.deepEqual(f.diagnostics, ['note_apply:busy']);
    await f.runtime.recoverUnapplied('one');
    assert.equal(await readFile(f.file, 'utf8'), 'pending');
    assert.equal(f.runtime.applicationBlocker('one'), null);
    assert.equal(f.state.mirrors[0].enabled, false);
    assert.equal(f.state.mirrors[0].failure, 'interrupted');
    assert.deepEqual(f.db.prepare('SELECT * FROM icloud_note_overlay_receipts').all(), receipt);
    await f.runtime.recoverUnapplied('one'); // no replay once recovered
    assert.equal(await readFile(f.file, 'utf8'), 'pending');
  } finally { await f.close(); }
});

test('restart holds a disabled interrupted pending save until explicit recovery', async () => {
  const f = await fixture(); let replacement: NoteRuntime | undefined;
  try {
    await f.runtime.stop();
    replacement = new NoteRuntime(f.root, f.db, f.worker, new NoteStore(join(f.root, 'legacy')), () => f.state);
    await replacement.start();
    await replacement.call('rc/noop', {});
    assert.equal(await readFile(f.file, 'utf8'), 'original');
    assert.equal(replacement.applicationBlocker('one'), 'application_uncertain');
    await replacement.recoverUnapplied('one');
    assert.equal(await readFile(f.file, 'utf8'), 'pending');
  } finally { await replacement?.stop(); await f.close(); }
});

for (const condition of ['changed-bytes', 'changed-source', 'conflict', 'stage', 'already-applied', 'partial-successor', 'stale-proof', 'after-journal', 'after-publication', 'stopped']) test('recovery refuses '+condition+' and retains evidence', async () => {
  const f = await fixture();
  try {
    if (condition === 'changed-bytes') await writeFile(f.file, 'other');
    if (condition === 'changed-source') { await rename(join(f.root, 'mirrors/one'), join(f.root, 'old')); await mkdir(join(f.root, 'mirrors/one')); await writeFile(f.file, 'original'); }
    if (condition === 'conflict') await writeFile(f.file+'.icloud-conflict1', 'incoming');
    if (condition === 'stage') await writeFile(join(f.root, 'overlay/stages', randomUUID()), 'preserve');
    if (condition === 'already-applied') await f.runtime.overlay.apply(join(f.root, 'mirrors/one'), 'one', 'Example.md');
    if (condition === 'partial-successor') f.db.prepare('UPDATE icloud_note_overlay_heads SET applied = ?').run(JSON.stringify({ generation: 999, ...JSON.parse((f.db.prepare('SELECT base FROM icloud_note_overlay_heads').get() as any).base) }));
    if (condition === 'stale-proof') {
      const prove = f.runtime.overlay.proveUnapplied.bind(f.runtime.overlay);
      f.runtime.overlay.proveUnapplied = async (root, id) => { const paths = await prove(root, id); await writeFile(f.file, 'other'); return paths; };
    }
    if (condition === 'after-journal' || condition === 'after-publication') (f.runtime.overlay as any).fault = async (s: string) => { if (s === (condition === 'after-journal' ? 'after_apply_journal' : 'after_apply_stage_cleanup')) throw new Error('PRIVATE_SENTINEL'); };
    if (condition === 'stopped') await f.runtime.stop();
    await assert.rejects(f.runtime.recoverUnapplied('one'));
    assert.equal(f.runtime.applicationBlocker('one'), 'application_uncertain');
    assert.equal(f.state.mirrors[0].enabled, false);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM icloud_note_overlay_receipts').get() as any).n, 1);
    assert(!f.diagnostics.join().includes('PRIVATE_SENTINEL'));
    if (condition === 'after-journal' || condition === 'after-publication') {
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM icloud_note_overlay_heads WHERE journal IS NOT NULL').get() as any).n, 1);
      await assert.rejects(f.runtime.recoverUnapplied('one'));
    }
  } finally { await f.close(); }
});
