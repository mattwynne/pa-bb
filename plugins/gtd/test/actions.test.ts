import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';

test('action tools and CLI share the TODO section and check its note version before writing', async () => {
  const area = { kind: 'area', source: 'one', id: 'Life/Areas/Home.md' };
  const project = { kind: 'project', source: 'one', id: 'Life/Projects/Active/Build a bench.md' };
  const original = ['```', '- [ ] Example', '```', '', '- [ ] Buy **paint**', '- [x] Call the shop'].join('\r\n');
  const sections = new Map([[area.id, original], [project.id, '']]);
  const version = (path: string) => createHash('sha256').update(path + sections.get(path)).digest('hex');
  let writes = 0;
  let fail = false;
  const { bb, harness } = createFakePluginHost({ pluginId: 'gtd', settings: { vaultId: 'one/Life' }, sdk: { plugins: {
    async callRpc(args: any) {
      if (args.method === 'vaultLocations') return { vaults: [{ id: 'one', root: 'Life', name: 'Vault' }], incomplete: false };
      const { path, heading, vaultId, operationId, expectedHash, text } = args.input;
      assert.equal(heading, 'TODO');
      assert.equal(vaultId, 'one');
      assert.ok(sections.has(path));
      if (args.method === 'readNoteSection') return { text: sections.get(path), hash: version(path) };
      assert.equal(args.method, 'writeNoteSection');
      assert.equal(expectedHash, version(path));
      writes++;
      if (fail) throw new Error('synthetic-private-note-body');
      sections.set(path, text.replace(/\s+$/u, ''));
      return { operationId, outcome: 'saved_locally_pending_sync' };
    },
  } } });
  await plugin(bb);
  const tool = async (name: string, input: unknown) => {
    const response = await harness.behavior.callAgentTool(`gtd_${name}`, input);
    assert.ok(typeof response !== 'string' && !response.isError);
    return JSON.parse((response.content[0] as { text: string }).text);
  };
  try {
    const list = await tool('list_actions', area);
    const areaRef = { source: area.source, id: area.id };
    assert.deepEqual(await harness.behavior.callRpc('readAreaActions', areaRef), list);
    assert.deepEqual(await harness.behavior.callRpc('readNoteActions', area), list);
    assert.deepEqual(list.actions, [
      { line: 5, text: 'Buy **paint**', complete: false },
      { line: 6, text: 'Call the shop', complete: true },
    ]);
    const help = await harness.behavior.runCli(['actions', '--help']);
    assert.equal(help.exitCode, 0);
    for (const word of ['list', 'add', 'edit', 'delete']) assert.match(help.stdout!, new RegExp(word));
    const add = await harness.behavior.runCli(['actions', 'add', '--kind', 'project', '--source', 'one', '--id', project.id,
      '--text', 'Measure the boards', '--json']);
    assert.equal(add.exitCode, 0);
    assert.equal(sections.get(project.id), '- [ ] Measure the boards');
    assert.equal((await tool('edit_action', { ...area, version: list.version, line: 5, text: 'Buy **primer**', complete: true })).outcome, 'saved_locally_pending_sync');
    assert.equal(sections.get(area.id), original.replace('[ ] Buy **paint**', '[x] Buy **primer**'));
    assert.deepEqual(await tool('delete_action', { ...area, version: list.version, line: 6 }), { outcome: 'not_saved', reason: 'changed' });
    assert.equal(writes, 2);
    const latest = await tool('list_actions', area);
    assert.equal((await tool('delete_action', { ...area, version: latest.version, line: 6 })).outcome, 'saved_locally_pending_sync');
    assert.equal(sections.get(area.id), original.replace('[ ] Buy **paint**', '[x] Buy **primer**').split('\r\n').slice(0, -1).join('\r\n'));
    await assert.rejects(() => harness.behavior.callRpc('readAreaActions', { source: 'one', id: project.id }), /Could not load actions/);
    const operationId = 'd3091c3e-00bb-4dc3-a52f-f1ba7f5069b6';
    const edit = { operation: 'edit', line: 5, version: version(area.id), complete: false };
    assert.deepEqual(await harness.behavior.callRpc('changeAreaAction', { ...areaRef, operationId, change: edit }), { outcome: 'saved_locally_pending_sync' });
    assert.match(sections.get(area.id)!, /\[ \] Buy \*\*primer\*\*/);
    assert.deepEqual(await harness.behavior.callRpc('changeAreaAction', { ...areaRef, operationId, change: { ...edit, complete: true } }), {
      outcome: 'not_saved', reason: 'changed',
    });
    const newAction = { operation: 'add', text: 'Check the supplies' };
    assert.deepEqual(await harness.behavior.callRpc('changeAreaAction', { ...areaRef,
      operationId: 'e66439a2-f72f-4c92-b007-99e244d689dd', change: newAction }), { outcome: 'saved_locally_pending_sync' });
    assert.match(sections.get(area.id)!, /^- \[ \] Check the supplies\r\n/);
    const projectList = await tool('list_actions', project);
    assert.deepEqual(await harness.behavior.callRpc('readNoteActions', project), projectList);
    const complete = () => harness.behavior.callRpc('changeNoteAction', { ...project, operationId: randomUUID(),
      change: { operation: 'edit', line: 1, version: version(project.id), complete: true } }) as Promise<{ outcome: string; completionVersion: string }>;
    const completion = await complete();
    assert.equal(completion.outcome, 'saved_locally_pending_sync');
    assert.match(completion.completionVersion, /^[0-9a-f]{64}$/);
    assert.equal(sections.get(project.id), '- [x] Measure the boards');
    const undo = (sectionVersion: string) => harness.behavior.callRpc('changeNoteAction', {
      ...project, operationId: randomUUID(), change: { operation: 'undoCompletion', line: 1, sectionVersion },
    });
    assert.deepEqual(await undo(completion.completionVersion), { outcome: 'saved_locally_pending_sync' });
    assert.equal(sections.get(project.id), '- [ ] Measure the boards');
    const secondCompletion = await complete();
    const rename = { operation: 'edit', line: 1, text: 'Measure the oak boards', version: projectList.version };
    const renameAction = { ...project, operationId: '001a5b25-0998-4965-9ca5-a225ce1b4a10', change: rename };
    assert.deepEqual(await harness.behavior.callRpc('changeNoteAction', renameAction), { outcome: 'not_saved', reason: 'changed' });
    assert.deepEqual(await harness.behavior.callRpc('changeNoteAction', {
      ...renameAction, operationId: '07ecac7f-138c-4963-9178-8eb139ec9b90', change: { ...rename, version: version(project.id) },
    }), { outcome: 'saved_locally_pending_sync' });
    assert.equal(sections.get(project.id), '- [x] Measure the oak boards');
    const writesBeforeStaleUndo = writes;
    assert.deepEqual(await undo(secondCompletion.completionVersion), { outcome: 'not_saved', reason: 'changed' });
    assert.equal(writes, writesBeforeStaleUndo);
    assert.equal(sections.get(project.id), '- [x] Measure the oak boards');
    await assert.rejects(() => harness.behavior.callRpc('readNoteActions', { ...project, id: area.id }), /Could not load actions/);
    fail = true;
    assert.deepEqual(await harness.behavior.callRpc('changeAreaAction', { ...areaRef,
      operationId: '8ea8d229-b352-4d4d-b001-c74167104724', change: newAction }), { outcome: 'uncertain' });
    const failed = await tool('add_action', { ...area, text: 'Check the supplies' });
    assert.equal(failed.outcome, 'uncertain');
    assert.match(failed.operationId, /^[0-9a-f-]{36}$/);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /GTD actions_write source_unavailable/);
    assert.doesNotMatch(logs, /synthetic-private-note-body|Check the supplies/);
  } finally { await harness.lifecycle.dispose(); }
});
