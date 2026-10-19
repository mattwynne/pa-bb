import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { NoteRuntime } from '../adapters/note-runtime.ts';
import { NoteStore } from '../adapters/note-store.ts';
import { RcloneProcess } from '../adapters/rclone-process.ts';
import { syncArguments } from '../adapters/rclone-cloud-provider.ts';
import type { State } from '../core/ports.ts';
const enabled=process.platform==='linux'&&!!process.env.RIPGREP_TEST_BINARY&&!!process.env.RCLONE_TEST_BINARY;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const operation=()=>{const time=Date.now().toString(16).padStart(12,'0');return`${time.slice(0,8)}-${time.slice(8)}-7${randomUUID().slice(15)}`;};
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
async function fixture(){
 const root=await mkdtemp('/tmp/icloud-search-runtime-generated-'),sync=join(root,'sync'),alias=join(root,'alias'),local=join(sync,'mirrors/one'),baseline=join(sync,'baselines/one');
 const db=new Database(join(root,'data.db'));db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');
 const state:State={connected:true,challenge:null,mirrors:[{id:'one',folder:{id:'generated',name:'Generated',ancestors:[]},initialized:true,enabled:false,phase:'paused',lastSuccess:null,failure:null,blocker:null}]};
 const worker=new RcloneProcess(sync,process.env.RCLONE_TEST_BINARY!),notes=new NoteStore(join(sync,'note-operations'));
 let runtime:NoteRuntime|undefined;
 try{await mkdir(alias);await writeFile(join(alias,'Old.md'),'needle old');await worker.ensure();await worker.call('config/create',{name:'icloud',type:'alias',parameters:{remote:alias},opt:{nonInteractive:true}});await mkdir(local);await mkdir(baseline);await worker.run(syncArguments('icloud:',local,baseline,true));await writeFile(join(baseline,'initialized'),'1',{mode:0o600});
 runtime=new NoteRuntime(sync,db,worker,notes,()=>state);await runtime.start();runtime.configure(1,['one']);
 return{root,local,runtime,state,async close(){await runtime!.stop();db.close();await rm(root,{recursive:true,force:true});}};
 }catch(error){await runtime?.stop();await worker.stop();db.close();await rm(root,{recursive:true,force:true});throw error;}
}
test('ripgrep uses pending logical edits and creates without waiting for a reserved native turn', {skip:!enabled},async()=>{
 const f=await fixture(),entered=gate(),release=gate();let turn:Promise<unknown>|undefined;
 try{turn=f.runtime.idleFiles(async()=>{entered.resolve();await release.promise;});await entered.promise;
 await f.runtime.commit(1,{mirrorId:'one',operationId:operation(),kind:'replace',path:'Old.md',expectedHash:hash('needle old'),text:'no longer matches'});
 await f.runtime.commit(1,{mirrorId:'one',operationId:operation(),kind:'create',path:'Pending.md',expectedHash:null,text:'needle pending'});
 assert.equal(await readFile(join(f.local,'Old.md'),'utf8'),'needle old');
 const result=await f.runtime.searchNotes({mirrorId:'one',revision:1,text:'needle',projection:'hits'});
 assert.deepEqual(result.candidates.map(c=>c.path),['Pending.md']);assert.equal(result.nextCursor,null);assert.equal(result.warnings.length,0);
 const none=await f.runtime.searchNotes({mirrorId:'one',revision:1,text:'needle old',projection:'hits'});assert.deepEqual(none.candidates,[]);
 }finally{release.resolve();await turn;await f.close();}
});
test('removal fences a search paused after reader acquisition and closes its session', {skip:!enabled},async()=>{
 const f=await fixture(),entered=gate(),release=gate();
 try{const view=(f.runtime.search as any).view,reader=view.reader;view.reader=async(...args:any[])=>{const result=await reader(...args);entered.resolve();await release.promise;return result;};
 const pending=f.runtime.searchNotes({mirrorId:'one',revision:1,text:'needle',projection:'hits'});await entered.promise;f.runtime.configure(2,[]);release.resolve();await assert.rejects(pending);assert.equal(f.runtime.search.sessionCount,0);
 assert.equal((await f.runtime.availability('one')).available,true,'removal revokes consumer access, not the local source');
 }finally{release.resolve();await f.close();}
});
