// Normal C005 uses the existing native host, execution journal and parent intake.
// The shared instruction iterator describes calls, never expected provider output.
// The parent derives instructions from the immutable fixture, NOT trace labels.
import assert from 'node:assert/strict';
// Native setup is loaded only by the genuine integration executor.
import {digest} from './audit.mjs';
const owner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'},id='snap-d';
const bytes=x=>Buffer.byteLength(JSON.stringify(x)),uuid=/^[a-f0-9-]{36}$/;
const decode=c=>JSON.parse(c.result.content[0].text);
const identityURL='https://openidconnect.googleapis.com/v1/userinfo';
const viewModes=Object.freeze({inline:'SUGGESTIONS_INLINE',acceptedPreview:'PREVIEW_SUGGESTIONS_ACCEPTED',rejectedPreview:'PREVIEW_WITHOUT_SUGGESTIONS'});
function viewContract(record,f,view){assert.ok(Object.hasOwn(viewModes,view));if(record.operation==='docs_read.view'){assert.equal(record.ledgerId,'C010');assert.equal(f.view,view);assert.equal(f.inspect.view,view);assert.equal(f.commentsDenied,false);}else assert.equal(view,'inline','existing read wrappers remain inline-only');}
function urls(f,view='inline'){const base=`https://docs.googleapis.com/v1/documents/${f.provider.document.documentId}?includeTabsContent=true&suggestionsViewMode=${viewModes[view]}`;return {identity:identityURL,metadata:`https://www.googleapis.com/drive/v3/files/${f.provider.document.documentId}?fields=id%2Cname%2CmimeType%2CmodifiedTime%2Cversion%2Ctrashed%2Ccapabilities%28canEdit%29&supportsAllDrives=true`,document:base+(view==='inline'?'&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED':''),fallback:base};}
function invalid(f,args){if(f.variant==='continuation')return {...args,format:'structured'};const key={text:'format',structured:'format',styleAnnotations:'styles',reviewAnnotations:'review',omitImages:'omitImages'}[f.variant];return {...args,[key]:key==='format'?'future-format':'true'};}
export function* projectionProgram(f){
 const state=()=>({op:'state'}),call=(args,expect='page',role='primary')=>({op:'native',name:'docs_read',args,expect,role});
 yield state();yield {op:'native',name:'docs_inspect',args:f.inspect,expect:'inspect'};yield state();yield {op:'get'};
 function* read(args,expect='page',role='primary'){const r=yield call(args,expect,role);yield state();return r;}
 function* finish(r,role='primary'){let count=0;while(!r.complete){assert.ok(++count<=20,'bounded C005 program');r=yield* read({account:owner.account,snapshotId:id,cursor:r.nextCursor},'page',role);}return r;}
 if(f.variant==='continuation'){
  const first=yield* read(f.read),args={account:owner.account,snapshotId:id,cursor:first.nextCursor};
  if(f.outcome==='invalid')yield* read(invalid(f,args),'schema');
  if(f.outcome==='wrongSubject')yield* read({...args,account:'other@example.test'},'snapshot');
  if(f.outcome==='bounds'){
   yield* read(args,'budget');yield* read(args,'budget');yield {op:'advance',to:300000};yield* read(args,'snapshot');
  }else{
   yield* finish(first);yield* read(args,'snapshot');
   if(f.outcome==='success'){const probe=yield* read(f.read,'page','expiry');yield {op:'advance',to:300000};yield* read({account:owner.account,snapshotId:id,cursor:probe.nextCursor},'snapshot','expiry');}
  }
 }else{
  if(f.outcome==='invalid')yield* read(invalid(f,f.read),'schema');
  if(f.outcome==='wrongSubject')yield* read({...f.read,account:'other@example.test'},'snapshot');
  if(f.controlRead)yield* finish(yield* read(f.controlRead,'page','control'),'control');
  if(f.outcome==='bounds'&&f.variant!=='omitImages')yield* read(f.read,'budget');
  else yield* finish(yield* read(f.read));
 }
 yield {op:'get'};yield state();
}
// The fixed native transport/capture is shared with structural diagnostics.
// A sequence describes actual calls only; it cannot supply captured results.
export async function executeC005(record,f,inventory,program=projectionProgram,view='inline'){
 const {productionHost,schemaShape}=await import('../support/production-host.mjs');
 viewContract(record,f,view);const views=record.operation==='docs_read.view';
 const http=[],faults=[],u=urls(f,view),original=structuredClone(f.provider);
 const fetchImpl=async(url,init={})=>{try{
  assert.equal(init.method??'GET','GET');assert.equal(init.body,undefined);const token=init.headers.authorization;
  assert.ok(['Bearer PRIVATE_TOKEN','Bearer PRIVATE_OTHER_TOKEN'].includes(token));const other=token==='Bearer PRIVATE_OTHER_TOKEN';
  const requestedView=views?Object.keys(viewModes).find(v=>urls(f,v).document===String(url)):undefined;
  const name=Object.keys(u).find(k=>u[k]===String(url))??(requestedView?'document':undefined);assert.ok(name,'C005 closed GET');assert.ok(!other||name==='identity');
  const status=f.commentsDenied&&name==='document'?403:200,value=status===403?{error:'unavailable'}:name==='identity'?f.provider[other?'otherIdentity':'identity']:views&&name==='document'?f.provider.responses[requestedView]:f.provider[name==='fallback'?'document':name];
  const raw=Buffer.from(JSON.stringify(value)),observed={method:'GET',url:String(url),response:name,principal:other?'other@example.test':owner.account,status,wireBytes:raw.length,emittedBytes:0,chunks:0,contentLength:null,...requestedView?{requestedView}:{}};let offset=0;
  const response=new Response(new ReadableStream({pull(c){if(offset===raw.length){c.close();return;}const chunk=raw.subarray(offset,offset+4096);offset+=chunk.length;observed.emittedBytes+=chunk.length;observed.chunks++;c.enqueue(chunk);}}),{status,headers:{'content-type':'application/json'}});http.push(observed);return response;
 }catch(error){faults.push('closed GET');throw error;}};
 const w=await productionHost(fetchImpl,{c009:true,pageBytes:f.pageBytes}),p=w.c009,capture=w.nativeSnapshotCalls;
 try{
  for(const [name,shape]of Object.entries(inventory.schemas))assert.deepEqual(schemaShape(w.tools.find(t=>t.name===name).parameters),shape);
  const plan=program(f);let step=plan.next();while(!step.done){const a=step.value;let result;
   if(a.op==='state')result=p.state();else if(a.op==='get')result=p.get(id,owner);else if(a.op==='advance')result=p.advance(a.to);
   else if(a.op==='coverage'){assert.equal(record.operation,'docs_read.view');result=p.coverage(id,owner,a.tokens,a.spec);}
   else if(a.op==='reviewCoverage'){assert.equal(record.ledgerId,'C011');assert.equal(record.operation,'docs_read.reviewView');result=p.coverage(id,owner,a.tokens,a.spec);}
   else {try{result=decode({result:await w.invokeNative(a.name,a.args,owner.threadId)});}catch(error){if(a.expect!=='schema')throw error;result=null;}}
   step=plan.next(result);
  }
  assert.deepEqual(f.provider,original);assert.deepEqual(faults,[]);assert.ok(!JSON.stringify(w.host.harness.logEntries).includes('PRIVATE_'));
  return {nativeCalls:w.nativeCalls(),localCalls:p.records(),snapshotCalls:capture(),http,providerAfter:structuredClone(f.provider)};
 }finally{await w.close();}
}
export function compareC005(record,f,t){
 assert.equal(record.ledgerId,'C005');assert.equal(record.operation,'docs_read.projection');assert.equal(record.requestedMode,'read');assert.equal(f.caseId,record.caseId);assert.equal(f.variant,record.base);assert.equal(f.outcome,record.outcomeVariant);
 assert.deepEqual(t.providerAfter,f.provider);assert.ok(['text','structured','styleAnnotations','reviewAnnotations','omitImages','continuation'].includes(f.variant));assert.ok(['success','invalid','preservation','bounds','wrongSubject'].includes(f.outcome));
 assert.equal(f.pageBytes,f.variant==='continuation'||f.variant==='omitImages'&&f.outcome==='bounds'?3000:65536);
 assert.equal(f.provider.document.revisionId,'rev-c005');
 return compareReadProgram(record,f,t,projectionProgram);
}
// Common exact read envelope/state checks. Feature wrappers must validate their
// own declaration, mode, bounds and authored semantic expectations first.
export function compareReadProgram(record,f,t,program,view='inline'){
 viewContract(record,f,view);const reviewView=record.operation==='docs_read.reviewView';if(reviewView){assert.equal(record.ledgerId,'C011');assert.equal(view,'inline');assert.equal(f.expected.missingReviewCoverage,f.commentsDenied||f.provider.document.commentsViewMode!=='COMMENTS_VIEW_MODE_INCLUDED');}const missingReviewCoverage=reviewView?f.expected.missingReviewCoverage:view!=='inline'||f.commentsDenied;
 assert.equal(f.expected.snapshotExpires,600000);assert.equal(f.expected.cursorExpires,300000);
 let li=0,ni=0,si=0,now=0,connection,model,saved,last,pending,nextRead=2;const runs=[],cursorStates=new Map(),deliveries=new Map(),work=new Map(),expectedHTTP=[];
 const local=(operation,args)=>{const c=t.localCalls[li++];assert.ok(c,'C005 missing actual local call');assert.equal(c.sequence,li);assert.match(c.id,uuid);connection??=c.connectionId;assert.match(connection,uuid);assert.equal(c.connectionId,connection);assert.equal(c.clock,now);assert.equal(c.operation,operation);assert.deepEqual(c.args,args);assert.equal(c.error,undefined);return c.result;};
 function state(){
  const s=local('sqlite.observe',{});assert.equal(s.connectionId,connection);assert.match(s.fileDigest,/^[a-f0-9]{64}$/);if(last)assert.equal(s.fileDigest,last.fileDigest);
  for(const k of ['snapshots','cursors','deliveries','pins','work','integrity'])assert.ok(Array.isArray(s[k])&&s[k].length<=128);
  const seals=[],binding=r=>({id:r.id,subject:r.subject,account:r.account,thread:r.thread,created:r.created,expires:r.expires,evidence_digest:r.evidence_digest,bytes:r.bytes,model_digest:r.model_digest});
  const add=(kind,key,snapshot,value)=>seals.push({kind,id:key,snapshot,digest:digest(JSON.stringify({kind,id:key,snapshot,value}))});
  for(const r of s.snapshots)add('snapshot',r.id,r.id,binding(r));
  const parent=key=>{const r=s.snapshots.find(r=>r.id===key);assert.ok(r);return binding(r);};
  for(const r of s.cursors)add('cursor',r.id,r.snapshot,{binding:parent(r.snapshot),expires:r.expires,state:r.state});
  for(const r of s.deliveries)add('delivery',r.id,r.snapshot,{binding:parent(r.snapshot),data:r.data});
  for(const r of s.pins)add('pin',r.owner,r.snapshot,{binding:parent(r.snapshot),expires:r.expires});
  for(const r of s.work)add('work',r.id,r.snapshot,{bytes:r.bytes});
  const order=(a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)||a.snapshot.localeCompare(b.snapshot);
  assert.deepEqual([...s.integrity].sort(order),seals.sort(order),'C005 persisted seals');assert.deepEqual(s.pins,[]);
  if(!ni)for(const k of ['snapshots','cursors','deliveries','work','integrity'])assert.deepEqual(s[k],[]);
  else if(!saved){saved=s;assert.equal(s.snapshots.length,1);assert.deepEqual(s.cursors,[]);assert.deepEqual(s.deliveries,[]);assert.deepEqual(s.work,[]);}
  else {
   assert.deepEqual(s.snapshots,saved.snapshots,'C005 immutable snapshot/deadline');
   assert.deepEqual(s.deliveries.map(r=>({id:r.id,snapshot:r.snapshot,data:JSON.parse(r.data)})).sort((a,b)=>a.id.localeCompare(b.id)),[...deliveries].map(([key,data])=>({id:key,snapshot:id,data})).sort((a,b)=>a.id.localeCompare(b.id)),'C005 exact persisted deliveries');
   assert.deepEqual(s.cursors.map(r=>({id:r.id,snapshot:r.snapshot,expires:r.expires,state:JSON.parse(r.state)})).sort((a,b)=>a.id.localeCompare(b.id)),[...cursorStates].map(([key,state])=>({id:key,snapshot:id,expires:300000,state})).sort((a,b)=>a.id.localeCompare(b.id)),'C005 frozen selection/request, no retarget or renewal');
   assert.deepEqual(s.work,[...work].map(([key,value])=>({id:key,snapshot:id,bytes:value})).sort((a,b)=>a.id.localeCompare(b.id)),'C005 exact durable projection work');
   if(pending==='schema'||pending==='snapshot'||pending==='scope')assert.deepEqual(s,last,'C005 refusal preserves all observed SQLite state');
   if(pending==='budget'){for(const k of ['snapshots','cursors','deliveries','pins'])assert.deepEqual(s[k],last[k],'C005 failed packing cannot publish/consume');assert.deepEqual(s.integrity.filter(r=>r.kind!=='work'),last.integrity.filter(r=>r.kind!=='work'));assert.notDeepEqual(s.work,last.work,'C005 failed packing stays charged');}
  }
  pending=null;last=s;return s;
 }
 function get(){const m=local('snapshot.get',{id,owner});if(model){assert.deepEqual(m,model,'C005 original source/model/unselected preservation');return m;}
  model=m;assert.deepEqual(m.evidence,f.provider.document);assert.deepEqual(m.metadata,f.provider.metadata);assert.deepEqual(Object.values(m.nodes),f.expected.nodes,'C005 independent typed model');
  assert.deepEqual(m.binding,{snapshotId:id,...owner,documentId:'doc-d',view,retrievedAt:0,responseDigest:digest(JSON.stringify(f.provider.document)),responseBytes:bytes(f.provider.document)});assert.equal(m.evidenceDigest,digest(JSON.stringify(f.provider.document)));assert.equal(m.missingReviewCoverage,missingReviewCoverage);
  assert.deepEqual(m.revision,{kind:'docs',id:f.provider.document.revisionId,subject:owner.subject});
  if(f.expected.registryEntries){assert.deepEqual(m.registryEntries,f.expected.registryEntries,'independent complete registry definitions');assert.deepEqual(m.registryReferences,f.expected.registryReferences,'independent complete registry relationships');}
  assert.equal(m.materialized,'complete');const {evidence,...rest}=m;
  assert.deepEqual(saved.snapshots,[{id,subject:owner.subject,account:owner.account,thread:owner.threadId,created:0,expires:600000,evidence_digest:m.evidenceDigest,model_digest:digest(JSON.stringify(rest)),bytes:bytes(rest)}]);return m;
 }
 function selection(ids){const positions=f.expected.nodes.map(n=>n.id),runs=[];for(const key of ids){const n=positions.indexOf(key);assert.ok(n>=0);const last=runs.at(-1);if(last&&last[0]+last[1]===n)last[1]++;else runs.push([n,1]);}const ancestors=[];let p=f.expected.nodes.find(n=>n.id===ids[0]).parent;while(p&&!ids.includes(p)){ancestors.push(p);p=f.expected.nodes.find(n=>n.id===p).parent;}return {tabs:['tab-d'],runs,selectedFootprint:true,ancestors};}
 function start(role){const control=role==='control',opaqueControl=role==='opaqueControl',request=opaqueControl?f.extraRead:control?f.controlRead:f.read,projection=opaqueControl?f.expected.extraProjection:control?f.expected.controlProjection:f.expected.projection,ids=opaqueControl?f.expected.extraIds:control?f.expected.controlIds:f.expected.selectedIds;
  const run={role,projection,request,selection:selection(ids),readId:`read-d-${nextRead++}`,offset:0,lossOffset:0,pages:0};runs.push(run);return run;}
 function snapshotAccess(a,run,nativeCall){const c=t.snapshotCalls[si++];assert.ok(c,'C005 missing private native snapshot access');const other=a.args.account==='other@example.test',method=a.args.cursor?'peekCursor':'get';
  const expected={nativeCallId:nativeCall.id,nativeSequence:nativeCall.sequence,native:'docs_read',method,key:a.args.cursor??id,owner:other?{...owner,subject:'subject-other',account:'other@example.test'}:owner,clock:now,...a.args.cursor?{expectedSnapshot:id}:{}};
  if(a.expect==='snapshot')assert.deepEqual(c,{...expected,error:{category:'snapshot'}},'C005 real owner/token refusal');
  else assert.deepEqual(c,{...expected,result:{binding:model.binding,evidenceDigest:model.evidenceDigest,...method==='peekCursor'?{state:cursorStates.get(a.args.cursor)}:{}}},'C005 actual original get/peek binding');
 }
 function page(r,a,run){
  const p=run.projection,allIds=new Set(p.records.map(x=>x.node??x.id)),orphans=p.losses.filter(x=>!allIds.has(x.node)),expectedRecords=p.records.slice(run.offset,run.offset+r.records.length);
  assert.deepEqual(r.records,expectedRecords,'C005 independent actual projection');const nodes=expectedRecords.map(x=>x.node??x.id),recordLosses=nodes.flatMap(key=>p.losses.filter(x=>x.node===key));
  assert.ok(r.losses.length>=recordLosses.length);const orphanCount=r.losses.length-recordLosses.length;assert.deepEqual(r.losses,[...recordLosses,...orphans.slice(run.lossOffset,run.lossOffset+orphanCount)],'C005 exact losses, no hidden omissions');
  const end=run.offset+r.records.length,lossEnd=run.lossOffset+orphanCount;assert.ok(end<=p.records.length&&lossEnd<=orphans.length);assert.ok(!orphanCount||end===p.records.length);assert.ok(r.records.length||orphanCount||!p.records.length&&!orphans.length,'C005 progress');
  const complete=end===p.records.length&&lossEnd===orphans.length,aspects=['content','styles','review'].filter(aspect=>nodes.length&&nodes.every(key=>p.nodeAspects[key].includes(aspect))),nodeAspects=Object.fromEntries(nodes.map(key=>[key,p.nodeAspects[key]])),missingAspects=['content','styles','review'].filter(x=>!aspects.includes(x));
  assert.match(r.coverage.deliveryToken,uuid);assert.ok(!deliveries.has(r.coverage.deliveryToken));if(complete)assert.equal(r.nextCursor,null);else{assert.match(r.nextCursor,uuid);assert.ok(!cursorStates.has(r.nextCursor));}
  const delivery={snapshotId:id,evidenceDigest:model.evidenceDigest,view,readId:run.readId,scope:run.request.scope,selection:run.selection,format:run.request.format,offset:run.offset,lossOffset:run.lossOffset,nodes,aspects,nodeAspects,missingAspects,complete,losses:r.losses};
  assert.deepEqual(r,{snapshotId:id,view,revision:model.revision,records:expectedRecords,losses:r.losses,complete,nextCursor:r.nextCursor,selection:{ancestorsNotDelivered:run.selection.ancestors,scope:'selectedFootprint'},coverage:{materialized:'complete',delivered:{nodes,aspects,nodeAspects},missingAspects,missingReviewCoverage,readProof:'scope_and_aspect_only',editReady:false,deliveryToken:r.coverage.deliveryToken},limitations:['API structure is not rendered fidelity','Read delivery is not authoring authorization'],thisCall:{providerMutationCount:0}},'C005 complete public envelope');
  const nextState=complete?null:{documentId:'doc-d',view,offset:end,lossOffset:lossEnd,selection:run.selection,request:{scope:run.request.scope,format:run.request.format,styles:run.request.styles??false,review:run.request.review??false,omitImages:run.request.omitImages??false,...run.request.registries?{registries:run.request.registries}:{}},readId:run.readId};
  assert.ok(bytes(r)<=f.pageBytes&&bytes(delivery)<=f.pageBytes&&(!nextState||bytes(nextState)<=f.pageBytes),'C005 actual complete envelopes bounded');
  if(a.args.cursor)assert.ok(cursorStates.delete(a.args.cursor),'C005 consumes only the actual continuation');
  if(nextState)cursorStates.set(r.nextCursor,nextState);deliveries.set(r.coverage.deliveryToken,delivery);run.offset=end;run.lossOffset=lossEnd;run.pages++;run.complete=complete;run.orphanOnly=(run.orphanOnly??false)||!r.records.length&&orphanCount>0;
 }
 function native(a){const c=t.nativeCalls[ni++];assert.ok(c,'C005 missing actual native call');assert.equal(c.sequence,ni);assert.match(c.id,uuid);assert.equal(c.name,a.name);assert.deepEqual(c.args,a.args,'C005 immutable mode/selector/cursor arguments');assert.equal(c.threadId,owner.threadId);assert.equal(c.clock,now);assert.equal(c.localSequence,li,'C005 causal native/local order');pending=a.expect;
  if(a.expect==='schema'){assert.deepEqual(c.control,{args:a.args,parsed:null});assert.equal(c.result,undefined);assert.match(c.error.message,/tool "docs_read" arguments are invalid:/);return null;}
  assert.deepEqual(c.control,{args:a.args,parsed:a.args});assert.equal(c.error,undefined);const r=decode(c);expectedHTTP.push({response:'identity',principal:a.args.account});
  if(a.expect==='inspect'){
   expectedHTTP.push({response:'identity',principal:owner.account},{response:'metadata',principal:owner.account},{response:'identity',principal:owner.account},{response:'document',principal:owner.account});if(f.commentsDenied)expectedHTTP.push({response:'identity',principal:owner.account},{response:'fallback',principal:owner.account});
   assert.equal(c.result.isError,undefined);assert.equal(r.snapshotId,id);assert.equal(r.kind,'nativeDoc');assert.deepEqual(r.coverage,{materialized:'complete',delivered:'summary',readProof:false,missingReviewCoverage});assert.deepEqual(r.thisCall,{providerMutationCount:0});assert.ok(bytes(r)<=f.pageBytes);return r;
  }
  let run;if(!['snapshot','scope'].includes(a.expect)){run=a.args.cursor?runs.find(x=>x.readId===cursorStates.get(a.args.cursor)?.readId):start(a.role);assert.ok(run,'C005 original continuation state');}
  snapshotAccess(a,run,c);
  if(['snapshot','budget','scope'].includes(a.expect)){assert.equal(c.result.isError,true);assert.deepEqual(r,{outcome:'unavailable',category:a.expect,guidance:'Check explicit scope and connected account; expired snapshots require a new inspection.',thisCall:{providerMutationCount:0}});}
  else{assert.equal(c.result.isError,undefined);page(r,a,run);}
  if(run){const charge=bytes(model)+bytes(run.projection);work.set(run.readId,(work.get(run.readId)??0)+charge);if(a.expect==='budget'){const next=run.projection.records[run.offset];assert.ok(next&&bytes(next)>f.pageBytes,'C005 actual indivisible mode record exceeds complete page cap');}}
  return r;
 }
 function coverage(a){assert.equal(record.operation,'docs_read.view');assert.equal(f.variant,'projectionNotEditProof');assert.deepEqual(a.spec,f.expected.authoritySpec);const result=local('coverage.evaluate',{id,owner,tokens:a.tokens,spec:a.spec});assert.deepEqual(result.model,{binding:model.binding,revision:model.revision,modelDigest:digest(JSON.stringify(model))});assert.deepEqual(result.deliveries,a.tokens.map(token=>{assert.ok(deliveries.has(token));return deliveries.get(token);}));assert.deepEqual(result.footprint,{snapshotId:id,evidenceDigest:model.evidenceDigest,nodes:a.spec.nodes,targets:a.spec.nodes,dependencies:[],aspects:['content'],destructive:false});assert.deepEqual(result.result,f.expected.authorityResult,'C010 actual production current-editor guard');return result;}
 function reviewCoverage(a){assert.ok(reviewView);assert.deepEqual(a.spec,{nodes:f.expected.controlIds,aspects:['review']});const result=local('coverage.evaluate',{id,owner,tokens:a.tokens,spec:a.spec});assert.deepEqual(result.model,{binding:model.binding,revision:model.revision,modelDigest:digest(JSON.stringify(model))});assert.deepEqual(result.deliveries,a.tokens.map(token=>{assert.ok(deliveries.has(token));return deliveries.get(token);}));assert.deepEqual(result.footprint,{snapshotId:id,evidenceDigest:model.evidenceDigest,nodes:a.spec.nodes,targets:a.spec.nodes,dependencies:[],aspects:['review'],destructive:false});assert.deepEqual(result.result,f.expected.authorityResult,'C011 actual production review guard');return result;}
 const plan=program(f);let step=plan.next();while(!step.done){const a=step.value;let value;if(a.op==='state')value=state();else if(a.op==='get')value=get();else if(a.op==='coverage')value=coverage(a);else if(a.op==='reviewCoverage')value=reviewCoverage(a);else if(a.op==='advance'){value=local('clock.advance',{from:now,to:a.to});assert.equal(value,a.to);now=a.to;}else value=native(a);step=plan.next(value);}
 assert.equal(li,t.localCalls.length,'C005 orphan local call');assert.equal(ni,t.nativeCalls.length,'C005 orphan native call');assert.equal(si,t.snapshotCalls.length,'C005 orphan native snapshot access');
 assert.deepEqual(t.http.map(h=>({response:h.response,principal:h.principal})),expectedHTTP,'C005 only real identity GETs after materialization');const u=urls(f,view);
 for(const h of t.http){assert.equal(h.method,'GET');assert.equal(h.url,u[h.response]);assert.equal(h.contentLength,null);const denied=f.commentsDenied&&h.response==='document';assert.equal(h.status,denied?403:200);const value=denied?{error:'unavailable'}:h.response==='identity'?f.provider[h.principal===owner.account?'identity':'otherIdentity']:f.provider[h.response==='fallback'?'document':h.response];assert.equal(h.wireBytes,bytes(value));assert.ok(h.emittedBytes<=h.wireBytes);if(!denied){assert.equal(h.emittedBytes,h.wireBytes);assert.equal(h.chunks,Math.ceil(h.wireBytes/4096));}}
 const primary=runs.find(r=>r.role==='primary');assert.ok(primary);if(f.outcome!=='bounds'||f.variant==='omitImages')assert.equal(primary.complete,true);
 if(f.variant==='continuation'){assert.ok(primary.pages>=1);if(f.outcome!=='bounds')assert.ok(primary.pages>=2);}
 if(f.variant==='omitImages'&&f.outcome==='bounds')assert.ok(primary.pages>=2&&primary.orphanOnly,'C005 omission-only loss pages required');
 return true;
}
export {executeC005 as executeReadProgram};
