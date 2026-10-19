// Generated-data Linux BB proof: captured original handlers + verified SDK caller.
// Uses the same wrappers as run-linux.mjs; no model/provider conversation.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, rm, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
const exec=promisify(execFile),bb=resolve(process.env.BB_FIXTURE_BB_ROOT??''),source=resolve(process.env.BB_FIXTURE_SOURCE??''),deps=resolve(process.env.BB_FIXTURE_DEPENDENCIES??''),artifacts=resolve(process.env.BB_FIXTURE_ARTIFACTS??''),port=Number(process.env.BB_FIXTURE_PORT??44887);
assert.equal(process.platform,'linux');for(const path of [bb,source,deps,artifacts])assert.notEqual(path,resolve('.'));assert.ok(artifacts.startsWith('/tmp/'));assert.ok(Number.isInteger(port)&&port>1024&&port<65534);
for(const p of [port,port+1])await new Promise((ok,fail)=>{const server=createServer();server.once('error',fail);server.listen(p,'127.0.0.1',()=>server.close(ok));});
const root=await mkdtemp('/tmp/pa-installed-search-'),base=`http://127.0.0.1:${port}`;
const env={HOME:join(root,'home'),PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',NODE_ENV:'production',BB_DATA_DIR:join(root,'data'),BB_SERVER_URL:base,BB_SERVER_BIND_HOST:'127.0.0.1',BB_SERVER_PORT:String(port),BB_HOST_DAEMON_PORT:String(port+1),BB_GENERATED_ALIAS_ROOT:join(root,'alias')};
await mkdir(artifacts,{recursive:true});await mkdir(env.HOME);await mkdir(env.BB_DATA_DIR);
const cli=async(...args)=>(await exec(process.execPath,[join(bb,'host-daemon/dist/bb'),...args],{env,cwd:root,timeout:180000,maxBuffer:2e6})).stdout;
const rpc=async(id,method,input=null)=>{const response=await fetch(`${base}/api/v1/plugins/${id}/rpc/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)}),body=await response.json();assert.equal(body.ok,true,JSON.stringify(body).slice(0,500));return body.result;};
const invoke=async(name,input)=>{const result=await rpc('obsidian','fixtureInvoke',{name,input});assert.equal(result.isError,false,result.text);return JSON.parse(result.text);};
const wait=async(check)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('generated fixture boundary did not complete');};
const record={root,port,providerConversation:false,personalNotesRead:false,originalHandlers:true,checks:[]},processes=[];
const save=()=>writeFile(join(artifacts,'result.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
const note=(active,body='needle',padding='')=>`---\nstatus: ${active?'active':'inactive'}\npriority: 7\napproved: true\ncategory: null\n---\n${body}\n${padding}`;
try{
 const main=join(env.BB_GENERATED_ALIAS_ROOT,'generated'),other=join(env.BB_GENERATED_ALIAS_ROOT,'other');await mkdir(join(main,'.hidden: generated'),{recursive:true});await mkdir(join(main,'.worktrees'));await mkdir(other,{recursive:true});
 const active=[],literal=[];
 for(let i=0;i<12000;i++){const path=i===0?'Topic: Active.md':String(i).padStart(5,'0')+'.md',hit=i%20===0||i===11999;await writeFile(join(main,path),note(hit,hit?'needle':'other','x'.repeat(1500)));if(hit){active.push(path);literal.push(path);}}
 for(const path of ['.hidden: generated/Final: note.md','.worktrees/Copy.md']){await writeFile(join(main,path),note(true));active.push(path);literal.push(path);}
 await writeFile(join(main,'Body.md'),note(false,'status: active is prose; needle'));literal.push('Body.md');await writeFile(join(main,'.gitignore'),'*.md\n');await writeFile(join(other,'Other.md'),note(true));
 for(const id of ['icloud','obsidian']){
  const dir=join(root,'packages',id);await mkdir(dir,{recursive:true});for(const item of await readdir(join(source,'plugins',id))){if(['server.ts','test','dist','node_modules'].includes(item))continue;if(!/\.(?:ts|tsx|css|json)$/.test(item)&&!['core','adapters'].includes(item))continue;await cp(join(source,'plugins',id,item),join(dir,item),{recursive:true});}
  await cp(join(source,'plugins',id,'server.ts'),join(dir,'production.ts'));await cp(join(source,'fixtures/installed-bb',`${id}-server.ts`),join(dir,'server.ts'));await symlink(join(deps,id,'node_modules'),join(dir,'node_modules'));await cli('plugin','build',dir);
 }
 const log=await open(join(root,'server.log'),'w',0o600),server=spawn(process.execPath,[join(bb,'server/dist/index.js')],{env,cwd:root,stdio:['ignore',log.fd,log.fd]});processes.push(server);await log.close();
 await wait(async()=>{assert.equal(server.exitCode,null);try{return(await fetch(base+'/',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}});
 assert.equal((await cli('--version')).trim(),'0.45.0');for(const id of ['icloud','obsidian'])assert.equal(JSON.parse(await cli('plugin','install',join(root,'packages',id),'--yes','--json')).plugin.status,'running');
 const tools=JSON.parse(await rpc('obsidian','fixtureCatalog'));assert.equal(tools.length,9);assert.ok(tools.every(t=>t.inputSchema.type==='object'));
 await rpc('obsidian','connect',{vaultId:'one'});await rpc('obsidian','connect',{vaultId:'two'});assert.equal((await rpc('obsidian','status')).search.available,true);
 const collect=async(query)=>{let cursor,pages=0,last,rows=[];do{last=await invoke('obsidian_search_notes',cursor?{cursor,limit:7}:{...query,limit:7});rows.push(...last.results);if(last.coverage.state==='running')assert.equal(last.totalMatches,null);cursor=last.nextCursor;pages++;assert.ok(pages<3000,'continuation failed to advance');}while(cursor);assert.equal(last.coverage.state,'complete');assert.equal(last.incomplete,false);return{last,rows,pages};};
 const text=await collect({vaultId:'one',text:'needle'});assert.deepEqual(text.rows.map(r=>r.path).sort(),literal.sort());assert.equal(text.last.totalMatches,literal.length);assert.equal(new Set(text.rows.map(r=>r.path)).size,literal.length);assert.ok(text.pages>1);record.checks.push({kind:'complete-literal-results',notes:12003,matches:literal.length,pages:text.pages});
 const properties=await collect({vaultId:'one',mode:'count',properties:[{key:'status',equals:'active'},{key:'priority',equals:7},{key:'approved',equals:true},{key:'category',equals:null}]});assert.equal(properties.last.totalMatches,active.length);assert.equal(properties.rows.length,0);record.checks.push({kind:'typed-properties-count',matches:active.length,pages:properties.pages});
 const all=await collect({mode:'count',properties:[{key:'status',equals:'active'}]});assert.equal(all.last.totalMatches,active.length+1);assert.equal(all.last.scope.vaultIds.length,2);record.checks.push({kind:'two-vault-count',matches:active.length+1});
 const scoped=await collect({vaultId:'one',mode:'count',folders:['.worktrees'],properties:[{key:'status',equals:'active'}]});assert.equal(scoped.last.totalMatches,1);
 const row=text.rows.find(r=>r.path==='Topic: Active.md');assert.ok(row);const denied=await rpc('obsidian','fixtureInvoke',{name:'obsidian_edit_note',input:{vaultId:'one',path:row.path,expectedHash:row.hash,append:'must not save'}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.text).category,'complete_read_required');
 const colonScope=await collect({vaultId:'one',mode:'count',folders:['.hidden: generated'],properties:[{key:'status',equals:'active'}]});assert.equal(colonScope.last.totalMatches,1);
 const colonExcluded=await collect({vaultId:'one',mode:'count',excludeFolders:['.hidden: generated'],properties:[{key:'status',equals:'active'}]});assert.equal(colonExcluded.last.totalMatches,active.length-1);
 // Save in the small sibling set: the separate 10,000-entry conflict-copy
 // inspection bound is unchanged, including for ordinary root filenames.
 const editPath='.hidden: generated/Final: note.md',full=await invoke('obsidian_read_note',{vaultId:'one',path:editPath});assert.equal(full.complete,true);await invoke('obsidian_edit_note',{vaultId:'one',path:editPath,expectedHash:full.hash,append:'Generated conditional colon-path save.\n'});assert.match((await invoke('obsidian_read_note',{vaultId:'one',path:editPath})).text,/Generated conditional colon-path save/);
 await invoke('obsidian_create_note',{vaultId:'one',path:'.hidden: generated/Pending: note.md',text:note(true)});const colonPending=await collect({vaultId:'one',mode:'count',folders:['.hidden: generated'],properties:[{key:'status',equals:'active'}]});assert.equal(colonPending.last.totalMatches,2);record.checks.push({kind:'colon-filenames-folders-scopes-cas-and-logical-create',matches:2,searchDidNotGrantEditProof:true});
 await invoke('obsidian_create_note',{vaultId:'one',path:'.worktrees/Pending.md',text:note(true)});const pending=await collect({vaultId:'one',mode:'count',folders:['.worktrees'],properties:[{key:'status',equals:'active'}]});assert.equal(pending.last.totalMatches,2);record.checks.push({kind:'logical-create-and-explicit-folder',matches:2,searchDidNotGrantEditProof:true});
 await writeFile(join(main,'Bad.md'),'---\nstatus: [\n---\nneedle');
 // Publish malformed fixture bytes through the mirrored generated source only,
 // not a production filesystem. Find the installed fixture's private mirror.
 const locate=async(path)=>{for(const e of await readdir(path,{withFileTypes:true})){if(!e.isDirectory()||e.isSymbolicLink())continue;const p=join(path,e.name);if(p.endsWith('/sync/mirrors/one'))return p;const found=await locate(p);if(found)return found;}return null;};
 const mirror=await locate(env.BB_DATA_DIR);assert.ok(mirror);await writeFile(join(mirror,'Bad.md'),'---\nstatus: [\n---\nneedle');let partial,cursor;do{partial=await invoke('obsidian_search_notes',cursor?{cursor}:{vaultId:'one',mode:'count',properties:[{key:'status',equals:'active'}]});cursor=partial.nextCursor;}while(cursor);assert.equal(partial.coverage.state,'partial');assert.equal(partial.totalMatches,null);record.checks.push({kind:'malformed-YAML-count-is-partial'});
 record.versions=JSON.parse(await cli('plugin','list','--json')).plugins.map(({id,version,status})=>({id,version,status}));record.passed=true;await save();console.log(JSON.stringify(record));
}catch(error){record.failure={kind:error?.name??'Error',message:String(error?.message??error).slice(0,600)};await save();console.error('Generated search fixture failed; retained root',root,record.failure);process.exitCode=1;
}finally{
 for(const child of processes)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await Promise.all(processes.map(child=>new Promise(r=>child.exitCode!==null||child.signalCode!==null?r():child.once('exit',r))));
 if(!process.exitCode){await wait(async()=>{for(const id of(await readdir('/proc')).filter(id=>/^\d+$/.test(id))){try{if((await readFile(`/proc/${id}/cmdline`,'utf8')).includes(root))return false;}catch{}}return true;});await rm(root,{recursive:true,force:true});}
}
