import { VaultError } from './ports.ts';
import type { Catalog, Diagnose, NoteParser, SearchQuery, SearchRequest, Source, VaultFiles } from './ports.ts';
type Context = { revision: number; ids: string[]; catalog: Catalog };
type Session = { query: SearchQuery; signature: string; revision: number; ids: string[]; fingerprint: string; index: number; producer?: string; rows: any[]; matched: number; visited: number; warnings: Set<string>; failures: Array<{vaultId:string;category:string}>; created: number; at: number; busy: boolean };
const normalized = (q:SearchQuery) => ({ vaultId:q.vaultId,text:q.text,tag:q.tag?.replace(/^#/,'').toLocaleLowerCase('und'),folders:q.folders?[...new Set(q.folders)].sort():undefined,excludeFolders:q.excludeFolders?[...new Set(q.excludeFolders)].sort():undefined,properties:q.properties?[...q.properties].sort((a,b)=>a.key.localeCompare(b.key)||JSON.stringify(a.equals).localeCompare(JSON.stringify(b.equals))):undefined,mode:q.mode??'results' });
const fingerprint = (c:Catalog,ids:string[]) => JSON.stringify(ids.map(id=>{const s=c.sources.find(s=>s.id===id);return[id,s?.local.available,s?.local.reason];}));
const prefix=(value:string)=>!!value&&value.length<=1024&&!/[\\\x00-\x1f\x7f]/.test(value)&&value.split('/').every(p=>!!p&&p!=='.'&&p!=='..');
export class VaultSearch {
  private sessions=new Map<string,Session>(); private stopped=false;
  private calls=new Set<string>();
  constructor(private files:VaultFiles,private parser:NoteParser,private id:()=>string,private clock:()=>number,private diagnose:Diagnose,private authorize:(vaultId?:string)=>Promise<Context>,private check:(revision:number)=>void){}
  private async close(s:Session){if(s.producer)await this.files.closeSearch(s.revision,s.producer).catch(()=>{});}
  invalidate(){const old=[...this.sessions.values()];this.sessions.clear();for(const s of old)void this.close(s);}
  async stop(){this.stopped=true;const old=[...this.sessions.values()];this.sessions.clear();await Promise.all(old.map(s=>this.close(s)));}
  async next(input:SearchQuery,signal?:AbortSignal){
    const key=input.cursor??this.id();if(this.calls.has(key))throw new VaultError('busy');this.calls.add(key);
    try{return await this.work(input,signal);}finally{this.calls.delete(key);}
  }
  private async work(input:SearchQuery,signal?:AbortSignal){
    if(this.stopped||signal?.aborted)throw new VaultError('cancelled');
    if(JSON.stringify(input).length>16384)throw new VaultError('invalid_query');
    for(const values of [input.folders,input.excludeFolders])if(values&&(values.length>16||values.some(v=>!prefix(v))))throw new VaultError('invalid_path');
    if(input.folders?.length===0)throw new VaultError('invalid_query');
    if(!input.cursor&&!input.text&&!input.tag&&!input.properties?.length&&!input.folders?.length&&input.mode!=='count')throw new VaultError('invalid_query');
    let token=input.cursor,s=token?this.sessions.get(token):undefined;
    if(token&&(!s||this.clock()-s.at>300000||this.clock()-s.created>1800000)){if(s){await this.close(s);this.sessions.delete(token);}throw new VaultError('cursor_expired','The search expired. Start a new search; its earlier matches are not a total.');}
    if(s?.busy)throw new VaultError('busy');
    if(s){for(const key of ['vaultId','text','tag','folders','excludeFolders','properties','mode'] as const)if(input[key]!==undefined&&JSON.stringify(normalized({...s.query,[key]:input[key]})[key])!==JSON.stringify(normalized(s.query)[key]))throw new VaultError('invalid_query','Continue the original query, or omit the cursor to start another search.');}
    const query=s?.query??normalized(input),context=await this.authorize(query.vaultId);
    if(!context.catalog.search?.available)throw new VaultError('unsupported','Vault search is unavailable. Update both plugins if needed and ask the host operator to check the ripgrep requirements.');
    if(s&&(s.revision!==context.revision||s.fingerprint!==fingerprint(context.catalog,s.ids))){await this.close(s);this.sessions.delete(token!);throw new VaultError('cursor_expired','Local source access changed. Start a new search.');}
    if(!s){
      for(const[id,old]of this.sessions)if(this.clock()-old.at>300000||this.clock()-old.created>1800000){this.sessions.delete(id);void this.close(old);}
      if(this.sessions.size>=4)throw new VaultError('capacity');
      token=this.id();s={query,signature:JSON.stringify(query),revision:context.revision,ids:context.ids,fingerprint:fingerprint(context.catalog,context.ids),index:0,rows:[],matched:0,visited:0,warnings:new Set(),failures:[],created:this.clock(),at:this.clock(),busy:false};this.sessions.set(token,s);
    }
    const state=s;state.busy=true;
    const cancel=()=>{void this.close(state);};signal?.addEventListener('abort',cancel,{once:true});
    try{
      if(signal?.aborted)throw new VaultError('cancelled');
      const mode=state.query.mode??'results',limit=Math.max(1,Math.min(input.limit??20,50)),sliceStarted=this.clock();let batches=0;
      while((mode==='count'||state.rows.length<limit)&&state.index<state.ids.length&&batches++<32&&this.clock()-sliceStarted<2000){
        const id=state.ids[state.index],source=context.catalog.sources.find(v=>v.id===id);
        if(!source?.local.available){state.failures.push({vaultId:id,category:'source_unavailable'});state.index++;}
        else{
          const request:SearchRequest={mirrorId:id,revision:state.revision,text:state.query.text,projection:state.query.tag?'markdown':state.query.properties?.length?'frontmatter':'hits',folders:state.query.folders,excludeFolders:state.query.excludeFolders,cursor:state.producer};
          try{
            if(!state.producer){
              // Acquire the opaque handle before executing rg, so cancellation
              // can explicitly close and await even the first running batch.
              const opened=await this.files.search({...request,startOnly:true});state.producer=opened.nextCursor??undefined;
              this.check(state.revision);if(signal?.aborted)throw new VaultError('cancelled');
              if(!state.producer)throw new VaultError('unavailable');
            }
            const batch=await this.files.search({...request,cursor:state.producer},signal);state.producer=batch.nextCursor??undefined;
            this.check(state.revision);if(signal?.aborted)throw new VaultError('cancelled');state.visited+=batch.visited;batch.warnings.forEach(w=>state.warnings.add(w));
            if(batch.warnings.length)this.diagnose('parse',batch.warnings.includes('unsupported')?'unsupported':'unavailable');
            for(const candidate of batch.candidates){
              try{
                if(candidate.limited)throw new VaultError('parser_limit');
                let line=candidate.line,snippet=candidate.snippet;
                if(state.query.properties?.length){const parsed=this.parser.frontmatter(candidate.content??'');if(parsed.warnings.length)throw new VaultError('properties_unsupported');if(!state.query.properties.every(p=>Object.hasOwn(parsed.properties,p.key)&&parsed.properties[p.key]===p.equals))continue;}
                if(state.query.tag){const tag=state.query.tag;const meta=this.parser.parse(candidate.content??'');if(meta.warnings.includes('properties_unsupported'))throw new VaultError('properties_unsupported');const match=meta.tags.find(t=>t.tag===tag||t.tag.startsWith(tag+'/'));if(!match)continue;if(!state.query.text){line=match.line;snippet=(candidate.content??'').split('\n')[line-1]?.replace(/\r$/,'').slice(0,240)??'';}}
                state.matched++;
                if(mode!=='count')state.rows.push({...this.provenance(source,candidate.readAt),path:candidate.path,lineStart:line,lineEnd:line+(state.query.text?.match(/\n/g)?.length??0),snippet,hash:candidate.hash});
              }catch(error){state.warnings.add(error instanceof VaultError&&error.category==='properties_unsupported'?'properties_unsupported':'parser_limit');this.diagnose('parse',error instanceof VaultError&&error.category==='properties_unsupported'?'unsupported':'limit');}
            }
            if(!state.producer)state.index++;
          }catch(error){this.check(state.revision);if(error instanceof VaultError&&['cancelled','cursor_expired','not_connected','capacity','invalid_query','unsupported'].includes(error.category))throw error;const category=error instanceof VaultError?error.category:'unavailable';state.failures.push({vaultId:id,category});if(!(error instanceof VaultError&&error.diagnosticReported))this.diagnose('rpc',category);if(state.producer)await this.close(state);state.producer=undefined;state.index++;}
        }
        // More batches can fill this page, but bounded work slices always
        // yield a real continuation rather than a terminal scan cutoff.
      }
      this.check(state.revision);if(this.stopped||signal?.aborted)throw new VaultError('cancelled');
      const finished=state.index===state.ids.length,partial=state.warnings.size>0||state.failures.length>0;
      const response={results:[] as any[],nextCursor:token as string|null,incomplete:!finished||partial,coverage:{state:finished?(partial?'partial':'complete'):'running',visitedNotes:state.visited,omissionKinds:state.warnings.size,failedSources:state.failures.length,consistency:'Per-note local observations during this search, not an atomic vault snapshot.',startedAt:new Date(state.created).toISOString(),observedAt:new Date(this.clock()).toISOString()},matchedNotesSoFar:state.matched,totalMatches:finished&&!partial?state.matched:null,scope:{vaultIds:state.ids,folders:state.query.folders??null,excludeFolders:state.query.excludeFolders??[]},failures:state.failures,warnings:[...state.warnings],evidenceOnly:true as const};
      while(response.results.length<limit&&state.rows.length){const row=state.rows[0];if(JSON.stringify({...response,results:[...response.results,row]}).length>48000)break;response.results.push(state.rows.shift());}
      if(finished&&state.rows.length===0){response.nextCursor=null;this.sessions.delete(token!);}state.at=this.clock();
      // Recheck even pages served entirely from a cached hit buffer.
      const final=await this.authorize(state.query.vaultId);this.check(state.revision);
      if(fingerprint(final.catalog,state.ids)!==state.fingerprint)throw new VaultError('cursor_expired','Local source access changed. Start a new search.');
      return response;
    }catch(error){this.sessions.delete(token!);await this.close(state);throw error;}finally{signal?.removeEventListener('abort',cancel);state.busy=false;}
  }
  private provenance(source:Source,at:string){return{vaultId:source.id,vaultName:source.name,localObservedAt:at,lastSuccessfulSync:source.lastSuccess,stale:!source.cloudConnected||source.phase!=='ready'||!source.enabled,delivery:'Local observation only; a sync timestamp is not proof of these bytes in iCloud or on a device.'};}
}
