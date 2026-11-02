// Fixed S02 selection routes. Real core/application, logical memory only.
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { createSemanticReadService } from '../../../core/docs-semantic/application.mjs';
import { materialize } from '../../../core/docs-semantic/model.mjs';
import { SEMANTIC_READ_SCHEMAS } from '../../../docs-semantic-schemas.mjs';
import { createMemorySnapshots } from '../support/memory-snapshots.mjs';
import { localInvocationBoundary,modelBinding } from '../support/local-invocations.mjs';
import { selectionFixture,selectionOwner as owner,selectionScope,paragraph } from './selection-fixtures.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex'),json=x=>JSON.parse(JSON.stringify(x)),bytes=x=>Buffer.byteLength(JSON.stringify(x));
export const isSelection=r=>['C004','C016','C017','C020'].includes(r.ledgerId);
export function selectionBoundary(r){assert.ok(isSelection(r));return {layer:r.ledgerId==='C004'?'application':'core',entryPoint:{C004:'createSemanticReadService.inspect',C016:'resolveSelector',C017:'resolveSelector/resolveScope/evaluateLogicalIdentity',C020:'parseDocument/resolveScope'}[r.ledgerId],ports:{snapshots:'memory/logical-only',authority:'scripted',document:'scripted-observation'},companions:['semantic-native-read','semantic-sqlite-contract','semantic-http-contract','s02-selection-native']};}
export function assertSelectionFixture(r,f){assert.ok(isSelection(r));assert.equal(f.caseId,r.caseId);assert.equal(f.variant,r.base);assert.equal(f.outcome,r.outcomeVariant);assert.deepEqual(f,json(selectionFixture(r)),'fixed original variant/outcome source and expected facts');}
const body=d=>d.tabs[0].documentTab.body;
function tableDocument(labels){return {documentId:'doc-s02',revisionId:labels.join('-'),suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-d',title:'Rows'},documentTab:{body:{content:[{startIndex:1,endIndex:3+labels.length*5,table:{rows:labels.length,columns:1,tableRows:labels.map((text,i)=>({startIndex:2+i*5,endIndex:7+i*5,tableCells:[{startIndex:3+i*5,endIndex:7+i*5,content:[paragraph(text,4+i*5)]}]}))}}]}}}]};}
const binding=(document,snapshotId)=>({snapshotId,...owner,documentId:'doc-s02',view:'inline',retrievedAt:0,responseDigest:hash(document),responseBytes:bytes(document)});
const mappingBinding=(document,snapshotId)=>({snapshotId,evidenceDigest:hash(document),...owner,documentId:'doc-s02',view:'inline'});
// Independent original cell8 -> destination cell12. Digests hash literal raw
// observations; neither the target nor the oracle is obtained from the resolver.
export function identityFacts(duplicate=false,wrongCell=false){const a=tableDocument(['A','B']),b=tableDocument(duplicate?['X','B','B']:['X','A','B']),origin=materialize({document:a,metadata:{id:'doc-s02'},binding:binding(a,'origin'),reviewIncluded:true}),destination=materialize({document:b,metadata:{id:'doc-s02'},binding:binding(b,'destination'),reviewIncluded:true});const index=wrongCell?1:2,facts={version:1,id:'original-B',provenance:{kind:'readEvidenceComparison',id:'two-observations'},origin:mappingBinding(a,'origin'),destination:mappingBinding(b,'destination'),entries:[{source:'origin:8',target:`destination:${wrongCell?8:12}`,kind:'tableCell',tabId:'tab-d',segment:{kind:'body'},sourceEvidenceDigest:hash(body(a).content[0].table.tableRows[1].tableCells[0]),targetEvidenceDigest:hash(body(b).content[0].table.tableRows[index].tableCells[0])}]};return {origin,destination,mapping:{...facts,mappingDigest:hash(facts)}};}
export function expectedIdentity(mapping){return {status:'resolved',logicalSource:'origin:8',target:'destination:12',kind:'tableCell',mappingId:'original-B',mappingDigest:mapping.mappingDigest,origin:mapping.origin,destination:mapping.destination,provenance:{kind:'readEvidenceComparison',id:'two-observations'},evidenceKind:'readSideIdentityComparison',authoringAuthority:'notEstablished'};}
export async function executeSelection(r,f){
 assertSelectionFixture(r,f);const memory=createMemorySnapshots(),calls=[],events=[],store={semanticSnapshots:memory.port,byEmail:async email=>({subject:email===owner.account?owner.subject:'subject-other',email})};let document=f.document,id=0;
 const service=createSemanticReadService({store,clock:()=>0,ids:()=>++id===1?'s02-a':`s02-token-${id}`,pageBytes:r.ledgerId==='C004'?65536:undefined,docs:{authority:async a=>{calls.push({operation:'authority',subject:a.subject});},metadata:async()=>{calls.push({operation:'metadata'});return f.metadata;},read:async()=>{calls.push({operation:'read'});return {document,responseDigest:hash(document),responseBytes:bytes(document),reviewIncluded:true};}}});
 const local=localInvocationBoundary(store);
 async function invoke(method,args){const schema=SEMANTIC_READ_SCHEMAS[method==='inspect'?'docs_inspect':'docs_read'].safeParse(args);if(!schema.success)return {error:'schema'};try{return {result:json(await service[method](schema.data,owner.threadId))};}catch(e){return {error:e.semanticCode??'unexpected'};}}
 const args={account:owner.account,document:'doc-s02',scope:selectionScope};
 if(r.ledgerId==='C004'){
  if(f.invalid){document=f.invalidDocument;const input={...args,document:f.invalidInput,...r.base==='depth'?{outlineDepth:-1}:{}};events.push({id:randomUUID(),role:'invalid',value:await invoke('inspect',input),state:memory.observe(),calls:json(calls)});document=f.document;id=0;}
  for(const [i,s]of f.invalidChecks.entries()){document=s.document??f.document;events.push({id:randomUUID(),role:`invalid-check-${i}`,value:await invoke('inspect',{...args,...s.outlineDepth!==undefined?{outlineDepth:s.outlineDepth}:{}}),state:memory.observe()});id=0;}document=f.document;
  for(const s of f.outlineProbes){const memory=createMemorySnapshots(),store={semanticSnapshots:memory.port,byEmail:async()=>({subject:owner.subject,email:owner.account})},service=createSemanticReadService({store,clock:()=>0,ids:()=>'outline-probe',docs:{authority:async()=>{},metadata:async()=>f.metadata,read:async()=>({document:s.document,responseDigest:hash(s.document),responseBytes:bytes(s.document),reviewIncluded:true})}});events.push({id:randomUUID(),role:'peer-precision',value:json(await service.inspect(args,owner.threadId)),outline:memory.port.get('outline-probe',owner,0).outline});}
  const initial=await invoke('inspect',{...args,outlineDepth:f.depth});events.push({id:randomUUID(),role:'summary',value:initial});
  // Use a separately configured service over the same original snapshot port;
  // diagnostic packing remains production application logic, not a projector.
  const paged=createSemanticReadService({store,clock:()=>0,ids:()=>`s02-page-${++id}`,pageBytes:3000,docs:{authority:async a=>calls.push({operation:'authority',subject:a.subject}),metadata:async()=>f.metadata,read:async()=>({document:f.document,responseDigest:hash(f.document),responseBytes:bytes(f.document),reviewIncluded:true})}});
  const first=json(await paged.inspect({...args,include:['outline'],outlineDepth:f.depth},owner.threadId));
  const pages=[first],before=memory.observeDetailed();let wrong=null;
  if(r.outcomeVariant==='wrongSubject'){assert.ok(first.nextCursor);try{await paged.inspect({account:'other@example.test',snapshotId:first.snapshotId,cursor:first.nextCursor},owner.threadId);}catch(e){wrong=e.semanticCode;} }
  const after=memory.observeDetailed();
  while(pages.at(-1).nextCursor){assert.ok(pages.length<128);pages.push(json(await paged.inspect({account:owner.account,snapshotId:first.snapshotId,cursor:pages.at(-1).nextCursor},owner.threadId)));}
  const m=memory.port.get('s02-a',owner,0),pagedModel=memory.port.get(first.snapshotId,owner,0),deliveries=memory.port.deliveries(first.snapshotId,owner,0,pages.map(p=>p.coverage.deliveryToken));
  events.push({id:randomUUID(),role:'pages',pages,before,after,wrong,outline:m.outline,pagedOutline:pagedModel.outline,evidence:m.evidence,paragraphs:[2,6,10,14].map(n=>m.nodes[`s02-a:${n}`].extent),deliveries});
 }else{
  const inspected=await invoke('inspect',{...args,scope:r.ledgerId==='C020'||r.base==='staleOrdinal'?{tabs:{all:true},segments:[{kind:'body'}]}:selectionScope});assert.ok(inspected.result);const model=memory.port.get('s02-a',owner,0);
  for(const [role,s]of [['primary',f.primary],['control',f.control],...f.checks.map((s,i)=>[`check-${i}`,s])]){
   let value,error;const selectedModel=s.snapshotDocument?materialize({document:s.snapshotDocument,metadata:f.metadata,binding:binding(s.snapshotDocument,'s02-a'),reviewIncluded:true}):model;
   try{if(s.operation==='selector')value=local.resolveSelector(selectedModel,s.scope,s.selector);
    else if(s.operation==='tab'){const parsed=local.parseDocument(s.input);value={parsed,resolved:local.resolveScope(selectedModel,s.scope,parsed.urlTab)};}
    else {const facts=identityFacts(s.duplicate);value=local.evaluateLogicalIdentity(facts.origin,facts.destination,facts.mapping,'origin:8');}
   }catch(e){error=e.semanticCode??'unexpected';}
   events.push({id:randomUUID(),role,...error?{error}:{value}});
  }
  if(r.base==='transformedIdentity'){
   const facts=identityFacts(false,true);let error;try{local.evaluateLogicalIdentity(facts.origin,facts.destination,facts.mapping,'origin:8');}catch(e){error=e.semanticCode;}events.push({id:randomUUID(),role:'rehashed-wrong-cell',error});
   events.push({id:randomUUID(),role:'stale-handle',value:local.resolveSelector(facts.destination,selectionScope,{node:'origin:8'})});
  }
  events.push({id:randomUUID(),role:'retained',outline:model.outline,evidence:model.evidence,state:memory.observe()});
 }
 const trace={boundary:selectionBoundary(r),events,localCalls:local.records(),calls,providerAfter:json(f.document)};compareSelection(r,f,trace);return trace;
}
export function compareSelection(r,f,t){
 assertSelectionFixture(r,f);assert.deepEqual(t.boundary,selectionBoundary(r));assert.deepEqual(t.providerAfter,f.document);
 const seen=new Set();for(const e of t.events){assert.match(e.id,/^[a-f0-9-]{36}$/);assert.ok(!seen.has(e.id));seen.add(e.id);}
 if(r.ledgerId==='C004'){
  assert.equal(t.localCalls.length,0);assert.deepEqual(t.events.map(e=>e.role),[...f.invalid?['invalid']:[],...f.invalidChecks.map((_,i)=>`invalid-check-${i}`),...f.outlineProbes.map(()=>'peer-precision'),'summary','pages']);
  for(const [i,s]of f.invalidChecks.entries()){assert.deepEqual(t.events[1+i].value,{error:s.error});assert.deepEqual(t.events[1+i].state,{snapshots:0,deliveries:0,cursors:0,pins:0,work:[]});}
  for(const [i,s]of f.outlineProbes.entries()){const e=t.events[i];assert.equal(e.role,'peer-precision');assert.deepEqual(e.outline,s.outline);assert.deepEqual(e.value.outline,s.outline);assert.equal(e.value.coverage.readProof,false);}
  if(f.invalid){assert.deepEqual(t.events[0].calls,f.invalid==='schema'?[]:f.invalid==='invalid'?[{operation:'authority',subject:owner.subject}]:[{operation:'authority',subject:owner.subject},{operation:'metadata'},{operation:'read'}]);assert.deepEqual(t.events[0].value,{error:f.invalid});assert.deepEqual(t.events[0].state,{snapshots:0,deliveries:0,cursors:0,pins:0,work:[]});}
  const summary=t.events.at(-2).value.result,e=t.events.at(-1);assert.ok(summary);assert.deepEqual(summary.outline,f.expectedOutline);assert.deepEqual(e.outline,f.outline);assert.deepEqual(e.evidence,f.document);assert.deepEqual(e.paragraphs,[{start:1,end:3},{start:5,end:7},{start:9,end:11},{start:13,end:15}]);
  assert.deepEqual(summary,{kind:'nativeDoc',metadata:f.metadata,capabilities:{read:{schema:'supported',account:'observed'},nativeSuggestions:{schema:'supported',account:'unverified'},authoring:{product:'not_exposed',account:'unverified'},documentPermission:'editorObserved'},snapshotId:'s02-a',view:'inline',revision:{kind:'docs',id:'docs-r1',subject:owner.subject},tabs:[{id:'tab-d',title:'Main',parent:null,ordinal:0,siblingIndex:7,depth:0,segments:[{node:'s02-a:1',segment:{kind:'body'}},...r.outcomeVariant==='preservation'?[{node:'s02-a:18',segment:{kind:'header',id:'hdr'}}]:[]]}],outline:f.expectedOutline,counts:{nodes:['bounds','wrongSubject'].includes(r.outcomeVariant)?r.base==='sectionExtent'?82:81:17,unknownNodes:0},registries:[{tabId:'tab-d',counts:Object.fromEntries(['lists','namedStyles','namedRanges','inlineObjects','positionedObjects','bookmarks','dropdownDefinitions','commentAnchors'].map(k=>[k,0])),readProof:false}],diagnosticRead:{include:['tabs','outline','styles','lists','objects','ranges','review','diagnostics'],paged:true},provenance:{provider:'googleDocs',retrievedAt:0,responseDigest:hash(f.document),source:'current',effectiveDefaults:'unknownWhenAbsent'},coverage:{materialized:'complete',delivered:'summary',readProof:false,missingReviewCoverage:false},thisCall:{providerMutationCount:0}},'independent complete summary; no content authority');
  assert.equal(summary.coverage.delivered,'summary');assert.equal(summary.coverage.readProof,false);assert.equal(summary.thisCall.providerMutationCount,0);
  const snapshotId=e.pages[0].snapshotId,expected=json(f.expectedOutline).map(h=>json(h));
  // Only the new snapshot handle prefix differs; original provider facts and
  // independently expected exact URLs/intervals/end identities remain literal.
  const replace=x=>JSON.parse(JSON.stringify(x).replaceAll('s02-a:',snapshotId+':'));
  assert.deepEqual(e.pages.flatMap(p=>p.records),replace([{id:'s02-a:metadata',kind:'documentSummary',metadata:f.metadata,counts:{selectedNodes:['bounds','wrongSubject'].includes(r.outcomeVariant)?r.base==='sectionExtent'?82:81:17},capabilities:{authoring:'not_exposed',nativeSuggestions:'accountUnverified'},readProof:false},...expected.map(heading=>({id:`s02-a:outline:${heading.node}`,kind:'headingSummary',heading}))]));
  assert.deepEqual(e.pagedOutline,replace(f.outline));assert.equal(e.deliveries.length,e.pages.length);
  if(['bounds','wrongSubject'].includes(r.outcomeVariant))assert.ok(e.pages.length>1);
  for(const [i,p]of e.pages.entries()){assert.deepEqual(p,{kind:'nativeDoc',snapshotId,view:'inline',revision:{kind:'docs',id:'docs-r1',subject:owner.subject},capabilities:summary.capabilities,records:p.records,losses:[],complete:i===e.pages.length-1,nextCursor:i===e.pages.length-1?null:p.nextCursor,coverage:{materialized:'complete',delivered:{nodes:p.records.map(r=>r.id),aspects:[],nodeAspects:Object.fromEntries(p.records.map(r=>[r.id,[]]))},readProof:false,editReady:false,missingReviewCoverage:false,deliveryToken:p.coverage.deliveryToken},provenance:summary.provenance,thisCall:{providerMutationCount:0}},'complete diagnostic envelope, no authoring authority');assert.ok(bytes(p)<=3000);assert.equal(p.complete,i===e.pages.length-1);assert.equal(p.coverage.readProof,false);assert.equal(p.coverage.editReady,false);assert.deepEqual(p.coverage.delivered.aspects,[]);assert.equal(p.thisCall.providerMutationCount,0);assert.equal(p.nextCursor===null,p.complete);assert.deepEqual(p.coverage.delivered.nodes,p.records.map(r=>r.id));const d=e.deliveries[i];assert.equal(d.format,'diagnostic');assert.deepEqual(d.nodes,p.records.map(r=>r.id));assert.deepEqual(d.aspects,[]);assert.equal(d.evidenceDigest,hash(f.document));assert.equal(d.complete,p.complete);}
  assert.deepEqual(e.before,e.after,'foreign subject cannot consume cursor or publish');assert.equal(e.wrong,r.outcomeVariant==='wrongSubject'?'snapshot':null);
 }else{
  const specs=[f.primary,f.control,...f.checks],identity=r.base==='transformedIdentity';assert.equal(t.events.length,specs.length+1+(identity?2:0));
  let localIndex=0;
  for(const [i,s]of specs.entries()){const e=t.events[i];assert.equal(e.role,i===0?'primary':i===1?'control':`check-${i-2}`);
   let error=s.error;if(s.operation==='identity'&&s.duplicate)error='conflict';
   if(error){assert.equal(e.error,error);assert.equal(e.value,undefined);}else{assert.equal(e.error,undefined);const expected=s.operation==='tab'?{parsed:s.parsed,resolved:s.expected}:s.operation==='identity'?expectedIdentity(identityFacts(false).mapping):s.expected;assert.deepEqual(e.value,expected,'independent exact selected interval/nodes/status');}
   const call=t.localCalls[localIndex++];assert.ok(call);assert.equal(call.operation,s.operation==='selector'?'resolveSelector':s.operation==='tab'?'parseDocument':'evaluateLogicalIdentity');
   if(s.operation==='selector'){assert.deepEqual(call.model.binding,binding(s.snapshotDocument??f.document,'s02-a'));assert.deepEqual(call.args,{scope:s.scope,selector:s.selector});assert.equal(call.model.binding.snapshotId,'s02-a');if(!error)assert.deepEqual(call.result,e.value);else assert.deepEqual(call.error,{category:error});}
   else if(s.operation==='tab'){assert.deepEqual(call.args,{input:s.input});if(call.error)assert.deepEqual(call.error,{category:error});else{assert.deepEqual(call.result,s.parsed);const scope=t.localCalls[localIndex++];assert.equal(scope.operation,'resolveScope');assert.deepEqual(scope.model.binding,binding(s.snapshotDocument??f.document,'s02-a'));assert.deepEqual(scope.args,{scope:s.scope,urlTab:s.parsed.urlTab});if(error)assert.deepEqual(scope.error,{category:error});else assert.deepEqual(scope.result,s.expected);}}
   else {const facts=identityFacts(s.duplicate);assert.deepEqual(call.model,modelBinding(facts.origin),'exact original identity observation');assert.deepEqual(call.args,{destination:modelBinding(facts.destination),mapping:facts.mapping,logicalSource:'origin:8'},'exact destination and logical B source');assert.deepEqual(call.args.mapping,facts.mapping);if(error)assert.deepEqual(call.error,{category:error});else assert.deepEqual(call.result,e.value);}
  }
  if(identity){assert.deepEqual(t.events.at(-3).error,'conflict');assert.deepEqual(t.events.at(-2).value,{status:'missing',snapshotId:'destination',nodes:[],candidates:[],readProof:false});const wrong=t.localCalls[localIndex++];assert.equal(wrong.operation,'evaluateLogicalIdentity');const wrongFacts=identityFacts(false,true);assert.deepEqual(wrong.model,modelBinding(wrongFacts.origin));assert.deepEqual(wrong.args,{destination:modelBinding(wrongFacts.destination),mapping:wrongFacts.mapping,logicalSource:'origin:8'});assert.deepEqual(wrong.args.mapping,wrongFacts.mapping);assert.deepEqual(wrong.error,{category:'conflict'});const stale=t.localCalls[localIndex++];assert.equal(stale.operation,'resolveSelector');assert.deepEqual(stale.model,modelBinding(wrongFacts.destination));assert.deepEqual(stale.args,{scope:selectionScope,selector:{node:'origin:8'}});assert.deepEqual(stale.result,t.events.at(-2).value);}
  assert.equal(localIndex,t.localCalls.length,'no orphan local calls');const retained=t.events.at(-1);assert.equal(retained.role,'retained');assert.deepEqual(retained.evidence,f.document);assert.deepEqual(retained.outline,f.outline);assert.deepEqual(retained.state,{snapshots:1,deliveries:0,cursors:0,pins:0,work:[]});assert.deepEqual(t.calls,[{operation:'authority',subject:owner.subject},{operation:'metadata'},{operation:'read'}]);
 }
 return true;
}
