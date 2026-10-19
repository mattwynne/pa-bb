import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tools } from '../contract.ts';
import { searchInputSchema } from '../adapters/icloud-note-contract.ts';
import { Obsidian } from '../core/service.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';

test('both search boundaries accept colon folder names without accepting unsafe prefixes', () => {
  for (const folder of ['Notes: 2026', '.hidden: copies', 'C:']) {
    assert.equal(tools.obsidian_search_notes.parameters.safeParse({ mode: 'count', folders: [folder], excludeFolders: [folder + '/Old: notes'] }).success, true);
    assert.equal(searchInputSchema.safeParse({ version: 2, searchVersion: 1, mirrorId: 'one', revision: 1, projection: 'hits', folders: [folder], excludeFolders: [folder + '/Old: notes'] }).success, true);
  }
  for (const folder of ['/Notes:', 'Notes:/../escape', 'Notes:/./child', 'Notes://child', 'Notes:\\child', 'Notes:\0child', 'Notes:\u007fchild']) {
    assert.equal(tools.obsidian_search_notes.parameters.safeParse({ mode: 'count', folders: [folder] }).success, false);
    assert.equal(searchInputSchema.safeParse({ version: 2, searchVersion: 1, mirrorId: 'one', revision: 1, projection: 'hits', folders: [folder] }).success, false);
  }
});
test('colon paths support complete counts, bounded scopes, full reads and conditional saves', async () => {
  const files = new FilesFake(), catalog = new CatalogFake(); files.notes.clear();
  for (const path of ['Topic: Active.md', 'Notes: 2026/Meeting: Friday.md', 'Notes: 2026-old/Other.md']) files.notes.set(`one/${path}`, '---\nstatus: active\n---\nneedle\n');
  const service = new Obsidian(catalog, files, new MarkdownNotes(), new MemoryState(), randomUUID, Date.now, () => {}); await service.start(); await service.connect('one');
  try {
    assert.equal((await service.search({ mode: 'count', properties: [{ key: 'status', equals: 'active' }] })).totalMatches, 3);
    assert.equal((await service.search({ mode: 'count', text: 'needle', folders: ['Notes: 2026'] })).totalMatches, 1);
    assert.equal((await service.search({ mode: 'count', text: 'needle', excludeFolders: ['Notes: 2026'] })).totalMatches, 2);
    const path = 'Notes: 2026/Meeting: Friday.md', note = await service.read({ vaultId: 'one', path }); assert.equal(note.complete, true);
    await service.edit({ vaultId: 'one', path, expectedHash: note.hash!, append: 'Saved once\n' }); assert.match((await service.read({ vaultId: 'one', path })).text!, /Saved once/);
    await service.create({ vaultId: 'one', path: 'Notes: 2026/Created: note.md', text: '---\nstatus: active\n---\nneedle\n' });
    const counted = await service.search({ mode: 'count', folders: ['Notes: 2026'], properties: [{ key: 'status', equals: 'active' }] }); assert.equal(counted.totalMatches, 2); assert.equal(counted.coverage.state, 'complete');
    for (const path of ['/Topic: Active.md', 'Notes:/../escape.md', 'Notes:\\escape.md', 'Notes:/nul\0.md']) await assert.rejects(service.read({ vaultId: 'one', path }), (e: any) => e.category === 'invalid_path');
  } finally { await service.stop(); }
});
