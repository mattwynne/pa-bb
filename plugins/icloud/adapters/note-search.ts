import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NoteStore, NoteError } from './note-store.ts';
import type { SearchPath, SearchReader } from './note-store.ts';
import type { SearchInput, SearchBatch, SearchCapability } from '../core/note-contract.ts';
export type SearchRequest = Omit<SearchInput, 'version' | 'searchVersion'>;
type View = { paths(id: string): string[]; reader(id: string, path: string): Promise<SearchReader> };
type Candidate = SearchBatch['candidates'][number];
type Session = { signature: string; mirrorId: string; revision: number; paths: AsyncGenerator<SearchPath>; seen: Set<string>; memory: number; at: number; created: number; abort: AbortController; task?: Promise<SearchBatch>; warnings: Set<SearchBatch['warnings'][number]> };
const inFolder = (path: string, folder: string) => path.startsWith(folder + '/');
const selected = (path: string, request: SearchRequest) => (!request.folders || request.folders.some(folder => inFolder(path, folder))) && !request.excludeFolders?.some(folder => inFolder(path, folder));
const signature = (q: SearchRequest) => JSON.stringify({ mirrorId:q.mirrorId,revision:q.revision,text:q.text,projection:q.projection,folders:q.folders ? [...q.folders].sort():undefined,excludeFolders:q.excludeFolders?[...q.excludeFolders].sort():undefined });
const env = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8', LC_ALL:'C.UTF-8' });
class MissingExecutable extends NoteError { constructor() { super('unavailable'); } }
// No shell, arbitrary flags, inherited credentials, ripgrep config or raw errors.
async function command(binary: string, args: string[], readers: SearchReader[], signal: AbortSignal, line: (value: string) => void, maxLine = 8 * 1024 * 1024) {
  if (signal.aborted) throw new NoteError('cancelled');
  return new Promise<number>((resolve,reject) => {
    const child=spawn(binary,args,{stdio:['ignore','pipe','pipe',...readers.map(r=>r.file.fd)],env:env()});
    let buffer='', failed=false, missing=false, stderrBytes=0, stdoutBytes=0;
    const terminate=()=>{child.kill('SIGTERM'); const hard=setTimeout(()=>child.kill('SIGKILL'),200);hard.unref();child.once('close',()=>clearTimeout(hard));};
    const fail=()=>{failed=true;terminate();};
    const timeout=setTimeout(fail,10000);timeout.unref(); signal.addEventListener('abort',fail,{once:true});
    child.stdout!.setEncoding('utf8');child.stdout!.on('data',(chunk:string)=>{
      if(failed)return;stdoutBytes+=Buffer.byteLength(chunk);if(stdoutBytes>32*1024*1024){fail();return;}buffer+=chunk;
      try{let end:number;while((end=buffer.indexOf('\n'))>=0){if(end>maxLine)throw new Error();line(buffer.slice(0,end));buffer=buffer.slice(end+1);}if(Buffer.byteLength(buffer)>maxLine)throw new Error();}catch{fail();}
    });
    child.stderr!.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>8192)fail();});
    child.on('error',(error:NodeJS.ErrnoException)=>{failed=true;missing=error.code==='ENOENT';});
    child.on('close',code=>{clearTimeout(timeout);signal.removeEventListener('abort',fail);if(failed||signal.aborted||code===null||code>1||stderrBytes)reject(missing?new MissingExecutable():new NoteError(signal.aborted?'cancelled':'unavailable'));else{try{if(buffer)line(buffer);resolve(code);}catch{reject(new NoteError('unavailable'));}}});
  });
}
export class NoteSearch {
  private sessions=new Map<string,Session>(); private closed=false; private running=0;
  private probes=new Map<AbortController,Promise<number>>();
  private checking?:Promise<SearchCapability>; private lastCapability?:SearchCapability;
  private sweep: ReturnType<typeof setInterval>;
  constructor(private store: NoteStore, private view: View, private binary='rg') {
    this.sweep=setInterval(()=>{for(const [id,s] of this.sessions)if(Date.now()-s.at>300000||Date.now()-s.created>1800000)void this.close(id);},30000);this.sweep.unref();
  }
  get sessionCount(){return this.sessions.size;}
  async capability():Promise<SearchCapability>{
    if(this.closed)return{version:1,available:false,reason:'unavailable'};
    if(this.running+this.probes.size>=2)return this.lastCapability??{version:1,available:false,reason:'unavailable'};
    if(!this.checking)this.checking=this.probe().then(value=>this.lastCapability=value).finally(()=>{this.checking=undefined;});
    return this.checking;
  }
  private async probe():Promise<SearchCapability>{
    if(this.closed)return{version:1,available:false,reason:'unavailable'};
    const abort=new AbortController();let output='';
    const task=command(this.binary,['--no-config','--version'],[],abort.signal,line=>{output+=line+'\n';if(Buffer.byteLength(output)>4096)throw new Error();},4096);this.probes.set(abort,task);
    try{await task;const major=Number(/^ripgrep (\d+)\./.exec(output)?.[1]);return{version:1,available:major>=14,reason:major>=14?null:'unsupported_version'};}
    catch(error){return{version:1,available:false,reason:error instanceof MissingExecutable?'missing_executable':'unavailable'};}
    finally{this.probes.delete(abort);}
  }
  private async *paths(root:string,q:SearchRequest){
    for(const path of this.view.paths(q.mirrorId))yield {path};
    yield* this.store.searchPaths(root,{file:path=>selected(path,q),directory:path=>(!q.folders||q.folders.some(folder=>folder===path||folder.startsWith(path+'/')||inFolder(path,folder)))&&!q.excludeFolders?.some(folder=>folder===path||inFolder(path,folder))});
  }
  async next(request:SearchRequest,root:string,guard:()=>void):Promise<SearchBatch>{
    guard();if(this.closed)throw new NoteError('unavailable');if(this.running+this.probes.size>=2)throw new NoteError('capacity');
    if(request.startOnly&&request.cursor)throw new NoteError('invalid_query');
    let id=request.cursor,s=id?this.sessions.get(id):undefined;
    if(id&&(!s||Date.now()-s.at>300000||Date.now()-s.created>1800000)){if(s)await this.close(id);throw new NoteError('cursor_expired');}
    if(s&&s.signature!==signature(request))throw new NoteError('invalid_query');
    if(s?.task)throw new NoteError('busy');
    if(!s){
      if(this.sessions.size>=4)throw new NoteError('capacity');
      if(!(await this.capability()).available)throw new NoteError('unsupported');
      guard();if(this.running+this.probes.size>=2||this.sessions.size>=4)throw new NoteError('capacity');id=randomUUID();s={signature:signature(request),mirrorId:request.mirrorId,revision:request.revision,paths:this.paths(root,request),seen:new Set(),memory:0,at:Date.now(),created:Date.now(),abort:new AbortController(),warnings:new Set()};this.sessions.set(id,s);
    }
    if(request.startOnly)return{candidates:[],nextCursor:id!,visited:0,warnings:[]};
    const session=s, token=id!;this.running++;
    const task=this.batch(session,request,token,guard);session.task=task;
    try{return await task;}catch(error){session.abort.abort();await session.paths.return(undefined).catch(()=>{});this.sessions.delete(token);this.remainders.delete(token);throw error;}finally{session.task=undefined;this.running--;}
  }
  private async batch(s:Session,q:SearchRequest,token:string,guard:()=>void):Promise<SearchBatch>{
    const readers:Array<{path:string;reader:SearchReader}>=[];const candidates:Candidate[]=[];let bytes=0,visited=0,done=false;
    const remainder=this.remainders.get(token);
    if(remainder){
      guard();if(s.abort.signal.aborted)throw new NoteError('cancelled');let size=0;
      while(remainder.rows.length&&size+Buffer.byteLength(JSON.stringify(remainder.rows[0]))<=900000){const row=remainder.rows.shift()!;size+=Buffer.byteLength(JSON.stringify(row));candidates.push(row);}
      if(!remainder.rows.length){this.remainders.delete(token);done=remainder.done;}
      guard();s.at=Date.now();if(done){await s.paths.return(undefined);this.sessions.delete(token);}
      return{candidates,nextCursor:done?null:token,visited:0,warnings:[...s.warnings]};
    }
    try{
      // Bound work per response, not total coverage. Even no-hit pages advance.
      let entries=0;
      while(readers.length<64&&bytes<1024*1024&&entries++<512){
        guard();if(s.abort.signal.aborted)throw new NoteError('cancelled');
        let next:IteratorResult<SearchPath>;
        try{next=await s.paths.next();}catch{s.warnings.add('note_unavailable');done=true;break;}
        if(next.done){done=true;break;}
        if('warning' in next.value){s.warnings.add(next.value.warning);continue;}if(!('path' in next.value))continue;const path=next.value.path;
        if(!path||s.seen.has(path)||!selected(path,q))continue;
        s.memory+=Buffer.byteLength(path)+128;if(s.memory>24*1024*1024){s.warnings.add('capacity');done=true;break;}s.seen.add(path);visited++;
        try{const reader=await this.view.reader(q.mirrorId,path);readers.push({path,reader});bytes+=Buffer.byteLength(reader.text);}catch(error){s.warnings.add(error instanceof NoteError&&error.category==='unsupported'?'unsupported':'note_unavailable');}
      }
      const matched=new Map<number,number>();
      if(readers.length){
        const paths=readers.map((_,i)=>`/proc/self/fd/${i+3}`);
        const pattern=q.text??(q.projection==='frontmatter'?'^(?:\\x{FEFF})?---\\r?$':'^');
        await command(this.binary,['--no-config','--null','--line-number','--with-filename','--no-heading','--color','never','--ignore-case','--no-mmap','--threads','1','--max-count','1',...(q.text?['--fixed-strings',...(q.text.includes('\n')?['--multiline']:[])]:[]),'-e',pattern,'--',...paths],readers.map(r=>r.reader),s.abort.signal,raw=>{
          // NUL-delimited generated fd name + numeric line prefix. Unlike rg
          // JSON, this cannot amplify a repeated literal into a submatch array.
          const end=raw.indexOf('\0'),index=paths.indexOf(raw.slice(0,end)),number=Number(/^(\d+):/.exec(raw.slice(end+1))?.[1]);
          if(end<0||index<0||!Number.isSafeInteger(number)||number<1)throw new Error();if(!matched.has(index))matched.set(index,number);
        });
      }
      for(let i=0;i<readers.length;i++){
        const {reader,path}=readers[i];guard();
        try{await reader.verify();}catch{s.warnings.add('note_unavailable');continue;}
        const line=matched.get(i)??(!q.text&&q.projection==='hits'&&reader.text.length===0?1:undefined);if(line===undefined)continue;
        const candidate:Candidate={path,hash:reader.hash,readAt:reader.readAt,line,snippet:reader.text.split('\n')[line-1]?.replace(/\r$/,'').slice(0,240)??''};
        if(q.projection!=='hits'){
          let content=reader.text;
          if(q.projection==='frontmatter'){
            const opening=/^(?:\uFEFF)?---\r?\n/.exec(content);const closing=/^---[ \t]*\r?$/gm;closing.lastIndex=opening?.[0].length??0;const end=opening?closing.exec(content):null;
            content=!opening?'':end?content.slice(0,end.index+end[0].length)+'\n':content;
          }
          if(Buffer.byteLength(content)>65536){candidate.limited=true;candidate.content='';}else candidate.content=content;
        }
        candidates.push(candidate);
      }
      // A candidate is <=~400 KiB after escaping. Keep all undelivered candidates
      // for the next response; never drop them to satisfy a transport bound.
      let length=0,cut=candidates.length;for(let i=0;i<candidates.length;i++){length+=Buffer.byteLength(JSON.stringify(candidates[i]));if(length>900000){cut=i;break;}}
      if(cut<candidates.length){
        // batches are deliberately smaller when semantic projections are used;
        // queue the bounded remainder, including its completion state.
        this.remainders.set(token,{rows:candidates.splice(cut),done});done=false;
      }
      guard();if(s.abort.signal.aborted)throw new NoteError('cancelled');s.at=Date.now();
      const warnings=[...s.warnings];if(done){await s.paths.return(undefined);this.sessions.delete(token);}
      return{candidates,nextCursor:done?null:token,visited,warnings};
    }finally{await Promise.allSettled(readers.map(r=>r.reader.close()));}
  }
  private remainders=new Map<string,{rows:Candidate[];done:boolean}>();
  async close(id:string){const s=this.sessions.get(id);if(!s)return;s.abort.abort();await s.task?.catch(()=>{});await s.paths.return(undefined).catch(()=>{});this.sessions.delete(id);this.remainders.delete(id);}
  async stop(){this.closed=true;clearInterval(this.sweep);for(const abort of this.probes.keys())abort.abort();await Promise.allSettled([...this.probes.values()]);await Promise.all([...this.sessions.keys()].map(id=>this.close(id)));}
  invalidate(revision:number){for(const[id,s]of this.sessions)if(s.revision!==revision)void this.close(id);}
}
