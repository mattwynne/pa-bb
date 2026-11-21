import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { createMovePlanner, hashText } from '../core/move.ts';
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
