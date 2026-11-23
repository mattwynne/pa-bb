import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path/posix';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { plugin as gtd } from '../server.ts';
import { plugin as obsidian } from '../../obsidian/server.ts';
import { CatalogFake, FilesFake, MemoryState, hash } from '../../obsidian/test/fakes.ts';

const id = 'Projects/Active/Example.md',
  moved = 'Projects/Done/Example.md',
  target = 'Areas/Work/Active Income/Cucumber.md';
class Fixture extends FilesFake {
  dirs = [
    'Projects',
    'Projects/Active',
    'Projects/Done',
    'Areas',
    'Areas/Work',
    'Areas/Work/Active Income',
    'Areas/Family',
  ];
  moves = new Map<string, 'moved_locally_pending_sync'>();
  clipped = false;
  async children(v: string, r: number, f: string) {
    const paths = (await this.list(v, r)).paths;
    return {
      entries: [
        ...this.dirs
          .filter((p) => dirname(p) === f)
          .map((p) => ({ name: basename(p), kind: 'directory' as const })),
        ...paths.filter((p) => dirname(p) === f).map((p) => ({ name: basename(p), kind: 'markdown' as const })),
      ],
      incomplete: this.clipped,
    };
  }
  async listProjectMove(i: { mirrorId: string; revision: number }) {
    return { ...await this.list(i.mirrorId, i.revision), attachments: [] };
  }
  async move(i: {
    mirrorId: string;
    revision: number;
    path: string;
    destination: string;
    expectedHash: string;
    operationId: string;
  }) {
    const note = await this.read(i.mirrorId, i.revision, i.path);
    assert.equal(note.hash, i.expectedHash);
    const key = i.mirrorId + '/' + i.destination;
    assert.ok(!this.notes.has(key));
    this.notes.delete(i.mirrorId + '/' + i.path);
    this.notes.set(key, note.text);
    this.moves.set(i.operationId, 'moved_locally_pending_sync');
    return { outcome: 'moved_locally_pending_sync' as const };
  }
  async moveReceipts(i: { operationId: string }) {
    const outcome = this.moves.get(i.operationId);
    return outcome ? [{ outcome }] : [];
  }
}
async function setup() {
  const files = new Fixture();
  files.notes.clear();
  for (const [path, text] of [
    [id, '---\ntitle: Example\n---\nBody\n'],
    [target, 'Target'],
    ['Areas/Family/Cucumber.md', 'Other'],
    ['Context.md', '[[Projects/Active/Example]]'],
  ])
    files.notes.set('one/' + path, text);
  const producer = createFakePluginHost({ pluginId: 'obsidian' });
  const repo = new MemoryState();
  repo.value = { revision: 1, vaultIds: ['one'] };
  await files.configure(repo.value);
  await obsidian(producer.bb as unknown as Parameters<typeof obsidian>[0], {
    files,
    catalog: new CatalogFake(),
    repository: repo,
  });
  const meta = { project: { source: 'one', id }, other: 'unchanged' };
  let lost = false,
    writes = 0;
  let archived = false, archiveFails = false;
  const consumer = createFakePluginHost({
    pluginId: 'gtd',
    agentSkillIds: ['gtd-projects'],
    settings: { vaultId: 'one' },
    sdk: {
      plugins: {
        callRpc: async (a: any) =>
          producer.harness.behavior.callRpc(a.method, a.input, {
            experimental_caller: { kind: 'plugin', pluginId: 'gtd' },
          }),
      },
      threads: {
        list: async (a) => (a?.offset || !!a?.archived !== archived ? [] : [
          makeThreadResponse({ id: 'linked', visibility: 'hidden', archivedAt: archived ? 1 : null }),
        ]),
        archive: async ({ threadId }) => {
          assert.equal(threadId, 'linked');
          assert.equal(meta.project.id, moved);
          if (archiveFails) throw new Error('PRIVATE_ARCHIVE_SENTINEL');
          archived = true;
          return { ok: true, archivedThreadIds: [threadId] };
        },
        experimental_listPluginMetadata: async () => ({
          threads: [{ threadId: 'linked', metadata: structuredClone(meta) }],
        }),
        getPluginMetadata: async () => structuredClone(meta),
        updatePluginMetadata: async (a: any) => {
          meta.project = a.set.project;
          writes++;
          if (lost) throw new Error('PRIVATE_SENTINEL');
          return meta;
        },
      },
    },
  });
  await gtd(consumer.bb);
  const tool = async (name: string, args: any, expectError = false) => {
    const harness = name.startsWith('gtd_') ? consumer.harness : producer.harness;
    const res: any = await harness.behavior.callAgentTool(name, args, { threadId: 'operator' });
    assert.equal(!!res.isError, expectError, JSON.stringify(res));
    return expectError ? res : JSON.parse(res.content[0].text);
  };
  const read = async (path = id) => {
    let n = await tool('obsidian_read_note', { vaultId: 'one', path });
    while (n.nextCursor) n = await tool('obsidian_read_note', { vaultId: 'one', path, cursor: n.nextCursor });
    assert.ok(n.editReady && n.complete);
    return n.hash;
  };
  const prepare = async (options: object, error = false) =>
    tool('gtd_prepare_project_change', { source: 'one', id, expectedHash: await read(), ...options }, error);
  return {
    files,
    tool,
    prepare,
    read,
    meta,
    consumer,
    archived: () => archived,
    failArchive: (value: boolean) => { archiveFails = value; },
    writes: () => writes,
    lose: () => {
      lost = true;
    },
    close: async () => {
      await consumer.harness.lifecycle.dispose();
      await producer.harness.lifecycle.dispose();
    },
  };
}
test('actual agent sequence browses nested targets, assigns the exact note, refuses stale CAS and verifies clear', async (t) => {
  const f = await setup();
  t.after(f.close);
  const cli = await f.consumer.harness.behavior.runCli([
    'area-targets',
    '--folder',
    'Areas/Work/Active Income',
    '--json',
  ]);
  assert.deepEqual(JSON.parse(cli.stdout!).entries, [{ path: target, kind: 'note' }]);
  const browse = await f.tool('gtd_browse_area_targets', { folder: 'Areas/Family' });
  assert.equal(browse.entries[0].path, 'Areas/Family/Cucumber.md');
  const plan = await f.prepare({ areaPath: target });
  await f.tool(plan.next.tool, plan.next.input);
  assert.equal((await f.tool('gtd_check_project_change', { planId: plan.planId })).state, 'verified');
  assert.equal((await f.prepare({ areaPath: target })).state, 'already_complete');
  const stale = await f.prepare({ areaPath: null });
  f.files.notes.set('one/' + id, f.files.notes.get('one/' + id) + 'External edit\n');
  await f.tool(stale.next.tool, stale.next.input, true);
  assert.equal((await f.tool('gtd_check_project_change', { planId: stale.planId })).state, 'not_verified');
  const clear = await f.prepare({ areaPath: null });
  await f.tool(clear.next.tool, clear.next.input);
  assert.equal((await f.tool('gtd_check_project_change', { planId: clear.planId })).state, 'verified');
  assert.match(f.files.notes.get('one/' + id)!, /External edit/);
  assert.equal((await f.prepare({ areaPath: null })).state, 'already_complete');
  await f.prepare({ areaPath: 'Areas/No.md' }, true);
  f.files.clipped = true;
  await f.prepare({ areaPath: target }, true);
});
test('real move dry run, receipt and backlink repair, then lost metadata reply is reconciled without a repeated write', async (t) => {
  const f = await setup();
  t.after(f.close);
  f.files.dirs.push(moved.slice(0, -3));
  await f.prepare({ status: 'done' }, true);
  f.files.dirs.pop();
  const plan = await f.prepare({ status: 'done' });
  const inspect = () => f.tool('gtd_check_project_change', { planId: plan.planId });
  assert.equal((await inspect()).state, 'move_not_verified');
  assert.equal((await f.tool(plan.next.tool, plan.next.input)).outcome, 'link_plan_ready');
  const movedNote = await f.tool(plan.next.tool, { ...plan.next.input, dryRun: false });
  const receipt = await f.tool('obsidian_move_status', { vaultId: 'one', operationId: movedNote.operationId });
  assert.equal(receipt.outcome, 'moved_supported_links_updated');
  assert.equal(receipt.destination, moved);
  assert.match(f.files.notes.get('one/Context.md')!, /Projects\/Done\/Example/);
  assert.equal((await inspect()).state, 'links_pending');
  const args = { planId: plan.planId, finishLinks: true, receipt };
  await f.tool('gtd_check_project_change', { ...args, receipt: { ...receipt, path: 'Projects/Wrong.md' } }, true);
  await assert.rejects(
    f.tool('gtd_check_project_change', { ...args, receipt: { ...receipt, outcome: 'moved_links_partial' } }),
    /receipt.outcome/,
  );
  assert.equal(f.writes(), 0);
  f.lose();
  await f.tool('gtd_check_project_change', args, true);
  assert.equal((await inspect()).state, 'links_verified');
  assert.equal((await f.tool('gtd_check_project_change', args)).state, 'links_verified');
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.meta, { project: { source: 'one', id: moved }, other: 'unchanged' });
});

