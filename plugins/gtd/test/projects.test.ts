import test from 'node:test';
import assert from 'node:assert/strict';
import { Projects } from '../core/projects.ts';
import { GtdError } from '../core/model.ts';
import type { ProjectBackend, ProjectSnapshot } from '../core/model.ts';
const signal = () => new AbortController().signal;
export function snapshot(): ProjectSnapshot { return {
  source: { backend: 'fake', id: 'test', name: 'Example', scope: 'Projects', observedAt: '2026-01-01T00:00:00Z', lastSuccessfulSync: null, sync: null },
  projects: [{ id: 'b', title: 'Zulu', status: 'active' }, { id: 'a', title: 'Alpha', status: 'active' }, { id: 'c', title: 'Alpha', status: 'done' }], complete: true, warnings: [],
}; }
function setup(value = snapshot()) {
  let reads = 0, key = 'first', now = 0, allowed = true;
  const backend: ProjectBackend = { async readProjects() { reads++; return structuredClone(value); }, async checkAccess() { if (!allowed) throw new GtdError('source_unavailable'); } };
  const service = new Projects(async () => ({ key, backend }), () => now);
  return { service, get reads() { return reads; }, set key(v: string) { key = v; }, set now(v: number) { now = v; }, set allowed(v: boolean) { allowed = v; } };
}
test('independent backend returns all statuses and accurate counts in one call, preserving duplicate titles', async () => {
  const f = setup(); const page = await f.service.list({}, signal(), 'reader');
  assert.equal(f.reads, 1); assert.equal(page.totalProjects, 3); assert.equal(page.matchedProjects, 3); assert.equal(page.nextCursor, null);
  assert.deepEqual(page.projects.map(p => p.id), ['a', 'b', 'c']); assert.deepEqual(page.counts, { active: 2, deferred: 0, someday: 0, done: 1 });
});
test('filtered pagination is stable, consumes tokens once, and never rereads the backend', async () => {
  const f = setup(); const first = await f.service.list({ status: 'active', limit: 1 }, signal(), 'reader');
  assert.equal(first.matchedProjects, 2); const cursor = first.nextCursor!;
  await assert.rejects(f.service.list({ cursor, status: 'done' }, signal(), 'reader'), /cursor/);
  await assert.rejects(f.service.list({ cursor }, signal(), 'other-reader'), /cursor/);
  const last = await f.service.list({ cursor }, signal(), 'reader'); assert.equal(last.projects.length, 1); assert.equal(last.nextCursor, null); assert.equal(f.reads, 1);
  await assert.rejects(f.service.list({ cursor }, signal(), 'reader'), /cursor/);
});
test('partial sources and duplicate IDs never claim totals', async () => {
  const data = snapshot(); data.projects.push(data.projects[0]);
  const page = await setup(data).service.list({}, signal(), 'reader');
  assert.equal(page.coverage, 'partial'); assert.equal(page.totalProjects, null); assert.equal(page.matchedProjects, null); assert.equal(page.counts, null); assert.deepEqual(page.warnings, ['duplicate_id']); assert.equal(page.projects.length, 3);
});
test('source revocation, configuration changes, idle expiry, and disposal invalidate continuation', async () => {
  for (const reason of ['access', 'config', 'expiry', 'stop']) {
    const f = setup(); const { nextCursor: cursor } = await f.service.list({ limit: 1 }, signal(), 'reader');
    if (reason === 'access') f.allowed = false;
    if (reason === 'config') f.key = 'next';
    if (reason === 'expiry') f.now = 300001;
    if (reason === 'stop') f.service.stop();
    await assert.rejects(f.service.list({ cursor: cursor! }, signal(), 'reader'), GtdError);
  }
});
test('UTF-8 output cap pages without dropping or duplicating projects', async () => {
  const data = snapshot(); data.projects = Array.from({ length: 200 }, (_, i) => ({ id: String(i) + 'x'.repeat(900), title: '例'.repeat(240), status: 'active' }));
  const f = setup(data); let page = await f.service.list({}, signal(), 'reader'); let ids: string[] = [];
  do { assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48000); ids.push(...page.projects.map(p => p.id)); if (!page.nextCursor) break; page = await f.service.list({ cursor: page.nextCursor }, signal(), 'reader'); } while (true);
  assert.equal(ids.length, 200); assert.equal(new Set(ids).size, 200); assert.equal(f.reads, 1);
});
test('bounded concurrent listings and cancellation fail closed', async () => {
  const f = setup(); for (let i = 0; i < 4; i++) await f.service.list({ limit: 1 }, signal(), 'reader');
  await assert.rejects(f.service.list({}, signal(), 'reader'), /capacity/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(setup().service.list({}, abort.signal, 'reader'), /cancelled/);
});
