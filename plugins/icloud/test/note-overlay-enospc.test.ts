// Opt-in only inside a disposable private mount namespace with a bounded
// generated tmpfs. Never fill /dev/shm, a shared disk or production storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { NoteStore } from '../adapters/note-store.ts';
import { NoteOverlay } from '../adapters/note-overlay.ts';
const parent = process.env.ICLOUD_ENOSPC_PRIVATE_MOUNT;
const enabled = process.platform === 'linux' && !!parent && process.env.ICLOUD_ENOSPC_FIXTURE === '1';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = () => { const time = Date.now().toString(16).padStart(12, '0'); return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(15)}`; };
test('physical ENOSPC leaves an old or inspectably new logical head, never a false saved reply', { skip: !enabled, timeout: 25000 }, async () => {
  const root = await mkdtemp(join(parent!, 'generated-')); const mirror = join(root, 'mirror'); let db: Database.Database | undefined;
  try {
    await mkdir(mirror); await writeFile(join(mirror, 'Note.md'), 'A');
    db = new Database(join(root, 'index.db')); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    const store = new NoteOverlay(join(root, 'overlay'), db, new NoteStore(join(root, 'legacy'))); await store.start(); await store.indexLegacy('generated', mirror);
    const first = { operationId: id(), mirrorId: 'generated', path: 'Note.md', kind: 'replace' as const, expectedHash: hash('A'), text: 'B' };
    await store.commit(mirror, first);
    const ballast = await open(join(root, 'ballast'), 'wx', 0o600);
    try {
      const chunk = Buffer.alloc(4096, 91);
      for (let i = 0; i < 2048; i++) {
        try { await ballast.writeFile(chunk); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOSPC') throw e; break; }
      }
    } finally { await ballast.close(); }
    const second = { ...first, operationId: id(), expectedHash: hash('B'), text: 'C'.repeat(64 * 1024) };
    let category = '';
    try { await store.commit(mirror, second); assert.fail('bounded tmpfs did not fill'); }
    catch (e) { category = (e as any)?.category ?? ''; assert.ok(['capacity', 'uncertain'].includes(category)); }
    // Release only synthetic ballast, not an overlay journal or recovery file.
    await rm(join(root, 'ballast'));
    const restarted = new NoteOverlay(join(root, 'overlay'), db, new NoteStore(join(root, 'legacy')));
    try {
      await restarted.start();
      const recorded = await restarted.receipt(second.operationId);
      const logical = await restarted.read(mirror, 'generated', 'Note.md');
      assert.equal(logical.text, recorded?.outcome === 'saved_locally_pending_sync' ? second.text : first.text);
    } catch (e) { assert.equal((e as any)?.category, 'uncertain'); }
    console.log(JSON.stringify({ fixture: 'private-physical-enospc', result: category }));
  } finally { db?.close(); await rm(root, { recursive: true, force: true }); }
});
