import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore } from '../adapters/note-store.ts';
import { NoteSearch } from '../adapters/note-search.ts';
const enabled = process.platform === 'linux' && !!process.env.RIPGREP_TEST_BINARY;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'icloud-search-generated-'));
  const store = new NoteStore(join(root, 'legacy'));
  await mkdir(join(root, 'vault'));
  const engine = new NoteSearch(store, { paths: () => [], reader: (_id: string, path: string) => store.searchReader(join(root, 'vault'), path) }, process.env.RIPGREP_TEST_BINARY);
  return { root, vault: join(root, 'vault'), store, engine, async close() { await engine.stop(); await rm(root, { recursive: true, force: true }); } };
}
test('real ripgrep continues past entry, byte, note and result cutoffs without per-note RPC', { skip: !enabled }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vault, '.hidden')); await writeFile(join(f.vault, '.gitignore'), '*.md\n');
    for (let i = 0; i < 12000; i++) await writeFile(join(f.vault, `${String(i).padStart(5, '0')}.md`), `${i % 20 === 0 || i === 11999 ? 'needle\n' : 'other\n'}${'x'.repeat(1500)}`);
    await writeFile(join(f.vault, '.hidden/Last.md'), 'needle');
    let cursor: string | undefined; const paths: string[] = []; let visited = 0;
    do { const page = await f.engine.next({ mirrorId: 'one', revision: 1, text: 'needle', projection: 'hits', cursor }, f.vault, () => {}); paths.push(...page.candidates.map(c => c.path)); visited += page.visited; assert.equal(page.warnings.length, 0); cursor = page.nextCursor ?? undefined; } while(cursor);
    assert.equal(visited, 12001); assert.equal(paths.length, 602); assert.equal(new Set(paths).size, 602); assert.ok(paths.includes('11999.md')); assert.ok(paths.includes('.hidden/Last.md'));
  } finally { await f.close(); }
});
test('colon filenames and folders are searched without omissions or scope-prefix leakage', { skip: !enabled }, async () => {
  const f=await fixture();try {
    await mkdir(join(f.vault,'Notes: 2026'));await mkdir(join(f.vault,'Notes: 2026-old'));
    for(const path of ['Topic: Active.md','Notes: 2026/Meeting: Friday.md','Notes: 2026-old/Other.md'])await writeFile(join(f.vault,path),'---\nstatus: active\n---\nneedle\n');
    for(const projection of ['hits','frontmatter'] as const){const result=await f.engine.next({mirrorId:'one',revision:1,projection,...(projection==='hits'?{text:'needle'}:{})},f.vault,()=>{});assert.equal(result.candidates.length,3);assert.deepEqual(result.warnings,[]);assert.equal(result.nextCursor,null);}
    const scoped=await f.engine.next({mirrorId:'one',revision:1,projection:'hits',text:'needle',folders:['Notes: 2026']},f.vault,()=>{});assert.deepEqual(scoped.candidates.map(c=>c.path),['Notes: 2026/Meeting: Friday.md']);assert.deepEqual(scoped.warnings,[]);
    const excluded=await f.engine.next({mirrorId:'one',revision:1,projection:'hits',text:'needle',excludeFolders:['Notes: 2026']},f.vault,()=>{});assert.equal(excluded.candidates.length,2);assert.deepEqual(excluded.warnings,[]);
  }finally{await f.close();}
});
test('literal, multiline, option-like input, explicit folder boundaries and empty files', { skip: !enabled }, async () => {
  const f = await fixture(); try {
    await mkdir(join(f.vault,'Notes')); await mkdir(join(f.vault,'Notes-old'));
    await writeFile(join(f.vault,'Notes/A.md'),'alpha\nbeta\n-n\n'); await writeFile(join(f.vault,'Notes/Empty.md'),''); await writeFile(join(f.vault,'Notes-old/B.md'),'alpha\nbeta');
    const run = (text?: string) => f.engine.next({ mirrorId:'one',revision:1,text,projection:'hits',folders:['Notes'] },f.vault,()=>{});
    assert.deepEqual((await run('ALPHA\nbeta')).candidates.map(c=>c.path),['Notes/A.md']);
    assert.equal((await run('-n')).candidates.length,1); assert.equal((await run('absent')).candidates.length,0); assert.equal((await run()).candidates.length,2);
  } finally { await f.close(); }
});
test('reader is pinned, verifies publication changes, refuses symlinks, and cursor guards run before delivery', { skip: !enabled }, async () => {
  const f=await fixture(); try {
    await writeFile(join(f.vault,'A.md'),'needle'); const reader=await f.store.searchReader(f.vault,'A.md');
    await rename(join(f.vault,'A.md'),join(f.vault,'Old.md')); await symlink(join(f.root,'outside.md'),join(f.vault,'A.md')); await writeFile(join(f.root,'outside.md'),'private-sentinel');
    await assert.rejects(reader.verify()); await reader.close(); await assert.rejects(f.store.searchReader(f.vault,'A.md'));
    await assert.rejects(f.engine.next({mirrorId:'one',revision:1,text:'needle',projection:'hits'},f.vault,()=>{throw new Error('revoked');}));
    assert.equal(f.engine.sessionCount,0);
  } finally { await f.close(); }
});
test('missing ripgrep is search-only unavailability and cursor cannot silently change its query', { skip: !enabled }, async () => {
  const f=await fixture(); try {
    assert.equal((await new NoteSearch(f.store, {paths:()=>[],reader:(_id,path)=>f.store.searchReader(f.vault,path)},'/nonexistent/rg').capability()).available,false);
    for(let i=0;i<70;i++) await writeFile(join(f.vault,`${i}.md`),'needle');
    const page=await f.engine.next({mirrorId:'one',revision:1,text:'needle',projection:'hits'},f.vault,()=>{}); assert.ok(page.nextCursor);
    await assert.rejects(f.engine.next({mirrorId:'one',revision:1,text:'changed',projection:'hits',cursor:page.nextCursor!},f.vault,()=>{}));
  } finally { await f.close(); }
});
