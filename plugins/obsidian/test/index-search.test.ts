import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import picomatch from 'picomatch';
import { VaultIndex } from '../core/vault-index.ts';
import { compilePathGlob } from '../core/path-glob.ts';
import { VaultSearch } from '../core/search.ts';
import { VaultError, type Catalog, type VaultFiles } from '../core/ports.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { CatalogFake, FilesFake } from './fakes.ts';

const matches = (glob: string, ...paths: string[]) => paths.filter(compilePathGlob(glob));
test('pathGlob uses whole, case-sensitive vault-relative POSIX paths, including dotfiles', () => {
  const notes = ['Projects/A.md', 'Projects/.Hidden.md', 'Projects/Nested/A.md', 'Archive/A.md', 'projectS/A.md', 'A.md'];
  assert.deepEqual(matches('Projects/*.md', ...notes), notes.slice(0, 2));
  assert.deepEqual(matches('Projects/**/*.md', ...notes), notes.slice(0, 3));
  assert.deepEqual(matches('**/A.md', ...notes), notes.filter(path => path.endsWith('/A.md') || path === 'A.md'));
  assert.deepEqual(matches('{Projects,Archive}/[A-Z]?.md', 'Projects/A1.md', 'Projects/.A.md', 'Archive/Bz.md', 'Archive/Ba.mo'), ['Projects/A1.md', 'Archive/Bz.md']);
  assert.deepEqual(matches('Projects/[!A].md', 'Projects/A.md', 'Projects/B.md'), ['Projects/B.md']);
  assert.deepEqual(matches('2026: Notes/**/Agenda: July.md', '2026: Notes/Agenda: July.md'), ['2026: Notes/Agenda: July.md']);
  assert.deepEqual(matches('A ("Other")|X.md', 'A ("Other")|X.md', 'A Other.md'), ['A ("Other")|X.md']);
  const unicodePath = '😀.md';
  for (const glob of ['?.md', '??.md', '[😀].md', '😀.md'])
    assert.equal(compilePathGlob(glob)(unicodePath), picomatch(glob, { dot: true, posix: true, literalBrackets: false })(unicodePath));
  assert.equal(compilePathGlob('?.md')(unicodePath), false);
  assert.equal(compilePathGlob('??.md')(unicodePath), true);
  assert.equal(compilePathGlob('Projects/**/*.md').mayMatchBelow('Archive'), false);
  assert.equal(compilePathGlob('Projects/**/Note.md').mayMatchBelow('Projects/Nested'), true);
  for (const malformed of ['', '/tmp/*.md', 'C:/notes/*.md', 'a\\b', 'a/../b', './*.md', '!**/*.md', 'x//y', '[abc', 'a}', '{a,b', 'a/*\n.md', 'a*/', 'a*(b).md', '*a*b*c*.md', 'a'.repeat(257)]) {
    assert.throws(() => compilePathGlob(malformed), (error: unknown) => error instanceof VaultError && error.category === 'invalid_query', malformed);
  }
});

function fixture() {
  const live = new FilesFake(), catalog = new CatalogFake().value as Catalog;
  live.configuration = { revision: 1, vaultIds: ['one', 'legacy'] };
  catalog.sources.push({ ...catalog.sources[0], id: 'legacy' });
  catalog.filesystem = { one: 'ready', legacy: 'legacy_pending' };
  catalog.mirrorDirectoryGrantVersion = 1;
  let releases = 0, indexReads = 0, checks = 0, now = 0;
  const calls: Parameters<VaultFiles['search']>[0][] = [];
  const port: VaultFiles = Object.assign(live, {
    async index() {
      indexReads++;
      return { view: { directories: [''], omissions: [], notes: [
        { path: 'A.md', hash: 'hash', readAt: 'observed', properties: { due: null, open: true, rank: 2, tags: ['x'] } },
        { path: 'B.md', hash: 'hash', readAt: 'observed', properties: { open: 'true', rank: '2', tags: ['x'] } },
      ] }, async check() { checks++; }, assertValid() {}, close() { releases++; } };
    },
    search: ((original) => async (request: Parameters<VaultFiles['search']>[0]) => { calls.push(request); return original(request); })(live.search.bind(live)),
  });
  live.notes.clear(); live.notes.set('one/A.md', '---\nopen: true\n---\nneedle #tag/child');
  live.notes.set('one/B.md', 'needle #tag/child');
  live.notes.set('legacy/L.md', '---\nopen: true\n---\nneedle #tag');
  const search = new VaultSearch(port, new MarkdownNotes(), randomUUID, () => now, () => {},
    async (vaultId?: string) => ({ revision: 1, ids: vaultId ? [vaultId] : ['one', 'legacy'], catalog }), () => {});
  return { search, catalog, calls, port, reads: () => indexReads, stats: () => ({ releases, checks }), advance(ms: number) { now += ms; } };
}

