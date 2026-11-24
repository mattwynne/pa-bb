import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { FilesystemIndex, INDEX_LIMITS } from '../adapters/filesystem-index.ts';
import { LocalNotes } from '../adapters/local-notes.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { diagnosticLogger } from '../adapters/diagnostic-log.ts';
import { abortError, IndexBudget, VaultIndex } from '../core/vault-index.ts';
import { VaultError } from '../core/ports.ts';
import { parseLinks } from '../core/vault-links.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const category = (expected: string) => (error: unknown) => error instanceof VaultError && error.category === expected;
const grantFor = async (directory: string) => {
  const info = await stat(directory, { bigint: true });
  return { directory, rootDev: info.dev.toString(), rootIno: info.ino.toString() };
};
async function eventually<T>(run: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = await run(); if (value !== undefined) return value;
    await delay(15);
  }
  throw new Error('Synthetic index did not reach the expected state');
}

test('actor waits cold, pins old generations during a refresh, serializes queued hints and releases retained bytes', async () => {
  const gates = Array.from({ length: 4 }, deferred), entered = Array.from({ length: 4 }, deferred);
  const scopes: unknown[] = [], released: number[] = [];
  const actor = new VaultIndex(async (_prior, paths) => {
    const run = scopes.length;
    scopes.push(paths ? [...paths] : null); entered[run].resolve(); await gates[run].promise;
    if (run === 2) throw new VaultError('conflict');
    return { view: { notes: [], directories: [String(run)], omissions: [] }, release: () => released.push(run) };
  }, async () => {}, error => error);
  const cold = actor.acquire(); await entered[0].promise;
  actor.hint('during startup'); gates[0].resolve();
  const old = await cold; assert.deepEqual(old.view.directories, ['0']);
  await entered[1].promise;
  assert.deepEqual((await actor.acquire()).view.directories, ['0']); // warm, not blocked by refresh
  actor.hint('A'); actor.hint('A'); actor.hint('B');
  assert.deepEqual(scopes, [null, ['during startup']]);
  gates[1].resolve(); await entered[2].promise;
  assert.deepEqual(scopes[2], ['A', 'B']);
  assert.deepEqual(old.view.directories, ['0']);
  gates[2].resolve();
  await eventually(async () => {
    try { (await actor.acquire()).close(); } catch (e) { if (category('conflict')(e)) return true; throw e; }
  });
  await old.check(); // old cursor survives a failed build while access is valid
  actor.hint('repair'); await entered[3].promise; assert.equal(scopes[3], null); gates[3].resolve();
  const current = await eventually(async () => {
    try { const value = await actor.acquire(); if (value.view.directories[0] === '3') return value; value.close(); }
    catch (e) { if (!category('conflict')(e)) throw e; }
  });
  assert.deepEqual(released, [1]);
  await actor.stop(); assert.deepEqual(released.sort(), [0, 1, 3]);
  await assert.rejects(current.check(), category('source_unavailable'));
  assert.throws(() => old.view, category('source_unavailable'));
});

test('cold failure recovers on a later full job; query cancellation does not abort shared startup', async () => {
  const failed = deferred(), building = deferred(), next = deferred(); let runs = 0;
  const actor = new VaultIndex(async () => {
    if (!runs++) { await failed.promise; throw new VaultError('capacity'); }
    building.resolve(); await next.promise;
    return { view: { notes: [], directories: [''], omissions: [] }, release() {} };
  }, async () => {}, error => error);
  const aborted = new AbortController();
  const gone = actor.acquire(aborted.signal), first = actor.acquire();
  aborted.abort(); await assert.rejects(gone, category('cancelled')); failed.resolve();
  await assert.rejects(first, category('capacity'));
  actor.hint(); await building.promise;
  const lease = actor.acquire(); next.resolve(); assert.deepEqual((await lease).view.directories, ['']); await actor.stop();
});

