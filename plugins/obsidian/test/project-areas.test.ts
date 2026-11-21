import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { areaEvidence, areaCandidates } from '../core/project-areas.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
const parser = new MarkdownNotes();
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };
test('only explicit metadata or designated Area section is evidence, with metadata precedence', () => {
  assert.deepEqual(areaEvidence('---\narea: "[[Areas/Finance|Budget]]"\n---\n## Area\n\n- [[Areas/Other]]', parser), ['[[Areas/Finance|Budget]]']);
  assert.deepEqual(areaEvidence('## Area\n\n- [[Areas/Finance]]\n\n## Notes\n[[Areas/Other]]', parser), ['[[Areas/Finance]]']);
  assert.deepEqual(areaEvidence('Prose [[Areas/Finance]]\n## References\n- [[Areas/Other]]\n#Area', parser), []);
  assert.equal(areaEvidence('## Area\n- [[Areas/Finance]]\n## Area\n- [[Areas/Other]]', parser), null);
  assert.equal(areaEvidence('## Area\nUnclear prose [[Areas/Finance]]', parser), null);
  assert.equal(areaEvidence('---\narea: 123\n---', parser), null);
  assert.deepEqual(areaEvidence('---\narea: null\n---\n## Area\n- [[Areas/Finance]]', parser), ['[[Areas/Finance]]']);
});
test('local candidates support vault-relative/prefixed IDs, .md, aliases and unique basename, not URLs or guesses', () => {
  const paths = ['Life/Areas/Finance.md', 'Life/Areas/Work/Consulting.md', 'Life/Areas/Empty/'];
  for (const link of ['[[Areas/Finance]]', '[[Areas/Finance.md|Budget]]', 'Life/Areas/Finance.md', 'Finance']) assert.deepEqual(areaCandidates(link, 'Life/Projects/Active/Plan.md', 'Life', paths), [paths[0]]);
  assert.deepEqual(areaCandidates('[[Areas/Work/Consulting]]', 'Life/Projects/Plan.md', 'Life', paths), [paths[1]]);
  assert.deepEqual(areaCandidates('[[Areas/Empty]]', 'Life/Projects/Plan.md', 'Life', paths), [paths[2]]);
  for (const link of ['https://example.test', '[[Missing]]', '../../outside', '[[Areas/Finance#Section]]']) assert.deepEqual(areaCandidates(link, 'Life/Projects/Plan.md', 'Life', paths), []);
  assert.equal(areaCandidates('Finance', 'Life/Projects/Plan.md', 'Life', [...paths, 'Life/Elsewhere/Finance.md']).length, 2);
});
test('bounded GTD consumer resolves explicit root relationships without returning bodies or edit proofs; conflicts remain unassigned', async () => {
  const files = Object.assign(new FilesFake(), { children: async (_id: string, _revision: number, folder: string) => ({ entries: [{ name: folder.endsWith('/Work') ? 'EmptyConsulting' : 'Empty', kind: 'directory' as const }], incomplete: false }) });
  files.notes.clear();
  const bodies: Record<string, string> = { Canonical: '---\nareaId: Life/Areas/Finance.md\n---', Property: '---\narea: "[[Areas/Finance|Budget]]"\n---', Section: '## Area\n\n- [[Areas/Work/Consulting]]', Conflict: '---\nareaId: Life/Areas/Finance.md\narea: "[[Areas/Work/Consulting]]"\n---', Multiple: '## Area\n- [[Areas/Finance]]\n- [[Areas/Work/Consulting]]', Incidental: 'See [[Areas/Finance]] in prose.', Empty: '---\narea: Areas/Empty\n---', Duplicate: '---\narea: ["[[Areas/Finance]]", "[[Areas/Finance|Budget]]"]\n---', Missing: '---\narea: "[[Areas/Missing]]"\n---', NestedDir: '---\narea: "[[Areas/Work/EmptyConsulting]]"\n---' };
  for (const [name, body] of Object.entries(bodies)) files.notes.set(`one/Life/Projects/${name}.md`, body + '\n## Notes\nPRIVATE_SENTINEL');
  for (const path of ['Finance.md', 'Work/Consulting.md']) files.notes.set('one/Life/Areas/' + path, 'target-body');
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  await plugin(host.bb, { catalog: new CatalogFake(), files, repository: new MemoryState() });
  await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
  const input = { vaultId: 'one', root: 'Life', areaFolder: 'Life/Areas', paths: Object.keys(bodies).map(name => `Life/Projects/${name}.md`) };
  try {
    await assert.rejects(host.harness.behavior.callRpc('projectAreas', input), /GTD/);
    const result = await host.harness.behavior.callRpc('projectAreas', input, caller) as any;
    const byName = Object.fromEntries(result.rows.map((r: any) => [r.path.split('/').at(-1), r]));
    for (const name of ['Canonical', 'Property', 'Duplicate']) assert.equal(byName[name + '.md'].areaId, 'Life/Areas/Finance.md');
    assert.equal(byName['Section.md'].areaId, 'Life/Areas/Work/Consulting.md');
    assert.equal(byName['Empty.md'].areaId, 'Life/Areas/Empty/');
    assert.equal(byName['NestedDir.md'].areaId, 'Life/Areas/Work/EmptyConsulting/');
    for (const name of ['Conflict', 'Multiple', 'Missing']) assert.equal(byName[name + '.md'].status, 'unresolved');
    assert.equal(byName['Incidental.md'].status, 'none');
    assert.equal(result.incomplete, false); assert.equal(files.saved.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|target-body|hash|editReady/);
  } finally { await host.harness.lifecycle.dispose(); }
});
