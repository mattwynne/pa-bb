import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteSearch } from '../adapters/note-search.ts';
import { NoteStore } from '../adapters/note-store.ts';
const enabled=process.platform==='linux'&&!!process.env.RIPGREP_TEST_BINARY;
const request={mirrorId:'one',revision:1,projection:'markdown' as const};
async function fixture(){const root=await mkdtemp('/tmp/icloud-search-lifecycle-'),vault=join(root,'vault'),store=new NoteStore(join(root,'legacy'));await mkdir(vault);return{root,vault,store};}
const waitFor=async(path:string)=>{for(let i=0;i<200;i++){try{return Number(await readFile(path,'utf8'));}catch{await new Promise(r=>setTimeout(r,10));}}throw new Error('generated child did not start');};
async function executable(root:string,hangVersion=false){const binary=join(root,'rg'),pid=join(root,'child.pid');await writeFile(binary,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--version')&&!${hangVersion})console.log('ripgrep 14.1.0');else{fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}\n`);await chmod(binary,0o700);return{binary,pid};}
test('escaped semantic candidates retain every response remainder and visit each path once', {skip:!enabled},async()=>{
 const f=await fixture(),engine=new NoteSearch(f.store,{paths:()=>[],reader:(_id,path)=>f.store.searchReader(f.vault,path)},process.env.RIPGREP_TEST_BINARY);
 try{for(let i=0;i<20;i++)await writeFile(join(f.vault,`${i}.md`),'\t'.repeat(60000));let cursor:string|undefined,visited=0,pages=0;const paths:string[]=[];
 do{const batch=await engine.next({...request,cursor},f.vault,()=>{});assert.ok(Buffer.byteLength(JSON.stringify(batch))<1048576);visited+=batch.visited;paths.push(...batch.candidates.map(c=>c.path));assert.ok(batch.candidates.every(c=>c.content?.length===60000));cursor=batch.nextCursor??undefined;pages++;}while(cursor);
 assert.equal(visited,20);assert.equal(paths.length,20);assert.equal(new Set(paths).size,20);assert.ok(pages>1);
 }finally{await engine.stop();await rm(f.root,{recursive:true,force:true});}
});
test('closing the known session kills and awaits a child that ignores TERM and releases every reader', {skip:!enabled},async()=>{
 const f=await fixture(),fake=await executable(f.root);let closed=0;const engine=new NoteSearch(f.store,{paths:()=>[],reader:async(_id,path)=>{const reader=await f.store.searchReader(f.vault,path);return{...reader,close:async()=>{await reader.close();closed++;}};}},fake.binary);
 try{await writeFile(join(f.vault,'Note.md'),'needle');const opened=await engine.next({...request,startOnly:true},f.vault,()=>{});assert.ok(opened.nextCursor);
 const pending=engine.next({...request,cursor:opened.nextCursor!},f.vault,()=>{});const rejected=assert.rejects(pending,(e:any)=>e.category==='cancelled');const pid=await waitFor(fake.pid);await engine.close(opened.nextCursor!);await rejected;
 assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');assert.equal(closed,1);assert.equal(engine.sessionCount,0);
 }finally{await engine.stop();await rm(f.root,{recursive:true,force:true});}
});
test('stop cancels and awaits an in-flight version probe too', {skip:!enabled},async()=>{
 const f=await fixture(),fake=await executable(f.root,true),engine=new NoteSearch(f.store,{paths:()=>[],reader:(_id,path)=>f.store.searchReader(f.vault,path)},fake.binary);
 try{const pending=engine.capability(),pid=await waitFor(fake.pid);await engine.stop();assert.equal((await pending).available,false);assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');}
 finally{await engine.stop();await rm(f.root,{recursive:true,force:true});}
});
test('malformed output and private stderr become a fixed failure without leaked child data', {skip:!enabled},async()=>{
 const f=await fixture(),fake=await executable(f.root);await writeFile(fake.binary,`#!${process.execPath}\nif(process.argv.includes('--version'))console.log('ripgrep 14.1.0');else{process.stderr.write('sentinel-private-content /private/path token');console.log('sentinel-private-output');}\n`);const engine=new NoteSearch(f.store,{paths:()=>[],reader:(_id,path)=>f.store.searchReader(f.vault,path)},fake.binary);
 try{await writeFile(join(f.vault,'Note.md'),'needle');await assert.rejects(engine.next(request,f.vault,()=>{}),(error:any)=>{assert.equal(error.category,'unavailable');assert.doesNotMatch(JSON.stringify(error)+error.message,/sentinel|private|token/);return true;});assert.equal(engine.sessionCount,0);}finally{await engine.stop();await rm(f.root,{recursive:true,force:true});}
});
test('four sessions are bounded, closed cursors expire, and environment configuration cannot preprocess notes', {skip:!enabled},async()=>{
 const f=await fixture(),engine=new NoteSearch(f.store,{paths:()=>[],reader:(_id,path)=>f.store.searchReader(f.vault,path)},process.env.RIPGREP_TEST_BINARY),old=process.env.RIPGREP_CONFIG_PATH;
 try{await writeFile(join(f.vault,'Note.md'),'needle');const config=join(f.root,'config');await writeFile(config,'--pre=/private-sentinel-not-executed\n');process.env.RIPGREP_CONFIG_PATH=config;
 const cursors:string[]=[];for(let i=0;i<4;i++){const batch=await engine.next({...request,startOnly:true},f.vault,()=>{});cursors.push(batch.nextCursor!);}await assert.rejects(engine.next({...request,startOnly:true},f.vault,()=>{}),(e:any)=>e.category==='capacity');
 const batch=await engine.next({...request,cursor:cursors[0]},f.vault,()=>{});assert.equal(batch.candidates.length,1);await engine.close(cursors[1]);await assert.rejects(engine.next({...request,cursor:cursors[1]},f.vault,()=>{}),(e:any)=>e.category==='cursor_expired');
 }finally{if(old===undefined)delete process.env.RIPGREP_CONFIG_PATH;else process.env.RIPGREP_CONFIG_PATH=old;await engine.stop();await rm(f.root,{recursive:true,force:true});}
});