async function fixture(t: TestContext, options?: { limits?: Partial<typeof INDEX_LIMITS>; realWatch?: boolean }) {
  const owner = await mkdtemp(join(tmpdir(), 'sentinel-private-index-')), root = join(owner, 'vault');
  await mkdir(root);
  const files = new LocalNotes(), logs: string[] = [], reads: string[] = [];
  const controls: { denied?: boolean; fail?: string; beforeRead?: (path: string) => Promise<void> } = {};
  const read = files.searchReader.bind(files);
  files.searchReader = async (...args) => {
    reads.push(args[1]); await controls.beforeRead?.(args[1]);
    if (controls.fail === args[1]) throw new Error('sentinel-private-read-error');
    return read(...args);
  };
  const watches = new Set<EventEmitter>(), watched = new Set<string>();
  const fakeWatch = ((path: string, _options: unknown, wake: (...args: any[]) => void) => {
    assert.match(path, /^\/proc\/self\/fd\/\d+$/); watched.add(path);
    const watch = new EventEmitter(); watches.add(watch); watch.on('change', wake);
    return Object.assign(watch, { close() { watches.delete(watch); } });
  }) as unknown as typeof import('node:fs').watch;
  const index = new FilesystemIndex(files, async () => {
    if (controls.denied) throw new Error('sentinel-private-auth-error');
    return grantFor(root);
  }, new MarkdownNotes(), diagnosticLogger(message => logs.push(message)), { ...INDEX_LIMITS, ...options?.limits }, options?.realWatch ? undefined : fakeWatch);
  t.after(async () => { await index.stop(); await rm(owner, { recursive: true, force: true }); });
  return { index, root, owner, controls, logs, reads, watches, watched, refresh: () => index.setEligible(7, ['one'], true), acquire: () => index.acquire('one', 7) };
}
const paths = (lease: Awaited<ReturnType<FilesystemIndex['acquire']>>) => lease.view.notes.map(note => note.path);
const nextPaths = (f: Awaited<ReturnType<typeof fixture>>, predicate: (paths: string[]) => boolean) => eventually(async () => {
  try { const lease = await f.acquire(); try { const current = paths(lease); if (predicate(current)) return current; } finally { lease.close(); } }
  catch (error) { if (!category('conflict')(error) && !category('unavailable')(error)) throw error; }
});

test('real nonrecursive watches rescan only the affected subtree, publishing rename and new descendants together', async t => {
  const f = await fixture(t, { realWatch: true });
  for (const folder of ['Left', 'Right']) {
    await mkdir(join(f.root, folder)); await writeFile(join(f.root, folder, 'Original.md'), '# Heading\n\n- [ ] task\n\n#tag [[Other]]\n\nBlock text ^demo\n');
  }
  f.refresh(); const old = await f.acquire();
  assert.deepEqual(paths(old), ['Left/Original.md', 'Right/Original.md']);
  const { metadata, ...note } = old.view.notes[0];
  assert.ok(metadata?.headings.length && metadata.blocks.length && metadata.tasks.length && metadata.tags.length && metadata.links.length);
  assert.ok(Object.isFrozen(metadata.tasks[0])); assert.ok(Object.isFrozen(old.view.notes));
  assert.equal('text' in note, false);
  f.reads.length = 0;
  await rename(join(f.root, 'Left/Original.md'), join(f.root, 'Left/Renamed.md'));
  await mkdir(join(f.root, 'Left/Nested'));
  await writeFile(join(f.root, 'Left/Nested/New.md'), 'new');
  assert.deepEqual(await nextPaths(f, current => current.includes('Left/Nested/New.md') && !current.includes('Left/Original.md')),
    ['Left/Nested/New.md', 'Left/Renamed.md', 'Right/Original.md']);
  assert.ok(f.reads.length > 0 && f.reads.every(path => path.startsWith('Left/')));
  assert.deepEqual(paths(old), ['Left/Original.md', 'Right/Original.md']);
  await rm(join(f.root, 'Left/Nested'), { recursive: true });
  await nextPaths(f, current => !current.includes('Left/Nested/New.md'));
  old.close();
});

test('default watches refresh a directory beyond the former 128-watch cap without reconciliation', async t => {
  const f = await fixture(t, { realWatch: true });
  for (let i = 0; i < 130; i++) await mkdir(join(f.root, `Folder-${i}`));
  f.refresh();
  const initial = await f.acquire();
  // The view lists directories in scan order, the same order watches are attempted.
  assert.equal(initial.view.directories.length, 131);
  const target = initial.view.directories.at(-1)!;
  assert.deepEqual(paths(initial), []);
  initial.close();

  const note = `${target}/New.md`;
  await writeFile(join(f.root, note), 'new');
  assert.deepEqual(await nextPaths(f, current => current.includes(note)), [note]);
  assert.deepEqual(f.logs, []);
});

