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
    notes: [
      note(projects + '/Example.md', { area: ['[[Finance|finance]]', '../Areas/Finance.md'] }),
      note(projects + '/Completed/Pilot.md', { status: 'active', title: 'Example', area: 'Areas/Work/Nested' }),
      note(projects + '/Example/README.md', { title: 'Support metadata', area: 'Areas/Work' }),
      note(projects + '/Notebook/README.md'),
      note(areas + '/Finance.md'), note(areas + '/Work.md'), note(areas + '/Work/Nested.md'),
    ],
    folders: [root, projects, projects + '/Completed', projects + '/Notebook', projects + '/Example', projects + '/Empty',
      areas, areas + '/Work', areas + '/Empty'],
    incomplete: false,
  };
  const received: string[] = [];
  let read = async () => structuredClone(result);
  const sdk = { plugins: { callRpc: async ({ method, input }: { method: string; input: Record<string, unknown> | null }) => {
    received.push(method);
    if (method === 'status') return { vaults: [{ vaultId: 'one', name: 'Example', source: {
      local: { available: true }, cloudConnected: false, enabled: false, phase: 'paused', failure: null, lastSuccess: null,
    } }] };
    assert.equal(method, 'vaultInventory');
    assert.equal(input?.vaultId, 'one');
    assert.equal(input?.root, root);
    return read();
  } } } as unknown as BbPluginApi['sdk'];
  return { result, received, sdk, setReader(next: typeof read) { read = next; },
    backend: new ObsidianBackend(sdk, { vaultId: 'one', root, folder: 'Projects', areasFolder: 'Areas' }) };
}

test('one Desktop query gives note-backed project IDs, status and Area assignments, and preserves empty Areas', async () => {
  const f = fixture();
  const { projects: snapshot, areas: areaList } = await f.backend.readBoth(signal());
  assert.deepEqual(f.received.sort(), ['status', 'vaultInventory']);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.source.sync?.phase, 'paused');
  assert.deepEqual(snapshot.projects, [
    { id: projects + '/Example.md', title: 'Example', status: 'active', areaId: areas + '/Finance.md' },
    { id: projects + '/Completed/Pilot.md', title: 'Example', status: 'done', areaId: areas + '/Work/Nested.md' },
  ]);
  assert.deepEqual(areaList.areas.map(area => area.id), [areas + '/Finance.md', areas + '/Work.md', areas + '/Empty/']);
  f.result.notes[0].path = projects + '/Renamed.md';
  const newer = await f.backend.readBoth(signal(), true);
  assert.ok(newer.projects.projects.some(row => row.id === projects + '/Renamed.md'));
  assert.ok(newer.projects.projects.every(row => row.id !== projects + '/Example.md'));
});

test('malformed landing frontmatter is named as partial, absent frontmatter and malformed supporting material are distinct', async () => {
  const f = fixture();
  f.result.notes.push(note(projects + '/Broken.md', {}, true), note(areas + '/Broken.md', {}, true),
    note(projects + '/No Properties.md'), note(projects + '/Support/Broken.md', {}, true));
  f.result.folders.push(areas + '/Broken');
  const { projects: snapshot, areas: areaList } = await f.backend.readBoth(signal());
  assert.deepEqual(snapshot.malformedFrontmatter, [projects + '/Broken.md']);
  assert.deepEqual(areaList.malformedFrontmatter, [areas + '/Broken.md']);
  assert.equal(snapshot.complete, false);
  assert.equal(areaList.complete, false);
  assert.ok(snapshot.projects.some(row => row.id === projects + '/No Properties.md'));
  assert.ok(snapshot.projects.every(row => row.id !== projects + '/Broken.md'));
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

test('one landing-note layer and exact folder confinement', () => {
  for (const path of ['../Projects/Test.md', '/Projects/Test.md', 'Projects-copy/Test.md', 'Projects/../Test.md', 'Projects/Test.txt'])
    assert.equal(projectFromNote('Projects', path, {}), 'invalid');
  for (const bad of ['Projects/', '../Projects', 'Projects//Active', 'Projects\\Active']) assert.equal(relativeFolder.safeParse(bad).success, false);
  assert.equal(projectFromNote('Projects', 'Projects/Active/Support/README.md', {}), null);
  assert.equal(projectFromNote('Projects', 'Projects/Support/README.md', {}), null);
  assert.deepEqual(projectFromNote('Projects', 'Projects/Done.md', {}), { id: 'Projects/Done.md', title: 'Done', status: 'active' });
  for (const status of ['active', 'deferred', 'someday', 'done']) {
    const path = 'Projects/' + status + '/Example.md';
    assert.deepEqual(projectFromNote('Projects', path, { status: 'unrecognized' }), { id: path, title: 'Example', status });
  }
});
