import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SqliteRunHistory, HISTORY_MIGRATIONS } from '../adapters/run-history.ts';
import { historyQuerySchema, SyncDiagnostics } from '../core/diagnostics.ts';
import type { RunSummary } from '../core/diagnostics.ts';
const day = (days: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + days * 86400_000).toISOString();
function fixture(legacy?: unknown, budgets?: { successRows?: number; errorRows?: number; successBytes?: number; errorBytes?: number }) {
  const db = new Database(':memory:'); let imports = 0;
  const make = () => new SqliteRunHistory(() => db, d => { for (const sql of HISTORY_MIGRATIONS) d.exec(sql); }, async () => { imports++; return legacy; }, budgets);
  return { db, make, imports: () => imports };
}
function run(sequence: number, outcome: RunSummary['outcome'] = 'succeeded', finishedAt = day(0)): RunSummary {
  return { sequence, kind: 'sync', startedAt: finishedAt, finishedAt, durationMs: 10, outcome, failure: outcome === 'succeeded' ? null : outcome === 'interrupted' ? 'interrupted' : 'sync_failed', failureStage: outcome === 'failed' ? 'backing_up_cloud' : null, evidence: outcome === 'failed' ? { kind: 'command_exit', exitCode: 4 } : null, stages: [] };
}
async function append(repo: SqliteRunHistory, value: RunSummary) { await repo.begin({ sequence: value.sequence, kind: value.kind, startedAt: value.startedAt }); await repo.finish(value); await repo.prune(value.finishedAt); }
const query = (value = {}) => historyQuerySchema.parse(value);
test('SQLite history keeps errors through healthy traffic and applies separate seven/30-day expiry', async () => {
  const f = fixture(); const repo = f.make();
  try {
    await repo.load(); await append(repo, run(1, 'failed')); await append(repo, run(2, 'interrupted'));
    for (let i = 3; i <= 50; i++) await append(repo, run(i));
    assert.equal((await repo.read(query(), day(0))).runs.length, 20); assert.equal((await repo.read(query({ outcome: 'errors' }), day(0))).runs.length, 2);
    await repo.prune(day(8)); const errors = await repo.read(query(), day(8)); assert.deepEqual(errors.runs.map(r => r.sequence), [1, 2]); assert.deepEqual(errors.retained, { successes: 0, errors: 2 });
    await repo.prune(day(31)); assert.equal((await repo.read(query(), day(31))).runs.length, 0); assert.equal((await repo.load() as any).sequence, 50);
  } finally { f.db.close(); }
});
test('pages are bounded, cursor-stable and filterable without discarding older history', async () => {
  const f = fixture(); const repo = f.make();
  try {
    await repo.load(); for (let i = 1; i <= 70; i++) await append(repo, run(i, i % 10 === 0 ? 'failed' : 'succeeded'));
    const first = await repo.read(query(), day(0)); assert.deepEqual(first.runs.map(r => r.sequence), Array.from({ length: 20 }, (_, i) => i + 51)); assert.equal(first.nextBefore, 51);
    const second = await repo.read(query({ before: first.nextBefore }), day(0)); assert.equal(second.runs[0].sequence, 31); assert.equal(second.runs.at(-1)!.sequence, 50);
    const errors = await repo.read(query({ outcome: 'errors', limit: 100 }), day(0)); assert.deepEqual(errors.runs.map(r => r.sequence), [10, 20, 30, 40, 50, 60, 70]); assert.equal(errors.nextBefore, null); assert.deepEqual(errors.retained, { successes: 63, errors: 7 });
    assert.throws(() => query({ limit: 101 })); assert.throws(() => query({ before: -1 }));
  } finally { f.db.close(); }
});
test('valid legacy KV summaries and sequence migrate exactly once without changing their evidence', async () => {
  const legacy = { schema: 1, sequence: 2, active: null, runs: [run(1, 'failed'), run(2)] }; const f = fixture(legacy);
  try {
    const first = f.make(); assert.equal((await first.load() as any).sequence, 2); assert.deepEqual((await first.read(query(), day(0))).runs, legacy.runs); await append(first, run(3));
    const reloaded = f.make(); assert.equal((await reloaded.load() as any).sequence, 3); assert.equal((await reloaded.read(query(), day(0))).runs.length, 3); assert.equal(f.imports(), 1); assert.equal(legacy.runs.length, 2);
  } finally { f.db.close(); }
});
test('malformed legacy history is neither imported nor replaced with an empty successful store', async () => {
  const f = fixture({ secret: 'sentinel-private-content' });
  try { const repo = f.make(); await assert.rejects(repo.load()); assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_sync_history_meta').get() as any).count, 0); await assert.rejects(f.make().load()); }
  finally { f.db.close(); }
});
test('independent row and byte caps cannot let healthy runs evict failures', async () => {
  for (const budgets of [{ successRows: 3, errorRows: 2 }, { successBytes: 3 * Buffer.byteLength(JSON.stringify(run(30))), errorBytes: 2 * Buffer.byteLength(JSON.stringify(run(31, 'failed'))) }]) {
    const f = fixture(undefined, budgets); const repo = f.make();
    try {
      await repo.load(); await append(repo, run(1, 'failed')); await append(repo, run(2, 'failed'));
      for (let i = 3; i <= 30; i++) await append(repo, run(i));
      const page = await repo.read(query({ limit: 100 }), day(0)); assert.equal(page.retained.errors, 2); assert.ok(page.retained.successes <= 3); assert.ok(page.trimmed.successes > 0); assert.equal(page.trimmed.errors, 0);
      await append(repo, run(31, 'failed')); const capped = await repo.read(query({ outcome: 'errors' }), day(0)); assert.ok(capped.retained.errors <= 2); assert.ok(capped.trimmed.errors > 0);
    } finally { f.db.close(); }
  }
});
test('native completion is atomic when SQLite rejects its append', async () => {
  const f = fixture(); const repo = f.make();
  try {
    await repo.load(); const value = run(1); await repo.begin({ sequence: 1, kind: 'sync', startedAt: value.startedAt });
    f.db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON icloud_sync_runs BEGIN SELECT RAISE(ABORT, 'sentinel-private-storage-error'); END");
    await assert.rejects(repo.finish(value)); assert.equal((await repo.load() as any).active.sequence, 1); assert.equal((await repo.read(query(), day(0))).runs.length, 0);
  } finally { f.db.close(); }
});
test('legacy pending markers become interrupted rows and cannot be replaced by a late successful completion', async () => {
  const value = run(2); const f = fixture({ schema: 1, sequence: 2, active: { sequence: 2, kind: 'sync', startedAt: value.startedAt }, runs: [run(1)] }); const repo = f.make();
  try {
    const diagnostics = new SyncDiagnostics(repo, () => day(8), () => 0, () => {}); await diagnostics.start();
    const snapshot = await diagnostics.snapshot(); assert.equal(snapshot.active, null); assert.equal(snapshot.runs.length, 1); assert.equal(snapshot.runs[0].outcome, 'interrupted');
    await repo.finish(value); assert.equal((await repo.read(query(), day(8))).runs[0].outcome, 'interrupted');
  } finally { f.db.close(); }
});
test('malformed row reads are private, preserve the offending row and do not invent successful persistence', async () => {
  const f = fixture(); const repo = f.make(); const logs: unknown[] = [];
  try {
    await repo.load(); await append(repo, run(1)); const body = JSON.stringify({ ...run(1), providerText: 'sentinel-private-content' });
    f.db.prepare('UPDATE icloud_sync_runs SET body = ?, bytes = ? WHERE sequence = 1').run(body, Buffer.byteLength(body));
    const diagnostics = new SyncDiagnostics(repo, () => day(0), () => 0, (stage, failure) => logs.push({ stage, failure })); await diagnostics.start(); const result = await diagnostics.snapshot();
    assert.equal(result.persistent, false); assert.deepEqual(result.runs, []); assert.deepEqual(logs, [{ stage: 'history_read', failure: 'unavailable' }]); assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(logs), /sentinel|providerText/);
    await diagnostics.begin('sync'); await diagnostics.finish('succeeded', null, null, null);
    assert.equal((f.db.prepare('SELECT body FROM icloud_sync_runs WHERE sequence = 1').get() as { body: string }).body, body); assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM icloud_sync_runs').get() as { count: number }).count, 1);
  } finally { f.db.close(); }
});
test('many row summaries can exceed the KV size limit while each append and response remain small', async () => {
  const f = fixture(); const repo = f.make();
  try {
    await repo.load(); for (let i = 1; i <= 1600; i++) await append(repo, run(i));
    const total = f.db.prepare('SELECT SUM(bytes) AS bytes FROM icloud_sync_runs').get() as any; assert.ok(total.bytes > 256 * 1024);
    const page = await repo.read(query(), day(0)); assert.equal(page.runs.length, 20); assert.equal(page.retained.successes, 1600); assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16 * 1024);
  } finally { f.db.close(); }
});