test('scope refresh never follows a symlink; missed events and watcher failures are reconciled', async t => {
  const f = await fixture(t);
  await mkdir(join(f.owner, 'outside'));
  await writeFile(join(f.owner, 'outside', 'Secret.md'), 'sentinel-private-outside');
  await symlink(join(f.owner, 'outside'), join(f.root, 'Link'));
  await symlink(join(f.owner, 'outside/Secret.md'), join(f.root, 'External.md'));
  await writeFile(join(f.root, 'Legit.md'), '---\nstatus: active\n---\n' + 'body '.repeat(14_000));
  f.refresh(); const first = await f.acquire();
  assert.deepEqual(paths(first), ['Legit.md']);
  assert.deepEqual(first.view.omissions.map(entry => entry.path).sort(), ['External.md', 'Link']);
  assert.equal(first.view.notes[0].properties.status, 'active'); assert.equal(first.view.notes[0].metadataWarning, 'parser_limit');
  const [watch] = f.watches; watch.emit('error', new Error('sentinel-private-watcher-error')); assert.equal(f.watches.size, 0);
  await writeFile(join(f.root, 'Missed.md'), 'missed by watcher');
  const stale = await f.acquire(); assert.deepEqual(paths(stale), ['Legit.md']); stale.close();
  f.refresh(); await nextPaths(f, current => current.includes('Missed.md'));
  assert.ok(f.logs.includes('Obsidian index_watch unavailable'));
  assert.doesNotMatch(JSON.stringify(f.logs), /sentinel-private|Secret\.md/);
  assert.ok(!f.reads.some(path => /Link|External/.test(path)));
  first.close();
});

test('required read failure does not publish a partial generation; root exchange and access loss close watch handles and leases', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'Before.md'), 'original');
  f.refresh(); const old = await f.acquire();
  await writeFile(join(f.root, 'After.md'), 'new'); f.controls.fail = 'After.md'; f.refresh();
  await eventually(async () => {
    try { (await f.acquire()).close(); } catch (e) { if (category('unavailable')(e)) return true; throw e; }
  });
  assert.deepEqual(paths(old), ['Before.md']);
  f.controls.fail = undefined; f.refresh(); await nextPaths(f, current => current.includes('After.md'));
  await rename(f.root, join(f.owner, 'replaced')); await mkdir(f.root);
  await assert.rejects(old.check(), category('source_unavailable')); assert.equal(f.watches.size, 0);
  assert.throws(() => old.view, category('source_unavailable'));
  f.refresh(); const fresh = await f.acquire(); assert.deepEqual(paths(fresh), []);
  f.controls.denied = true;
  await assert.rejects(fresh.check(), category('source_unavailable')); assert.equal(f.watches.size, 0);
  assert.deepEqual(f.logs, ['Obsidian index_refresh unavailable', 'Obsidian index_access source_unavailable', 'Obsidian index_access source_unavailable']);
});

test('workspace/config removal cancels a startup waiter and drains a background directory grant', async () => {
  const entered = deferred();
  const index = new FilesystemIndex(new LocalNotes(), async (_id, _rev, signal) => {
    entered.resolve(); await once(signal!, 'abort'); throw abortError(signal!);
  }, new MarkdownNotes(), () => {});
  index.setEligible(7, ['one']); await entered.promise;
  const waiting = index.acquire('one', 7);
  index.setEligible(8, []);
  await assert.rejects(waiting, category('source_unavailable'));
  await index.stop();
  await assert.rejects(index.acquire('one', 8), category('source_unavailable'));
});

