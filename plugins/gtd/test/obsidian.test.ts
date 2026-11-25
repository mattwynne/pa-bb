import test from 'node:test';
import assert from 'node:assert/strict';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { ObsidianBackend, projectFromNote, relativeFolder } from '../adapters/obsidian.ts';

const signal = () => new AbortController().signal;
const root = 'Life';
const projects = root + '/Projects';
const areas = root + '/Areas';
const note = (path: string, properties: Record<string, unknown> = {}, malformed = false) => ({ path, properties, malformed });
function fixture() {
  const result = {
    source: { vaultId: 'one', name: 'Example', cloudConnected: false, enabled: false, phase: 'paused', failure: null, lastSuccess: null },
    notes: [
      note(projects + '/Example.md', { area: ['[[Finance|finance]]', '../Areas/Finance.md'] }),
      note(projects + '/Completed/Pilot.md', { status: 'active', title: 'Legacy label', area: 'Areas/Work/Nested' }),
      note(projects + '/Example/README.md', { title: 'Support metadata', area: 'Areas/Work' }),
      note(projects + '/Notebook/README.md'),
      note(areas + '/Finance.md', { title: 'Old finance label' }),
      note(areas + '/Work.md', { title: false }),
      note(areas + '/Work/Nested.md'),
    ],
    folders: [root, projects, projects + '/Completed', projects + '/Notebook', projects + '/Example', projects + '/Empty',
      areas, areas + '/Work', areas + '/Empty'],
    incomplete: false,
  };
  const received: string[] = [];
  let read = async () => structuredClone(result);
  const sdk = { plugins: { callRpc: async ({ method, input }: { method: string; input: Record<string, unknown> | null }) => {
    received.push(method);
    assert.equal(method, 'vaultInventory');
    assert.equal(input?.vaultId, 'one');
    assert.equal(input?.root, root);
    const page = await read();
    if (Array.isArray(input?.folders) && input.folders.length === 0) return { ...page, notes: [], folders: [] };
    if (Array.isArray(input?.folders)) {
      assert.deepEqual(input.folders, [areas]);
      assert.deepEqual(input.metadataFolders, [areas]);
      assert.equal(input.metadataDepth, 1);
      assert.deepEqual(input.fields, []);
    } else {
      assert.equal(input?.metadataDepth, 2);
      assert.deepEqual(input?.metadataFolders, [projects, areas]);
      assert.deepEqual(input?.fields, ['status', 'area']);
    }
    return page;
  } } } as unknown as BbPluginApi['sdk'];
  return { result, received, sdk, setReader(next: typeof read) { read = next; },
    backend: new ObsidianBackend(sdk, { vaultId: 'one', root, folder: 'Projects', areasFolder: 'Areas' }) };
}

test('one Desktop query gives note-backed project IDs, status and Area assignments, and preserves empty Areas', async () => {
  const f = fixture();
  const { projects: snapshot, areas: areaList } = await f.backend.readBoth(signal());
  assert.deepEqual(f.received, ['vaultInventory']);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.source.sync?.phase, 'paused');
  assert.deepEqual(snapshot.projects, [
    { id: projects + '/Example.md', title: 'Example', status: 'active', areaId: areas + '/Finance.md' },
    { id: projects + '/Completed/Pilot.md', title: 'Pilot', status: 'done', areaId: areas + '/Work/Nested.md' },
  ]);
  const expectedAreas = [
    { id: areas + '/Finance.md', title: 'Finance' },
    { id: areas + '/Work.md', title: 'Work' },
    { id: areas + '/Empty/', title: 'Empty' },
  ];
  assert.deepEqual(areaList.areas, expectedAreas);
  assert.deepEqual((await f.backend.readAreas(signal())).areas, expectedAreas);
  f.result.notes[0].path = projects + '/Renamed.md';
  const newer = await f.backend.readBoth(signal());
  assert.ok(newer.projects.projects.some(row => row.id === projects + '/Renamed.md'));
  assert.ok(newer.projects.projects.every(row => row.id !== projects + '/Example.md'));
});

