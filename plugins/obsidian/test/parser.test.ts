import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownNotes, editText, updateProperties } from '../adapters/markdown-notes.ts';
const parser = new MarkdownNotes();
for (const eol of ['\n', '\r\n']) test(`pinned semantics retain offsets with ${JSON.stringify(eol)}`, () => {
  const text = ['---', 'aliases: [Launch, "Next step"] # keep', 'tags: [Work/Launch]', 'link: "[[Other]]"', '---', '# Launch', '> [!note]', '> - [ ] Visible #work/launch [[Other#Next]]', '- [?] Done', '`#ignored [[Hidden]]`', '%% #ignored [[Hidden]] %%', '```md', '- [ ] Not a task #ignored', '```', '<div>', '#ignored [[Hidden]]', '</div>', '', 'Paragraph ^block-id', '', '^standalone', ''].join(eol);
  const note = parser.parse(text);
  assert.deepEqual(note.aliases, ['Launch', 'Next step']); assert.ok(note.tags.some(t => t.tag === 'work/launch'));
  assert.equal(note.tasks.length, 2); assert.equal(note.tasks[0].complete, false); assert.equal(note.tasks[1].complete, true); assert.equal(note.tasks[1].marker, '?');
  assert.equal(text.slice(note.tasks[0].markerOffset, note.tasks[0].markerOffset + 1), ' '); assert.equal(note.tasks[0].line, 8);
  assert.equal(note.links.some(l => l.target.includes('Hidden')), false); assert.equal(note.tags.some(t => t.tag === 'ignored'), false);
  assert.ok(note.links.some(l => l.target === 'Other' && l.line === 4)); assert.equal(note.headings[0].line, 6);
  assert.ok(note.blocks.some(b => b.id === 'block-id')); assert.ok(note.blocks.some(b => b.id === 'standalone'));
});
test('Unicode tags, Markdown references, embeds and escaped wikilinks retain source offsets', () => {
  const text = '# Café\n#Équipe/東京 #123 #123ok\n[Other](Folder/Note.md#Heading) ![[Folder/Note#^block|shown]] \\[[Ignored]]\n- [✓] Finished\n'; const note = parser.parse(text);
  assert.deepEqual(note.tags.map(t => t.tag), ['équipe/東京', '123ok']); assert.ok(note.links.some(l => l.target === 'Folder/Note.md#Heading')); assert.ok(note.links.some(l => l.embed && l.target === 'Folder/Note#^block')); assert.equal(note.links.some(l => l.target === 'Ignored'), false);
  assert.equal(note.tasks[0].marker, '✓'); assert.equal(note.tasks[0].complete, true); for (const tag of note.tags) assert.equal(text.slice(tag.start, tag.end).toLocaleLowerCase('und'), '#' + tag.tag);
});
test('unclosed inline HTML does not supply Markdown semantics, while void tags leave following Markdown intact', () => {
  const closed = parser.parse('Text <span>#hidden [[Hidden]]</span> #visible [[Visible]]\n'); assert.deepEqual(closed.tags.map(t => t.tag), ['visible']); assert.deepEqual(closed.links.map(l => l.target), ['Visible']);
  const open = parser.parse('Text <span>#hidden [[Hidden]]\n'); assert.equal(open.tags.length, 0); assert.equal(open.links.length, 0); assert.ok(open.warnings.includes('unclosed_html'));
  const linebreak = parser.parse('Text <br> #visible [[Visible]]\n'); assert.deepEqual(linebreak.tags.map(t => t.tag), ['visible']); assert.deepEqual(linebreak.links.map(l => l.target), ['Visible']);
});
test('property removals leave other comments/body bytes and validate reserved shapes and dates', () => {
  const text = '---\r\n# preserve\r\nremove: old # removed with property\r\nkeep: [one, two] # exact\r\n---\r\nBody\r\n';
  const next = updateProperties(text, { set: {}, remove: ['remove'] }); assert.equal(next, '---\r\n# preserve\r\nkeep: [one, two] # exact\r\n---\r\nBody\r\n');
  for (const set of [{ cssclasses: false }, { tags: ['123'] }, { date: '2026-13-01' }, { time: '2026-01-01T12:60:00' }]) assert.throws(() => updateProperties(text, { set, remove: [] }));
});
test('malformed, duplicate and unsafe YAML are warnings, not executed or valid write inputs', () => {
  for (const yaml of ['tags: [broken', 'same: one\nsame: two', 'secret: !!js/function function(){}', 'value: &a [*a]']) {
    const text = `---\n${yaml}\n---\nBody\n`; assert.ok(parser.parse(text).warnings.includes('properties_unsupported'));
    assert.throws(() => updateProperties(text, { set: { title: 'safe' }, remove: [] }));
    assert.throws(() => editText(text, [{ oldText: 'Body', newText: 'Changed' }]));
  }
});
test('exact text replacements must be unique and non-overlapping', () => {
  assert.equal(editText('One\r\nTwo\r\n', [{ oldText: 'Two', newText: 'Second' }]), 'One\r\nSecond\r\n');
  assert.throws(() => editText('same same', [{ oldText: 'same', newText: 'x' }]));
  assert.throws(() => editText('abcdef', [{ oldText: 'abcd', newText: 'x' }, { oldText: 'cdef', newText: 'y' }]));
});
test('property edits preserve unrelated bytes and append to existing aliases explicitly', () => {
  const text = '---\r\n# keep header comment\r\naliases: [Old] # keep alias comment\r\nstatus: draft # keep status comment\r\nuntouched: "spacing"\r\n---\r\nBody [[Link]] ^id\r\n';
  const next = updateProperties(text, { set: { status: 'done', aliases: ['Old', 'New'] }, remove: [] });
  assert.ok(next.includes('# keep header comment\r\n')); assert.ok(next.includes('# keep status comment\r\n')); assert.ok(next.includes('untouched: "spacing"\r\n---\r\nBody [[Link]] ^id\r\n'));
  assert.deepEqual(parser.parse(next).aliases, ['Old', 'New']);
  for (const set of [{ tags: 'not-a-list' }, { aliases: [1] }, { date: '2026-02-30' }, { time: '2026-01-01T28:30:00' }]) assert.throws(() => updateProperties(text, { set, remove: [] }));
  assert.equal(updateProperties('Body\n', { set: { title: '[[Link]]' }, remove: [] }), '---\ntitle: "[[Link]]"\n---\nBody\n');
});
