import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { createMovePlanner, hashText, MoveLinkError } from '../core/move.ts';
const parser=new MarkdownNotes();
const note=(path:string,text:string)=>({path,text,hash:hashText(text)});
function planMove(notes: ReturnType<typeof note>[], from: string, to: string, parser: MarkdownNotes) {
  const planner = createMovePlanner(new Set(notes.map(note => note.path)), from, to, parser);
  for (const note of notes) planner.visit(note, Buffer.byteLength(note.text));
  return planner.repairs;
}
const source=note('Areas/Example.md','Text\n');
test('wiki aliases, embeds, headings and blocks retain exact suffixes',()=>{
 const notes=[source,note('Index.md','A [[Areas/Example#Heading|alias]] ![[Example#^block]] B\n')];
 const p=planMove(notes,source.path,'Reference/New example.md',parser);
 assert.equal(p[0].text,'A [[Reference/New example#Heading|alias]] ![[Reference/New example#^block]] B\n');
});
test('Markdown links and outgoing relative paths are based on original locations',()=>{
 const notes=[note(source.path,'[other](../Other.md#part)\n'),note('Other.md','x'),note('Index.md','![display](Areas/Example.md#part "title")\n')];
 const p=planMove(notes,source.path,'Reference/New example.md',parser);
 assert.equal(p.find(n=>n.path==='Index.md')?.text,'![display](Reference/New%20example.md#part "title")\n');
});
test('code and unrelated bytes remain untouched',()=>{
 const notes=[source,note('Index.md','`[[Example]]`\n```\n[[Example]]\n```\nExternal [x](https://example.test)\n')];
 assert.deepEqual(planMove(notes,source.path,'Reference/Example.md',parser),[]);
});
for(const text of ['[x][ref]\n\n[ref]: Areas/Example.md','<a href="Areas/Example.md">x</a>','---\nrelated: "[[Example]]"\n---\n'])test('unsupported form is refused',()=>{
 assert.throws(()=>planMove([source,note('Index.md',text)],source.path,'Reference/Example.md',parser));
});
test('ambiguous basename is refused rather than guessed',()=>{
 assert.throws(()=>planMove([source,note('Other/Example.md','x'),note('Index.md','[[Example]]')],source.path,'Reference/New.md',parser),/ambiguous_link/);
});
test('frontmatter is inspected even when link delimiters only appear after YAML decoding', () => {
  const index = note('Index.md', '---\nrelated: "\\u005b\\u005bExample\\u005d\\u005d"\n---\n');
  assert.throws(() => planMove([source, index], source.path, 'Reference/Example.md', parser), /unsupported_links/);
});

test('unrelated YAML wikilinks stay unchanged and affected YAML wikilinks still block', () => {
  const unrelated = '---\nowner: "[[Workspaces/People/Contact]]"\n---\n';
  const index = note('Index.md', unrelated + '[[Example]]\n');
  const [repair] = planMove([source, index], source.path, 'Reference/Example.md', parser);
  assert.equal(repair.text, unrelated + '[[Reference/Example]]\n');
  assert.throws(() => planMove([source, note('Index.md', '---\nrelated: "[[Reference/Example]]"\n---\n')], source.path, 'Reference/Example.md', parser),
    error => error instanceof MoveLinkError && error.location.reason === 'frontmatter_link');
});

test('move refusals give the location of the suspect markup without quoting it', () => {
  for (const [text, reason, line, column] of [
    ['---\nnested:\n  value: PRIVATE_MARKER\n---\n', 'frontmatter', 1, 1],
    ['Example\n\nText <a href="PRIVATE_MARKER.md">link</a>\n', 'html_link_attribute', 3, 9],
    ['Example\n\nText <span>PRIVATE_MARKER\n', 'unclosed_html', 3, 6],
    ['Example\n\nText [label](Bad%XXPRIVATE_MARKER.md)\n', 'target_encoding', 3, 6],
  ] as const) {
    const index = note('Index.md', text);
    assert.throws(() => planMove([source, index], source.path, 'Reference/Example.md', parser), error => {
      assert.ok(error instanceof MoveLinkError);
      assert.equal(error.category, 'unsupported_links');
      assert.deepEqual(error.location, { reason, path: index.path, line, column });
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_MARKER/);
      return true;
    });
  }
});

