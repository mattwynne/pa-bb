import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { VaultError } from '../core/ports.ts';
import { Obsidian } from '../core/service.ts';
import { MarkdownNotes } from '../adapters/markdown-notes.ts';
import { CatalogFake, FilesFake, MemoryState } from './fakes.ts';
async function fixture() { const files=new FilesFake(), catalog=new CatalogFake();const service=new Obsidian(catalog,files,new MarkdownNotes(),new MemoryState(),randomUUID,Date.now,()=>{});await service.start();await service.connect('one');return{files,catalog,service}; }
test('count-only search follows real continuation and returns a total only after filtering all candidates',async()=>{
 const f=await fixture();try{f.files.notes.clear();for(let i=0;i<2800;i++)f.files.notes.set(`one/${i}.md`,`---\nstatus: ${i%2?'inactive':'active'}\n---\nstatus: active is body prose\n`);
 let cursor:string|undefined, result:any;do{result=await f.service.search({mode:'count',properties:[{key:'status',equals:'active'}],cursor} as any);if(result.nextCursor)assert.equal(result.totalMatches,null);cursor=result.nextCursor??undefined;}while(cursor);
 assert.equal(result.totalMatches,1400);assert.equal(result.coverage.state,'complete');assert.equal(result.incomplete,false);assert.deepEqual(result.results,[]);
 }finally{f.service.stop();}
});
test('counting covers all twenty connected sources and includes an ordinary saved note',async()=>{
 const ids=Array.from({length:20},(_,i)=>`vault-${i}`),files=new FilesFake(),catalog=new CatalogFake(),state=new MemoryState();state.value={revision:1,vaultIds:ids,pending:[]};const base=catalog.value.sources[0];catalog.value.sources=ids.map(id=>({...structuredClone(base),id}));files.notes.clear();for(const id of ids)files.notes.set(`${id}/Only.md`,'---\nstatus: active\n---\n');const service=new Obsidian(catalog,files,new MarkdownNotes(),state,randomUUID,Date.now,()=>{});await service.start();
 try{await service.create({vaultId:ids[19],path:'Saved.md',text:'---\nstatus: active\n---\n'});let page:any,cursor:string|undefined;do{page=await service.search(cursor?{cursor}:{mode:'count',properties:[{key:'status',equals:'active'}]});cursor=page.nextCursor??undefined;}while(cursor);assert.equal(page.totalMatches,21);assert.equal(page.scope.vaultIds.length,20);assert.equal(page.coverage.state,'complete');}finally{await service.stop();}
});
test('explicit exclusions are query scopes, copies remain accessible, and search does not grant edit proof',async()=>{
 const f=await fixture();try{f.files.notes.clear();f.files.notes.set('one/.worktrees/Copy.md','---\nstatus: active\n---\nneedle\n');f.files.notes.set('one/Projects/A.md','---\n"status": "active"\n---\nneedle\n');
 const r:any=await f.service.search({text:'needle',excludeFolders:['.worktrees'],properties:[{key:'status',equals:'active'}]} as any);assert.deepEqual(r.results.map((n:any)=>n.path),['Projects/A.md']);assert.equal(r.totalMatches,1);
 await assert.rejects(f.service.edit({vaultId:'one',path:'Projects/A.md',expectedHash:r.results[0].hash,append:'x'}),(e:any)=>e.category==='complete_read_required');
 assert.match((await f.service.read({vaultId:'one',path:'.worktrees/Copy.md'})).text!,/needle/);
 }finally{f.service.stop();}
});
test('cancellation closes the acquired producer session before returning',async()=>{
 const f=await fixture(),controller=new AbortController();let entered!:()=>void,release!:()=>void;const running=new Promise<void>(r=>entered=r),waiting=new Promise<void>(r=>release=r),search=f.files.search.bind(f.files),close=f.files.closeSearch.bind(f.files);let closed=0;
 try{f.files.search=async(input,signal)=>{if(input.startOnly)return search(input);entered();await waiting;if(signal?.aborted)throw new VaultError('cancelled');return search(input);};f.files.closeSearch=async(revision,cursor)=>{closed++;await close(revision,cursor);release();};
 const pending=f.service.search({text:'Launch'},controller.signal);await running;controller.abort();await assert.rejects(pending,(e:any)=>e.category==='cancelled');assert.ok(closed>=1);assert.equal((f.service as any).searcher.sessions.size,0);assert.equal(f.files.saved.length,0);
 }finally{release();await f.service.stop();}
});
test('overlapping continuations return busy without deleting the original cursor',async()=>{
 const f=await fixture();let release!:()=>void;try{f.files.notes.set('one/Second.md','Launch');const first=await f.service.search({text:'Launch',limit:1});assert.ok(first.nextCursor);let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r),snapshot=f.catalog.snapshot.bind(f.catalog);f.catalog.snapshot=async()=>{entered();await hold;return snapshot();};
 const pending=f.service.search({cursor:first.nextCursor!,limit:1});await waiting;await assert.rejects(f.service.search({cursor:first.nextCursor!}),(e:any)=>e.category==='busy');release();const second=await pending;assert.ok(second.results.length);assert.notEqual(second.results[0].path,first.results[0].path);
 }finally{release?.();await f.service.stop();}
});
test('missing search capability does not revoke connections or ordinary local reads',async()=>{
 const f=await fixture();try{f.catalog.value.search={version:1,available:false,reason:'missing_executable'};await assert.rejects(f.service.search({text:'Launch'}),(e:any)=>e.category==='unsupported');assert.equal((await f.service.status()).vaults.length,1);assert.equal((await f.service.read({vaultId:'one',path:'Launch.md'})).complete,true);}finally{await f.service.stop();}
});
test('frontmatter-only filtering accepts a long body, rejects invalid YAML without claiming a total, and text does not depend on YAML',async()=>{
 const f=await fixture();try{f.files.notes.clear();f.files.notes.set('one/Long.md','\uFEFF---\r\n{status: active}\r\n---\r\n'+'x'.repeat(70000));
 const r:any=await f.service.search({properties:[{key:'status',equals:'active'}],mode:'count'} as any);assert.equal(r.totalMatches,1);
 f.files.notes.set('one/Bad.md','---\nstatus: [\n---\nneedle');const p:any=await f.service.search({properties:[{key:'status',equals:'active'}],mode:'count'} as any);assert.equal(p.totalMatches,null);assert.equal(p.coverage.state,'partial');
 const text:any=await f.service.search({text:'needle',mode:'count'} as any);assert.equal(text.totalMatches,1);
 }finally{f.service.stop();}
});
