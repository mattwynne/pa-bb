// Fixed actual application path for remaining S02 discovery obligations.
// Independent literal fixtures own expectations; only external ports are replaced.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSemanticReadService } from '../../../core/docs-semantic/application.mjs';
import { createMemorySnapshots } from '../support/memory-snapshots.mjs';
import { SEMANTIC_READ_SCHEMAS } from '../../../docs-semantic-schemas.mjs';
import { digest } from './audit.mjs';
import { describeSemanticFailure } from '../../../core/docs-semantic/failures.mjs';
import { footprint,evaluateWitness } from '../../../core/docs-semantic/coverage.mjs';
const operations=new Set(['docs_inspect.kind','docs_inspect.tabs','docs_inspect.provenance']);
export const isDiscoveryApplication=r=>operations.has(r.operation)&&r.caseId!=='C001.nativeDoc__read.success';
export function discoveryBoundary(r){assert.ok(isDiscoveryApplication(r));return{layer:'application',entryPoint:'createSemanticReadService.inspect',ports:{snapshots:'memory/logical-only',authority:'scripted',document:'scripted-observation'},companions:['semantic-native-read','semantic-sqlite-contract','semantic-http-contract','s02-discovery-native']};}
const owner={subject:'subject-d',account:'reader@example.test',threadId:'thread-d'},other={subject:'subject-other',email:'other@example.test'},bytes=x=>Buffer.byteLength(JSON.stringify(x)),json=x=>JSON.parse(JSON.stringify(x));
export function discoveryModelFacts(snapshot){return{binding:snapshot.binding,revision:snapshot.revision,metadata:snapshot.metadata,evidenceDigest:snapshot.evidenceDigest,providerDigest:digest(JSON.stringify(snapshot.evidence)),nodeCount:Object.keys(snapshot.nodes).length,tabs:snapshot.tabs.map(t=>({id:t.providerId,title:t.title,parent:t.parent,ordinal:t.ordinal,siblingIndex:t.siblingIndex,depth:t.depth,segments:t.segments})),outline:snapshot.outline};}
export function assertDiscoveryFixture(r,f){
 assert.ok(isDiscoveryApplication(r));assert.equal(f.caseId,r.caseId);assert.equal(f.variant,r.base);assert.equal(f.outcome,r.outcomeVariant);assert.equal(r.requestedMode,'read');
 const blob=['markdownBlob','wordBlob'].includes(r.base),nativeKind=r.base==='notReadProof'?'proof':r.base==='changeAwareness'?'change':'summary';
 const tabInvalid=r.operation==='docs_inspect.tabs'&&r.outcomeVariant==='invalid';
 const kind=r.outcomeVariant==='invalid'?(tabInvalid&&r.base==='duplicateTitle'?'ambiguous':'error'):r.outcomeVariant==='bounds'?(blob?'error':'paged'):r.outcomeVariant==='wrongSubject'?(blob?'error':'pagedOwnership'):nativeKind;
 assert.equal(f.primary.kind,kind,'exact discovery outcome branch');assert.equal(f.control.kind,nativeKind,'same-variant permitted control');
 if(blob){const mimes=r.base==='markdownBlob'?['text/markdown','text/x-markdown']:['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword'];assert.equal(f.primary.metadata.mimeType,mimes[0]);assert.equal(f.control.metadata.mimeType,mimes[1]);}
 else {assert.equal(f.primary.metadata.mimeType,'application/vnd.google-apps.document');assert.equal(f.control.metadata.mimeType,'application/vnd.google-apps.document');}
 if(r.base==='permissionUnknown'){assert.equal(f.primary.metadata.capabilities,undefined);assert.deepEqual(f.control.metadata.capabilities,{canEdit:false});}
 if(r.outcomeVariant==='bounds'&&!blob){assert.equal(f.primary.pageBytes,3000);assert.equal(f.primary.tabs.length,100);if(r.base==='selected')assert.equal(f.primary.args.scope.tabs.ids.length,100);if(r.base==='recursive')assert.equal(f.primary.tabs[2].depth,2);if(r.base==='duplicateTitle')assert.equal(new Set(f.primary.tabs.map(t=>t.title)).size,1);}
 if(r.operation==='docs_inspect.tabs'&&['success','preservation'].includes(r.outcomeVariant)){assert.deepEqual(f.primary.args.scope.tabs,r.base==='selected'?{ids:['tab-child']}:{all:true});assert.equal(f.primary.tabs[2].depth,2);assert.equal(f.primary.tabs[0].title,f.primary.tabs[3].title);}
 if(r.outcomeVariant==='invalid'){if(!tabInvalid){assert.equal(f.primary.metadata.id,'wrong-document');assert.equal(f.primary.error,'conflict');}else{assert.equal(f.checks.length,1);assert.equal(f.checks[0].metadata.id,'wrong-document');assert.equal(f.checks[0].kind,'error');assert.equal(f.primary.metadata.id,'doc-s02');if(r.base==='recursive'){assert.equal(f.primary.document.tabs[0].childTabs[0].tabProperties.parentTabId,'tab-b');assert.equal(f.primary.error,'conflict');}if(r.base==='selected'){assert.deepEqual(f.primary.args.scope.tabs,{ids:['missing-tab']});assert.equal(f.primary.error,'scope');}if(r.base==='all'){assert.deepEqual(f.primary.args.scope.segments,[{kind:'header',id:'missing-header'}]);assert.equal(f.primary.error,'scope');}if(r.base==='duplicateTitle'){assert.deepEqual(f.primary.args.scope.tabs,{path:['Main']});assert.deepEqual(f.control.args.scope.tabs,{ids:['tab-b']});}}}
 if(r.outcomeVariant==='wrongSubject'&&blob){assert.equal(f.primary.fault,'authorityChanged');assert.equal(f.primary.error,'snapshot');}
 return true;
}
export async function executeDiscovery(record,f){
 assertDiscoveryFixture(record,f);
 assert.ok(isDiscoveryApplication(record));const events=[];
 for(const [role,s]of [['primary',f.primary],['control',f.control],...(f.checks??[]).map((s,i)=>[`check-${i}`,s])]){
  const memory=createMemorySnapshots(),calls=[];let now=0,id=0,account={subject:owner.subject,email:owner.account},metadata=structuredClone(s.metadata),document=structuredClone(s.document);
  const store={semanticSnapshots:memory.port,byEmail:async email=>email===owner.account?account:email===other.email?other:null};
  const docs={authority:async r=>{calls.push({operation:'authority',subject:r.subject});if(s.fault==='authorityChanged')account={...account,subject:'changed'};},metadata:async(r,doc)=>{calls.push({operation:'metadata',documentId:doc});return metadata;},read:async(r,doc,view,signal,options)=>{calls.push({operation:'read',documentId:doc,view,options});return{document,responseDigest:digest(JSON.stringify(document)),responseBytes:bytes(document),reviewIncluded:true};}};
  const service=createSemanticReadService({store,docs,clock:()=>now,ids:()=>++id===1?'s02-a':s.kind==='change'&&id===2?'s02-b':`s02-token-${id}`,pageBytes:s.pageBytes??65536});
  async function invoke(method,args,thread=owner.threadId){const parsed=SEMANTIC_READ_SCHEMAS[{inspect:'docs_inspect',read:'docs_read'}[method]].safeParse(args);if(!parsed.success)return{error:'schema'};try{return{result:json(await service[method](parsed.data,thread))};}catch(error){return{error:error.semanticCode??'unavailable',failure:describeSemanticFailure(error)};}}
  const observed={id:randomUUID(),role,kind:s.kind,initial:await invoke('inspect',s.args)};
  if(observed.initial.result?.snapshotId){
   const snapshot=store.semanticSnapshots.get('s02-a',owner,now);observed.model=discoveryModelFacts(snapshot);observed.snapshotBytes=bytes(snapshot);
   if(s.kind==='paged'||s.kind==='pagedOwnership'){
    observed.pages=[observed.initial.result];let page=observed.initial.result;
    if(s.kind==='pagedOwnership'){assert.ok(page.nextCursor);observed.beforeRefusal=memory.observeDetailed();observed.wrongOwner=await invoke('inspect',{account:other.email,snapshotId:'s02-a',cursor:page.nextCursor});observed.afterRefusal=memory.observeDetailed();}
    for(let i=0;page.nextCursor;i++){assert.ok(i<127,'bounded original diagnostic pages');const cursor=page.nextCursor;const next=await invoke('inspect',{account:owner.account,snapshotId:'s02-a',cursor});assert.ok(next.result,'actual diagnostic continuation failed');page=next.result;observed.pages.push(page);assert.throws(()=>store.semanticSnapshots.peekCursor(cursor,owner,now,'s02-a'),e=>e.semanticCode==='snapshot');}
    observed.deliveries=store.semanticSnapshots.deliveries('s02-a',owner,now,observed.pages.map(p=>p.coverage.deliveryToken));
    if(record.base==='notReadProof'){try{observed.diagnosticWitness=evaluateWitness(snapshot,footprint(snapshot,{nodes:['s02-a:2'],aspects:['content'],destructive:true}),{deliveries:observed.deliveries});}catch(error){observed.diagnosticWitness={error:error.semanticCode};}}
   }
   if(s.kind==='change'){now=1;metadata=structuredClone(s.nextMetadata);document=structuredClone(s.nextDocument);observed.next=await invoke('inspect',s.args);observed.nextModel=discoveryModelFacts(store.semanticSnapshots.get('s02-b',owner,now));}
   if(s.kind==='proof'){
    const fp=footprint(snapshot,{nodes:['s02-a:2'],aspects:['content'],destructive:true});observed.summaryWitness=evaluateWitness(snapshot,fp,{deliveries:[]});
    observed.read=await invoke('read',{account:owner.account,snapshotId:'s02-a',scope:s.args.scope,selector:{node:'s02-a:2'},format:'structured'});
    const delivery=store.semanticSnapshots.deliveries('s02-a',owner,now,[observed.read.result.coverage.deliveryToken]);observed.contentWitness=evaluateWitness(snapshot,fp,{deliveries:delivery});
   }
   // Mutating external aliases after reads must never alter the saved snapshot.
   document.tabs[0].tabProperties.title='EXTERNAL_CHANGE';metadata.name='EXTERNAL_CHANGE';observed.retained=discoveryModelFacts(store.semanticSnapshots.get('s02-a',owner,now));
  }
  observed.calls=calls;observed.state=memory.observe();events.push(observed);
 }
 const trace={boundary:discoveryBoundary(record),events};compareDiscovery(record,f,trace);return trace;
}
// Independent complete public diagnostic envelope, not a production projector.
export function assertDiscoveryPage(p,s,index,count){
 const complete=index===count-1;assert.match(p.coverage.deliveryToken,/^[a-f0-9-]{36}$/);if(!complete)assert.match(p.nextCursor,/^[a-f0-9-]{36}$/);
 assert.deepEqual(p,{kind:'nativeDoc',snapshotId:'s02-a',view:'inline',revision:{kind:'docs',id:'docs-r1',subject:'subject-d'},capabilities:s.expectedCapabilities,records:p.records,losses:[],complete,nextCursor:complete?null:p.nextCursor,coverage:{materialized:'complete',delivered:{nodes:p.records.map(r=>r.id),aspects:[],nodeAspects:Object.fromEntries(p.records.map(r=>[r.id,[]]))},readProof:false,editReady:false,missingReviewCoverage:false,deliveryToken:p.coverage.deliveryToken},provenance:s.expectedProvenance,thisCall:{providerMutationCount:0}},'independent complete diagnostic envelope');
}
export function compareDiscovery(record,f,t){
 assertDiscoveryFixture(record,f);
 assert.deepEqual(t.boundary,discoveryBoundary(record),'fixed S02 discovery application boundary');assert.equal(f.caseId,record.caseId);assert.equal(f.variant,record.base);assert.equal(f.outcome,record.outcomeVariant);assert.equal(t.events.length,2+(f.checks??[]).length);
 for(const [i,s]of [f.primary,f.control,...f.checks??[]].entries()){
  const e=t.events[i];assert.match(e.id,/^[a-f0-9-]{36}$/);assert.equal(e.role,i===0?'primary':i===1?'control':`check-${i-2}`);assert.equal(e.kind,s.kind);
  if(s.kind==='error'){assert.equal(e.initial.error,s.error,'independent discovery refusal');assert.deepEqual(e.initial.failure,s.expectedFailure,'independently authored bounded failure');assert.equal(e.initial.result,undefined);assert.equal(e.state.snapshots,0);assert.equal(e.state.deliveries,0);assert.equal(e.state.cursors,0);assert.deepEqual(e.calls,s.fault==='authorityChanged'?[{operation:'authority',subject:owner.subject}]:[{operation:'authority',subject:owner.subject},{operation:'metadata',documentId:'doc-s02'},...s.metadata.id==='doc-s02'&&s.metadata.mimeType==='application/vnd.google-apps.document'?[{operation:'read',documentId:'doc-s02',view:'inline',options:{includeReview:true}}]:[]]);assert.deepEqual(e.state.work,[]);assert.equal(e.state.pins,0);continue;}
  const native=s.metadata.mimeType==='application/vnd.google-apps.document';
  assert.equal(e.initial.error,undefined);
  if(s.kind==='paged'||s.kind==='pagedOwnership'){
   assert.deepEqual(e.initial.result,e.pages[0],'actual first diagnostic output binding');
   assert.ok(e.pages.length>1,'actual bounded diagnostic continuation');assert.deepEqual(e.pages.flatMap(p=>p.records),s.expectedRecords,'independent complete diagnostic tab inventory');assert.equal(e.deliveries.length,e.pages.length);
   for(const [index,p]of e.pages.entries()){assertDiscoveryPage(p,s,index,e.pages.length);assert.ok(bytes(p)<=3000);assert.deepEqual(p.capabilities,s.expectedCapabilities);assert.deepEqual(p.provenance,s.expectedProvenance);assert.deepEqual(p.losses,[]);assert.equal(p.snapshotId,'s02-a');assert.equal(p.complete,index===e.pages.length-1);assert.equal(p.coverage.readProof,false);assert.equal(p.coverage.editReady,false);assert.deepEqual(p.coverage.delivered.aspects,[]);assert.deepEqual(p.coverage.delivered.nodeAspects,Object.fromEntries(p.records.map(r=>[r.id,[]])));const d=e.deliveries[index];assert.equal(d.format,'diagnostic');assert.equal(d.snapshotId,'s02-a');assert.equal(d.evidenceDigest,digest(JSON.stringify(s.document)));assert.equal(d.view,'inline');assert.deepEqual(d.nodes,p.records.map(r=>r.id));assert.deepEqual(d.aspects,[]);assert.deepEqual(d.nodeAspects,p.coverage.delivered.nodeAspects);assert.equal(d.complete,p.complete);assert.equal(d.readId,'s02-token-2');assert.deepEqual(d.scope,s.args.scope);assert.equal(d.offset,e.pages.slice(0,index).reduce((n,p)=>n+p.records.length,0));assert.equal(d.lossOffset,0);assert.deepEqual(d.losses,[]);assert.equal(p.thisCall.providerMutationCount,0);assert.ok(p.complete?p.nextCursor===null:typeof p.nextCursor==='string');}
   const projection={records:s.expectedRecords,losses:[],nodeAspects:Object.fromEntries(s.expectedRecords.map(r=>[r.id,[]])),aspects:[],missingAspects:['content','styles','review'],projection:'diagnostic'};
   assert.deepEqual(e.state.work,[[JSON.stringify(['s02-a','s02-token-2']),e.pages.length*(e.snapshotBytes+bytes(projection))]],'exact diagnostic traversal work, no refusal charge');assert.deepEqual(e.beforeRefusal,e.afterRefusal,'owner refusal changes no logical snapshot/cursor/delivery/work state');
   if(record.base==='notReadProof')assert.deepEqual(e.diagnosticWitness,{error:'scope'},'diagnostic handles are not content witness nodes');
   if(s.kind==='pagedOwnership')assert.deepEqual(e.wrongOwner,{error:'snapshot',failure:s.expectedOwnerFailure});assert.equal(e.state.cursors,0);assert.equal(e.state.deliveries,e.pages.length);
  }else assert.deepEqual(e.initial.result,s.expected,'independent complete discovery envelope');
  if(s.kind==='ambiguous'){assert.deepEqual(e.calls,[{operation:'authority',subject:owner.subject},{operation:'metadata',documentId:'doc-s02'},{operation:'read',documentId:'doc-s02',view:'inline',options:{includeReview:true}}]);assert.deepEqual(e.state,{snapshots:0,deliveries:0,cursors:0,pins:0,work:[]});assert.equal(e.model,undefined);continue;}
  const expectedCalls=[{operation:'authority',subject:owner.subject},{operation:'metadata',documentId:'doc-s02'},...native?[{operation:'read',documentId:'doc-s02',view:'inline',options:{includeReview:true}}]:[]];
  if(native){
   assert.deepEqual(e.model.binding,{snapshotId:'s02-a',...owner,documentId:'doc-s02',view:'inline',retrievedAt:0,responseDigest:digest(JSON.stringify(s.document)),responseBytes:bytes(s.document)});assert.deepEqual(e.model.revision,{kind:'docs',id:'docs-r1',subject:owner.subject});assert.deepEqual(e.model.metadata,s.metadata);assert.equal(e.model.providerDigest,digest(JSON.stringify(s.document)));assert.equal(e.model.evidenceDigest,e.model.providerDigest);assert.equal(e.model.nodeCount,s.nodes);assert.deepEqual(e.model.tabs,s.tabs.map(tab=>({id:tab.id,title:tab.title,parent:tab.parent,ordinal:tab.ordinal,siblingIndex:tab.siblingIndex,depth:tab.depth,segments:[tab.segment]})));assert.deepEqual(e.retained,e.model,'original saved observation survives new reads/external alias changes');
   if(s.kind==='change'){assert.deepEqual(e.next,{result:s.expectedNext});assert.equal(e.nextModel.revision.id,'docs-r2');assert.equal(e.nextModel.metadata.version,'18');assert.equal(e.nextModel.binding.retrievedAt,1);assert.notEqual(e.nextModel.evidenceDigest,e.model.evidenceDigest);expectedCalls.push(...expectedCalls.slice(0,3));}
   if(s.kind==='proof'){assert.deepEqual(e.summaryWitness,{materialized:'complete',delivered:'incomplete',witnessSatisfied:false,missingAspects:[],missingNodes:['s02-a:2','s02-a:3'],unresolvedNodes:[],editReady:false,authoringAuthority:'notEstablished'});assert.deepEqual(e.contentWitness,{materialized:'complete',delivered:'content',witnessSatisfied:true,missingAspects:[],missingNodes:[],unresolvedNodes:[],editReady:false,authoringAuthority:'notEstablished'});assert.equal(e.read.result.coverage.editReady,false);assert.deepEqual(e.read.result.coverage.delivered.nodes,['s02-a:2','s02-a:3']);assert.equal(e.read.result.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),'Plan\n');expectedCalls.push({operation:'authority',subject:owner.subject});}
   if(e.pages)expectedCalls.push(...e.pages.slice(1).map(()=>({operation:'authority',subject:owner.subject})));if(e.wrongOwner)expectedCalls.splice(3,0,{operation:'authority',subject:other.subject});
   assert.equal(e.state.snapshots,s.kind==='change'?2:1);assert.equal(e.state.pins,0);if(!e.pages&&s.kind!=='proof'){assert.deepEqual(e.state.work,[]);assert.equal(e.state.deliveries,0);assert.equal(e.state.cursors,0);}
  }else{assert.equal(e.model,undefined);assert.equal(e.state.snapshots,0);assert.equal(e.state.deliveries,0);assert.equal(e.state.cursors,0);assert.deepEqual(e.state.work,[]);}
  assert.deepEqual(e.calls,expectedCalls,'actual narrow external observations; never document/asset reads for blobs');
 }
 return true;
}