test('index queries do not depend on rg; scalar filters match typed own values, with legacy glob omissions explicit', async t => {
  const f = fixture(); t.after(() => f.search.stop());
  f.catalog.search = { version: 1, available: false, reason: 'missing_executable' };
  const native = await f.search.search({ vaultId: 'one', pathGlob: '*.md', properties: [{ key: 'due', equals: null }, { key: 'open', equals: true }, { key: 'rank', equals: 2 }] });
  assert.deepEqual(native.results.map(row => row.path), ['A.md']); assert.equal(native.totalMatches, 1);
  const multi = await f.search.search({ pathGlob: '*.md', mode: 'count' });
  assert.equal(multi.matchedNotesSoFar, 2); assert.equal(multi.totalMatches, null);
  assert.deepEqual(multi.failures, [{ vaultId: 'legacy', category: 'unsupported' }]);
  const filtersOnly = await f.search.search({ vaultId: 'one', properties: [{ key: 'tags', equals: 'x' }] });
  assert.equal(filtersOnly.totalMatches, 0); assert.equal(f.calls.length, 0);
});

test('mixed text and tag search stays live, with a glob applied only to direct hits', async t => {
  const f = fixture(); t.after(() => f.search.stop());
  const live = await f.search.search({ text: 'needle', tag: 'tag', pathGlob: 'A.md', properties: [{ key: 'open', equals: true }] });
  assert.deepEqual(live.results.map(row => row.path), ['A.md']);
  assert.equal(f.reads(), 0); assert.equal(live.totalMatches, null);
  assert.ok(f.calls.length > 0 && f.calls.every(call => call.mirrorId === 'one' && !Object.hasOwn(call, 'pathGlob')));
  const legacy = await f.search.search({ vaultId: 'legacy', properties: [{ key: 'open', equals: true }] });
  assert.equal(legacy.totalMatches, 1); assert.ok(f.calls.some(call => call.mirrorId === 'legacy'));
});

test('cursor TTL reclaims pinned generations without another query; continuations bind pathGlob', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(); t.after(() => f.search.stop());
  const first = await f.search.search({ vaultId: 'one', pathGlob: '*.md', limit: 1 });
  assert.ok(first.nextCursor); assert.deepEqual(f.stats(), { releases: 0, checks: 1 });
  await assert.rejects(f.search.search({ cursor: first.nextCursor, pathGlob: 'B.md' }), (e: any) => e.category === 'invalid_query');
  f.advance(300_001); t.mock.timers.tick(330_000);
  assert.deepEqual(f.stats(), { releases: 1, checks: 1 });
  await assert.rejects(f.search.search({ cursor: first.nextCursor }), (e: any) => e.category === 'cursor_expired');
});

test('unsupported live lane does not discard indexed progress from a mixed query', async t => {
  const f = fixture(); t.after(() => f.search.stop());
  const live = f.port.search.bind(f.port);
  f.port.search = (request, signal) => {
    if (request.mirrorId === 'legacy') return Promise.reject(new VaultError('unsupported'));
    return live(request, signal);
  };
  const result = await f.search.search({ properties: [{ key: 'open', equals: true }], mode: 'count' });
  assert.equal(result.matchedNotesSoFar, 1);
  assert.equal(result.totalMatches, null);
  assert.equal(result.coverage.state, 'partial');
  assert.deepEqual(result.failures, [{ vaultId: 'legacy', category: 'unsupported' }]);
});

test('multi-vault page cannot commit A rows after its lease is revoked during B authorization', async t => {
  const f = fixture(), catalog = f.catalog;
  catalog.sources = ['A', 'B'].map(id => ({ ...catalog.sources[0], id }));
  catalog.filesystem = { A: 'ready', B: 'ready' };
  let entered!: () => void, resume!: () => void, b = 0;
  const blocker = new Promise<void>(resolve => { resume = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const actor = (id: string, authorize: () => Promise<void>) => new VaultIndex(async () => ({
    view: { notes: [{ path: `${id}.md`, hash: 'hash', readAt: 'time', properties: {} }], directories: [''], omissions: [] }, release() {},
  }), authorize, error => error);
  const lanes = new Map([['A', actor('A', async () => {})], ['B', actor('B', async () => { if (++b === 2) { entered(); await blocker; } })]]);
  f.port.index = (id, _revision, signal) => lanes.get(id)!.acquire(signal);
  const search = new VaultSearch(f.port, new MarkdownNotes(), randomUUID, Date.now, () => {}, async () => ({ revision: 1, ids: ['A', 'B'], catalog }), () => {});
  t.after(async () => { resume(); await search.stop(); await Promise.all([...lanes.values()].map(lane => lane.stop())); });
  const response = search.search({ pathGlob: '*.md' });
  const rejected = assert.rejects(response, (e: any) => e.category === 'source_unavailable');
  await reached;
  await lanes.get('A')!.stop(new VaultError('source_unavailable')); resume();
  await rejected;
});
