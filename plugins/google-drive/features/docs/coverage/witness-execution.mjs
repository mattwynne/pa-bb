// Fixed K3 local comparisons. Only raw observations/authority/snapshot ports
// are substituted. Broad's immutable legacy primary remains a native route.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSemanticReadService } from '../../../core/docs-semantic/application.mjs';
import { compareReadEvidence,inspectNamedStyleEvidence,compareNamedStyleEvidence,compareGeneratedEvidence } from '../../../core/docs-semantic/coverage.mjs';
import { createReadEvidenceService } from '../../../core/docs-semantic/read-evidence-service.mjs';
import { createMemorySnapshots } from '../support/memory-snapshots.mjs';
import { witnessVariants,witnessFixture,witnessOwner as owner,scope,hash,descriptor,requestFor,generatedRequest,namedStyleOracle } from './witness-fixtures.mjs';
const json=x=>JSON.parse(JSON.stringify(x));
export const isWitness=r=>r.ledgerId==='C021'&&r.base!=='broadDelivered';
export function witnessBoundary(r){assert.ok(isWitness(r));return {layer:['siblingNotCovered','completePreview'].includes(r.base)?'application':'core',entryPoint:r.base==='generatedNode'?'compareGeneratedEvidence':r.base==='namedStyleIndirect'?'inspectNamedStyleEvidence/compareNamedStyleEvidence':['siblingNotCovered','completePreview'].includes(r.base)?'createReadEvidenceService.evaluate':'compareReadEvidence',ports:{snapshots:'memory/logical-only',authority:'scripted',document:'scripted-observation'},companions:['semantic-native-read','semantic-sqlite-contract','semantic-http-contract','s02-witness-native']};}
export function assertWitnessFixture(r,f){assert.equal(r.requestedMode,'local');assert.ok(witnessVariants.includes(r.base));assert.deepEqual(f,json(witnessFixture(r)),'fixed independent witness source/outcome');}
const ref=s=>({binding:s.binding,evidenceDigest:s.evidenceDigest});
export function expectedFootprint(f,s,request){const style=['styleFromMetadata','historyNotCurrent'].includes(f.variant),literal=f.variant==='narrowLiteral',prefix=s.binding.snapshotId;return {snapshotId:prefix,evidenceDigest:hash(f.document),nodes:(style?[5,4]:[4,5]).map(n=>`${prefix}:${n}`),targets:(style?[5]:literal?[4]:[4,5]).map(n=>`${prefix}:${n}`),dependencies:(style?[4]:literal?[5]:[]).map(n=>`${prefix}:${n}`),aspects:style?['styles']:['content','styles','review'],destructive:!style&&!literal};}
export function expectedReadResult(f,s,request,{missing=[],delivered}={}){return {materialized:'complete',delivered:delivered??(missing.includes('effectPresentation')?'none':['styleFromMetadata','historyNotCurrent','narrowLiteral'].includes(f.variant)?'effectPreview':'completePreview'),target:requestFor(f,s).presentation.target,footprint:expectedFootprint(f,s,request),comparisonDigest:hash(requestFor(f,s).presentation),globalDiagnostics:{missingReviewCoverage:false,unresolvedExtents:false},witnessSatisfied:missing.length===0,missingAspects:missing,editReady:false,authoringAuthority:'notEstablished'};}
// Original invocation returns, never a fixture-provided semantic answer.
export function captureWitnessCall(events,operation,models,args,run){const e={id:randomUUID(),operation,models:models.map(ref),args:json(args)};try{e.result=json(run());}catch(error){e.error=error.semanticCode??'unexpected';}events.push(e);return e.result;}
export async function executeWitness(r,f){
 assertWitnessFixture(r,f);const memory=createMemorySnapshots(),calls=[],events=[],reads=[];let document=f.document,clock=0,identity=0;
 const store={semanticSnapshots:memory.port,byEmail:async account=>({subject:owner.subject,email:account})};
 const read=createSemanticReadService({store,clock:()=>clock,ids:()=>++identity===1?'witness-a':`witness-${identity}`,docs:{authority:async()=>{calls.push('authority');},metadata:async()=>{calls.push('metadata');return structuredClone(f.metadata);},read:async()=>{calls.push('read');return {document:structuredClone(document),responseDigest:hash(document),responseBytes:Buffer.byteLength(JSON.stringify(document)),reviewIncluded:true};}}});
 const inspect=async()=>{const result=await read.inspect({account:owner.account,document:'doc-a',scope},owner.threadId);return memory.port.get(result.snapshotId,owner,clock);};
 const s=await inspect(),before=json(s),service=createReadEvidenceService({snapshots:memory.port,clock:()=>clock});
 const call=(op,args,fn,models=[s])=>captureWitnessCall(events,op,models,args,fn);
 const request=requestFor(f,s),bad=json(request);const negative=r.outcomeVariant==='counterexample';
 async function tokens(selector){const pages=[];let p=await read.read({account:owner.account,snapshotId:s.binding.snapshotId,scope,selector,format:'structured',styles:true,review:true},owner.threadId);for(;;){pages.push(json(p));if(!p.nextCursor)break;p=await read.read({account:owner.account,snapshotId:s.binding.snapshotId,cursor:p.nextCursor},owner.threadId);assert.ok(pages.length<100);}const ts=pages.map(p=>p.coverage.deliveryToken),stored=memory.port.deliveries(s.binding.snapshotId,owner,clock,ts);reads.push({selector,pages,tokens:ts,stored});return ts;}
 if(['narrowLiteral','styleFromMetadata'].includes(r.base)){
  bad.presentation.changes[0][r.base==='narrowLiteral'?'before':'after']='COUNTERFEIT';
  call('compareReadEvidence',negative?bad:request,()=>compareReadEvidence(s,negative?bad:request));
  call('compareReadEvidence',request,()=>compareReadEvidence(s,request));
 }else if(r.base==='historyNotCurrent'){
  const historical=json(s);historical.binding.source='historical';const model=negative?historical:s,q=requestFor(f,model);
  call('compareReadEvidence',q,()=>compareReadEvidence(model,q),[model]);call('compareReadEvidence',request,()=>compareReadEvidence(s,request));
 }else if(r.base==='completePreview'){
  bad.originalRecords=bad.originalRecords.slice(1);
  const q={snapshotId:s.binding.snapshotId,...negative?bad:request};call('evaluate',{owner,request:q},()=>service.evaluate(owner,q));
  const good={snapshotId:s.binding.snapshotId,...request};call('evaluate',{owner,request:good},()=>service.evaluate(owner,good));
  for(const [role,originalRecords]of [['stringified',request.originalRecords.map(r=>({...r,providerEvidence:JSON.stringify(r.providerEvidence)}))],['altered',request.originalRecords.map((r,i)=>i?{...r,providerEvidence:{...r.providerEvidence,startIndex:8}}:r)]]){const q={...good,originalRecords};call(role,{owner,request:q},()=>service.evaluate(owner,q));}
 }else if(['broadDelivered','siblingNotCovered'].includes(r.base)){
  const {originalRecords,...q}=request,none={snapshotId:s.binding.snapshotId,...q};call('no-delivery',{owner,request:none},()=>service.evaluate(owner,none));
  const sibling=await tokens({heading:{headingId:'end'}}),selected=await tokens(request.selector);
  const primary={...none,deliveryTokens:negative?sibling:selected};call('evaluate',{owner,request:primary},()=>service.evaluate(owner,primary));
  const control={...none,deliveryTokens:selected};call('evaluate',{owner,request:control},()=>service.evaluate(owner,control));
  const foreign={...owner,subject:'subject-other'};call('foreign-owner',{owner:foreign,request:control},()=>service.evaluate(foreign,control));
 }else if(r.base==='namedStyleIndirect'){
  const q={tabId:'tab-a',namedType:'HEADING_1',family:'text',property:'bold',value:false};
  const first=call('inspectNamedStyleEvidence',{request:q,options:{limit:1}},()=>inspectNamedStyleEvidence(s,q,{limit:1}));
  const second=call('inspectNamedStyleEvidence',{request:q,options:{offset:1,limit:1}},()=>inspectNamedStyleEvidence(s,q,{offset:1,limit:1}));
  const pages=negative?[first]:[first,second];call('compareNamedStyleEvidence',{request:q,pages},()=>compareNamedStyleEvidence(s,q,pages));
  call('compareNamedStyleEvidence',{request:q,pages:[first,second]},()=>compareNamedStyleEvidence(s,q,[first,second]));
  const forged=json(second);forged.usages[0].after=true;call('compareNamedStyleEvidence',{request:q,pages:[first,forged]},()=>compareNamedStyleEvidence(s,q,[first,forged]));
 }else if(r.base==='generatedNode'){
  document=f.after;clock=1;const after=await inspect(),preserved=json(after),q=generatedRequest(s,after,f.table),bad=json(q);bad.observation.predecessorRevision='r0';
  call('compareGeneratedEvidence',negative?bad:q,()=>compareGeneratedEvidence(s,after,negative?bad:q),[s,after]);
  call('compareGeneratedEvidence',q,()=>compareGeneratedEvidence(s,after,q),[s,after]);
  for(const [role,change]of [['anchor',q=>{q.binding.startIndex=2;}],['preservation',q=>{q.preservation[3].target=after.binding.snapshotId+':2';}]]){const bad=json(q);change(bad);call(role,bad,()=>compareGeneratedEvidence(s,after,bad),[s,after]);}
  assert.deepEqual(after,preserved,'all generated observation fields unchanged');
 }
 assert.deepEqual(s,before,'canonical model, registries, prose and logo unchanged');
 const t={boundary:r.base==='broadDelivered'?{layer:'application',entryPoint:'createReadEvidenceService.evaluate'}:witnessBoundary(r),events,reads,calls,source:{evidence:s.evidence,metadata:s.metadata,registries:s.registries,binding:s.binding,evidenceDigest:s.evidenceDigest},providerAfter:f.document,logical:memory.observe()};compareWitness(r,f,t);return t;
}
function checked(e,op,models,args,result,error){assert.ok(e,'missing actual witness invocation');assert.equal(e.operation,op);assert.deepEqual(e.models,models.map(ref),'exact source observation binding');assert.deepEqual(e.args,json(args),'exact independent disclosure/original/token arguments');assert.equal(e.error,error);assert.deepEqual(e.result,result,'independent exact witness decision');}
export function compareWitness(r,f,t){
 assertWitnessFixture(r,f);if(r.base!=='broadDelivered')assert.deepEqual(t.boundary,witnessBoundary(r));
 const s=descriptor(f.document),negative=r.outcomeVariant==='counterexample',request=requestFor(f,s),good=expectedReadResult(f,s,request);let i=0;
 assert.deepEqual(t.source.evidence,f.document);assert.deepEqual(t.source.metadata,f.metadata);assert.deepEqual(t.source.registries,{comments:null,suggestions:null,documentStyle:null,suggestedNamedStylesChanges:null});assert.deepEqual(t.providerAfter,f.document);assert.deepEqual(t.source.binding,{...s.binding,responseDigest:hash(f.document),responseBytes:Buffer.byteLength(JSON.stringify(f.document))});assert.equal(t.source.evidenceDigest,hash(f.document));
 // Model binding carries the raw response bounds as well as the witness binding.
 s.binding=t.source.binding;
 const seen=new Set();for(const e of t.events){assert.match(e.id,/^[a-f0-9-]{36}$/);assert.ok(!seen.has(e.id));seen.add(e.id);}
 const check=(op,args,result,error,models=[s])=>checked(t.events[i++],op,models,args,result,error);
 if(['narrowLiteral','styleFromMetadata'].includes(r.base)){
  const bad=json(request);bad.presentation.changes[0][r.base==='narrowLiteral'?'before':'after']='COUNTERFEIT';check('compareReadEvidence',negative?bad:request,negative?expectedReadResult(f,s,request,{missing:['effectPresentation']}):good);check('compareReadEvidence',request,good);
 }else if(r.base==='historyNotCurrent'){
  const h=descriptor(f.document,'witness-a',0,'historical');h.binding={...s.binding,source:'historical'};const model=negative?h:s,q=requestFor(f,model);check('compareReadEvidence',q,negative?expectedReadResult(f,h,q,{missing:['currentEditorRevision']}):good,undefined,[model]);check('compareReadEvidence',request,good);
 }else if(r.base==='completePreview'){
  const bad=json(request);bad.originalRecords=bad.originalRecords.slice(1);const q={snapshotId:'witness-a',...negative?bad:request},control={snapshotId:'witness-a',...request};check('evaluate',{owner,request:q},negative?undefined:good,negative?'scope':undefined);check('evaluate',{owner,request:control},good);
  for(const [role,originalRecords,error]of [['stringified',request.originalRecords.map(r=>({...r,providerEvidence:JSON.stringify(r.providerEvidence)})),'invalid'],['altered',request.originalRecords.map((r,i)=>i?{...r,providerEvidence:{...r.providerEvidence,startIndex:8}}:r),'conflict']])check(role,{owner,request:{...control,originalRecords}},undefined,error);
 }else if(['broadDelivered','siblingNotCovered'].includes(r.base)){
  assert.equal(t.reads.length,2);for(const [n,read]of t.reads.entries()){const ns=n?[4,5]:[6,7];assert.deepEqual(read.selector,n?request.selector:{heading:{headingId:'end'}});assert.deepEqual(read.pages.flatMap(p=>p.coverage.delivered.nodes),ns.map(n=>`witness-a:${n}`));assert.deepEqual(read.stored.flatMap(d=>d.nodes),ns.map(n=>`witness-a:${n}`));assert.deepEqual(read.tokens,read.pages.map(p=>p.coverage.deliveryToken));for(const [j,p]of read.pages.entries()){assert.equal(p.coverage.editReady,false);assert.equal(p.thisCall.providerMutationCount,0);assert.equal(p.complete,j===read.pages.length-1);const d=read.stored[j];assert.equal(d.snapshotId,'witness-a');assert.equal(d.evidenceDigest,hash(f.document));assert.equal(d.view,'inline');assert.equal(d.format,'structured');assert.deepEqual(d.scope,scope);assert.deepEqual(d.aspects,['content','styles','review']);assert.deepEqual(d.nodes,p.coverage.delivered.nodes);assert.deepEqual(d.nodeAspects,Object.fromEntries(d.nodes.map(id=>[id,['content','styles','review']])));}}
  const {originalRecords,...q}=request,none={snapshotId:'witness-a',...q},bad=expectedReadResult(f,s,request,{missing:['fullOriginals'],delivered:'none'}),ok=expectedReadResult(f,s,request,{delivered:'storedContent'});check('no-delivery',{owner,request:none},bad);check('evaluate',{owner,request:{...none,deliveryTokens:t.reads[negative?0:1].tokens}},negative?bad:ok);const control={...none,deliveryTokens:t.reads[1].tokens};check('evaluate',{owner,request:control},ok);check('foreign-owner',{owner:{...owner,subject:'subject-other'},request:control},undefined,'snapshot');
 }else if(r.base==='namedStyleIndirect'){
  compareNamedEvents(f,s,t.events,check,negative);
 }else if(r.base==='generatedNode'){
  const after=descriptor(f.after,'witness-2',1);after.binding={...after.binding,responseDigest:hash(f.after),responseBytes:Buffer.byteLength(JSON.stringify(f.after))};const q=generatedRequest(s,after,f.table),bad=json(q);bad.observation.predecessorRevision='r0';const expected=expectedGenerated(s,after,q);check('compareGeneratedEvidence',negative?bad:q,negative?undefined:expected,negative?'conflict':undefined,[s,after]);check('compareGeneratedEvidence',q,expected,undefined,[s,after]);const anchor=json(q);anchor.binding.startIndex=2;check('anchor',anchor,undefined,'scope',[s,after]);const preservation=json(q);preservation.preservation[3].target='witness-2:2';check('preservation',preservation,undefined,'conflict',[s,after]);
 }
 assert.equal(t.logical.snapshots,r.base==='generatedNode'?2:1);assert.equal(t.logical.pins,0);assert.equal(t.logical.cursors,0);assert.equal(t.logical.deliveries,t.reads.reduce((n,r)=>n+r.pages.length,0));assert.equal(i,t.events.length,'no orphan witness calls');assert.deepEqual(t.calls,r.base==='generatedNode'?['authority','metadata','read','authority','metadata','read']:['broadDelivered','siblingNotCovered'].includes(r.base)?['authority','metadata','read','authority','authority']:['authority','metadata','read']);if(!['broadDelivered','siblingNotCovered'].includes(r.base))assert.deepEqual(t.reads,[]);return true;
}
export function expectedGenerated(before,after,q){const read=s=>({snapshotId:s.binding.snapshotId,...owner,documentId:'doc-a',view:'inline',retrievedAt:s.binding.retrievedAt,source:'current',evidenceDigest:s.evidenceDigest,revision:{kind:'docs',id:s.evidence.revisionId,subject:owner.subject}});return {materialized:'complete',delivered:'internalObservation',evidenceKind:'generatedReadComparison',predecessor:read(before),observation:read(after),generated:{node:'witness-2:4',kind:'table',extent:{start:3,end:9},binding:q.binding},comparisonDigest:hash({original:q.expectedOriginal,preservation:q.preservation}),protocolProvenance:'notEstablished',driveObservations:{predecessor:{version:null,modifiedTime:null},observed:{version:null,modifiedTime:null},docsCas:false},retainedEvidenceOnly:false,witnessSatisfied:true,missingAspects:[],editReady:false,authoringAuthority:'notEstablished'};}
function compareNamedEvents(f,s,events,check,negative){
 const {request:q,pages:[first,second],result,partial}=namedStyleOracle(s);
 check('inspectNamedStyleEvidence',{request:q,options:{limit:1}},first);check('inspectNamedStyleEvidence',{request:q,options:{offset:1,limit:1}},second);
 check('compareNamedStyleEvidence',{request:q,pages:negative?[first]:[first,second]},negative?partial:result);check('compareNamedStyleEvidence',{request:q,pages:[first,second]},result);const forged=json(second);forged.usages[0].after=true;check('compareNamedStyleEvidence',{request:q,pages:[first,forged]},partial);
}
