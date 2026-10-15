// Generation-owned durable note overlay. The caller owns the inherited native flock
// before start and supplies the admission predicate for each pointer publication.
import type Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NoteStore, NoteError, NOTE_LIMITS, validateNotePath } from './note-store.ts';
import { CloudError } from '../core/ports.ts';
import type { CommitInput, NoteReceipt } from './note-store.ts';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const INCOMING_ARCHIVE_LIMIT = 32768; // separate metadata bound; shared/empty bytes cannot exhaust the byte quota
const validId = (value: string) => /^[a-zA-Z0-9-]{1,64}$/.test(value);
const validOperation = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const issuedAt = (id: string) => Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
type Observation = Awaited<ReturnType<NoteStore['observe']>>;
type Proof = { hash: string; info: NonNullable<Observation>['info'] } | null;
type Conflict = { token: string; incomingHash: string | null; incoming: Proof; canonical: Proof; incomingCopyNumber: number | null };
type Journal = { generation: number; hash: string; stage: string; stageDev: number; stageIno: number; expected: Proof };
type Head = { mirror_id: string; path: string; generation: number; hash: string; bytes: number; base: string; applied: string | null; journal: string | null; conflict: string | null; copies: string; queue_order: number; queued_at: number };
const proof = (observation: Observation): Proof => observation ? { hash: observation.hash, info: { dev: observation.info.dev, ino: observation.info.ino, size: observation.info.size, mtimeMs: observation.info.mtimeMs, ctimeMs: observation.info.ctimeMs } } : null;
const same = (a: Proof, b: Proof) => a === null || b === null ? a === b : a.hash === b.hash && a.info.dev === b.info.dev && a.info.ino === b.info.ino && a.info.size === b.info.size && a.info.mtimeMs === b.info.mtimeMs && a.info.ctimeMs === b.info.ctimeMs;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const inodeSchema = z.object({ dev: z.number().int().nonnegative().safe(), ino: z.number().int().nonnegative().safe(), size: z.number().int().nonnegative().safe(), mtimeMs: z.number().finite(), ctimeMs: z.number().finite() }).strict();
const proofSchema = z.object({ hash: hashSchema, info: inodeSchema }).strict().nullable();
const copySchema = z.object({ side: z.enum(['icloud', 'bb']), number: z.number().int().positive().safe(), evidence: proofSchema }).strict();
const copiesSchema = z.array(copySchema).max(32);
const receiptSchema = z.object({ operationId: z.string().uuid(), mirrorId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/), path: z.string().min(1).max(1024), at: z.string().datetime(), outcome: z.enum(['saved_locally_pending_sync', 'not_saved', 'uncertain']), hash: hashSchema, previousHash: hashSchema.nullable() }).strict();
const journalSchema = z.object({ generation: z.number().int().positive().safe(), hash: hashSchema, stage: z.string().uuid(), stageDev: z.number().int().nonnegative().safe(), stageIno: z.number().int().nonnegative().safe(), expected: proofSchema }).strict();
const appliedSchema = z.object({ generation: z.number().int().positive().safe(), hash: hashSchema, info: inodeSchema }).strict();
const conflictSchema = z.object({ token: z.string().uuid(), incomingHash: hashSchema.nullable(), incoming: proofSchema, canonical: proofSchema, incomingCopyNumber: z.number().int().positive().safe().nullable() }).strict().refine(value => value.incomingHash === (value.incoming?.hash ?? null) && (value.incomingCopyNumber === null || value.incoming !== null));
const parse = <T>(value: string, schema: z.ZodType<T>): T => { try { return schema.parse(JSON.parse(value)); } catch { throw new NoteError('uncertain'); } };
type CopyProof = { side: 'icloud' | 'bb'; number: number; evidence: Proof };
const copiesOf = (copies: Awaited<ReturnType<NoteStore['conflictCopies']>>): CopyProof[] => copies.map(copy => ({ side: copy.side, number: copy.number, evidence: proof(copy.observation) })).sort((a, b) => a.side.localeCompare(b.side) || a.number - b.number);
const sameCopies = (a: CopyProof[], b: CopyProof[]) => a.length === b.length && a.every((copy, i) => copy.side === b[i].side && copy.number === b[i].number && same(copy.evidence, b[i].evidence));
const translate = (error: unknown) => error instanceof NoteError || error instanceof CloudError ? error : new NoteError(['ENOSPC', 'SQLITE_FULL'].includes((error as NodeJS.ErrnoException)?.code ?? '') ? 'capacity' : 'unavailable');
const migrations = `
CREATE TABLE IF NOT EXISTS icloud_note_overlay_heads (mirror_id TEXT NOT NULL, path TEXT NOT NULL, generation INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), base TEXT NOT NULL, applied TEXT, journal TEXT, conflict TEXT, copies TEXT NOT NULL DEFAULT '[]', queue_order INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(mirror_id, path));
CREATE INDEX IF NOT EXISTS icloud_note_overlay_queue ON icloud_note_overlay_heads(queue_order, mirror_id, path);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_receipts (operation_id TEXT PRIMARY KEY, mirror_id TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL, hash TEXT NOT NULL, previous_hash TEXT, quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0), checked_at INTEGER);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_receipts_expiry ON icloud_note_overlay_receipts(at, checked_at);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_receipts_scope ON icloud_note_overlay_receipts(mirror_id, at DESC, operation_id);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_receipts_path ON icloud_note_overlay_receipts(mirror_id, path, at DESC);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_recovery (operation_id TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL);
-- A captured incoming version is neither a save receipt nor a previous local
-- version. Its original conflict token is its durable recovery identity.
CREATE TABLE IF NOT EXISTS icloud_note_overlay_incoming_archive (token TEXT PRIMARY KEY, mirror_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, captured_at INTEGER NOT NULL, resolution_operation_id TEXT);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_incoming_expiry ON icloud_note_overlay_incoming_archive(captured_at, token);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_resolutions (operation_id TEXT PRIMARY KEY, mirror_id TEXT NOT NULL, path TEXT NOT NULL, at TEXT NOT NULL, digest TEXT NOT NULL, outcome TEXT NOT NULL, hash TEXT, quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0), checked_at INTEGER);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_resolutions_maintenance ON icloud_note_overlay_resolutions(checked_at, operation_id);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_resolutions_scope ON icloud_note_overlay_resolutions(mirror_id, at DESC, operation_id);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_resolutions_path ON icloud_note_overlay_resolutions(mirror_id, path, at DESC);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_legacy (operation_id TEXT PRIMARY KEY, mirror_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, expected_hash TEXT, hash TEXT NOT NULL, request_digest TEXT NOT NULL, receipt TEXT NOT NULL, uncertain INTEGER NOT NULL, previous_bytes INTEGER NOT NULL, checked_at INTEGER);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_legacy_uncertain ON icloud_note_overlay_legacy(mirror_id, path, uncertain);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_legacy_scope ON icloud_note_overlay_legacy(mirror_id, path, operation_id);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_legacy_admission (mirror_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_usage (scope TEXT PRIMARY KEY, paths INTEGER NOT NULL, bytes INTEGER NOT NULL, staged_paths INTEGER NOT NULL DEFAULT 0, staged_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_totals (id INTEGER PRIMARY KEY CHECK(id = 1), receipts INTEGER NOT NULL, receipt_bytes INTEGER NOT NULL, recovery_bytes INTEGER NOT NULL, staged_receipts INTEGER NOT NULL DEFAULT 0, staged_receipt_bytes INTEGER NOT NULL DEFAULT 0, staged_recovery_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_reservations (operation_id TEXT PRIMARY KEY, mirror_id TEXT NOT NULL, hash TEXT, bytes INTEGER NOT NULL, paths INTEGER NOT NULL, receipt_bytes INTEGER NOT NULL, recovery_hash TEXT, recovery_bytes INTEGER NOT NULL, receipt_hash TEXT, receipt_content_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_generations (generation_id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, mirror_id TEXT NOT NULL, path TEXT NOT NULL, parent_generation INTEGER REFERENCES icloud_note_overlay_generations(generation_id), hash TEXT NOT NULL, bytes INTEGER NOT NULL, published_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','applied','superseded','conflicted','retired','resolved','uncertain')), superseded_by INTEGER REFERENCES icloud_note_overlay_generations(generation_id), applied TEXT, checked_at INTEGER);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_generations_path ON icloud_note_overlay_generations(mirror_id, path, generation_id);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_generations_maintenance ON icloud_note_overlay_generations(published_at, checked_at, state);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_heads_generation ON icloud_note_overlay_heads(generation);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_generations_parent ON icloud_note_overlay_generations(parent_generation);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_generations_successor ON icloud_note_overlay_generations(superseded_by);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_generations_expiry ON icloud_note_overlay_generations(state, published_at);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_blob_refs (class TEXT NOT NULL CHECK(class IN ('pending','recovery')), kind TEXT NOT NULL, owner TEXT NOT NULL, mirror_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), PRIMARY KEY(kind, owner, mirror_id, hash));
CREATE INDEX IF NOT EXISTS icloud_note_overlay_blob_hash ON icloud_note_overlay_blob_refs(class, hash, mirror_id);
CREATE TABLE IF NOT EXISTS icloud_note_overlay_blob_catalog (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes >= 0), orphan_at INTEGER);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_blobs_maintenance ON icloud_note_overlay_blob_catalog(orphan_at, hash);
CREATE INDEX IF NOT EXISTS icloud_note_overlay_orphans ON icloud_note_overlay_blob_catalog(orphan_at, hash);
`;
export type Resolution = { operationId: string; token: string; expectedLogicalHash: string; expectedIncomingHash: string | null; choice: 'keep_local' | 'accept_incoming' | 'replace'; text?: string };
export class NoteOverlay {
  private barriers = new Map<string, Promise<void>>();
  constructor(private root: string, private db: Database.Database, private mirror: NoteStore, private clock = () => Date.now(), private fault?: (stage: string) => void | Promise<void>, private admission?: (mirrorId: string) => void) {}
  private head(id: string, path: string) { return this.db.prepare('SELECT * FROM icloud_note_overlay_heads WHERE mirror_id = ? AND path = ?').get(id, path) as Head | undefined; }
  private key(id: string, path: string) { return JSON.stringify([id, path]); }
  private async locked<T>(id: string, path: string, action: () => Promise<T>): Promise<T> {
    const key = this.key(id, path), previous = this.barriers.get(key) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>(resolve => { release = resolve; });
    this.barriers.set(key, current);
    await previous;
    try { return await action(); } finally { release(); if (this.barriers.get(key) === current) this.barriers.delete(key); }
  }
  private async directory(path: string) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new NoteError('unavailable');
  }
  private async syncDir(path: string) { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
  private async write(path: string, text: string, stage: string) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await this.fault?.(`before_${stage}_fsync`); await handle.sync(); await this.fault?.(`after_${stage}_fsync`); } finally { await handle.close(); }
  }
  private async blob(text: string) {
    return this.locked('blob', sha(text), () => this.blobLocked(text));
  }
  private async blobLocked(text: string) {
    const hash = sha(text), folder = join(this.root, 'blobs'), path = join(folder, hash);
      // A crash before fsync must leave only an unreferenced removable temp,
      // never a corrupt final content-addressed pathname.
      const temp = join(folder, `tmp-${randomUUID()}`);
      try {
        await this.write(temp, text, 'blob');
        try { await link(temp, path); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
        await this.syncDir(folder); await this.fault?.('after_blob_parent_fsync');
      } catch (error) { throw translate(error); }
      finally {
        await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; });
        await this.syncDir(folder);
      }
      await this.readBlob(hash);
      this.db.prepare('INSERT OR IGNORE INTO icloud_note_overlay_blob_catalog(hash, bytes, orphan_at) VALUES (?, ?, ?)').run(hash, Buffer.byteLength(text), this.clock());
      return hash;
  }
  private loadBlob(hash: string) { return this.locked('blob', hash, () => this.readBlob(hash)); }
  private async readBlob(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new NoteError('uncertain');
    let file;
    try {
      file = await open(join(this.root, 'blobs', hash), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat(); if (!info.isFile() || info.size > NOTE_LIMITS.bytes || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new NoteError('uncertain');
      const bytes = await file.readFile(); const after = await file.stat(); const named = await lstat(join(this.root, 'blobs', hash));
      if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.dev !== named.dev || info.ino !== named.ino || info.ctimeMs !== named.ctimeMs) throw new NoteError('uncertain');
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new NoteError('uncertain');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes('\0')) throw new NoteError('uncertain'); return text;
    } catch { throw new NoteError('uncertain'); } finally { await file?.close(); }
  }
  async start() {
    if (process.platform !== 'linux') throw new NoteError('unavailable');
    // The caller must first acquire the inherited worker flock. This method
    // intentionally cannot be invoked by a disabled top-level import.
    for (const path of [this.root, join(this.root, 'blobs'), join(this.root, 'stages')]) await this.directory(path);
    if (this.db.pragma('synchronous', { simple: true }) !== 2) throw new NoteError('unavailable');
    this.db.exec(migrations);
    const priorUsage = this.db.prepare('SELECT scope, paths, bytes, staged_paths FROM icloud_note_overlay_usage ORDER BY scope').all() as Array<{ scope: string; paths: number; bytes: number; staged_paths: number }>;
    const priorTotals = this.db.prepare('SELECT receipts, receipt_bytes, recovery_bytes, staged_receipts FROM icloud_note_overlay_totals WHERE id = 1').get() as { receipts: number; receipt_bytes: number; recovery_bytes: number; staged_receipts: number } | undefined;
    const abandoned = (this.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_reservations').get() as { count: number }).count;
    // Only after taking actual native ownership: an unacknowledged reservation
    // cannot contain a published head/receipt. Rebuild indexed counters once at
    // admission, never by walking every note during an ordinary save.
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM icloud_note_overlay_blob_refs WHERE kind IN ('reservation', 'reservation-previous', 'reservation-receipt')").run();
      this.db.prepare('DELETE FROM icloud_note_overlay_reservations').run();
      this.db.prepare('DELETE FROM icloud_note_overlay_usage').run();
      this.db.prepare("INSERT INTO icloud_note_overlay_usage(scope, paths, bytes) SELECT '*', COUNT(*), 0 FROM icloud_note_overlay_heads").run();
      this.db.prepare('INSERT INTO icloud_note_overlay_usage(scope, paths, bytes) SELECT mirror_id, COUNT(*), 0 FROM icloud_note_overlay_heads GROUP BY mirror_id').run();
      for (const scope of priorUsage.map(row => row.scope).filter(scope => scope !== '*')) this.db.prepare('INSERT OR IGNORE INTO icloud_note_overlay_usage(scope, paths, bytes) VALUES (?, 0, 0)').run(scope);
      this.db.prepare("UPDATE icloud_note_overlay_usage SET bytes = (SELECT COALESCE(SUM(bytes), 0) FROM (SELECT MAX(bytes) AS bytes FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND (icloud_note_overlay_usage.scope = '*' OR mirror_id = icloud_note_overlay_usage.scope) GROUP BY hash))").run();
      const receipts = this.db.prepare("SELECT (SELECT COUNT(*) FROM icloud_note_overlay_receipts) + (SELECT COUNT(*) FROM icloud_note_overlay_resolutions) + (SELECT COUNT(*) FROM icloud_note_overlay_legacy) AS rows, (SELECT COALESCE(SUM(quota_bytes), 0) FROM icloud_note_overlay_receipts) + (SELECT COALESCE(SUM(quota_bytes), 0) FROM icloud_note_overlay_resolutions) + (SELECT COALESCE(SUM(LENGTH(receipt)), 0) FROM icloud_note_overlay_legacy) AS bytes, (SELECT COALESCE(SUM(bytes), 0) FROM (SELECT MAX(bytes) AS bytes FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' GROUP BY hash)) + (SELECT COALESCE(SUM(previous_bytes), 0) FROM icloud_note_overlay_legacy) AS recovery").get() as { rows: number; bytes: number; recovery: number };
      this.db.prepare('INSERT INTO icloud_note_overlay_totals(id, receipts, receipt_bytes, recovery_bytes) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET receipts = excluded.receipts, receipt_bytes = excluded.receipt_bytes, recovery_bytes = excluded.recovery_bytes, staged_receipts = 0, staged_receipt_bytes = 0, staged_recovery_bytes = 0').run(receipts.rows, receipts.bytes, receipts.recovery);
      if (!abandoned && priorUsage.length) {
      const actualUsage = this.db.prepare('SELECT scope, paths, bytes, staged_paths FROM icloud_note_overlay_usage ORDER BY scope').all();
      const actualTotals = this.db.prepare('SELECT receipts, receipt_bytes, recovery_bytes, staged_receipts FROM icloud_note_overlay_totals WHERE id = 1').get();
      if (JSON.stringify(priorUsage) !== JSON.stringify(actualUsage) || JSON.stringify(priorTotals) !== JSON.stringify(actualTotals)) throw new NoteError('uncertain');
      }
    })();
    for (const item of await readdir(join(this.root, 'blobs'))) {
      if (/^tmp-[a-f0-9-]{36}$/.test(item)) { await unlink(join(this.root, 'blobs', item)); continue; }
      if (!/^[a-f0-9]{64}$/.test(item)) throw new NoteError('uncertain');
      const info = await lstat(join(this.root, 'blobs', item));
      if (!info.isFile() || info.isSymbolicLink() || info.size > NOTE_LIMITS.bytes || info.uid !== process.getuid?.()) throw new NoteError('uncertain');
      const row = this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(item) as { bytes: number } | undefined;
      if (row && row.bytes !== info.size) throw new NoteError('uncertain');
      if (!row) this.db.prepare('INSERT INTO icloud_note_overlay_blob_catalog(hash, bytes, orphan_at) VALUES (?, ?, ?)').run(item, info.size, this.clock());
    }
    await this.syncDir(join(this.root, 'blobs'));
    this.db.prepare('UPDATE icloud_note_overlay_blob_catalog SET orphan_at = ? WHERE orphan_at IS NULL AND NOT EXISTS (SELECT 1 FROM icloud_note_overlay_blob_refs WHERE icloud_note_overlay_blob_refs.hash = icloud_note_overlay_blob_catalog.hash)').run(this.clock());
    for (const row of this.db.prepare('SELECT hash FROM icloud_note_overlay_blob_refs GROUP BY hash').all() as Array<{ hash: string }>) await this.loadBlob(row.hash);
    const generations = this.db.prepare('SELECT * FROM icloud_note_overlay_generations ORDER BY generation_id').all() as Array<{ generation_id: number; operation_id: string; mirror_id: string; path: string; parent_generation: number | null; superseded_by: number | null; hash: string; bytes: number; published_at: number; state: string; applied: string | null }>;
    const byGeneration = new Map(generations.map(g => [g.generation_id, g]));
    for (const generation of generations) {
      if (!Number.isSafeInteger(generation.generation_id) || generation.generation_id < 1 || !validOperation(generation.operation_id) || !validId(generation.mirror_id) || !['pending', 'applied', 'superseded', 'conflicted', 'retired', 'resolved', 'uncertain'].includes(generation.state) || !Number.isSafeInteger(generation.bytes) || generation.bytes < 0 || !Number.isSafeInteger(generation.published_at)) throw new NoteError('uncertain');
      validateNotePath(generation.path);
      const parent = generation.parent_generation === null ? null : byGeneration.get(generation.parent_generation);
      if (generation.parent_generation !== null && (!parent || parent.generation_id >= generation.generation_id || parent.mirror_id !== generation.mirror_id || parent.path !== generation.path)) throw new NoteError('uncertain');
      if (generation.superseded_by !== null && (!byGeneration.has(generation.superseded_by) || generation.superseded_by <= generation.generation_id)) throw new NoteError('uncertain');
      const referenced = this.db.prepare('SELECT 1 FROM icloud_note_overlay_blob_refs WHERE hash = ? LIMIT 1').get(generation.hash);
      if (referenced || ['pending', 'applied', 'conflicted', 'uncertain'].includes(generation.state)) {
        if (Buffer.byteLength(await this.loadBlob(generation.hash)) !== generation.bytes) throw new NoteError('uncertain');
      } else if (!/^[a-f0-9]{64}$/.test(generation.hash)) throw new NoteError('uncertain');
      if (generation.applied) { const applied = parse(generation.applied, appliedSchema); if (applied.generation !== generation.generation_id || applied.hash !== generation.hash) throw new NoteError('uncertain'); }
      if (!this.operation(generation.operation_id).save && !this.operation(generation.operation_id).resolution && (!['superseded', 'retired', 'resolved'].includes(generation.state) || this.clock() - issuedAt(generation.operation_id) <= NOTE_LIMITS.retentionMs)) throw new NoteError('uncertain');
    }
    const heads = this.db.prepare('SELECT * FROM icloud_note_overlay_heads').all() as Head[];
    for (const head of heads) {
      const generation = byGeneration.get(head.generation);
      if (!generation || generation.mirror_id !== head.mirror_id || generation.path !== head.path || generation.hash !== head.hash || generation.bytes !== head.bytes || !Number.isSafeInteger(head.queue_order) || head.queue_order < 1 || head.queue_order > head.generation || !Number.isSafeInteger(head.queued_at) || head.queued_at < 1 || head.queued_at > this.clock() + 300000) throw new NoteError('uncertain');
      if (!this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND kind = 'head' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(String(head.generation), head.mirror_id, head.hash, head.bytes)) throw new NoteError('uncertain');
      if (!validId(head.mirror_id)) throw new NoteError('uncertain'); validateNotePath(head.path);
      if (!Number.isSafeInteger(head.bytes) || head.bytes < 0 || Buffer.byteLength(await this.loadBlob(head.hash)) !== head.bytes || !Number.isSafeInteger(head.generation) || head.generation < 1) throw new NoteError('uncertain');
      parse(head.base, proofSchema); parse(head.copies, copiesSchema);
      if (head.applied) {
        const checkpoint = parse(head.applied, appliedSchema), applied = byGeneration.get(checkpoint.generation);
        if (!applied || checkpoint.generation > head.generation || applied.hash !== checkpoint.hash || applied.mirror_id !== head.mirror_id || applied.path !== head.path || applied.applied !== head.applied) throw new NoteError('uncertain');
        if (!this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND kind = 'checkpoint' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(String(checkpoint.generation), head.mirror_id, checkpoint.hash, applied.bytes)) throw new NoteError('uncertain');
      }
      if (head.journal) {
        const journal = parse(head.journal, journalSchema);
        if (journal.generation !== head.generation || journal.hash !== head.hash || !/^[a-f0-9-]{36}$/.test(journal.stage)) throw new NoteError('uncertain');
      }
      if (head.conflict) {
        const collision = parse(head.conflict, conflictSchema);
        if (collision.incomingHash) {
          const text = await this.loadBlob(collision.incomingHash);
          if (!this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND kind = 'incoming' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(collision.token, head.mirror_id, collision.incomingHash, Buffer.byteLength(text))) throw new NoteError('uncertain');
        }
      }
    }
    for (const ref of this.db.prepare('SELECT class, kind, owner, mirror_id, hash, bytes FROM icloud_note_overlay_blob_refs').all() as Array<{ class: string; kind: string; owner: string; mirror_id: string; hash: string; bytes: number }>) {
      if (!validId(ref.mirror_id) || !/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ![['pending', 'head'], ['pending', 'checkpoint'], ['pending', 'incoming'], ['recovery', 'receipt'], ['recovery', 'previous'], ['recovery', 'incoming-archive']].some(([cls, kind]) => cls === ref.class && kind === ref.kind)) throw new NoteError('uncertain');
      const catalog = this.db.prepare('SELECT bytes, orphan_at FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(ref.hash) as { bytes: number; orphan_at: number | null } | undefined;
      if (!catalog || catalog.bytes !== ref.bytes || catalog.orphan_at !== null) throw new NoteError('uncertain');
    }
    const archived = this.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number };
    if (archived.count > INCOMING_ARCHIVE_LIMIT) throw new NoteError('uncertain');
    for (const row of this.db.prepare('SELECT * FROM icloud_note_overlay_incoming_archive').all() as Array<{ token: string; mirror_id: string; path: string; hash: string; bytes: number; captured_at: number; resolution_operation_id: string | null }>) {
      if (!z.string().uuid().safeParse(row.token).success || !validId(row.mirror_id) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(row.captured_at) || row.captured_at < 0 || row.captured_at > this.clock() + 300000) throw new NoteError('uncertain');
      validateNotePath(row.path);
      if (row.resolution_operation_id && (!validOperation(row.resolution_operation_id) || !this.db.prepare('SELECT 1 FROM icloud_note_overlay_resolutions WHERE operation_id = ? AND mirror_id = ? AND path = ?').get(row.resolution_operation_id, row.mirror_id, row.path))) throw new NoteError('uncertain');
      if (Buffer.byteLength(await this.loadBlob(row.hash)) !== row.bytes || !this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND kind = 'incoming-archive' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(row.token, row.mirror_id, row.hash, row.bytes)) throw new NoteError('uncertain');
    }
    for (const ref of this.db.prepare("SELECT owner, mirror_id, hash, bytes FROM icloud_note_overlay_blob_refs WHERE kind = 'incoming-archive'").all() as Array<{ owner: string; mirror_id: string; hash: string; bytes: number }>) {
      if (!this.db.prepare('SELECT 1 FROM icloud_note_overlay_incoming_archive WHERE token = ? AND mirror_id = ? AND hash = ? AND bytes = ?').get(ref.owner, ref.mirror_id, ref.hash, ref.bytes)) throw new NoteError('uncertain');
    }
    for (const row of this.db.prepare('SELECT * FROM icloud_note_overlay_receipts').all() as Array<{ operation_id: string; mirror_id: string; path: string; hash: string; previous_hash: string | null }>) {
      if (!validOperation(row.operation_id) || !validId(row.mirror_id)) throw new NoteError('uncertain'); validateNotePath(row.path);
      const content = await this.loadBlob(row.hash);
      if (!this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND kind = 'receipt' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(row.operation_id, row.mirror_id, row.hash, Buffer.byteLength(content))) throw new NoteError('uncertain');
      if (row.previous_hash) {
        const previous = this.db.prepare('SELECT hash, bytes FROM icloud_note_overlay_recovery WHERE operation_id = ?').get(row.operation_id) as { hash: string; bytes: number } | undefined;
        if (!previous || previous.hash !== row.previous_hash || Buffer.byteLength(await this.loadBlob(previous.hash)) !== previous.bytes || !this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND kind = 'previous' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(row.operation_id, row.mirror_id, previous.hash, previous.bytes)) throw new NoteError('uncertain');
      }
    }
    for (const row of this.db.prepare('SELECT * FROM icloud_note_overlay_resolutions').all() as Array<{ operation_id: string; mirror_id: string; path: string; hash: string | null; at: string }>) {
      if (!Number.isFinite(Date.parse(row.at)) || !validOperation(row.operation_id) || !validId(row.mirror_id)) throw new NoteError('uncertain'); validateNotePath(row.path);
      if (row.hash) {
        const size = Buffer.byteLength(await this.loadBlob(row.hash));
        if (!this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND kind = 'receipt' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(row.operation_id, row.mirror_id, row.hash, size)) throw new NoteError('uncertain');
      }
      const previous = this.db.prepare('SELECT hash, bytes FROM icloud_note_overlay_recovery WHERE operation_id = ?').get(row.operation_id) as { hash: string; bytes: number } | undefined;
      if (!previous || Buffer.byteLength(await this.loadBlob(previous.hash)) !== previous.bytes || !this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND kind = 'previous' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(row.operation_id, row.mirror_id, previous.hash, previous.bytes)) throw new NoteError('uncertain');
    }
    for (const previous of this.db.prepare('SELECT operation_id, hash, bytes FROM icloud_note_overlay_recovery').all() as Array<{ operation_id: string; hash: string; bytes: number }>) {
      const saved = this.db.prepare('SELECT previous_hash AS hash FROM icloud_note_overlay_receipts WHERE operation_id = ?').get(previous.operation_id) as { hash: string | null } | undefined;
      const resolution = this.db.prepare('SELECT 1 FROM icloud_note_overlay_resolutions WHERE operation_id = ?').get(previous.operation_id);
      if ((!saved && !resolution) || (saved && saved.hash !== previous.hash) || !Number.isSafeInteger(previous.bytes) || previous.bytes < 0) throw new NoteError('uncertain');
    }
    // Unreferenced stage files are not authoritative; never delete referenced
    // journals or incoming/recovery bytes as cleanup during admission.
    const stages = new Set(heads.filter(h => h.journal).map(h => parse(h.journal!, journalSchema).stage));
    for (const item of await readdir(join(this.root, 'stages'))) {
      if (!/^[a-f0-9-]{36}$/.test(item)) throw new NoteError('uncertain');
      if (!stages.has(item)) await unlink(join(this.root, 'stages', item));
    }
    await this.syncDir(join(this.root, 'stages'));
  }
  private validText(text: unknown): text is string {
    return typeof text === 'string' && Buffer.byteLength(text) <= NOTE_LIMITS.bytes && Buffer.from(text).toString('utf8') === text && !text.includes('\0');
  }
  private validate(input: CommitInput) {
    if (!input || typeof input !== 'object') throw new NoteError('invalid_path');
    validateNotePath(input.path);
    if (!validId(input.mirrorId) || !validOperation(input.operationId) || !['create', 'replace'].includes(input.kind) || (input.kind === 'create' ? input.expectedHash !== null : !/^[a-f0-9]{64}$/.test(input.expectedHash ?? '')) || !this.validText(input.text)) throw new NoteError('invalid_path');
  }
  private validateResolution(id: string, path: string, input: Resolution) {
    if (!validId(id) || !input || typeof input !== 'object') throw new NoteError('invalid_path');
    validateNotePath(path);
    if (!validOperation(input.operationId) || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedLogicalHash) || (input.expectedIncomingHash !== null && !/^[a-f0-9]{64}$/.test(input.expectedIncomingHash)) || !['keep_local', 'accept_incoming', 'replace'].includes(input.choice) || (input.choice === 'replace' ? !this.validText(input.text) : input.text !== undefined)) throw new NoteError('invalid_path');
  }
  private digest(input: CommitInput) { return sha(JSON.stringify([input.mirrorId, input.path, input.operationId, input.kind, input.expectedHash, input.text])); }
  // Migration runs only after native generation ownership and before v2
  // publications. Existing old receipt/recovery directories are never removed.
  async indexLegacy(id: string, root: string) {
    if (!validId(id)) throw new NoteError('invalid_path');
    if (this.db.prepare('SELECT mirror_id FROM icloud_note_overlay_legacy_admission WHERE mirror_id = ?').get(id)) return;
    const records = await this.mirror.legacyRecords(id, root);
    try {
      this.db.transaction(() => {
        for (const { receipt, kind, requestDigest, uncertain, previousBytes } of records) {
          if (this.operation(receipt.operationId).save || this.operation(receipt.operationId).resolution) throw new NoteError('uncertain');
          const existing = this.db.prepare('SELECT receipt FROM icloud_note_overlay_legacy WHERE operation_id = ?').get(receipt.operationId) as { receipt: string } | undefined;
          if (existing && existing.receipt !== JSON.stringify(receipt)) throw new NoteError('uncertain');
          const inserted = this.db.prepare('INSERT OR IGNORE INTO icloud_note_overlay_legacy(operation_id, mirror_id, path, kind, expected_hash, hash, request_digest, receipt, uncertain, previous_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(receipt.operationId, id, receipt.path, kind, receipt.previousHash, receipt.hash, requestDigest, JSON.stringify(receipt), Number(uncertain), previousBytes);
          if (inserted.changes) this.db.prepare('UPDATE icloud_note_overlay_totals SET receipts = receipts + 1, receipt_bytes = receipt_bytes + ?, recovery_bytes = recovery_bytes + ? WHERE id = 1').run(Buffer.byteLength(JSON.stringify(receipt)), previousBytes);
        }
        this.db.prepare('INSERT INTO icloud_note_overlay_legacy_admission(mirror_id) VALUES (?)').run(id);
      })();
    } catch (error) { throw translate(error); }
  }
  private requireIndexed(id: string) {
    if (!this.db.prepare('SELECT mirror_id FROM icloud_note_overlay_legacy_admission WHERE mirror_id = ?').get(id)) throw new NoteError('uncertain');
  }
  private ref(cls: 'pending' | 'recovery', kind: string, owner: string, mirrorId: string, hash: string, bytes: number, add: boolean) {
    const global = (this.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_blob_refs WHERE class = ? AND hash = ?').get(cls, hash) as { count: number }).count;
    const vault = cls === 'pending' ? (this.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_blob_refs WHERE class = ? AND hash = ? AND mirror_id = ?').get(cls, hash, mirrorId) as { count: number }).count : 0;
    if (add) {
      const registered = this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(hash) as { bytes: number } | undefined;
      if (registered && registered.bytes !== bytes) throw new NoteError('uncertain');
      if (!registered) this.db.prepare('INSERT INTO icloud_note_overlay_blob_catalog(hash, bytes) VALUES (?, ?)').run(hash, bytes);
      else this.db.prepare('UPDATE icloud_note_overlay_blob_catalog SET orphan_at = NULL WHERE hash = ?').run(hash);
      const inserted = this.db.prepare('INSERT INTO icloud_note_overlay_blob_refs(class, kind, owner, mirror_id, hash, bytes) VALUES (?, ?, ?, ?, ?, ?)').run(cls, kind, owner, mirrorId, hash, bytes);
      if (!inserted.changes) throw new NoteError('uncertain');
      if (cls === 'pending') {
        if (!global) this.db.prepare("UPDATE icloud_note_overlay_usage SET bytes = bytes + ? WHERE scope = '*'").run(bytes);
        if (!vault) this.db.prepare('UPDATE icloud_note_overlay_usage SET bytes = bytes + ? WHERE scope = ?').run(bytes, mirrorId);
      } else if (!global) this.db.prepare('UPDATE icloud_note_overlay_totals SET recovery_bytes = recovery_bytes + ? WHERE id = 1').run(bytes);
    } else {
      const removed = this.db.prepare('DELETE FROM icloud_note_overlay_blob_refs WHERE class = ? AND kind = ? AND owner = ? AND mirror_id = ? AND hash = ?').run(cls, kind, owner, mirrorId, hash).changes;
      if (!removed) throw new NoteError('uncertain');
      if (cls === 'pending') {
        if (global === 1) this.db.prepare("UPDATE icloud_note_overlay_usage SET bytes = bytes - ? WHERE scope = '*'").run(bytes);
        if (vault === 1) this.db.prepare('UPDATE icloud_note_overlay_usage SET bytes = bytes - ? WHERE scope = ?').run(bytes, mirrorId);
      } else if (global === 1) this.db.prepare('UPDATE icloud_note_overlay_totals SET recovery_bytes = recovery_bytes - ? WHERE id = 1').run(bytes);
      const left = this.db.prepare('SELECT 1 FROM icloud_note_overlay_blob_refs WHERE hash = ? LIMIT 1').get(hash);
      if (!left) this.db.prepare('UPDATE icloud_note_overlay_blob_catalog SET orphan_at = ? WHERE hash = ?').run(this.clock(), hash);
    }
  }
  // Must run inside the same transaction that releases the live incoming ref.
  // A distinct incoming version consumes the separate 64 MiB recovery budget;
  // existing recovery references to identical bytes are counted only once.
  private archiveIncoming(id: string, path: string, conflict: Conflict, resolutionId: string | null = null) {
    if (!conflict.incomingHash) return;
    const bytes = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(conflict.incomingHash) as { bytes: number } | undefined)?.bytes;
    if (bytes === undefined || !this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND kind = 'incoming' AND owner = ? AND mirror_id = ? AND hash = ? AND bytes = ?").get(conflict.token, id, conflict.incomingHash, bytes)) throw new NoteError('uncertain');
    const already = this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'recovery' AND hash = ? LIMIT 1").get(conflict.incomingHash);
    const total = this.db.prepare('SELECT recovery_bytes FROM icloud_note_overlay_totals WHERE id = 1').get() as { recovery_bytes: number };
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM icloud_note_overlay_incoming_archive').get() as { count: number };
    if (count.count >= INCOMING_ARCHIVE_LIMIT || (!already && total.recovery_bytes + bytes > NOTE_LIMITS.recoveryBytes)) throw new NoteError('capacity');
    this.db.prepare('INSERT INTO icloud_note_overlay_incoming_archive(token, mirror_id, path, hash, bytes, captured_at, resolution_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conflict.token, id, path, conflict.incomingHash, bytes, this.clock(), resolutionId);
    this.ref('recovery', 'incoming-archive', conflict.token, id, conflict.incomingHash, bytes, true);
  }
  private reserve(id: string, mirrorId: string, hash: string | null, bytes: number, paths: number, recoveryHash: string | null, recovery: number, receiptBytes: number, receiptHash: string | null, receiptContentBytes: number) {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO icloud_note_overlay_usage(scope, paths, bytes) VALUES (?, 0, 0)').run(mirrorId);
      const global = this.db.prepare("SELECT * FROM icloud_note_overlay_usage WHERE scope = '*'").get() as { paths: number; bytes: number; staged_paths: number };
      const vault = this.db.prepare('SELECT * FROM icloud_note_overlay_usage WHERE scope = ?').get(mirrorId) as typeof global;
      const totals = this.db.prepare('SELECT * FROM icloud_note_overlay_totals WHERE id = 1').get() as { receipts: number; receipt_bytes: number; recovery_bytes: number; staged_receipts: number; staged_receipt_bytes: number };
      const has = (cls: string, value: string, mirror?: string) => !!this.db.prepare(`SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = ? AND hash = ?${mirror ? ' AND mirror_id = ?' : ''} LIMIT 1`).get(cls, value, ...(mirror ? [mirror] : []));
      const recoveryAdded = new Map<string, number>();
      if (recoveryHash && !has('recovery', recoveryHash)) recoveryAdded.set(recoveryHash, recovery);
      if (receiptHash && !has('recovery', receiptHash)) recoveryAdded.set(receiptHash, receiptContentBytes);
      if (global.paths + global.staged_paths + paths > 256 || vault.paths + vault.staged_paths + paths > 128 || global.bytes + (hash && !has('pending', hash) ? bytes : 0) > 64 * 1024 * 1024 || vault.bytes + (hash && !has('pending', hash, mirrorId) ? bytes : 0) > 16 * 1024 * 1024 || totals.receipts + totals.staged_receipts >= 32768 || totals.receipt_bytes + totals.staged_receipt_bytes + receiptBytes > 64 * 1024 * 1024 || totals.recovery_bytes + [...recoveryAdded.values()].reduce((a, b) => a + b, 0) > 64 * 1024 * 1024) throw new NoteError('capacity');
      this.db.prepare('INSERT INTO icloud_note_overlay_reservations(operation_id, mirror_id, hash, bytes, paths, receipt_bytes, recovery_hash, recovery_bytes, receipt_hash, receipt_content_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, mirrorId, hash, bytes, paths, receiptBytes, recoveryHash, recovery, receiptHash, receiptContentBytes);
      if (hash) this.ref('pending', 'reservation', id, mirrorId, hash, bytes, true);
      if (recoveryHash) this.ref('recovery', 'reservation-previous', id, mirrorId, recoveryHash, recovery, true);
      if (receiptHash) this.ref('recovery', 'reservation-receipt', id, mirrorId, receiptHash, receiptContentBytes, true);
      this.db.prepare('UPDATE icloud_note_overlay_usage SET staged_paths = staged_paths + ? WHERE scope IN (?, ?)').run(paths, '*', mirrorId);
      this.db.prepare('UPDATE icloud_note_overlay_totals SET staged_receipts = staged_receipts + 1, staged_receipt_bytes = staged_receipt_bytes + ? WHERE id = 1').run(receiptBytes);
    })();
  }
  private release(id: string) {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM icloud_note_overlay_reservations WHERE operation_id = ?').get(id) as { mirror_id: string; hash: string | null; paths: number; bytes: number; receipt_bytes: number; recovery_hash: string | null; recovery_bytes: number; receipt_hash: string | null; receipt_content_bytes: number } | undefined;
      if (!row) return;
      if (row.hash) this.ref('pending', 'reservation', id, row.mirror_id, row.hash, row.bytes, false);
      if (row.recovery_hash) this.ref('recovery', 'reservation-previous', id, row.mirror_id, row.recovery_hash, row.recovery_bytes, false);
      if (row.receipt_hash) this.ref('recovery', 'reservation-receipt', id, row.mirror_id, row.receipt_hash, row.receipt_content_bytes, false);
      this.db.prepare('DELETE FROM icloud_note_overlay_reservations WHERE operation_id = ?').run(id);
      this.db.prepare('UPDATE icloud_note_overlay_usage SET staged_paths = staged_paths - ? WHERE scope IN (?, ?)').run(row.paths, '*', row.mirror_id);
      this.db.prepare('UPDATE icloud_note_overlay_totals SET staged_receipts = staged_receipts - 1, staged_receipt_bytes = staged_receipt_bytes - ? WHERE id = 1').run(row.receipt_bytes);
    })();
  }
  // Bounded private maintenance. The generation owner calls this on idle wake;
  // it never requires the native command queue. A protected candidate is deferred
  // instead of starving all later eligible records.
  async maintain(limit = 128) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new NoteError('invalid_path');
    const now = this.clock(), cutoff = now - NOTE_LIMITS.retentionMs - 1, deadline = performance.now() + 200;
    if (!Number.isSafeInteger(now)) throw new NoteError('unavailable');
    let examined = 0, generations = 0, receipts = 0, blobs = 0;
    const budget = () => examined < limit && performance.now() < deadline;
    const expired = (id: string) => now - issuedAt(id) > NOTE_LIMITS.retentionMs;
    const eligible = (id: string) => {
      const generation = this.db.prepare('SELECT generation_id, state FROM icloud_note_overlay_generations WHERE operation_id = ?').get(id) as { generation_id: number; state: string } | undefined;
      return !generation || (['superseded', 'retired', 'resolved'].includes(generation.state) && !this.db.prepare('SELECT 1 FROM icloud_note_overlay_heads WHERE generation = ? LIMIT 1').get(generation.generation_id) && !this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE kind = 'checkpoint' AND owner = ? LIMIT 1").get(String(generation.generation_id)));
    };
    const genRows = this.db.prepare("SELECT generation_id, operation_id FROM icloud_note_overlay_generations WHERE state IN ('superseded','retired','resolved') AND published_at < ? AND (checked_at IS NULL OR checked_at < ?) ORDER BY published_at, generation_id LIMIT ?").all(cutoff, now - 60000, limit) as Array<{ generation_id: number; operation_id: string }>;
    for (const row of genRows) {
      if (!budget()) break; examined++;
      const pinned = this.db.prepare('SELECT 1 FROM icloud_note_overlay_heads WHERE generation = ? LIMIT 1').get(row.generation_id) || this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE kind = 'checkpoint' AND owner = ? LIMIT 1").get(String(row.generation_id));
      if (!expired(row.operation_id) || pinned) { this.db.prepare('UPDATE icloud_note_overlay_generations SET checked_at = ? WHERE generation_id = ?').run(now, row.generation_id); continue; }
      generations += this.db.transaction(() => {
        // These history links are not active ownership proofs. Compact an
        // expired intermediate version without retaining an endless chain
        // behind a still-pending descendant; checkpoint refs remain pinned.
        this.db.prepare('UPDATE icloud_note_overlay_generations SET parent_generation = NULL WHERE parent_generation = ?').run(row.generation_id);
        this.db.prepare('UPDATE icloud_note_overlay_generations SET superseded_by = NULL WHERE superseded_by = ?').run(row.generation_id);
        return this.db.prepare('DELETE FROM icloud_note_overlay_generations WHERE generation_id = ?').run(row.generation_id).changes;
      })();
    }
    const saved = this.db.prepare('SELECT * FROM icloud_note_overlay_receipts WHERE at < ? AND (checked_at IS NULL OR checked_at < ?) ORDER BY at LIMIT ?').all(new Date(cutoff).toISOString(), now - 60000, limit - examined) as Array<{ operation_id: string; mirror_id: string; path: string; digest: string; hash: string; previous_hash: string | null; outcome: string; quota_bytes: number }>;
    for (const row of saved) {
      if (!budget()) break; examined++;
      if (!expired(row.operation_id) || row.outcome === 'uncertain' || !eligible(row.operation_id)) { this.db.prepare('UPDATE icloud_note_overlay_receipts SET checked_at = ? WHERE operation_id = ?').run(now, row.operation_id); continue; }
      this.db.transaction(() => {
        const size = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(row.hash) as { bytes: number }).bytes;
        this.ref('recovery', 'receipt', row.operation_id, row.mirror_id, row.hash, size, false);
        const old = this.db.prepare('SELECT hash, bytes FROM icloud_note_overlay_recovery WHERE operation_id = ?').get(row.operation_id) as { hash: string; bytes: number } | undefined;
        if (old) { this.ref('recovery', 'previous', row.operation_id, row.mirror_id, old.hash, old.bytes, false); this.db.prepare('DELETE FROM icloud_note_overlay_recovery WHERE operation_id = ?').run(row.operation_id); }
        this.db.prepare('DELETE FROM icloud_note_overlay_receipts WHERE operation_id = ?').run(row.operation_id);
        this.db.prepare('UPDATE icloud_note_overlay_totals SET receipts = receipts - 1, receipt_bytes = receipt_bytes - ? WHERE id = 1').run(row.quota_bytes);
      })(); receipts++;
    }
    const resolved = this.db.prepare('SELECT * FROM icloud_note_overlay_resolutions WHERE (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at, operation_id LIMIT ?').all(now - 60000, limit - examined) as Array<{ operation_id: string; mirror_id: string; path: string; digest: string; hash: string | null; quota_bytes: number }>;
    for (const row of resolved) {
      if (!budget()) break; examined++;
      if (!expired(row.operation_id) || !eligible(row.operation_id)) { this.db.prepare('UPDATE icloud_note_overlay_resolutions SET checked_at = ? WHERE operation_id = ?').run(now, row.operation_id); continue; }
      this.db.transaction(() => {
        if (row.hash) { const size = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(row.hash) as { bytes: number }).bytes; this.ref('recovery', 'receipt', row.operation_id, row.mirror_id, row.hash, size, false); }
        const old = this.db.prepare('SELECT hash, bytes FROM icloud_note_overlay_recovery WHERE operation_id = ?').get(row.operation_id) as { hash: string; bytes: number } | undefined;
        if (old) { this.ref('recovery', 'previous', row.operation_id, row.mirror_id, old.hash, old.bytes, false); this.db.prepare('DELETE FROM icloud_note_overlay_recovery WHERE operation_id = ?').run(row.operation_id); }
        this.db.prepare('UPDATE icloud_note_overlay_incoming_archive SET resolution_operation_id = NULL WHERE resolution_operation_id = ?').run(row.operation_id);
        this.db.prepare('DELETE FROM icloud_note_overlay_resolutions WHERE operation_id = ?').run(row.operation_id);
        this.db.prepare('UPDATE icloud_note_overlay_totals SET receipts = receipts - 1, receipt_bytes = receipt_bytes - ? WHERE id = 1').run(row.quota_bytes);
      })(); receipts++;
    }
    const archives = this.db.prepare('SELECT token, mirror_id, path, hash, bytes FROM icloud_note_overlay_incoming_archive WHERE captured_at < ? ORDER BY captured_at, token LIMIT ?').all(cutoff, limit - examined) as Array<{ token: string; mirror_id: string; path: string; hash: string; bytes: number }>;
    for (const row of archives) {
      if (!budget()) break; examined++;
      // The current conflict and its readers cannot lose their only incoming
      // reference. Old captures expire after 30 days, even if a receipt lives on.
      const active = this.head(row.mirror_id, row.path)?.conflict;
      if (active && parse(active, conflictSchema).token === row.token) continue;
      this.db.transaction(() => {
        this.ref('recovery', 'incoming-archive', row.token, row.mirror_id, row.hash, row.bytes, false);
        this.db.prepare('DELETE FROM icloud_note_overlay_incoming_archive WHERE token = ?').run(row.token);
      })();
    }
    const orphans = this.db.prepare('SELECT hash, bytes FROM icloud_note_overlay_blob_catalog WHERE orphan_at IS NOT NULL AND orphan_at <= ? ORDER BY orphan_at, hash LIMIT ?').all(now, limit - examined) as Array<{ hash: string; bytes: number }>;
    for (const row of orphans) {
      if (!budget()) break; examined++;
      await this.locked('blob', row.hash, async () => {
        if (this.db.prepare('SELECT 1 FROM icloud_note_overlay_blob_refs WHERE hash = ? LIMIT 1').get(row.hash)) return;
        const path = join(this.root, 'blobs', row.hash);
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size !== row.bytes || info.nlink !== 1) throw new NoteError('uncertain');
          // Reservation/publication also takes this per-hash barrier before
          // inserting a reference, so no new owner can appear after this test.
          if (this.db.prepare('SELECT 1 FROM icloud_note_overlay_blob_refs WHERE hash = ? LIMIT 1').get(row.hash)) return;
          await unlink(path); await this.syncDir(join(this.root, 'blobs'));
        } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw translate(error); }
        this.db.prepare('DELETE FROM icloud_note_overlay_blob_catalog WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM icloud_note_overlay_blob_refs WHERE hash = ?)').run(row.hash, row.hash);
        blobs++;
      });
    }
    return { examined, generations, receipts, blobs };
  }
  private expiry(id: string) {
    if (this.clock() - issuedAt(id) > NOTE_LIMITS.retentionMs || issuedAt(id) > this.clock() + 300000) throw new NoteError('operation_expired');
  }
  private operation(id: string) {
    const save = this.db.prepare('SELECT digest FROM icloud_note_overlay_receipts WHERE operation_id = ?').get(id) as { digest: string } | undefined;
    const resolution = this.db.prepare('SELECT digest, outcome, hash FROM icloud_note_overlay_resolutions WHERE operation_id = ?').get(id) as { digest: string; outcome: 'saved_locally_pending_sync' | 'adopted_content' | 'adopted_absence'; hash: string | null } | undefined;
    const legacy = this.db.prepare('SELECT mirror_id, path, kind, expected_hash, hash, receipt, uncertain FROM icloud_note_overlay_legacy WHERE operation_id = ?').get(id) as { mirror_id: string; path: string; kind: string; expected_hash: string | null; hash: string; receipt: string; uncertain: number } | undefined;
    if (Number(!!save) + Number(!!resolution) + Number(!!legacy) > 1) throw new NoteError('uncertain');
    return { save, resolution, legacy };
  }
  async receipt(id: string): Promise<NoteReceipt | null> {
    const row = this.db.prepare('SELECT * FROM icloud_note_overlay_receipts WHERE operation_id = ?').get(id) as any;
    if (row) return { operationId: row.operation_id, mirrorId: row.mirror_id, path: row.path, at: row.at, outcome: row.outcome, hash: row.hash, previousHash: row.previous_hash };
    const old = this.db.prepare('SELECT receipt FROM icloud_note_overlay_legacy WHERE operation_id = ?').get(id) as { receipt: string } | undefined;
    return old ? parse(old.receipt, receiptSchema) : null;
  }
  async read(root: string, id: string, path: string) {
    validateNotePath(path); if (!validId(id)) throw new NoteError('invalid_path');
    // A retirement/resolution/GC turn must not remove the captured head's
    // immutable bytes between lookup and opening the blob.
    return this.locked(id, path, async () => {
      const row = this.head(id, path);
      if (!row) return this.mirror.read(root, path);
      return { text: await this.loadBlob(row.hash), hash: row.hash, readAt: new Date(this.clock()).toISOString(), complete: true as const };
    });
  }
  async list(root: string, id: string) {
    const listed = await this.mirror.list(root);
    const paths = new Set(listed.paths);
    for (const row of this.db.prepare('SELECT path FROM icloud_note_overlay_heads WHERE mirror_id = ?').all(id) as Array<{ path: string }>) paths.add(validateNotePath(row.path));
    return { ...listed, paths: [...paths].sort().slice(0, NOTE_LIMITS.entries), incomplete: listed.incomplete || paths.size > NOTE_LIMITS.entries };
  }
  async commit(root: string, input: CommitInput, signal?: AbortSignal): Promise<NoteReceipt> {
    this.validate(input);
    // Fixed order: operation identity, then path, then synchronous quota SQL.
    // An unrelated operation ID never waits for another note's fsync.
    return this.locked('operation', input.operationId, () => this.locked(input.mirrorId, input.path, async () => {
      try {
        if (signal?.aborted) throw new NoteError('cancelled');
        this.requireIndexed(input.mirrorId);
        const existing = this.operation(input.operationId);
        if (existing.resolution) throw new NoteError('operation_reused');
        if (existing.legacy) {
          const old = existing.legacy;
          if (old.mirror_id !== input.mirrorId || old.path !== input.path || old.kind !== input.kind || old.expected_hash !== input.expectedHash || old.hash !== sha(input.text)) throw new NoteError('operation_reused');
          return parse(old.receipt, receiptSchema);
        }
        if (existing.save) { if (existing.save.digest !== this.digest(input)) throw new NoteError('operation_reused'); return (await this.receipt(input.operationId))!; }
        this.expiry(input.operationId);
        const previous = this.head(input.mirrorId, input.path);
        if (previous?.journal || this.db.prepare('SELECT operation_id FROM icloud_note_overlay_legacy WHERE mirror_id = ? AND path = ? AND uncertain = 1 LIMIT 1').get(input.mirrorId, input.path)) throw new NoteError('uncertain');
        const current = previous ? { text: await this.loadBlob(previous.hash), hash: previous.hash } : await this.mirror.observe(root, input.path);
        if (input.kind === 'create' ? current !== null : current?.hash !== input.expectedHash) throw new NoteError('conflict');
        const nextBytes = Buffer.byteLength(input.text);
        const recoveryBytes = current ? Buffer.byteLength(current.text) : 0;
        const receiptReservation = 2048 + Buffer.byteLength(input.path);
        await this.locked('blob', sha(input.text), async () => { this.reserve(input.operationId, input.mirrorId, sha(input.text), nextBytes, previous ? 0 : 1, current?.hash ?? null, recoveryBytes, receiptReservation, sha(input.text), nextBytes); });
        // All file writes precede the durable atomic head/receipt pointer. A
        // crash before this transaction cannot acknowledge a mutation.
        const hash = await this.blob(input.text);
        if (current) await this.blob(current.text);
        const copies = previous?.copies ?? JSON.stringify(copiesOf(await this.mirror.conflictCopies(root, input.path)));
        if (signal?.aborted) throw new NoteError('cancelled');
        await this.fault?.('before_head');
        const at = new Date(this.clock()).toISOString();
        const receipt: NoteReceipt = { operationId: input.operationId, mirrorId: input.mirrorId, path: input.path, at, outcome: 'saved_locally_pending_sync', hash, previousHash: current?.hash ?? null };
        this.db.transaction(() => {
          if (this.operation(input.operationId).resolution || this.operation(input.operationId).legacy) throw new NoteError('operation_reused');
          this.admission?.(input.mirrorId);
          const inserted = this.db.prepare('INSERT INTO icloud_note_overlay_generations(operation_id, mirror_id, path, parent_generation, hash, bytes, published_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.operationId, input.mirrorId, input.path, previous?.generation ?? null, hash, nextBytes, this.clock(), previous?.conflict ? 'conflicted' : 'pending');
          const next = Number(inserted.lastInsertRowid);
          if (previous) this.db.prepare("UPDATE icloud_note_overlay_generations SET superseded_by = ?, state = CASE WHEN state = 'applied' THEN state ELSE 'superseded' END WHERE generation_id = ?").run(next, previous.generation);
          const base = previous?.base ?? JSON.stringify(proof(current as Observation));
          const oldConflict = previous?.conflict ? parse(previous.conflict, conflictSchema) : null;
          const collision = oldConflict ? { ...oldConflict, token: randomUUID() } : null;
          if (oldConflict?.incomingHash && collision?.incomingHash) {
            const size = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(collision.incomingHash) as { bytes: number }).bytes;
            this.ref('pending', 'incoming', collision.token, input.mirrorId, collision.incomingHash, size, true);
            this.ref('pending', 'incoming', oldConflict.token, input.mirrorId, oldConflict.incomingHash, size, false);
          }
          this.db.prepare('INSERT INTO icloud_note_overlay_heads(mirror_id, path, generation, hash, bytes, base, applied, journal, conflict, copies, queue_order, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(mirror_id, path) DO UPDATE SET generation = excluded.generation, hash = excluded.hash, bytes = excluded.bytes, conflict = excluded.conflict, queue_order = CASE WHEN json_extract(icloud_note_overlay_heads.applied, \'$.generation\') = icloud_note_overlay_heads.generation THEN excluded.queue_order ELSE icloud_note_overlay_heads.queue_order END, queued_at = CASE WHEN json_extract(icloud_note_overlay_heads.applied, \'$.generation\') = icloud_note_overlay_heads.generation THEN excluded.queued_at ELSE icloud_note_overlay_heads.queued_at END').run(input.mirrorId, input.path, next, hash, nextBytes, base, previous?.applied ?? null, collision && JSON.stringify(collision), copies, next, this.clock());
          this.db.prepare('INSERT INTO icloud_note_overlay_receipts(operation_id, mirror_id, path, digest, at, outcome, hash, previous_hash, quota_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(input.operationId, input.mirrorId, input.path, this.digest(input), at, receipt.outcome, hash, receipt.previousHash, this.digest(input).length + Buffer.byteLength(input.path) + input.mirrorId.length + 200);
          if (current) this.db.prepare('INSERT INTO icloud_note_overlay_recovery(operation_id, hash, bytes) VALUES (?, ?, ?)').run(input.operationId, current.hash, recoveryBytes);
          this.ref('pending', 'head', String(next), input.mirrorId, hash, nextBytes, true);
          this.ref('recovery', 'receipt', input.operationId, input.mirrorId, hash, nextBytes, true);
          if (current) this.ref('recovery', 'previous', input.operationId, input.mirrorId, current.hash, recoveryBytes, true);
          if (previous) this.ref('pending', 'head', String(previous.generation), input.mirrorId, previous.hash, previous.bytes, false);
          this.release(input.operationId);
          this.db.prepare('UPDATE icloud_note_overlay_usage SET paths = paths + ? WHERE scope IN (?, ?)').run(previous ? 0 : 1, '*', input.mirrorId);
          this.db.prepare('UPDATE icloud_note_overlay_totals SET receipts = receipts + 1, receipt_bytes = receipt_bytes + ? WHERE id = 1').run(this.digest(input).length + Buffer.byteLength(input.path) + input.mirrorId.length + 200);
        })();
        await this.fault?.('after_head');
        return receipt;
      } catch (error) {
        try { this.release(input.operationId); } catch { throw new NoteError('uncertain'); }
        throw translate(error);
      }
    }));
  }
  private async recover(root: string, id: string, path: string, row: Head): Promise<Head> {
    if (!row.journal) return row;
    const journal = parse(row.journal, journalSchema);
    const observed = await this.mirror.observe(root, path);
    if (observed && observed.info.dev === journal.stageDev && observed.info.ino === journal.stageIno && observed.hash === journal.hash) {
      const durable = await this.mirror.provePublishedStage(root, path, { hash: journal.hash, info: { dev: journal.stageDev, ino: journal.stageIno } });
      const applied = JSON.stringify({ generation: journal.generation, ...proof(durable) });
      this.db.transaction(() => {
        const previous = row.applied ? parse(row.applied, appliedSchema) : null;
        this.ref('pending', 'checkpoint', String(journal.generation), id, journal.hash, Buffer.byteLength(durable.text), true);
        if (previous && previous.generation !== journal.generation) {
          const old = this.db.prepare('SELECT bytes FROM icloud_note_overlay_generations WHERE generation_id = ?').get(previous.generation) as { bytes: number };
          this.ref('pending', 'checkpoint', String(previous.generation), id, previous.hash, old.bytes, false);
        }
        this.db.prepare('UPDATE icloud_note_overlay_heads SET applied = ?, journal = NULL WHERE mirror_id = ? AND path = ? AND generation = ?').run(applied, id, path, row.generation);
        this.db.prepare("UPDATE icloud_note_overlay_generations SET applied = ?, state = 'applied' WHERE generation_id = ?").run(applied, journal.generation);
        if (previous && previous.generation !== journal.generation) this.db.prepare("UPDATE icloud_note_overlay_generations SET state = 'superseded' WHERE generation_id = ?").run(previous.generation);
      })();
      await unlink(join(this.root, 'stages', journal.stage)).catch(error => { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; });
      await this.syncDir(join(this.root, 'stages'));
      return this.head(id, path)!;
    }
    const stagePath = join(this.root, 'stages', journal.stage);
    try {
      const stage = await lstat(stagePath);
      if (stage.dev === journal.stageDev && stage.ino === journal.stageIno && same(proof(observed), journal.expected)) {
        // Prepared but never published. Clear the durable reference before
        // deleting its stage; a crash then leaves only a safe orphan.
        this.db.prepare('UPDATE icloud_note_overlay_heads SET journal = NULL WHERE mirror_id = ? AND path = ? AND generation = ? AND journal = ?').run(id, path, row.generation, row.journal);
        await unlink(stagePath); await this.syncDir(join(this.root, 'stages'));
        return this.head(id, path)!;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    throw new NoteError('uncertain');
  }
  private async collision(root: string, id: string, path: string, row: Head, observed: Observation, expected: Proof) {
    const copies = await this.mirror.conflictCopies(root, path);
    const baseline = parse(row.copies, copiesSchema);
    for (const old of baseline) {
      const existing = copies.find(copy => copy.side === old.side && copy.number === old.number);
      if (!existing || !same(proof(existing.observation), old.evidence)) throw new NoteError('uncertain');
    }
    const fresh = copies.filter(copy => !baseline.some(old => old.side === copy.side && old.number === copy.number));
    const remote = fresh.filter(copy => copy.side === 'icloud');
    let incoming = observed;
    let incomingCopyNumber: number | null = null;
    if (fresh.length) {
      const local = fresh.filter(copy => copy.side === 'bb');
      if (remote.length !== 1 || local.length !== 1 || remote[0].number !== local[0].number || local[0].observation.hash !== expected?.hash) throw new NoteError('uncertain');
      incoming = remote[0].observation;
      incomingCopyNumber = remote[0].number;
    }
    // Hold the hash fence through durable content publication AND its DB ref.
    const publish = async () => {
      if (incoming) await this.blobLocked(incoming.text);
      const record: Conflict = { token: randomUUID(), incomingHash: incoming?.hash ?? null, incoming: proof(incoming), canonical: proof(observed), incomingCopyNumber };
      this.db.transaction(() => {
      if (incoming) {
        const global = this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND hash = ? LIMIT 1").get(incoming.hash);
        const vault = this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND hash = ? AND mirror_id = ? LIMIT 1").get(incoming.hash, id);
        const usage = this.db.prepare("SELECT scope, bytes FROM icloud_note_overlay_usage WHERE scope IN ('*', ?)").all(id) as Array<{ scope: string; bytes: number }>;
        if (usage.some(item => item.bytes + ((item.scope === '*' ? global : vault) ? 0 : Buffer.byteLength(incoming.text)) > (item.scope === '*' ? 64 : 16) * 1024 * 1024)) throw new NoteError('capacity');
      }
      const changed = this.db.prepare('UPDATE icloud_note_overlay_heads SET conflict = ? WHERE mirror_id = ? AND path = ? AND generation = ? AND conflict IS NULL').run(JSON.stringify(record), id, path, row.generation).changes;
      if (changed) {
        if (incoming) this.ref('pending', 'incoming', record.token, id, incoming.hash, Buffer.byteLength(incoming.text), true);
        this.db.prepare("UPDATE icloud_note_overlay_generations SET state = 'conflicted' WHERE generation_id = ?").run(row.generation);
      }
      })();
    };
    if (incoming) await this.locked('blob', incoming.hash, publish);
    else await publish();
  }
  // Called exclusively from the native-idle application turn, never by a note RPC.
  async apply(root: string, id: string, path: string): Promise<'applied' | 'conflict' | 'idle'> {
    return this.locked(id, path, async () => {
      const original = this.head(id, path); if (!original) return 'idle';
      const row = await this.recover(root, id, path, original);
      if (row.conflict) return 'conflict';
      const checkpoint = row.applied ? parse(row.applied, appliedSchema) : null;
      const expected: Proof = checkpoint ? { hash: checkpoint.hash, info: checkpoint.info } : parse(row.base, proofSchema);
      let observed = await this.mirror.observe(root, path);
      if (!same(proof(observed), expected) || !sameCopies(copiesOf(await this.mirror.conflictCopies(root, path)), parse(row.copies, copiesSchema))) {
        // Capture bytes before publishing the token. A disappearing or unstable
        // incoming file is an error rather than fabricated absence.
        await this.collision(root, id, path, row, observed, expected);
        return 'conflict';
      }
      if (checkpoint?.generation === row.generation) return 'idle';
      const stage = randomUUID(); const content = await this.loadBlob(row.hash);
      const stagePath = join(this.root, 'stages', stage);
      await this.write(stagePath, content, 'apply_stage'); await this.syncDir(join(this.root, 'stages'));
      const info = await lstat(stagePath);
      const journal: Journal = { generation: row.generation, hash: row.hash, stage, stageDev: info.dev, stageIno: info.ino, expected };
      this.db.prepare('UPDATE icloud_note_overlay_heads SET journal = ? WHERE mirror_id = ? AND path = ? AND generation = ?').run(JSON.stringify(journal), id, path, row.generation);
      await this.fault?.('after_apply_journal');
      try { await this.mirror.publishStage(root, path, stagePath, expected); await this.fault?.('after_mirror_publish'); }
      catch (error) {
        // A genuine observed collision gets captured on a later turn; an
        // ambiguous publication remains journaled and blocks successors.
        const after = await this.mirror.observe(root, path);
        if (!same(proof(after), expected)) {
          const applied = after && after.info.dev === info.dev && after.info.ino === info.ino && after.hash === row.hash;
          if (!applied) throw new NoteError('uncertain');
        } else throw translate(error);
      }
      await this.recover(root, id, path, this.head(id, path)!);
      await this.fault?.('after_apply_checkpoint');
      return 'applied';
    });
  }
  pending(limit = 256): Array<{ mirrorId: string; path: string; queued: number }> {
    return (this.db.prepare('SELECT mirror_id, path, queue_order FROM icloud_note_overlay_heads WHERE conflict IS NULL AND (applied IS NULL OR json_extract(applied, \'$.generation\') != generation) ORDER BY queue_order, mirror_id, path LIMIT ?').all(limit) as Array<{ mirror_id: string; path: string; queue_order: number }>).map(row => ({ mirrorId: row.mirror_id, path: row.path, queued: row.queue_order }));
  }
  hasUnresolvedJournals(id: string) {
    return !!this.db.prepare('SELECT 1 FROM icloud_note_overlay_heads WHERE mirror_id = ? AND journal IS NOT NULL LIMIT 1').get(id);
  }
  pendingAgeMs(id?: string) {
    const row = this.db.prepare('SELECT MIN(queued_at) AS oldest FROM icloud_note_overlay_heads WHERE (? IS NULL OR mirror_id = ?)').get(id ?? null, id ?? null) as { oldest: number | null };
    return row.oldest === null ? null : Math.max(0, this.clock() - row.oldest);
  }
  async receipts(query: { mirrorId: string; operationId?: string; path?: string; since?: string; limit: number }) {
    if (!validId(query.mirrorId) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 || (query.operationId && !validOperation(query.operationId))) throw new NoteError('invalid_path');
    if (query.path) validateNotePath(query.path);
    if (query.since && !Number.isFinite(Date.parse(query.since))) throw new NoteError('invalid_path');
    const rows = this.db.prepare(`SELECT operation_id, mirror_id, path, at, outcome, hash, previous_hash FROM icloud_note_overlay_receipts WHERE mirror_id = ? AND (? IS NULL OR operation_id = ?) AND (? IS NULL OR path = ?) AND (? IS NULL OR at >= ?)
      UNION ALL SELECT operation_id, mirror_id, path, json_extract(receipt, '$.at'), json_extract(receipt, '$.outcome'), hash, json_extract(receipt, '$.previousHash') FROM icloud_note_overlay_legacy WHERE mirror_id = ? AND (? IS NULL OR operation_id = ?) AND (? IS NULL OR path = ?) AND (? IS NULL OR json_extract(receipt, '$.at') >= ?) ORDER BY at DESC, operation_id LIMIT ?`).all(query.mirrorId, query.operationId ?? null, query.operationId ?? null, query.path ?? null, query.path ?? null, query.since ?? null, query.since ?? null, query.mirrorId, query.operationId ?? null, query.operationId ?? null, query.path ?? null, query.path ?? null, query.since ?? null, query.since ?? null, query.limit) as Array<{ operation_id: string; mirror_id: string; path: string; at: string; outcome: NoteReceipt['outcome']; hash: string; previous_hash: string | null }>;
    const resolutions = this.db.prepare('SELECT operation_id, mirror_id, path, at, outcome, hash FROM icloud_note_overlay_resolutions WHERE mirror_id = ? AND (? IS NULL OR operation_id = ?) AND (? IS NULL OR path = ?) AND (? IS NULL OR at >= ?) ORDER BY at DESC, operation_id LIMIT ?').all(query.mirrorId, query.operationId ?? null, query.operationId ?? null, query.path ?? null, query.path ?? null, query.since ?? null, query.since ?? null, query.limit) as Array<{ operation_id: string; mirror_id: string; path: string; at: string; outcome: 'saved_locally_pending_sync' | 'adopted_content' | 'adopted_absence'; hash: string | null }>;
    return [...rows.map(row => ({ kind: 'save' as const, operationId: row.operation_id, mirrorId: row.mirror_id, path: row.path, at: row.at, outcome: row.outcome, hash: row.hash, previousHash: row.previous_hash })), ...resolutions.map(row => ({ kind: 'resolution' as const, operationId: row.operation_id, mirrorId: row.mirror_id, path: row.path, at: row.at, outcome: row.outcome, hash: row.hash }))].sort((a, b) => b.at.localeCompare(a.at) || a.operationId.localeCompare(b.operationId)).slice(0, query.limit);
  }
  beforeRun(id: string) {
    // Called by the arbiter immediately before native invocation. A successor
    // published during that command cannot inherit this snapshot's evidence.
    return (this.db.prepare('SELECT path, generation, applied FROM icloud_note_overlay_heads WHERE mirror_id = ? AND applied IS NOT NULL AND conflict IS NULL AND journal IS NULL').all(id) as Array<{ path: string; generation: number; applied: string }>).map(row => {
      const checkpoint = parse(row.applied, appliedSchema);
      if (checkpoint.generation > row.generation) throw new NoteError('uncertain');
      // The native command can observe only the applied predecessor, not a
      // successor that has been saved locally but has not reached the mirror.
      return { ...row, generation: checkpoint.generation };
    });
  }
  async afterRun(root: string, id: string, eligible: ReturnType<NoteOverlay['beforeRun']>, succeeded: boolean) {
    let retired = 0;
    for (const candidate of eligible) await this.locked(id, candidate.path, async () => {
      const row = this.head(id, candidate.path);
      if (!row || row.applied !== candidate.applied || row.conflict || row.journal) return;
      const checkpoint = parse(candidate.applied, appliedSchema);
      const observed = await this.mirror.observe(root, candidate.path);
      const expected: Proof = { hash: checkpoint.hash, info: checkpoint.info };
      if (!same(proof(observed), expected) || !sameCopies(copiesOf(await this.mirror.conflictCopies(root, candidate.path)), parse(row.copies, copiesSchema))) {
        await this.collision(root, id, candidate.path, row, observed, expected); return;
      }
      if (!succeeded || row.generation !== candidate.generation) return;
      await this.fault?.('before_retirement');
      retired += this.db.transaction(() => {
        const deleted = this.db.prepare('DELETE FROM icloud_note_overlay_heads WHERE mirror_id = ? AND path = ? AND generation = ? AND applied = ? AND conflict IS NULL AND journal IS NULL').run(id, candidate.path, candidate.generation, candidate.applied).changes;
        if (deleted) {
          this.ref('pending', 'head', String(row.generation), id, row.hash, row.bytes, false);
          this.ref('pending', 'checkpoint', String(checkpoint.generation), id, checkpoint.hash, row.bytes, false);
          this.db.prepare('UPDATE icloud_note_overlay_usage SET paths = paths - 1 WHERE scope IN (?, ?)').run('*', id);
          this.db.prepare("UPDATE icloud_note_overlay_generations SET state = 'retired' WHERE generation_id = ?").run(row.generation);
        }
        return deleted;
      })();
      await this.fault?.('after_retirement');
    });
    return retired;
  }
  // Two bounded stable observations, not a native-command turn. The baseline
  // and the selected pair remain historical evidence; only one genuinely new
  // numbered pair may supersede a captured incoming copy.
  private async incomingEvidence(root: string, path: string, row: Head, captured: Conflict) {
    const observe = async () => ({ canonical: await this.mirror.observe(root, path), copies: await this.mirror.conflictCopies(root, path) });
    const first = await observe(), second = await observe();
    if (!same(proof(first.canonical), proof(second.canonical)) || !sameCopies(copiesOf(first.copies), copiesOf(second.copies))) throw new NoteError('conflict');
    const baseline = parse(row.copies, copiesSchema);
    for (const old of baseline) {
      const found = first.copies.find(copy => copy.side === old.side && copy.number === old.number);
      if (!found || !same(proof(found.observation), old.evidence)) throw new NoteError('uncertain');
    }
    const priorNumber = captured.incomingCopyNumber;
    const selected = priorNumber === null ? null : first.copies.find(copy => copy.side === 'icloud' && copy.number === priorNumber);
    if (priorNumber !== null && !selected) throw new NoteError('uncertain');
    const fresh = first.copies.filter(copy => !baseline.some(old => old.side === copy.side && old.number === copy.number) && copy.number !== priorNumber);
    let incoming = selected?.observation ?? first.canonical;
    let number = priorNumber;
    if (fresh.length) {
      const remote = fresh.filter(copy => copy.side === 'icloud'), local = fresh.filter(copy => copy.side === 'bb');
      const checkpoint = row.applied ? parse(row.applied, appliedSchema) : null;
      const expected = checkpoint?.hash ?? parse(row.base, proofSchema)?.hash;
      if (fresh.length !== 2 || remote.length !== 1 || local.length !== 1 || remote[0].number !== local[0].number || local[0].observation.hash !== expected) throw new NoteError('uncertain');
      incoming = remote[0].observation; number = remote[0].number;
    }
    // A disappearing canonical file does not prove remote absence when an
    // earlier preserved remote copy remains. Without a selected fresh pair,
    // its relationship to this change is uncertain, not an absent version.
    if (!incoming && captured.incomingHash !== null && first.copies.some(copy => copy.side === 'icloud')) throw new NoteError('uncertain');
    return { canonical: proof(first.canonical), incoming, number, copies: copiesOf(first.copies) };
  }
  async inspect(id: string, path: string, ownedRoot?: string) {
    if (!validId(id)) throw new NoteError('invalid_path'); validateNotePath(path);
    return this.locked(id, path, async () => {
      const row = this.head(id, path); if (!row?.conflict) return null;
      const captured = parse(row.conflict, conflictSchema);
      if (ownedRoot) {
        const observed = await this.incomingEvidence(ownedRoot, path, row, captured);
        const changed = !same(observed.canonical, captured.canonical) || !same(proof(observed.incoming), captured.incoming) || observed.number !== captured.incomingCopyNumber;
        if (changed) {
          const publish = async () => {
            if (observed.incoming) await this.blobLocked(observed.incoming.text);
            // An awaited blob fsync may overlap native publication. Never
            // publish a token for bytes that have already moved again.
            const latest = await this.incomingEvidence(ownedRoot, path, row, captured);
            if (!same(latest.canonical, observed.canonical) || !same(proof(latest.incoming), proof(observed.incoming)) || latest.number !== observed.number || !sameCopies(latest.copies, observed.copies)) throw new NoteError('conflict');
            const next: Conflict = { token: randomUUID(), canonical: observed.canonical, incoming: proof(observed.incoming), incomingHash: observed.incoming?.hash ?? null, incomingCopyNumber: observed.number };
            // A replaced numbered pair becomes historical evidence, not a
            // second candidate incoming pair on the next inspection/restart.
            const history = parse(row.copies, copiesSchema);
            if (captured.incomingCopyNumber !== null && observed.number !== captured.incomingCopyNumber) {
              const oldPair = observed.copies.filter(copy => copy.number === captured.incomingCopyNumber);
              if (oldPair.length !== 2 || !oldPair.some(copy => copy.side === 'icloud' && same(copy.evidence, captured.incoming))) throw new NoteError('uncertain');
              history.push(...oldPair);
            }
            this.db.transaction(() => {
              this.admission?.(id);
              if (this.head(id, path)?.conflict !== row.conflict) throw new NoteError('conflict');
              // Reserve archival capacity before the old incoming token is
              // released. A failed transaction leaves the entire head intact.
              this.archiveIncoming(id, path, captured);
              if (observed.incoming) {
                const bytes = Buffer.byteLength(observed.incoming.text);
                const usage = this.db.prepare("SELECT scope, bytes FROM icloud_note_overlay_usage WHERE scope IN ('*', ?)").all(id) as Array<{ scope: string; bytes: number }>;
                for (const usageRow of usage) {
                  const exists = this.db.prepare("SELECT 1 FROM icloud_note_overlay_blob_refs WHERE class = 'pending' AND hash = ? AND (? = '*' OR mirror_id = ?) LIMIT 1").get(observed.incoming.hash, usageRow.scope, id);
                  if (usageRow.bytes + (exists ? 0 : bytes) > (usageRow.scope === '*' ? 64 : 16) * 1024 * 1024) throw new NoteError('capacity');
                }
                this.ref('pending', 'incoming', next.token, id, observed.incoming.hash, bytes, true);
              }
              if (captured.incomingHash) {
                const bytes = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(captured.incomingHash) as { bytes: number }).bytes;
                this.ref('pending', 'incoming', captured.token, id, captured.incomingHash, bytes, false);
              }
              this.db.prepare('UPDATE icloud_note_overlay_heads SET conflict = ?, copies = ? WHERE mirror_id = ? AND path = ? AND generation = ? AND conflict = ?').run(JSON.stringify(next), JSON.stringify(history), id, path, row.generation, row.conflict);
            })();
          };
          if (observed.incoming) await this.locked('blob', observed.incoming.hash, publish);
          else await publish();
        }
      }
      const current = this.head(id, path)!;
      const conflict = parse(current.conflict!, conflictSchema);
      return { token: conflict.token, logicalHash: current.hash, incomingHash: conflict.incomingHash, incomingAbsent: conflict.incomingHash === null };
    });
  }
  async readIncoming(id: string, path: string, token: string): Promise<string | null> {
    if (!validId(id)) throw new NoteError('invalid_path'); validateNotePath(path);
    return this.locked(id, path, async () => {
      const row = this.head(id, path); if (!row?.conflict) throw new NoteError('conflict');
      const conflict = parse(row.conflict, conflictSchema); if (conflict.token !== token) throw new NoteError('conflict');
      return conflict.incomingHash ? this.loadBlob(conflict.incomingHash) : null;
    });
  }
  async resolve(root: string, id: string, path: string, input: Resolution): Promise<{ outcome: 'saved_locally_pending_sync' | 'adopted_content' | 'adopted_absence'; hash: string | null }> {
    this.validateResolution(id, path, input);
    return this.locked('operation', input.operationId, () => this.locked(id, path, async () => {
      this.requireIndexed(id);
      const request = sha(JSON.stringify([id, path, input]));
      const prior = this.operation(input.operationId);
      if (prior.save || prior.legacy) throw new NoteError('operation_reused');
      if (prior.resolution) { if (prior.resolution.digest !== request) throw new NoteError('operation_reused'); return { outcome: prior.resolution.outcome, hash: prior.resolution.hash }; }
      this.expiry(input.operationId);
      const row = this.head(id, path); if (!row?.conflict) throw new NoteError('conflict');
      const conflict = parse(row.conflict, conflictSchema);
      if (conflict.token !== input.token || row.hash !== input.expectedLogicalHash || conflict.incomingHash !== input.expectedIncomingHash) throw new NoteError('conflict');
      const observation = await this.incomingEvidence(root, path, row, conflict);
      if (!same(observation.canonical, conflict.canonical) || !same(proof(observation.incoming), conflict.incoming) || observation.number !== conflict.incomingCopyNumber) throw new NoteError('conflict');
      const adoptedMirror = input.choice === 'accept_incoming' && conflict.incomingCopyNumber === null;
      let hash: string | null = input.choice === 'replace' ? sha(input.text!) : input.choice === 'keep_local' ? row.hash : conflict.incomingHash;
      const nextBytes = adoptedMirror ? 0 : hash === row.hash ? row.bytes : hash ? input.choice === 'replace' ? Buffer.byteLength(input.text!) : Buffer.byteLength(await this.loadBlob(hash)) : 0;
      const receiptBytes = request.length + Buffer.byteLength(path) + id.length + 200;
      const incomingReceiptBytes = hash ? hash === row.hash ? row.bytes : input.choice === 'replace' ? Buffer.byteLength(input.text!) : (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(hash) as { bytes: number }).bytes : 0;
      if (hash) await this.locked('blob', hash, async () => { this.reserve(input.operationId, id, adoptedMirror ? null : hash, nextBytes, 0, row.hash, row.bytes, 2048 + Buffer.byteLength(path), hash, incomingReceiptBytes); });
      else this.reserve(input.operationId, id, null, 0, 0, row.hash, row.bytes, 2048 + Buffer.byteLength(path), null, 0);
      try {
        if (input.choice === 'replace') hash = await this.blob(input.text!);
        const receiptHashBytes = hash ? (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(hash) as { bytes: number } | undefined)?.bytes : 0;
        if (hash && receiptHashBytes === undefined) throw new NoteError('uncertain');
        const outcome = input.choice === 'accept_incoming' ? hash ? 'adopted_content' : 'adopted_absence' : 'saved_locally_pending_sync';
        await this.fault?.('before_resolution_head');
        // Last stable evidence boundary after every awaited preparation step.
        // No more awaited preparation occurs before the pointer transaction;
        // this is a bounded observation, not a native cloud-delivery proof.
        const final = await this.incomingEvidence(root, path, row, conflict);
        if (!same(final.canonical, conflict.canonical) || !same(proof(final.incoming), conflict.incoming) || final.number !== conflict.incomingCopyNumber || !sameCopies(final.copies, observation.copies)) throw new NoteError('conflict');
        this.db.transaction(() => {
          this.admission?.(id);
          if (this.operation(input.operationId).save || this.operation(input.operationId).legacy) throw new NoteError('operation_reused');
          this.archiveIncoming(id, path, conflict, input.operationId);
          let nextGeneration: number | null = null;
          if (adoptedMirror) {
            this.db.prepare('DELETE FROM icloud_note_overlay_heads WHERE mirror_id = ? AND path = ? AND generation = ? AND conflict = ?').run(id, path, row.generation, row.conflict);
            this.db.prepare("UPDATE icloud_note_overlay_generations SET state = 'resolved' WHERE generation_id = ?").run(row.generation);
          } else {
            const inserted = this.db.prepare('INSERT INTO icloud_note_overlay_generations(operation_id, mirror_id, path, parent_generation, hash, bytes, published_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.operationId, id, path, row.generation, hash, nextBytes, this.clock(), 'pending');
            const next = Number(inserted.lastInsertRowid); nextGeneration = next;
            this.db.prepare("UPDATE icloud_note_overlay_generations SET state = 'resolved', superseded_by = ? WHERE generation_id = ?").run(next, row.generation);
            this.db.prepare('UPDATE icloud_note_overlay_heads SET generation = ?, hash = ?, bytes = ?, base = ?, applied = NULL, conflict = NULL, copies = ?, queue_order = ?, queued_at = ? WHERE mirror_id = ? AND path = ? AND generation = ? AND conflict = ?').run(next, hash, nextBytes, JSON.stringify(final.canonical), JSON.stringify(final.copies), next, this.clock(), id, path, row.generation, row.conflict);
          }
          if (nextGeneration && hash) this.ref('pending', 'head', String(nextGeneration), id, hash, nextBytes, true);
          if (hash) this.ref('recovery', 'receipt', input.operationId, id, hash, receiptHashBytes!, true);
          this.ref('recovery', 'previous', input.operationId, id, row.hash, row.bytes, true);
          this.ref('pending', 'head', String(row.generation), id, row.hash, row.bytes, false);
          if (row.applied) {
            const checkpoint = parse(row.applied, appliedSchema);
            const checkpointBytes = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_generations WHERE generation_id = ?').get(checkpoint.generation) as { bytes: number }).bytes;
            this.ref('pending', 'checkpoint', String(checkpoint.generation), id, checkpoint.hash, checkpointBytes, false);
          }
          if (conflict.incomingHash) {
            const incomingBytes = (this.db.prepare('SELECT bytes FROM icloud_note_overlay_blob_catalog WHERE hash = ?').get(conflict.incomingHash) as { bytes: number }).bytes;
            this.ref('pending', 'incoming', conflict.token, id, conflict.incomingHash, incomingBytes, false);
          }
          this.release(input.operationId);
          this.db.prepare('UPDATE icloud_note_overlay_usage SET paths = paths - ? WHERE scope IN (?, ?)').run(Number(adoptedMirror), '*', id);
          this.db.prepare('INSERT INTO icloud_note_overlay_recovery(operation_id, hash, bytes) VALUES (?, ?, ?)').run(input.operationId, row.hash, row.bytes);
          this.db.prepare('INSERT INTO icloud_note_overlay_resolutions(operation_id, mirror_id, path, at, digest, outcome, hash, quota_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.operationId, id, path, new Date(this.clock()).toISOString(), request, outcome, hash, receiptBytes);
          this.db.prepare('UPDATE icloud_note_overlay_totals SET receipts = receipts + 1, receipt_bytes = receipt_bytes + ? WHERE id = 1').run(receiptBytes);
        })();
        return { outcome, hash };
      } catch (error) {
        try { this.release(input.operationId); } catch { throw new NoteError('uncertain'); }
        throw translate(error);
      }
    }));
  }
}