test('email autolinks and HTML examples leave verified backlinks repairable', () => {
  const retained = 'Contact <team@example.test>.\n\n<span>Label</span>\n\n```html\n<a href="Example.md">Example</a>\n```\n\n';
  const index = note('Index.md', retained + '[[Example]]\n');
  const [repair] = planMove([source, index], source.path, 'Reference/Example.md', parser);
  assert.equal(repair.text, retained + '[[Reference/Example]]\n');
});

test('live HTML embeds still block a move', () => {
  const index = note('Index.md', 'Contact <team@example.test>.\n\n<img srcset="Example.md 1x">\n');
  assert.throws(() => planMove([source, index], source.path, 'Reference/Example.md', parser),
    error => error instanceof MoveLinkError && error.location.reason === 'html_link_attribute');
});

test('parser-confirmed unrelated absolute file and external links stay unchanged', () => {
  const other = [
    '[PDF](file:///example/Report(2026).pdf) and <https://example.test/page>',
    '[Note](file:///external/Reference%20notes.md)',
    '[Folder](<file:///external/Reference folder/>)',
    '[Same stem but another extension](file:///external/Example.wav)',
    '[Call](tel:+1-555-0100) [Artifact](sandbox:/mnt/data/sample.md)',
    '',
  ].join('\n');
  const [repair] = planMove([source, note('Index.md', other + '[[Example]]')], source.path, 'Reference/Example.md', parser);
  assert.equal(repair.text, other + '[[Reference/Example]]');
  for (const endpoint of ['Example.md', 'Ex%61mple.md', 'New.md', 'Example.md#heading']) {
    const index = note('Index.md', '[note](file:///some/mount/' + endpoint + ')');
    assert.throws(() => planMove([source, index], source.path, 'Reference/New.md', parser), /ambiguous_link/);
  }
  const unknown = note('Index.md', '[Note](obsidian://open?vault=Demo&file=Areas%2FExample)');
  assert.throws(() => planMove([source, unknown], source.path, 'Reference/New.md', parser),
    error => error instanceof MoveLinkError && error.location.reason === 'target_scheme');
  const encodedSeparator = note('Index.md', '[note](file:///some/mount/Areas%2FExample.md)');
  assert.throws(() => planMove([source, encodedSeparator], source.path, 'Reference/New.md', parser), /unsupported_links/);
});

const projectPath = 'Example/Projects/Active/Service a heater.md';
const donePath = 'Example/Projects/Done/Service a heater.md';
test('sibling move preserves a stable short path and ignores unrelated missing and ambiguous links', () => {
  const project = note(projectPath, '[[Areas/Equipment]]\n[Equipment](../../Areas/Equipment.md)\n[[#Checklist]]\n');
  const index = note('Example/Index.md', '[[Example/Projects/Active/Service a heater]]\n[[Missing]]\n[[Equipment]]\n');
  const notes = [project, index, note('Example/Areas/Equipment.md', ''), note('Copy/Reference/Equipment.md', '')];
  assert.deepEqual(planMove(notes, projectPath, donePath, parser), [{
    path: index.path, expectedHash: index.hash,
    text: '[[Example/Projects/Done/Service a heater]]\n[[Missing]]\n[[Equipment]]\n',
    hash: hashText('[[Example/Projects/Done/Service a heater]]\n[[Missing]]\n[[Equipment]]\n'),
  }]);
});

for (const [title, backlink, extra] of [
  ['duplicate source basename', '[[Service a heater]]', 'Copy/Service a heater.md'],
  ['unresolved short path that could be a backlink', '[[Projects/Active/Service a heater]]'],
  ['missing destination link that would acquire a target', '[[Example/Projects/Done/Service a heater]]'],
  ['contextual link that could acquire the destination', '[[Projects/Done/Service a heater]]'],
  ['Markdown link that would acquire the destination', '[project](Projects/Done/Service%20a%20heater.md)'],
] as const) {
  test(`${title} blocks the move`, () => {
    const notes = [note(projectPath, ''), note('Example/Index.md', backlink)];
    if (extra) notes.push(note(extra, ''));
    assert.throws(() => planMove(notes, projectPath, donePath, parser), /ambiguous_link/);
  });
}

test('a short outgoing path with a possible target under the destination sibling blocks the move', () => {
  const notes = [
    note(projectPath, '[[Areas/Equipment]]\n'),
    note('Example/Projects/Done/Areas/Equipment.md', ''),
  ];
  assert.throws(() => planMove(notes, projectPath, donePath, parser), /ambiguous_link/);
});