test('caps refuse incomplete builds, bound watch counts, and account for outstanding reservations', async t => {
  const budget = new IndexBudget({ building: 10, current: 10, retained: 10 }, 8), a = budget.reservation(), b = budget.reservation();
  a.add(8); assert.throws(() => a.add(1), category('capacity')); assert.throws(() => b.add(3), category('capacity'));
  a.release(); b.add(8); b.release();
  const f = await fixture(t, { limits: { watchers: 1, entries: 5 } });
  await mkdir(join(f.root, 'Folder')); await writeFile(join(f.root, 'Folder/X.md'), 'valid');
  f.refresh(); const lease = await f.acquire(); assert.equal(f.watches.size, 1);
  assert.deepEqual(f.logs, ['Obsidian index_watch unavailable']);
  await writeFile(join(f.root, 'Folder/Missed.md'), 'valid');
  const beforeReconcile = await f.acquire();
  assert.deepEqual(paths(beforeReconcile), ['Folder/X.md']); beforeReconcile.close();
  f.refresh();
  assert.deepEqual(await nextPaths(f, current => current.includes('Folder/Missed.md')), ['Folder/Missed.md', 'Folder/X.md']);
  assert.equal(f.watches.size, 1);

  await writeFile(join(f.root, 'Extra.md'), 'valid'); await writeFile(join(f.root, 'Overflow.md'), 'valid'); f.refresh();
  await eventually(async () => {
    try { (await f.acquire()).close(); } catch (e) { if (category('entry_cap')(e)) return true; throw e; }
  });
  assert.deepEqual(paths(lease), ['Folder/X.md']); lease.close();
  assert.deepEqual(f.logs, ['Obsidian index_watch unavailable', 'Obsidian index_refresh entry_cap']);
});

test('folder move index checks directory membership even when a watcher misses the event', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'Folder'));
  await writeFile(join(f.root, 'Folder/Original.md'), 'Synthetic note');
  f.refresh();
  const signal = new AbortController().signal;
  const before = await f.index.acquireForMove('one', 7, signal);
  await writeFile(join(f.root, 'Folder/Added.md'), 'Synthetic new candidate');
  await assert.rejects(before.checkMembership(signal), category('conflict'));
  before.close();
  const after = await f.index.acquireForMove('one', 7, signal);
  assert.deepEqual(paths(after), ['Folder/Added.md', 'Folder/Original.md']);
  after.close();
});

test('the index reports a scan timeout separately from its entry cap', async t => {
  const f = await fixture(t, { limits: { scanMs: 20 } });
  await writeFile(join(f.root, 'Synthetic.md'), 'Synthetic note');
  f.controls.beforeRead = () => delay(30);
  f.refresh();
  await assert.rejects(f.index.acquireForMove('one', 7, new AbortController().signal), category('scan_timeout'));
  assert.deepEqual(f.logs, ['Obsidian index_refresh scan_timeout']);
});

test('a cold grant mismatching the opened root causes zero traversal, reads, or watch registration', async t => {
  const f = await fixture(t);
  const original = await grantFor(f.root);
  const reported = deferred(), resume = deferred();
  const scan = new LocalNotes();
  let traversals = 0, reads = 0, watches = 0;
  const walk = scan.indexDirectory.bind(scan), read = scan.searchReader.bind(scan);
  scan.indexDirectory = (...args) => { traversals++; return walk(...args); };
  scan.searchReader = (...args) => { reads++; return read(...args); };
  const index = new FilesystemIndex(scan, async () => { reported.resolve(); await resume.promise; return original; }, new MarkdownNotes(), () => {}, INDEX_LIMITS,
    (() => { watches++; throw new Error('must not watch replacement'); }) as typeof import('node:fs').watch);
  t.after(async () => { resume.resolve(); await index.stop(); });
  index.setEligible(7, ['one']); const opening = index.acquire('one', 7);
  const denied = assert.rejects(opening, category('source_unavailable'));
  await reported.promise;
  await rename(f.root, join(f.owner, 'original')); await mkdir(f.root);
  await writeFile(join(f.root, 'Replacement.md'), 'synthetic unauthorized content');
  resume.resolve(); await denied;
  assert.deepEqual({ traversals, reads, watches }, { traversals: 0, reads: 0, watches: 0 });
});

