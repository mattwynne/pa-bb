// C009 joins extend the existing runner/receipt channel, not a second pipeline.
import assert from 'node:assert/strict';
import {productionHost,schemaShape} from '../support/production-host.mjs';
import {digest} from './audit.mjs';
const owner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'},id='snap-d';
const identityURL='https://openidconnect.googleapis.com/v1/userinfo';
const other={...owner,threadId:'other-thread'};
const bytes=x=>Buffer.byteLength(JSON.stringify(x));
const decode=c=>JSON.parse(c.result.content[0].text);
const facts=m=>Object.values(m.nodes).map(n=>({id:n.id,kind:n.kind,parent:n.parent,tabId:n.tabId,segment:n.segment,extent:n.extent,...n.text===undefined?{}:{text:n.text}}));
function urls(f){const doc=f.provider.document.documentId;return {metadata:`https://www.googleapis.com/drive/v3/files/${doc}?fields=id%2Cname%2CmimeType%2CmodifiedTime%2Cversion%2Ctrashed%2Ccapabilities%28canEdit%29&supportsAllDrives=true`,document:`https://docs.googleapis.com/v1/documents/${doc}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`};}
function wire(f){const raw=JSON.stringify(f.provider.document),n=f.wireBytes??Buffer.byteLength(raw);assert.ok(Number.isSafeInteger(n)&&n>=Buffer.byteLength(raw)&&n<=8388609,'C009 bounded wire fixture');return raw+' '.repeat(n-Buffer.byteLength(raw));}
const spec={nodes:['snap-d:2'],aspects:['content'],destructive:true};
export async function executeC009(record,f,inventory){
 const http=[],faults=[],u=urls(f),original=structuredClone(f.provider);
 const fetchImpl=async(url,init={})=>{
  try{
   assert.equal(init.method??'GET','GET');assert.equal(init.body,undefined);assert.equal(init.headers.authorization,'Bearer PRIVATE_TOKEN');
   const name=String(url)===identityURL?'identity':String(url)===u.metadata?'metadata':String(url)===u.document?'document':null;assert.ok(name,'C009 closed GET');
   const raw=name==='document'?wire(f):JSON.stringify(f.provider[name]);let offset=0;const observed={method:'GET',url:String(url),response:name,wireBytes:Buffer.byteLength(raw),contentLength:null,emittedBytes:0,chunks:0};
   const stream=new ReadableStream({pull(controller){if(offset===raw.length){controller.close();return;}const end=Math.min(raw.length,offset+4096),chunk=new TextEncoder().encode(raw.slice(offset,end));observed.emittedBytes+=chunk.byteLength;observed.chunks++;controller.enqueue(chunk);offset=end;}});
   const response=new Response(stream,{headers:{'content-type':'application/json'}});
   observed.contentLength=response.headers.get('content-length');http.push(observed);return response;
  }catch(error){faults.push('closed GET');throw error;}
 };
 const w=await productionHost(fetchImpl,{c009:true,pageBytes:f.pageBytes}),p=w.c009;
 const native=async(name,args)=>decode({result:await w.invokeNative(name,args,owner.threadId)});
 const attempt=fn=>{try{return fn();}catch(error){assert.ok(error.semanticCode,'unexpected C009 error');return null;}};
 try{
  for(const [name,shape] of Object.entries(inventory.schemas))assert.deepEqual(schemaShape(w.tools.find(t=>t.name===name).parameters),shape);
  p.state();const setup=await native('docs_inspect',f.inspect);p.state();
  if(setup.snapshotId){
   p.get(id,owner);
   const v=record.base,negative=record.outcomeVariant==='counterexample';
   if(v==='wrongThread'){
    attempt(()=>p.get(id,negative?other:owner));attempt(()=>p.get('missing-snapshot',owner));
   }else if(v==='snapshotExpiry'){
    p.pin(id,owner,'retention',900000);p.advance(negative?600000:599999);attempt(()=>p.get(id,owner));p.readPinned(id,owner,'retention');
   }else if(v==='cursorExpiry'||v==='cursorReplay'){
    const first=await native('docs_read',f.read);p.state();p.peek(first.nextCursor,owner,id);
    const continuation={account:owner.account,snapshotId:id,cursor:first.nextCursor};
    if(v==='cursorExpiry'){
     p.advance(negative?300000:299999);attempt(()=>p.peek(first.nextCursor,owner,id));await native('docs_read',continuation);
    }else if(negative){
     await native('docs_read',continuation);p.state();await native('docs_read',continuation);p.peek(first.nextCursor,owner,id);
     p.consumeCursor(first.nextCursor,owner,id);attempt(()=>p.consumeCursor(first.nextCursor,owner,id));await native('docs_read',continuation);
    }else{
     await native('docs_read',continuation);attempt(()=>p.peek(first.nextCursor,owner,id));await native('docs_read',continuation);
    }
   }else if(v==='empty'){
    const tokens=[];
    if(!negative){const read=await native('docs_read',f.read);tokens.push(read.coverage.deliveryToken);p.deliveries(id,owner,tokens);}
    p.coverage(id,owner,tokens,{nodes:['snap-d:1'],aspects:['content'],destructive:true});
   }else if(v==='partial'){
    const first=await native('docs_read',f.read),tokens=[first.coverage.deliveryToken];
    p.deliveries(id,owner,tokens);p.coverage(id,owner,tokens,spec);p.state();
    if(!negative){const next=await native('docs_read',{account:owner.account,snapshotId:id,cursor:first.nextCursor});tokens.push(next.coverage.deliveryToken);p.deliveries(id,owner,tokens);p.coverage(id,owner,tokens,spec);}
   }else if(v==='draftPinnedEvidence'){
    const read=await native('docs_read',f.read),tokens=[read.coverage.deliveryToken];p.deliveries(id,owner,tokens);
    const request={...f.witness,deliveryTokens:tokens};p.evaluate(owner,request);const handle=p.retain(owner,{request,expires:900000});p.state();
    attempt(()=>p.pin(id,owner,handle.pinId,900001));
    for(let i=0;i<31;i++)p.pin(id,owner,`extra-${i}`,900000);
    attempt(()=>p.pin(id,owner,'overflow',900000));p.state();
    for(let i=0;i<31;i++)p.release(id,owner,`extra-${i}`);
    p.advance(600000);attempt(()=>p.get(id,owner));p.consume(owner,handle);attempt(()=>p.consume(other,handle));
    if(negative)attempt(()=>p.consume(owner,{...handle,witnessDigest:'0'.repeat(64)}));
    p.advance(900000);attempt(()=>p.consume(owner,handle));p.release(id,owner,handle.pinId);attempt(()=>p.consume(owner,handle));
   }else assert.equal(v,'overrun');
   p.state();
  }
  assert.deepEqual(f.provider,original);assert.deepEqual(faults,[]);assert.ok(!JSON.stringify(w.host.harness.logEntries).includes('PRIVATE_'));
  return {nativeCalls:w.nativeCalls(),localCalls:p.records(),http,providerAfter:structuredClone(f.provider)};
 }finally{await w.close();}
}
// Parent consumes every captured call exactly once in expected causal order.
// Expectations below do not invoke a production projector/selector/effect builder.
export function compareC009(record,f,t){
 assert.equal(record.ledgerId,'C009');assert.equal(record.operation,'snapshot.coverage');assert.equal(record.requestedMode,'local');
 assert.equal(f.caseId,record.caseId,'C009 fixture identity');assert.equal(f.variant,record.base,'C009 fixture variant');assert.equal(f.outcome,record.outcomeVariant,'C009 fixture outcome');
 const v=record.base,negative=record.outcomeVariant==='counterexample',paged=['cursorExpiry','cursorReplay','partial'].includes(v);
 assert.equal(f.pageBytes,paged?3000:65536);assert.deepEqual(f.owner,owner);assert.equal(f.expected.cursorExpires,300000);assert.equal(f.expected.snapshotExpires,600000);assert.equal(f.expected.pinExpires,900000);
 assert.deepEqual(t.providerAfter,f.provider);const u=urls(f);let li=0,ni=0,now=0,connection;
 const local=(operation,args,error)=>{
  const c=t.localCalls[li++];assert.ok(c,'C009 missing actual local call');assert.equal(c.sequence,li);assert.match(c.id,/^[0-9a-f-]{36}$/);
  connection??=c.connectionId;assert.match(connection,/^[0-9a-f-]{36}$/);assert.equal(c.connectionId,connection);assert.equal(c.clock,now,'C009 actual clock');
  assert.equal(c.operation,operation,'C009 actual local method');assert.deepEqual(c.args,args,'C009 immutable local arguments');
  assert.deepEqual(c.error,error?{category:error}:undefined,'C009 actual typed local outcome');if(error)assert.equal(c.result,undefined);return c.result;
 };
 const advance=value=>{assert.equal(local('clock.advance',{from:now,to:value}),value);now=value;};
 const native=(name,args,category)=>{
  const c=t.nativeCalls[ni++];assert.ok(c,'C009 missing actual native call');assert.equal(c.sequence,ni);assert.match(c.id,/^[0-9a-f-]{36}$/);
  assert.equal(c.name,name);assert.deepEqual(c.args,args,'C009 actual native arguments');assert.equal(c.threadId,owner.threadId);assert.equal(c.clock,now);assert.equal(c.localSequence,li,'C009 causal native/local ordering');
  assert.equal(c.error,undefined);assert.deepEqual(c.control,{args,parsed:args});const result=decode(c);
  if(category){assert.equal(c.result.isError,true,'C009 native refusal');assert.deepEqual(result,{outcome:'unavailable',category,guidance:'Check explicit scope and connected account; expired snapshots require a new inspection.',thisCall:{providerMutationCount:0}});}
  else {assert.equal(c.result.isError,undefined);assert.equal(result.thisCall.providerMutationCount,0);}
  return result;
 };
 const state=()=>{
  const s=local('sqlite.observe',{});assert.equal(s.connectionId,connection);assert.match(s.fileDigest,/^[a-f0-9]{64}$/);
  for(const k of ['snapshots','cursors','deliveries','pins','work','integrity']){assert.ok(Array.isArray(s[k])&&s[k].length<=128);}
  for(const r of s.integrity)assert.match(r.digest,/^[a-f0-9]{64}$/);
  const binding=row=>({id:row.id,subject:row.subject,account:row.account,thread:row.thread,created:row.created,expires:row.expires,evidence_digest:row.evidence_digest,bytes:row.bytes,model_digest:row.model_digest});
  const seals=[];const add=(kind,key,snapshot,value)=>seals.push({kind,id:key,snapshot,digest:digest(JSON.stringify({kind,id:key,snapshot,value}))});
  for(const r of s.snapshots)add('snapshot',r.id,r.id,binding(r));
  const parent=id=>{const r=s.snapshots.find(r=>r.id===id);assert.ok(r,'C009 child storage owner');return binding(r);};
  for(const r of s.cursors)add('cursor',r.id,r.snapshot,{binding:parent(r.snapshot),expires:r.expires,state:r.state});
  for(const r of s.deliveries)add('delivery',r.id,r.snapshot,{binding:parent(r.snapshot),data:r.data});
  for(const r of s.pins)add('pin',r.owner,r.snapshot,{binding:parent(r.snapshot),expires:r.expires});
  for(const r of s.work)add('work',r.id,r.snapshot,{bytes:r.bytes});
  const order=(a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)||a.snapshot.localeCompare(b.snapshot);
  assert.deepEqual([...s.integrity].sort(order),seals.sort(order),'C009 exact persisted seals');
  return s;
 };
 const noPublication=(a,b)=>{for(const k of ['snapshots','cursors','deliveries','pins'])assert.deepEqual(b[k],a[k],'C009 failed attempt cannot publish/consume/renew');assert.deepEqual(b.integrity.filter(r=>r.kind!=='work'),a.integrity.filter(r=>r.kind!=='work'));};
 const initial=state();for(const k of ['snapshots','cursors','deliveries','pins','work','integrity'])assert.deepEqual(initial[k],[]);
 if(v==='overrun')assert.equal(f.wireBytes,8388608+(negative?1:0));else assert.equal(f.wireBytes,undefined);
 const setup=native('docs_inspect',f.inspect,v==='overrun'&&negative?'budget':undefined),stored=state();
 let model;
 if(!(v==='overrun'&&negative)){
  assert.equal(setup.snapshotId,id);assert.equal(setup.kind,'nativeDoc');assert.equal(setup.coverage.readProof,false);
  model=local('snapshot.get',{id,owner});assert.deepEqual(model.binding,{...f.expected.binding,responseDigest:digest(wire(f)),responseBytes:Buffer.byteLength(wire(f))},'C009 actual wire/model binding');
  assert.deepEqual(model.revision,f.expected.revision);assert.deepEqual(model.evidence,f.provider.document);assert.deepEqual(model.metadata,f.provider.metadata);assert.deepEqual(facts(model),f.expected.nodes,'C009 independent materialized nodes');
  assert.equal(model.evidenceDigest,digest(JSON.stringify(f.provider.document)));const {evidence,...rest}=model;
  assert.deepEqual(stored.snapshots,[{id,subject:owner.subject,account:owner.account,thread:owner.threadId,created:0,expires:600000,evidence_digest:model.evidenceDigest,model_digest:digest(JSON.stringify(rest)),bytes:bytes(rest)}]);
  assert.deepEqual(stored.cursors,[]);assert.deepEqual(stored.deliveries,[]);assert.deepEqual(stored.pins,[]);assert.deepEqual(stored.work,[]);
 }
 const get=(who=owner,category)=>{const result=local('snapshot.get',{id,owner:who},category);if(!category)assert.deepEqual(result,model);return result;};
 const delivery=(tokens)=>local('delivery.get',{id,owner,tokens});
 const checkPage=(r,records,losses,complete,offset)=>{
  assert.deepEqual(r.records,records,'C009 independent delivered records');assert.deepEqual(r.losses,losses,'C009 independent omissions');assert.equal(r.complete,complete);assert.equal(r.snapshotId,id);assert.equal(r.view,'inline');assert.deepEqual(r.revision,f.expected.revision);
  if(complete)assert.equal(r.nextCursor,null);else assert.match(r.nextCursor,/^[0-9a-f-]{36}$/);
  const nodes=records.map(x=>x.node??x.id),aspects=nodes.length?['content']:[];
  assert.deepEqual(r.coverage,{materialized:'complete',delivered:{nodes,aspects,nodeAspects:Object.fromEntries(nodes.map(n=>[n,['content']]))},missingAspects:['content','styles','review'].filter(a=>!aspects.includes(a)),missingReviewCoverage:false,readProof:'scope_and_aspect_only',editReady:false,deliveryToken:r.coverage.deliveryToken});
  assert.match(r.coverage.deliveryToken,/^[0-9a-f-]{36}$/);
  return {snapshotId:id,evidenceDigest:model.evidenceDigest,view:'inline',readId:'read-d-2',scope:f.scope,format:'text',offset,lossOffset:0,nodes,aspects,nodeAspects:r.coverage.delivered.nodeAspects,missingAspects:r.coverage.missingAspects,complete,losses};
 };
 const readFirst=()=>{const r=native('docs_read',f.read);const d=checkPage(r,f.expected.records.slice(0,1),f.expected.losses.slice(0,1),false,0);return {r,d};};
 const checkStored=(s,pages)=>{
  assert.deepEqual(s.snapshots,stored.snapshots);assert.equal(s.deliveries.length,pages.length);
  for(const {r,d} of pages){const row=s.deliveries.find(x=>x.id===r.coverage.deliveryToken);assert.ok(row,'C009 persisted native delivery token');assert.equal(row.snapshot,id);assert.deepEqual(JSON.parse(row.data),d,'C009 exact stored delivery');}
 };
 const checkCursor=(s,cursor)=>{assert.equal(s.cursors.length,1);const row=s.cursors[0];assert.equal(row.id,cursor);assert.equal(row.snapshot,id);assert.equal(row.expires,300000);
  assert.deepEqual(JSON.parse(row.state),{documentId:'doc-d',view:'inline',offset:1,lossOffset:0,selection:{tabs:['tab-d'],runs:[[0,4]],selectedFootprint:false,ancestors:[]},request:{scope:f.scope,format:'text',styles:false,review:false,omitImages:false},readId:'read-d-2'},'C009 exact frozen cursor state');return row;};
 const peek=(cursor,expected,category)=>{const p=local('cursor.peek',{cursor,owner,id},category);if(p){assert.deepEqual(p.snapshot,model);if(expected)assert.deepEqual(p.state,expected);assert.equal(p.state.offset,1);assert.equal(p.state.lossOffset,0);assert.equal(p.state.readId,'read-d-2');assert.deepEqual(p.state.request,{scope:f.scope,format:'text',styles:false,review:false,omitImages:false});}return p;};
 const coverage=(tokens,footprintSpec,missing)=>{
  const c=local('coverage.evaluate',{id,owner,tokens,spec:footprintSpec});assert.deepEqual(c.model,{binding:model.binding,revision:model.revision,modelDigest:digest(JSON.stringify(model))});
  assert.deepEqual(c.footprint.nodes,footprintSpec.nodes[0]==='snap-d:1'?f.expected.nodes.map(n=>n.id):['snap-d:2','snap-d:3','snap-d:4']);
  assert.equal(c.footprint.snapshotId,id);assert.equal(c.footprint.evidenceDigest,model.evidenceDigest);assert.deepEqual(c.footprint.aspects,['content']);assert.equal(c.footprint.destructive,true);
  assert.deepEqual(c.footprint,{snapshotId:id,evidenceDigest:model.evidenceDigest,nodes:footprintSpec.nodes[0]==='snap-d:1'?f.expected.nodes.map(n=>n.id):['snap-d:2','snap-d:3','snap-d:4'],targets:footprintSpec.nodes,dependencies:[],aspects:['content'],destructive:true});
  assert.deepEqual(c.result,{materialized:'complete',delivered:'incomplete',witnessSatisfied:false,missingAspects:[],missingNodes:missing,unresolvedNodes:[],editReady:false,authoringAuthority:'notEstablished'},'C009 exact incomplete coverage');
  return c;
 };
 if(v==='overrun'){
  if(negative){for(const k of ['snapshots','cursors','deliveries','pins','work','integrity'])assert.deepEqual(stored[k],[]);}
  else assert.deepEqual(state(),stored);
 }else if(v==='wrongThread'){
  get(negative?other:owner,negative?'snapshot':undefined);local('snapshot.get',{id:'missing-snapshot',owner},'snapshot');assert.deepEqual(state(),stored);
 }else if(v==='snapshotExpiry'){
  local('pin.create',{id,owner,pinId:'retention',expires:900000});advance(negative?600000:599999);get(owner,negative?'snapshot':undefined);
  assert.deepEqual(local('pin.read',{id,owner,pinId:'retention'}),model);const end=state();assert.deepEqual(end.snapshots,stored.snapshots);assert.deepEqual(end.pins,[{snapshot:id,owner:'retention',expires:900000}]);assert.deepEqual(end.deliveries,[]);assert.deepEqual(end.cursors,[]);
 }else if(v==='cursorExpiry'||v==='cursorReplay'){
  const first=readFirst(),before=state();checkStored(before,[first]);const row=checkCursor(before,first.r.nextCursor);
  const p=peek(row.id,JSON.parse(row.state)),args={account:owner.account,snapshotId:id,cursor:row.id};
  if(v==='cursorExpiry'){
   advance(negative?300000:299999);peek(row.id,p.state,negative?'snapshot':undefined);
   const next=native('docs_read',args,negative?'snapshot':undefined),end=state();
   if(negative)assert.deepEqual(end,before);else{const d=checkPage(next,f.expected.records.slice(1),[f.expected.losses[1],f.expected.losses[2]],true,1);checkStored(end,[first,{r:next,d}]);assert.deepEqual(end.cursors,[]);}
  }else if(negative){
   native('docs_read',args,'budget');const failed=state();noPublication(before,failed);assert.equal(failed.work[0].bytes,2*before.work[0].bytes,'C009 failed packing charged');
   native('docs_read',args,'budget');peek(row.id,p.state);assert.deepEqual(local('cursor.consume',{cursor:row.id,owner,id}),p);local('cursor.consume',{cursor:row.id,owner,id},'snapshot');native('docs_read',args,'snapshot');
   const end=state();checkStored(end,[first]);assert.deepEqual(end.cursors,[]);assert.equal(end.work[0].bytes,3*before.work[0].bytes);
  }else{
   const next=native('docs_read',args),d=checkPage(next,f.expected.records.slice(1),[f.expected.losses[1],f.expected.losses[2]],true,1);peek(row.id,undefined,'snapshot');native('docs_read',args,'snapshot');const end=state();checkStored(end,[first,{r:next,d}]);assert.deepEqual(end.cursors,[]);
  }
 }else if(v==='empty'){
  let ds=[],tokens=[];
  if(!negative){const r=native('docs_read',f.read);ds=[checkPage(r,[],[],true,0)];tokens=[r.coverage.deliveryToken];assert.deepEqual(delivery(tokens),ds);}
  const c=coverage(tokens,{nodes:['snap-d:1'],aspects:['content'],destructive:true},f.expected.nodes.map(n=>n.id));assert.deepEqual(c.deliveries,ds);const end=state();assert.deepEqual(end.deliveries,ds.map((d,i)=>({id:tokens[i],snapshot:id,data:JSON.stringify(d)})));assert.deepEqual(end.cursors,[]);
 }else if(v==='partial'){
  const first=readFirst(),tokens=[first.r.coverage.deliveryToken];assert.deepEqual(delivery(tokens),[first.d]);assert.deepEqual(coverage(tokens,spec,['snap-d:2','snap-d:4']).deliveries,[first.d]);const before=state();checkStored(before,[first]);checkCursor(before,first.r.nextCursor);
  if(negative)assert.deepEqual(state(),before);
  else {const next=native('docs_read',{account:owner.account,snapshotId:id,cursor:first.r.nextCursor}),d=checkPage(next,f.expected.records.slice(1),[f.expected.losses[1],f.expected.losses[2]],true,1);tokens.push(next.coverage.deliveryToken);assert.deepEqual(delivery(tokens),[first.d,d]);assert.deepEqual(coverage(tokens,spec,['snap-d:2']).deliveries,[first.d,d]);const end=state();checkStored(end,[first,{r:next,d}]);assert.deepEqual(end.cursors,[]);}
 }else if(v==='draftPinnedEvidence'){
  const r=native('docs_read',f.read);assert.equal(r.complete,true);assert.equal(r.nextCursor,null);assert.deepEqual(r.records.map(x=>x.id),f.expected.nodes.map(x=>x.id));assert.equal(r.coverage.editReady,false);
  assert.deepEqual(r.records,f.expected.nodes.map(n=>{const {evidence,...value}=model.nodes[n.id];return {...value,evidenceDigest:evidence.digest};}),'C009 exact pinned read records');
  const tokens=[r.coverage.deliveryToken],ds=delivery(tokens);assert.equal(ds.length,1);assert.deepEqual(ds[0].nodes,f.expected.nodes.map(x=>x.id));assert.deepEqual(ds[0].aspects,['content','styles','review']);assert.deepEqual(ds[0].losses,[]);
  const request={...f.witness,deliveryTokens:tokens},evaluation=local('evidence.evaluate',{owner,args:request});
  assert.equal(evaluation.witnessSatisfied,true);assert.deepEqual(evaluation.missingAspects,[]);assert.equal(evaluation.authoringAuthority,'notEstablished');assert.equal(evaluation.editReady,false);assert.deepEqual(evaluation.target,f.witness.presentation.target);
  const handle=local('evidence.retain',{owner,args:{request,expires:900000}});assert.equal(handle.kind,'pinnedReadEvidence');assert.equal(handle.pinId,'pin-c009');assert.equal(handle.expires,900000);assert.equal(handle.retainedEvidenceOnly,true);assert.equal(handle.editReady,false);assert.equal(handle.authoringAuthority,'notEstablished');assert.deepEqual(handle.references.deliveryTokens,tokens);
  const saved=state();assert.deepEqual(saved.pins,[{snapshot:id,owner:handle.pinId,expires:900000}]);assert.equal(saved.deliveries.length,2);const witness=JSON.parse(saved.deliveries.find(d=>d.id===handle.witnessToken).data);
  assert.deepEqual(witness.result,evaluation);assert.equal(handle.witnessDigest,digest(JSON.stringify(witness)));assert.deepEqual(handle.references,witness.references);assert.deepEqual(handle.binding,witness.binding);assert.deepEqual(witness.retention,{pinId:handle.pinId,expires:900000});assert.deepEqual(witness.nodes,[]);assert.equal(witness.format,'retainedWitness');
  local('pin.create',{id,owner,pinId:handle.pinId,expires:900001},'conflict');
  for(let i=0;i<31;i++)local('pin.create',{id,owner,pinId:`extra-${i}`,expires:900000});local('pin.create',{id,owner,pinId:'overflow',expires:900000},'budget');const full=state();assert.equal(full.pins.length,32);assert.ok(!full.pins.some(p=>p.owner==='overflow'));assert.deepEqual(full.deliveries,saved.deliveries);
  for(let i=0;i<31;i++)local('pin.release',{id,owner,pinId:`extra-${i}`});advance(600000);get(owner,'snapshot');
  const consumed=local('evidence.consume',{owner,handle});assert.deepEqual(consumed,{...evaluation,retainedEvidenceOnly:true,pinId:handle.pinId,expires:900000,references:handle.references,currentReadAuthority:false,authoringAuthority:'notEstablished',editReady:false});
  local('evidence.consume',{owner:other,handle},'snapshot');if(negative)local('evidence.consume',{owner,handle:{...handle,witnessDigest:'0'.repeat(64)}},'conflict');
  advance(900000);local('evidence.consume',{owner,handle},'snapshot');local('pin.release',{id,owner,pinId:handle.pinId});local('evidence.consume',{owner,handle},'snapshot');const end=state();assert.deepEqual(end.pins,[]);assert.deepEqual(end.deliveries,saved.deliveries);assert.deepEqual(end.snapshots,saved.snapshots);assert.deepEqual(end.cursors,[]);
 }else assert.fail('unimplemented C009 discriminator');
 assert.equal(li,t.localCalls.length,'C009 orphan local call');assert.equal(ni,t.nativeCalls.length,'C009 orphan native call');
 const expectedHTTP=[identityURL,identityURL,u.metadata,identityURL,u.document,...t.nativeCalls.slice(1).map(()=>identityURL)];
 assert.deepEqual(t.http.map(h=>h.url),expectedHTTP,'C009 actual closed GET order');
 for(const h of t.http){assert.equal(h.method,'GET');assert.equal(h.contentLength,null);const name=h.url===identityURL?'identity':h.url===u.metadata?'metadata':'document';assert.equal(h.response,name);assert.equal(h.wireBytes,name==='document'?Buffer.byteLength(wire(f)):bytes(f.provider[name]));assert.equal(h.emittedBytes,h.wireBytes,'C009 actual streamed bytes');assert.ok(Number.isSafeInteger(h.chunks)&&h.chunks>0&&h.chunks<=2049);}
}