test('panel assignment and completion use checked Obsidian writes and archive hidden linked threads', async t => {
  const f = await setup();
  t.after(f.close);
  const change = (projectId: string, change: object) => f.consumer.harness.behavior.callRpc('changeProject', {
    source: 'one', id: projectId, change,
  });
  assert.equal((await change(id, { kind: 'area', areaPath: target }) as { state: string }).state, 'assigned');
  assert.ok(f.files.notes.get('one/' + id)!.includes(`area: "${target}"`));
  assert.equal((await change(id, { kind: 'done' }) as { state: string }).state, 'done');
  assert.ok(f.files.notes.has('one/' + moved));
  assert.equal(f.meta.project.id, moved);
  assert.equal(f.archived(), true);
  assert.equal((await change(moved, { kind: 'done' }) as { state: string }).state, 'done');
});

test('archive failure keeps the verified move and can be reconciled from Done', async t => {
  const f = await setup();
  t.after(f.close);
  const done = (projectId: string) => f.consumer.harness.behavior.callRpc('changeProject', {
    source: 'one', id: projectId, change: { kind: 'done' },
  });
  f.failArchive(true);
  const incomplete = await done(id);
  assert.match(JSON.stringify(incomplete), /"state":"partial"/);
  assert.doesNotMatch(JSON.stringify(incomplete), /PRIVATE_ARCHIVE_SENTINEL/);
  const logs = JSON.stringify(f.consumer.harness.inspection.logEntries);
  assert.match(logs, /GTD project_panel archive_incomplete/);
  assert.doesNotMatch(logs, /PRIVATE_ARCHIVE_SENTINEL/);
  assert.equal(f.archived(), false);
  assert.ok(f.files.notes.has('one/' + moved));
  f.failArchive(false);
  assert.match(JSON.stringify(await done(moved)), /"state":"done"/);
  assert.equal(f.files.moves.size, 1);
  assert.equal(f.archived(), true);
});