test('malformed project frontmatter is partial and Area entries use their paths', async () => {
  const f = fixture();
  f.result.notes.push(note(projects + '/Broken.md', {}, true), note(areas + '/Broken.md', {}, true),
    note(projects + '/No Properties.md'), note(projects + '/Support/Broken.md', {}, true));
  f.result.folders.push(areas + '/Broken');
  const { projects: snapshot, areas: areaList } = await f.backend.readBoth(signal());
  assert.deepEqual(snapshot.malformedFrontmatter, [projects + '/Broken.md']);
  assert.equal(areaList.malformedFrontmatter, undefined);
  assert.equal(snapshot.complete, false);
  assert.equal(areaList.complete, true);
  assert.ok(snapshot.projects.some(row => row.id === projects + '/No Properties.md'));
  assert.ok(snapshot.projects.every(row => row.id !== projects + '/Broken.md'));
  assert.ok(areaList.areas.some(row => row.id === areas + '/Broken.md' && row.title === 'Broken'));
  assert.ok(areaList.areas.every(row => row.id !== areas + '/Broken/'));
});

test('colliding bare names and partial source evidence cannot create an inferred Area assignment', async () => {
  const f = fixture();
  f.result.notes.push(note(root + '/Elsewhere/Finance.md'));
  let result = await f.backend.readProjects(signal());
  assert.equal(result.complete, true);
  assert.equal(result.projects[0].areaId, undefined);
  assert.equal(result.projects[1].areaId, areas + '/Work/Nested.md');
  f.result.incomplete = true;
  result = await f.backend.readProjects(signal());
  assert.equal(result.complete, false);
  assert.ok(result.projects.every(row => row.areaId === undefined));
});

test('read refuses scope escape, missing method, changed settings and cancellation without exposing source errors', async () => {
  const f = fixture();
  f.result.notes.push(note('Life-copy/Projects/Other.md'));
  await assert.rejects(f.backend.readProjects(signal()), /invalid source/);
  f.result.notes.pop();
  f.setReader(async () => { throw { status: 404, body: { error: { code: 'unknown_method' } }, private: 'PRIVATE_SENTINEL' }; });
  await assert.rejects(f.backend.readProjects(signal()), /incompatible/);
  let release!: () => void;
  f.setReader(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.result; });
  const controller = new AbortController();
  const work = f.backend.readProjects(controller.signal);
  controller.abort(); release();
  await assert.rejects(work, /cancelled/);
  const changed = f.backend.readProjects(signal());
  f.backend.invalidate(); release();
  await assert.rejects(changed, /source unavailable/);
});

test('access checks use empty authorized inventory, not source status or retained notes', async () => {
  const f = fixture();
  await f.backend.checkAccess(signal());
  assert.deepEqual(f.received, ['vaultInventory']);
  f.result.source.vaultId = 'wrong';
  await assert.rejects(f.backend.checkAccess(signal()), /invalid source/);
});

test('one landing-note layer, filename labels, and exact folder confinement', () => {
  for (const path of ['../Projects/Test.md', '/Projects/Test.md', 'Projects-copy/Test.md', 'Projects/../Test.md', 'Projects/Test.txt'])
    assert.equal(projectFromNote('Projects', path, {}), 'invalid');
  for (const bad of ['Projects/', '../Projects', 'Projects//Active', 'Projects\\Active']) assert.equal(relativeFolder.safeParse(bad).success, false);
  assert.equal(projectFromNote('Projects', 'Projects/Active/Support/README.md', {}), null);
  assert.equal(projectFromNote('Projects', 'Projects/Support/README.md', {}), null);
  assert.deepEqual(projectFromNote('Projects', 'Projects/🪚 Done.md', { title: false }), { id: 'Projects/🪚 Done.md', title: '🪚 Done', status: 'active' });
  for (const status of ['active', 'deferred', 'someday', 'done']) {
    const path = 'Projects/' + status + '/Example.md';
    assert.deepEqual(projectFromNote('Projects', path, { status: 'unrecognized' }), { id: path, title: 'Example', status });
  }
});