test('a scan traverses the authorized descriptor, not a replacement pathname after pinning', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'Original.md'), 'authorized');
  const original = await grantFor(f.root), pinned = deferred(), resume = deferred();
  const files = new LocalNotes(), walk = files.indexDirectory.bind(files), read = files.searchReader.bind(files);
  const notes: string[] = [];
  files.indexDirectory = async function* (...args) { pinned.resolve(); await resume.promise; yield* walk(...args); };
  files.searchReader = (...args) => { notes.push(args[1]); return read(...args); };
  const index = new FilesystemIndex(files, async () => original, new MarkdownNotes(), () => {});
  t.after(async () => { resume.resolve(); await index.stop(); });
  index.setEligible(7, ['one']);
  const expected = assert.rejects(index.acquire('one', 7), category('source_unavailable'));
  await pinned.promise;
  await rename(f.root, join(f.owner, 'original')); await mkdir(f.root);
  await writeFile(join(f.root, 'Replacement.md'), 'synthetic unauthorized content');
  resume.resolve(); await expected;
  assert.deepEqual(notes, ['Original.md']);
});

test('full published budget still permits repeated replacements with and without a pinned cursor', async t => {
  const f = await fixture(t), parser = new MarkdownNotes();
  const roots = new Map<string, string>(), files = new LocalNotes(), notes = ['A', 'B'];
  const body = (value: string) => `---\nstatus: ${value}\n---\n`;
  for (const id of notes) {
    const root = join(f.root, id); await mkdir(root); await writeFile(join(root, 'Only.md'), body('first')); roots.set(id, root);
  }
  const { properties, ...metadata } = parser.parse(body('first'));
  const stampLengths = await Promise.all([...roots.values()].map(async root => {
    const { dev, ino, mtimeNs, ctimeNs } = await stat(root, { bigint: true });
    return [dev, ino, mtimeNs, ctimeNs].join(':').length;
  }));
  const directoryBytes = 256 + 4 * Math.max(...stampLengths);
  const bytes = 256 + directoryBytes + 256 + 256 + 4 * 'Only.md'.length + 4 * JSON.stringify({ linkData: parseLinks(body('first'), parser), path: 'Only.md', hash: 'h'.repeat(64), readAt: '2026-01-01T00:00:00.000Z', properties, metadata }).length;
  const logs: string[] = [];
  const noEvents = (() => Object.assign(new EventEmitter(), { close() {} })) as unknown as typeof import('node:fs').watch;
  const index = new FilesystemIndex(files, id => grantFor(roots.get(id)!), parser, diagnosticLogger(log => logs.push(log)),
    { ...INDEX_LIMITS, currentBytes: bytes * 2, viewBytes: bytes, retainedBytes: bytes }, noEvents);
  t.after(() => index.stop());
  const acquire = (id: string) => index.acquire(id, 7);
  index.setEligible(7, notes);
  const initial = await Promise.all(notes.map(acquire)); initial.forEach(l => l.close());
  const refresh = async (value: string) => {
    for (const root of roots.values()) await writeFile(join(root, 'Only.md'), body(value));
    index.setEligible(7, notes, true);
    for (const id of notes) await eventually(async () => {
      const lease = await acquire(id);
      try { if (lease.view.notes[0].properties.status === value) return true; } finally { lease.close(); }
    });
  };
  await refresh('other');
  const pinned = await acquire('A');
  await refresh('third'); await refresh('final');
  assert.equal(pinned.view.notes[0].properties.status, 'other'); pinned.close();
  assert.deepEqual(logs, []);
});

test('repeated unchanged omission is logged once at publication', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'Folder'));
  await writeFile(join(f.root, 'Folder/Bad.md'), '---\nmalformed: [\n---\n');
  await writeFile(join(f.root, 'Folder/Original.md'), 'original');
  f.refresh(); (await f.acquire()).close();
  const [folderWatch] = [...f.watches].slice(1);
  await rename(join(f.root, 'Folder/Original.md'), join(f.root, 'Folder/Updated.md'));
  folderWatch.emit('change', 'change', 'Updated.md');
  await nextPaths(f, value => value.includes('Folder/Updated.md'));
  assert.deepEqual(f.logs, ['Obsidian index_refresh unsupported']);
});

test('file or sync hints invalidate write evidence on a held link generation before refresh', async () => {
  const empty = { notes: [], directories: [], omissions: [] };
  const actor = new VaultIndex(async () => ({ view: empty, release() {} }), async () => {}, error => error);
  const lease = await actor.acquire();
  try {
    lease.assertUnchanged?.();
    actor.hint(undefined, 1000);
    assert.equal(lease.view, empty);
    assert.throws(() => lease.assertUnchanged?.(), /conflict/);
  } finally { lease.close(); await actor.stop(); }
});
