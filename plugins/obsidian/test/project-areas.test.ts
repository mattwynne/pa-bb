import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { areaEvidence, areaLookup } from '../core/project-areas.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
const parser = new MarkdownNotes();
const caller = { experimental_caller: { kind: 'plugin' as const, pluginId: 'gtd' } };
test('only exact lowercase area frontmatter declares an Area', () => {
  const evidence = (text: string) => areaEvidence(parser.frontmatter(text).properties);
  const body = 'Prose [[Areas/Finance]]\n## Area\n- [[Areas/Other]]\n#Area';
  assert.deepEqual(evidence(body), []);
  assert.deepEqual(evidence('---\nareaId: Areas/Old.md\nArea: Areas/Other.md\narea_id: Areas/Other.md\n---\n' + body), []);
  for (const area of [null, ' ', []]) assert.deepEqual(areaEvidence({ area, areaId: 'Areas/Old.md' }), []);
  assert.deepEqual(evidence('---\nareaId: Areas/Old.md\narea: ["[[Areas/Finance|Budget]]"]\n---\n' + body), ['[[Areas/Finance|Budget]]']);
  assert.deepEqual(areaEvidence({ area: 'Areas/Finance.md', areaId: 123 }), ['Areas/Finance.md']);
  for (const area of [123, [null], [''], 'x'.repeat(1025), Array(9).fill('Areas/Finance')]) assert.equal(areaEvidence({ area, areaId: 'Areas/Old.md' }), null);
});
test('local candidates support vault-relative/prefixed IDs, .md, aliases and unique basename, not URLs or guesses', () => {
  const paths = ['Life/Areas/Finance.md', 'Life/Areas/Work/Consulting.md', 'Other/Areas/Finance.md'];
  const dirs = ['Life/Areas/Finance', 'Life/Areas/Empty', 'Life/Areas/Work/Nested'];
  const lookup = areaLookup('Life', 'Life/Areas', paths, dirs);
  const source = 'Life/Projects/Active/Plan.md';
  for (const link of ['[[Areas/Finance]]', '[[Areas/Finance.md|Budget]]', 'Life/Areas/Finance.md', 'Finance']) assert.deepEqual(lookup(link, source), [paths[0]]);
  assert.deepEqual(lookup('[[Areas/Work/Consulting]]', source), [paths[1]]);
  for (const link of ['[[Areas/Empty]]', 'Empty']) assert.deepEqual(lookup(link, source), ['Life/Areas/Empty/']);
  assert.deepEqual(lookup('[[Areas/Work/Nested]]', source), ['Life/Areas/Work/Nested/']);
  for (const link of ['https://example.test', '[[Missing]]', '../../../outside', '[[Areas/Finance#Section]]', 'Nested']) assert.deepEqual(lookup(link, source), []);
  assert.equal(areaLookup('Life', 'Life/Areas', [...paths, 'Life/Elsewhere/Finance.md'], dirs)('Finance', source).length, 2);
});
test('bounded GTD consumer resolves explicit root relationships without returning bodies or edit proofs; conflicts remain unassigned', async () => {
  const files = Object.assign(new FilesFake(), { children: async (_id: string, _revision: number, folder: string) => ({ entries: [{ name: folder.endsWith('/Work') ? 'EmptyConsulting' : 'Empty', kind: 'directory' as const }], incomplete: false }) });
  files.notes.clear();
  const bodies: Record<string, string> = {
    Canonical: '---\narea: Life/Areas/Finance.md\n---',
    Property: '---\narea: "[[Areas/Finance|Budget]]"\n---',
    Section: '## Area\n\n- [[Areas/Work/Consulting]]',
    OldOnly: '---\nareaId: Life/Areas/Finance.md\n---',
    StaleKey: '---\nareaId: Life/Areas/Work/Consulting.md\narea: Life/Areas/Finance.md\n---',
    Multiple: '---\narea: ["[[Areas/Finance]]", "[[Areas/Work/Consulting]]"]\n---',
    Incidental: 'See [[Areas/Finance]] in prose.',
    Empty: '---\narea: Areas/Empty\n---',
    Duplicate: '---\narea: ["[[Areas/Finance]]", "[[Areas/Finance|Budget]]"]\n---',
    Missing: '---\narea: "[[Areas/Missing]]"\n---',
    NestedDir: '---\narea: "[[Areas/Work/EmptyConsulting]]"\n---',
  };
  for (const [name, body] of Object.entries(bodies)) files.notes.set(`one/Life/Projects/${name}.md`, body + '\n## Notes\nPRIVATE_SENTINEL');
  for (const path of ['Finance.md', 'Work/Consulting.md']) files.notes.set('one/Life/Areas/' + path, 'target-body');
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  await plugin(host.bb, { catalog: new CatalogFake(), files, repository: new MemoryState() });
  await host.harness.behavior.callRpc('connect', { vaultId: 'one' });
  const input = { vaultId: 'one', root: 'Life', areaFolder: 'Life/Areas', paths: Object.keys(bodies).map(name => `Life/Projects/${name}.md`) };
  try {
    const marked = { ...input, declarationKey: 'area' };
    await assert.rejects(host.harness.behavior.callRpc('projectAreas', input), /GTD/);
    await assert.rejects(host.harness.behavior.callRpc('projectAreasFromFrontmatter', marked), /GTD/);
    await assert.rejects(host.harness.behavior.callRpc('projectAreasFromFrontmatter', { ...input, declarationKey: 'areaId' }, caller));
    const result = await host.harness.behavior.callRpc('projectAreas', input, caller) as any;
    const { authority, ...current } = await host.harness.behavior.callRpc('projectAreasFromFrontmatter', marked, caller) as any;
    assert.equal(authority.route, 'legacy');
    assert.deepEqual(current, result);
    assert.deepEqual(await host.harness.behavior.callRpc('projectAreasFromFrontmatter', input, caller), { ...result, authority });
    const byName = Object.fromEntries(result.rows.map((r: any) => [r.path.split('/').at(-1), r]));
    for (const name of ['Canonical', 'Property', 'StaleKey', 'Duplicate']) assert.equal(byName[name + '.md'].areaId, 'Life/Areas/Finance.md');
    for (const name of ['Section', 'OldOnly', 'Incidental']) assert.equal(byName[name + '.md'].status, 'none');
    assert.equal(byName['Empty.md'].areaId, 'Life/Areas/Empty/');
    assert.equal(byName['NestedDir.md'].areaId, 'Life/Areas/Work/EmptyConsulting/');
    for (const name of ['Multiple', 'Missing']) assert.equal(byName[name + '.md'].status, 'unresolved');
    assert.equal(result.incomplete, false); assert.equal(files.saved.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|target-body|hash|editReady/);
  } finally { await host.harness.lifecycle.dispose(); }
});