test('a relative link that would rebase from a missing target fails closed', () => {
  const notes = [note(projectPath, '[Equipment](Areas/Equipment.md)\n')];
  assert.throws(() => planMove(notes, projectPath, donePath, parser), /ambiguous_link/);
});

test('a repair that would introduce an ambiguous wiki path fails closed', () => {
  const notes = [
    note(projectPath, ''),
    note('Example/Index.md', '[[Example/Projects/Active/Service a heater]]'),
    note('Copy/Example/Projects/Done/Service a heater.md', ''),
  ];
  assert.throws(() => planMove(notes, projectPath, donePath, parser), /ambiguous_link/);
});

test('repairs angle and table destinations while preserving every surrounding byte', () => {
  const from = 'Workspace/Active/Café (north) & south.md';
  const to = 'Workspace/Done/Café (north) & south.md';
  const section = '#Section%20%C3%A9';
  const escapedAlias = '\\|display';
  const before = [
    '\uFEFF😀 [label with [brackets]](<Active/Café (north) & south.md' + section + '> \'quoted title\')',
    '',
    '| Wiki | Markdown |',
    '| ---- | -------- |',
    '| ![[Workspace/Active/Café (north) & south#Heading' + escapedAlias + ']] | [image](Files/A%26B%28v2%29.txt) |',
    '',
    '![screen][surface]',
    '',
    '[surface]: <data:image/png;base64,AAAA> "image title"',
    '',
  ].join('\r\n');
  const expected = before
    .replace('Active/Café (north) & south.md', 'Done/Caf%C3%A9%20%28north%29%20%26%20south.md')
    .replace('Workspace/Active/', 'Workspace/Done/');
  const repairs = planMove([note(from, ''), note('Workspace/Index.md', before)], from, to, parser);
  assert.equal(repairs.length, 1);
  assert.deepEqual(Buffer.from(repairs[0].text), Buffer.from(expected));
  assert.equal(repairs[0].hash, hashText(expected));
});

test('encoded note destinations preserve literal fragments and distinguish encoded path characters', () => {
  const index = note('Index.md', '[back](Areas/Example%2Emd#part%23one) [other](Areas/Example%23Other.md)\n');
  const [repair] = planMove([source, index], source.path, 'Reference/Ex(ample).md', parser);
  assert.equal(repair.text, '[back](Reference/Ex%28ample%29.md#part%23one) [other](Areas/Example%23Other.md)\n');
  const uncertain = note('Index.md', '[back](Areas%2FExample.md)');
  assert.throws(() => planMove([source, uncertain], source.path, 'Reference/Example.md', parser),
    error => error instanceof MoveLinkError && error.location.reason === 'target_encoding');
});

test('still refuses destinations hidden in local and non-raster reference definitions', () => {
  for (const link of ['<Areas/Example.md>', 'data:image/svg+xml;base64,AAAA']) {
    const index = note('Index.md', '![image][ref]\n\n[ref]: ' + link);
    assert.throws(() => planMove([source, index], source.path, 'Reference/Example.md', parser),
      error => error instanceof MoveLinkError && error.location.reason === 'reference_definition');
  }
});

test('an affected encoded fragment delimiter cannot establish an outgoing target', () => {
  const from = 'Workspace/Active/Example.md';
  const to = 'Workspace/Done/Example.md';
  const notes = [note(from, '[Guide](./Guide%20%231.md)'), note('Workspace/Active/Guide #1.md', '')];
  assert.throws(() => planMove(notes, from, to, parser),
    error => error instanceof MoveLinkError && error.location.reason === 'target_encoding');
});


test('fenced reference examples keep exact bytes while malformed live references block', () => {
  const example = '\`\`\`markdown\r\n[demo]: Areas/Example.md\r\n[image]: data:image/png;base64,AAAA\r\n\`\`\`\r\n\r\n';
  const index = note('Index.md', example + '[[Example]]');
  const [repair] = planMove([source, index], source.path, 'Reference/Example.md', parser);
  assert.equal(repair.text, example + '[[Reference/Example]]');

  const malformed = note('Index.md', 'Body\n\n[broken]: [[Example]] trailing markup\n');
  assert.throws(() => planMove([source, malformed], source.path, 'Reference/Example.md', parser),
    error => error instanceof MoveLinkError && error.location.reason === 'reference_definition');
});
