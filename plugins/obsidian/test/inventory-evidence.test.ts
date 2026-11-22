import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedChildren, projectFields, targetQuery, targetEvidence } from '../core/inventory-evidence.ts';
import type { IndexView } from '../core/vault-index.ts';
const notes = ['Life/Areas/Finance.md', 'Life/Other/Finance.md', 'Other/Finance.md'];
const directories = ['Life', 'Life/Areas', 'Life/Areas/Empty', 'Life/Projects'];
const view: IndexView = { notes: notes.map(path => ({ path, hash: 'hash', readAt: 'now', properties: {} })), directories, omissions: [] };
test('children distinguish observed emptiness, missing folders, omissions and known malformed properties', () => {
  assert.deepEqual(indexedChildren(view, 'Life/Areas/Empty'), { entries: [], incomplete: false });
  assert.equal(indexedChildren(view, 'Life/Missing').incomplete, true);
  for (const path of ['', 'Life', 'Life/Areas', 'Life/Areas/Omitted.md']) assert.equal(indexedChildren({ ...view, omissions: [{ path, kind: 'tree' }] }, 'Life/Areas').incomplete, true);
  assert.equal(indexedChildren({ ...view, omissions: [{ path: 'Other', kind: 'tree' }] }, 'Life/Areas').incomplete, false);
  assert.equal(indexedChildren({ ...view, notes: [{ ...view.notes[0], propertyWarning: 'properties_unsupported' }] }, 'Life/Areas').incomplete, false);
  const clipped = indexedChildren({ ...view, directories: Array.from({ length: 5001 }, (_, i) => `Life/Areas/D${i}`) }, 'Life/Areas');
  assert.equal(clipped.entries.length, 5000); assert.equal(clipped.incomplete, true);
});
test('field budgets retain usable title/status and eight long declarations above the recursive 4096 budget', () => {
  const area = Array.from({ length: 8 }, () => 'x'.repeat(1024));
  const values = { title: 'Title', status: 'active', area };
  assert.deepEqual(projectFields(values, ['title', 'status', 'area']).properties.area, area);
  const projected = projectFields({ ...values, area: ['x'.repeat(4097)] }, ['title', 'status', 'area']);
  assert.deepEqual(projected.unsupported, ['area']); assert.equal(projected.properties.title, 'Title');
});
test('target lookup measures bounded catalog scans without a second index', t => {
  const paths = ['Areas/Target.md', ...Array.from({ length: 51 }, (_, i) => `Projects/P${i}.md`)];
  for (const count of [1, 51]) {
    let examined = 0;
    function* observed() { for (const path of paths) { examined++; yield path; } }
    for (let i = 0; i < count; i++) targetEvidence(targetQuery('Areas/Target', 'Projects/P0.md', ''), '', observed(), false, false);
    assert.equal(examined, 52 * count);
    t.diagnostic(JSON.stringify({ references: count, indexedTargetEntriesExamined: examined }));
  }
});
test('target evidence leaves ownership and Area policy to the consumer, preserving syntax and root fences', () => {
  const resolve = (reference: string, incomplete = false) => {
    const query = targetQuery(reference, 'Life/Projects/Plan.md', 'Life');
    return targetEvidence(query, 'Life', notes, !!query.path && directories.includes(query.path), incomplete);
  };
  assert.equal(resolve('Finance').status, 'ambiguous');
  assert.equal(resolve('Areas/Missing').status, 'missing');
  assert.deepEqual(resolve('Areas/Empty').matches, [{ path: 'Life/Areas/Empty', kind: 'directory' }]);
  assert.deepEqual(resolve('[[Areas/Finance|X]]').matches, [{ path: 'Life/Areas/Finance.md', kind: 'markdown' }]);
  assert.equal(resolve('[[Life/Areas/Finance#Budget]]').fragment, true);
  assert.equal(resolve('![[Areas/Finance]]').embed, true);
  assert.deepEqual(resolve('../Areas/Finance').matches, resolve('Areas/Finance').matches);
  for (const reference of ['../../Other/Finance', '%bad', 'https://example.com', '//remote']) assert.equal(resolve(reference).status, 'unsupported');
  assert.equal(resolve('Areas/Finance', true).status, 'incomplete');
});
