import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { NoteStore } from '../adapters/note-store.ts';
import { NoteMoves } from '../adapters/note-move.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture(fault?: (s: string) => void | Promise<void>) {
 const root = await mkdtemp(join(tmpdir(), 'note-move-'));
 await mkdir(join(root,'Areas')); await mkdir(join(root,'Reference'));
 await writeFile(join(root,'Areas/Example.md'), 'original');
 const db = new Database(join(root,'state.sqlite')); db.pragma('synchronous=FULL');
 db.exec('CREATE TABLE icloud_note_overlay_totals(id INTEGER PRIMARY KEY, recovery_bytes INTEGER, staged_recovery_bytes INTEGER); INSERT INTO icloud_note_overlay_totals VALUES(1,0,0)');
 const files = new NoteStore(join(root,'private'), { fault });
 const moves = new NoteMoves(db, files); moves.start();
 return { root, db, files, moves, input: { mirrorId:'one', path:'Areas/Example.md', destination:'Reference/New example.md', expectedHash:hash('original'), operationId: randomUUID() }, async close(){db.close();await rm(root,{recursive:true,force:true});} };
}
test('move/rename never overwrites, retains original, returns idempotent receipt',async()=>{
 const f=await fixture();try{
  const r=await f.moves.move(f.root,f.input);assert.equal(r.outcome,'moved_locally_pending_sync');
  assert.equal(await readFile(join(f.root,f.input.destination),'utf8'),'original');await assert.rejects(lstat(join(f.root,f.input.path)));
  assert.equal((f.db.prepare('SELECT original FROM icloud_note_moves').get() as any).original,'original');
  assert.deepEqual(await f.moves.move(f.root,f.input),r);
  await assert.rejects(f.moves.move(f.root,{...f.input,destination:'Reference/Other.md'}),/operation_reused/);
 }finally{await f.close();}
});
for(const kind of ['collision','stale','cancelled'] as const)test(kind+' refuses before journal/file change',async()=>{
 const f=await fixture();try{
  if(kind==='collision')await writeFile(join(f.root,f.input.destination),'unrelated');
  const controller=new AbortController();if(kind==='cancelled')controller.abort();
  await assert.rejects(f.moves.move(f.root,{...f.input,expectedHash:kind==='stale'?hash('stale'):f.input.expectedHash},controller.signal));
  assert.equal(await readFile(join(f.root,f.input.path),'utf8'),'original');assert.equal(f.moves.receipts('one').length,0);
  if(kind==='collision')assert.equal(await readFile(join(f.root,f.input.destination),'utf8'),'unrelated');
 }finally{await f.close();}
});
for(const stage of ['before_move_link','after_move_link','after_move_destination_sync','after_move_unlink','after_move_source_sync'])test('fault '+stage+' retains evidence without replay',async()=>{
 const f=await fixture(s=>{if(s===stage)throw new Error('PRIVATE_SENTINEL');});try{
  const r=await f.moves.move(f.root,f.input); const expected=stage==='before_move_link'?'not_moved':stage.includes('unlink')||stage==='after_move_source_sync'?'moved_locally_pending_sync':'uncertain';
  assert.equal(r.outcome,expected);assert.equal(JSON.stringify(r).includes('PRIVATE_SENTINEL'),false);
  const restarted=new NoteMoves(f.db,f.files);assert.deepEqual(await restarted.move(f.root,f.input),r);
  if(expected==='uncertain'){assert.equal(restarted.blocked('one'),true);assert.equal(await readFile(join(f.root,f.input.path),'utf8'),'original');}
 }finally{await f.close();}
});
for (const stage of ['before_move_link', 'after_move_link', 'after_move_unlink']) test('SIGKILL '+stage+' leaves a durable inspectable receipt, never replays', async()=>{
 const f=await fixture();try{
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
   import Database from 'better-sqlite3';
   import {NoteStore} from ${JSON.stringify(new URL('../adapters/note-store.ts',import.meta.url).href)};
   import {NoteMoves} from ${JSON.stringify(new URL('../adapters/note-move.ts',import.meta.url).href)};
   const db=new Database(process.env.MOVE_ROOT+'/state.sqlite');db.pragma('synchronous=FULL');
   const store=new NoteStore(process.env.MOVE_ROOT+'/private',{fault(s){if(s===process.env.MOVE_STAGE)process.kill(process.pid,'SIGKILL');}});
   const moves=new NoteMoves(db,store);moves.start();await moves.move(process.env.MOVE_ROOT,JSON.parse(process.env.MOVE_INPUT));
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,MOVE_ROOT:f.root,MOVE_STAGE:stage,MOVE_INPUT:JSON.stringify(f.input)},encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const restarted=new NoteMoves(f.db,f.files);assert.equal(restarted.receipts('one')[0].outcome,'uncertain');
  await restarted.inspect(f.root,'one');
  assert.equal(restarted.receipts('one')[0].outcome,stage==='before_move_link'?'not_moved':stage==='after_move_link'?'uncertain':'moved_locally_pending_sync');
  const result=await restarted.move(f.root,f.input);assert.deepEqual(result,restarted.receipts('one')[0]);
 }finally{await f.close();}
});

test('cancellation after destination creation leaves uncertainty and both originals',async()=>{
 const controller=new AbortController();const f=await fixture(s=>{if(s==='after_move_link')controller.abort();});try{
  assert.equal((await f.moves.move(f.root,f.input,controller.signal)).outcome,'uncertain');
  assert.equal(await readFile(join(f.root,f.input.path),'utf8'),'original');assert.equal(await readFile(join(f.root,f.input.destination),'utf8'),'original');
 }finally{await f.close();}
});
