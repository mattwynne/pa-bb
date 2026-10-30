import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink, link, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { RcloneTrace } from '../adapters/rclone-trace.ts';
import { RCLONE_LOG_LIMITS, projectRcloneRecord, traceSnapshotSchema } from '../core/rclone-trace.ts';
import type { TraceEntry } from '../core/rclone-trace.ts';

const commandId = '11111111-1111-4111-8111-111111111111';
const entry = (elapsedMs = 0): TraceEntry => ({ at: '2026-01-01T00:00:00.000Z', commandId, elapsedMs, event: 'command_start', timeoutMs: 1200000 });
const limits = { fileBytes: 1024, files: 4, queueRecords: 8, recordBytes: 512 };
async function fixture() {
  const root = await mkdtemp('/tmp/icloud-trace-'); const directory = join(root, 'logs');
  return { root, directory, close: () => rm(root, { recursive: true, force: true }) };
}
test('rclone records retain only fixed categories, native components and validated counters', () => {
  const projected = projectRcloneRecord({
    level: 'error', source: 'backend/iclouddrive/iclouddrive.go:435', msg: 'PRIVATE_SENTINEL https://user:secret@example.test/request?token=secret HTTP error 503: i/o timeout',
    object: 'PRIVATE_SENTINEL.md', token: 'PRIVATE_SENTINEL', error: { cause: 'PRIVATE_SENTINEL' },
    stats: { bytes: 42, totalBytes: 100, errors: 3, checks: 8, totalChecks: 100, transferring: [{ name: 'PRIVATE_SENTINEL' }], checking: ['PRIVATE_SENTINEL'], lastError: 'PRIVATE_SENTINEL', speed: 1.5, elapsedTime: 12.25, retryError: true, fatalError: false },
  });
  assert.deepEqual(projected, { event: 'stats', level: 'error', component: 'icloud', line: 435, stats: { bytes: 42, totalBytes: 100, checks: 8, totalChecks: 100, errors: 3, speed: 1.5, elapsedTime: 12.25, retryError: true, fatalError: false, checking: 1, transferring: 1 }, httpStatus: 503, category: 'timeout' });
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SENTINEL|https|secret|example|token|msg|object|lastError/);
  for (const [text, category] of [['connection reset by peer', 'connection_reset'], ['connection refused', 'connection_refused'], ['no such host', 'dns'], ['context deadline exceeded', 'timeout'], ['HTTP error 429', 'rate_limited'], ['trust token expired, please reauth', 'authentication'], ['unrecognized PRIVATE_SENTINEL', 'unknown']]) {
    assert.equal(projectRcloneRecord({ level: 'error', msg: text }).category, category);
  }
  for (const value of [-1, Infinity, NaN, 'PRIVATE_SENTINEL', Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(projectRcloneRecord({ level: 'PRIVATE_SENTINEL', source: 'PRIVATE_SENTINEL', msg: 'PRIVATE_SENTINEL', stats: { bytes: value, errors: value, speed: value, fatalError: value } }), { event: 'stats', component: 'unknown', stats: {} });
  }
  assert.deepEqual(projectRcloneRecord(null), { event: 'invalid_record' });
});
test('native activity and retry markers provide context without arbitrary messages', () => {
  assert.equal(projectRcloneRecord({ source: 'bisync/listing.go:10', msg: 'Reading current listings PRIVATE_SENTINEL' }).event, 'listing');
  assert.equal(projectRcloneRecord({ source: 'bisync/compare.go:10', msg: 'Comparing listings PRIVATE_SENTINEL' }).event, 'comparing');
  assert.equal(projectRcloneRecord({ msg: 'pacer: low level retry 2/10 PRIVATE_SENTINEL i/o timeout' }).event, 'retry');
  assert.equal(projectRcloneRecord({ level: 'error', msg: 'HTTP error 999 PRIVATE_SENTINEL' }).httpStatus, undefined);
});
test('private files rotate within a hard byte/count budget and survive a new logger', async () => {
  const f = await fixture(); const logger = new RcloneTrace(f.directory, undefined, limits);
  try {
    await logger.start();
    for (let i = 0; i < 80; i++) { logger.append(entry(i)); await logger.flush(); }
    const names = await readdir(f.directory);
    assert.equal(names.length, 4);
    for (const name of names) { const info = await stat(join(f.directory, name)); assert.ok(info.size <= limits.fileBytes); assert.equal(info.mode & 0o777, 0o600); }
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    const snapshot = traceSnapshotSchema.parse(await logger.snapshot(3));
    assert.equal(snapshot.available, true); assert.equal(snapshot.failure, null);
    assert.deepEqual(snapshot.entries.map(e => e.elapsedMs), [77, 78, 79]);
    await logger.stop();
    const next = new RcloneTrace(f.directory, undefined, limits); await next.start();
    assert.deepEqual((await next.snapshot(2)).entries.map(e => e.elapsedMs), [78, 79]);
    next.append(entry(80)); await next.flush(); assert.equal((await next.snapshot(1)).entries[0].elapsedMs, 80);
    await next.stop();
  } finally { await logger.stop(); await f.close(); }
});
test('queue flood remains bounded and reports dropped records rather than blocking native work', async () => {
  const f = await fixture(); const logger = new RcloneTrace(f.directory, undefined, limits);
  try {
    await logger.start();
    for (let i = 0; i < 10000; i++) logger.append(entry(i));
    const snapshot = await logger.snapshot();
    assert.ok(snapshot.queuedRecords <= limits.queueRecords); assert.ok(snapshot.droppedRecords > 0); assert.equal(snapshot.incomplete, true);
    await logger.flush();
    logger.append(entry(10001)); await logger.flush();
    assert.equal((await logger.snapshot(1)).entries[0].elapsedMs, 10001);
    for (const name of await readdir(f.directory)) assert.ok((await stat(join(f.directory, name))).size <= limits.fileBytes);
  } finally { await logger.stop(); await f.close(); }
});
test('strict persistence boundary rejects arbitrary fields, malformed and oversized entries', async () => {
  const f = await fixture(); const logger = new RcloneTrace(f.directory, undefined, limits);
  try {
    await logger.start();
    logger.append({ ...entry(), msg: 'PRIVATE_SENTINEL' } as any);
    logger.append({ ...entry(), commandId: 'PRIVATE_SENTINEL' });
    logger.record(commandId, 1, { msg: 'PRIVATE_SENTINEL', object: 'PRIVATE_SENTINEL.md', stats: { lastError: 'PRIVATE_SENTINEL' } });
    await logger.flush(); const snapshot = await logger.snapshot();
    assert.equal(snapshot.droppedRecords, 2); assert.equal(snapshot.entries.length, 1);
    assert.doesNotMatch(await readFile(join(f.directory, 'rclone.jsonl'), 'utf8'), /PRIVATE_SENTINEL/);
  } finally { await logger.stop(); await f.close(); }
});
test('capture failures warn once, never throw or retry a native operation, and expose unavailability', async () => {
  const f = await fixture(); let warnings = 0;
  const logger = new RcloneTrace(f.directory, () => { warnings++; throw new Error('PRIVATE_SENTINEL'); }, limits);
  try {
    await logger.start(); await rm(f.directory, { recursive: true }); await writeFile(f.directory, 'PRIVATE_SENTINEL');
    logger.append(entry()); await logger.flush(); logger.append(entry(1)); await logger.flush();
    assert.equal(warnings, 1);
    const result = await logger.snapshot(); assert.equal(result.available, false); assert.equal(result.failure, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  } finally { await logger.stop(); await f.close(); }
});
test('read-only snapshots do not create directories and never return corrupt/private bytes', async () => {
  const f = await fixture(); const logger = new RcloneTrace(f.directory, undefined, limits);
  try {
    assert.equal((await logger.snapshot()).available, false); assert.deepEqual(await readdir(f.root), []);
    await logger.start();
    await writeFile(join(f.directory, 'rclone.jsonl'), JSON.stringify({ ...entry(), msg: 'PRIVATE_SENTINEL' }) + '\nPRIVATE_SENTINEL', { mode: 0o600 });
    const result = await logger.snapshot(); assert.deepEqual(result.entries, []); assert.equal(result.incomplete, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  } finally { await logger.stop(); await f.close(); }
});
test('symlink, hardlink, oversized and publicly readable logs are refused without touching targets', async () => {
  for (const kind of ['symlink', 'hardlink', 'oversized', 'public'] as const) {
    const f = await fixture(); let warnings = 0; const logger = new RcloneTrace(f.directory, () => warnings++, limits);
    try {
      await mkdir(f.directory, { mode: 0o700 });
      const target = join(f.root, 'target'); const path = join(f.directory, 'rclone.jsonl');
      await writeFile(target, 'PRIVATE_SENTINEL', { mode: 0o600 });
      if (kind === 'symlink') await symlink(target, path);
      if (kind === 'hardlink') await link(target, path);
      if (kind === 'oversized') await writeFile(path, 'x'.repeat(limits.fileBytes + 1), { mode: 0o600 });
      if (kind === 'public') { await writeFile(path, 'PRIVATE_SENTINEL', { mode: 0o644 }); await chmod(path, 0o644); }
      await logger.start(); logger.append(entry()); await logger.flush();
      assert.equal(warnings, 1); assert.equal((await logger.snapshot()).available, false);
      assert.equal(await readFile(target, 'utf8'), 'PRIVATE_SENTINEL');
    } finally { await logger.stop(); await f.close(); }
  }
});
test('public defaults are four 1 MiB files and a bounded pending queue', () => {
  assert.equal(RCLONE_LOG_LIMITS.fileBytes * RCLONE_LOG_LIMITS.files, 4 * 1024 * 1024);
  assert.ok(RCLONE_LOG_LIMITS.queueRecords * RCLONE_LOG_LIMITS.recordBytes <= 1024 * 1024);
});
