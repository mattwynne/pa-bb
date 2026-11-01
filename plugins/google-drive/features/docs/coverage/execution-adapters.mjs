// Trusted offline execution boundary. Entries contain executable production
// routes, not capabilities inferred from labels or the obligation manifest.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { productionHost, schemaShape } from '../support/production-host.mjs';
import { footprint } from '../../../core/docs-semantic/coverage.mjs';
import { modelBinding } from '../support/local-invocations.mjs';
import { assertRecursiveContract } from './schema-contract.mjs';
import { digest } from './audit.mjs';
import { executeC009, compareC009 } from './c009-execution.mjs';
import { executeC005, compareC005 } from './c005-execution.mjs';
import { executeC006, compareC006 } from './c006-execution.mjs';
import { executeC007, compareC007 } from './c007-execution.mjs';
import { executeC008, compareC008 } from './c008-execution.mjs';
import { executeC003, compareC003 } from './c003-execution.mjs';
import { executeC010, compareC010 } from './c010-execution.mjs';
import { executeC011, compareC011 } from './c011-execution.mjs';
import { executeC012, compareC012 } from './c012-execution.mjs';
import { executeC013, compareC013 } from './c013-execution.mjs';
import { executeC015, compareC015 } from './c015-execution.mjs';
const owner=Object.freeze({subject:'subject-d',account:'reader@example.test',threadId:'thread-d'});
const routes=Object.freeze({
  ...Object.fromEntries(['deniedComments','missingReviewCoverage','tabsAndInline'].map(v=>[`docs_read.reviewView/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c011',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['inline','acceptedPreview','rejectedPreview','projectionNotEditProof'].map(v=>[`docs_read.view/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c010',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['body','header','footer','footnote'].map(v=>[`docs_read.segment/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c003',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['autoText','drawing','equation','toc','unknown'].map(v=>[`docs_read.opaque/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c008',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['adjacentRuns','inlineObject','nestedTable','paragraphNewlines'].map(v=>[`docs_read.richCell/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c007',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['styles','objects','ranges','suggestions'].map(v=>[`docs_read.structure/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c006',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['cursorExpiry','cursorReplay','draftPinnedEvidence','empty','overrun','partial','snapshotExpiry'].map(v=>[`snapshot.coverage/${v}__local`,{driver:'snapshot-store',schema:'snapshot.contract',mode:'local',native:'docs_inspect',action:'c009',outcomes:['success','counterexample']}])),
  'policy.publicRawMask/refuseRawMask__capability':{driver:'schema-policy-refusal',schema:'explicit-excluded-operation',mode:'capability',native:'docs_read',action:'rawMask',outcomes:['refused','noMutation']},
  'docs_inspect.kind/nativeDoc__read':{driver:'docs_inspect',schema:'inspect.include-and-scope',mode:'read',native:'docs_inspect',action:'inspect',outcomes:['success']},
  ...Object.fromEntries(['structured','styleAnnotations','reviewAnnotations','omitImages','continuation'].map(v=>[`docs_read.projection/${v}__read`,{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'c005',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  'docs_read.projection/text__read':{driver:'docs_read',schema:'read.scope-format-view',mode:'read',native:'docs_read',action:'read',outcomes:['success','invalid','preservation','bounds','wrongSubject']},
  ...Object.fromEntries(['exact','typographic','nfc','caseFold','inverseMap','emoji','combining','rtl'].map(v=>[`docs_find.normalization/${v}__read`,{driver:'docs_find',schema:'find.matcher',mode:'read',native:'docs_find',action:'c013',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  ...Object.fromEntries(['crossRun','paragraphBoundary','chipBoundary','boundedContext'].map(v=>[`docs_find.literal/${v}__read`,{driver:'docs_find',schema:'find.matcher',mode:'read',native:'docs_find',action:'c012',outcomes:['success','invalid','preservation','bounds','wrongSubject']}])),
  'snapshot.coverage/wrongThread__local':{driver:'snapshot-store',schema:'snapshot.contract',mode:'local',native:'docs_inspect',action:'snapshot',outcomes:['success','counterexample']},
  ...Object.fromEntries(['exactlyOne','explicitOccurrenceZero','allExpectedCount','ambiguous','missing'].map(v=>[`selector.cardinality/${v}__local`,{driver:'selector-resolver',schema:'selector.closed-union',mode:'local',native:'docs_find',action:'c015',outcomes:['success','counterexample']}])), 
  'coverage.witness/broadDelivered__local':{driver:'coverage-auditor',schema:'coverage.manifest-and-witness',mode:'local',native:'docs_read',action:'witness',outcomes:['success','counterexample']},
  'gdrive_get_file.metadata/fileMetadata__read':{driver:'gdrive_get_file',schema:'drive-file.metadata',mode:'read',native:'gdrive_get_file',action:'metadata',outcomes:['success']},
});
export const adapterBindings=()=>structuredClone(routes);
const key=r=>`${r.operation}/${r.semanticVariant}`;
export function implementedRoute(record) {
  const route=routes[key(record)];assert.ok(route,'missing implemented semantic driver and production registered schema / unavailable variant');
  if(record.bridgeCandidate&&record.operation==='docs_read.projection'){
    assert.equal(record.semanticVariant,'text__read','missing implemented semantic driver for historical candidate');
    assert.ok(['success','invalid','wrongSubject'].includes(record.outcomeVariant),'unimplemented adapter outcome discriminator');
  }
  assert.equal(record.driver,route.driver,'adapter driver');assert.equal(record.schema,route.schema,'adapter schema');assert.equal(record.requestedMode,route.mode,'adapter mode');
  if(record.outcomeVariant!==undefined)assert.ok(route.outcomes.includes(record.outcomeVariant),'unimplemented adapter outcome discriminator');
  return route;
}
function assertSchemaSurface(tools) {
  const expected={docs_inspect:[['account','document','scope','view','outlineDepth','include'],['account','snapshotId','cursor']],
    docs_read:[['account','snapshotId','scope','selector','format','styles','review','omitImages','registries'],['account','snapshotId','cursor']],
    docs_find:[['account','snapshotId','scope','query'],['account','snapshotId','scope','selector']]};
  for(const [name,branches] of Object.entries(expected)){
    const tool=tools.find(t=>t.name===name),shape=schemaShape(tool.parameters);
    assert.deepEqual(shape.anyOf.map(s=>Object.keys(s.properties).sort()),branches.map(b=>b.sort()),'unjoined native schema discriminator');
    assert.ok(shape.anyOf.every(s=>s.additionalProperties===false),'native schema must stay closed');
  }
  const shape=Object.fromEntries(tools.filter(t=>expected[t.name]).map(t=>[t.name,schemaShape(t.parameters)]));
  const keys=s=>Object.keys(s.properties).sort(),branches=s=>s.anyOf.map(keys);
  const selectorContract=[['node'],['span'],['heading'],['section'],['text']];
  for(const name of Object.keys(expected))for(const branch of shape[name].anyOf){
    const p=branch.properties;
    if(p.scope){
      assert.deepEqual(keys(p.scope),['segments','tabs']);
      assert.deepEqual(branches(p.scope.properties.tabs),[['all'],['ids'],['path'],['ordinal','snapshotId']]);
      const segments=p.scope.properties.segments.items.anyOf;
      assert.deepEqual(segments.map(keys),[['kind'],['id','kind']]);
      assert.equal(segments[0].properties.kind.const,'body');
      assert.deepEqual(segments[1].properties.kind.enum,['header','footer','footnote']);
    }
    if(p.selector){
      assert.deepEqual(branches(p.selector),name==='docs_read'?selectorContract.slice(0,4):selectorContract,'unjoined selector discriminator');
      const selector=p.selector.anyOf;
      assert.deepEqual(keys(selector[1].properties.span),['from','to']);
      assert.deepEqual(keys(selector[2].properties.heading),['depth','headingId','level','path','text']);
      assert.deepEqual(keys(selector[3].properties.section),['before','depth','headingId','includeHeading','level','path','text']);
      if(selector[4]){
        const text=selector[4].properties.text;assert.deepEqual(keys(text),['cardinality','casePolicy','literal','normalization']);
        assert.deepEqual(branches(text.properties.cardinality),[['exactly'],['occurrence'],['all']]);
      }
    }
    const text=p.query??p.selector?.anyOf[4]?.properties.text;
    if(text){
      if(p.query)assert.deepEqual(keys(text),['casePolicy','limit','literal','normalization']);
      assert.deepEqual(text.properties.normalization.enum,['exact','typographic','nfc']);
      assert.deepEqual(text.properties.casePolicy.enum,['exact','simpleCaseFold']);
    }
    if(p.view)assert.deepEqual(p.view.enum,['inline','acceptedPreview','rejectedPreview']);
    if(p.include)assert.deepEqual(p.include.items.enum,['tabs','outline','styles','lists','objects','ranges','review','diagnostics']);
    if(p.registries)assert.deepEqual(p.registries.items.enum,['styles','lists','objects','ranges','review','diagnostics']);
  }
  const scope={tabs:{ids:['tab-d']},segments:[{kind:'body'}]},base={account:'reader@example.test',snapshotId:'snap-d',scope};
  const read=tools.find(t=>t.name==='docs_read').parameters,find=tools.find(t=>t.name==='docs_find').parameters;
  assert.deepEqual(schemaShape(read).anyOf[0].properties.format.enum,['text','structured'],'unavailable read format');
  for(const format of ['markdown','html'])assert.equal(read.safeParse({...base,format}).success,false,'future format must stay denied');
  for(const selector of [{table:{row:0}},{namedRange:'r'},{objectId:'o'},{text:{regex:'.*'}}])assert.equal(find.safeParse({...base,selector}).success,false,'later selector must stay denied');
  assert.equal(find.safeParse({...base,query:{regex:'.*'}}).success,false,'regex must stay denied');
  assert.equal(read.safeParse({...base,format:'text',fields:'*'}).success,false,'public raw mask denied');
}
export async function productionInventory() {
  const faults=[];
  const w=await productionHost(async()=>{faults.push('HTTP');throw new Error('inventory must make no HTTP calls');});
  try {
    assert.deepEqual(faults,[],'inventory must make no HTTP calls');
    assertSchemaSurface(w.tools);
    assertRecursiveContract(w.tools);
    const names=['docs_inspect','docs_read','docs_find','gdrive_get_file'];
    const schemas=Object.fromEntries(names.map(name=>{const tool=w.tools.find(t=>t.name===name);assert.ok(tool&&typeof tool.execute==='function','missing actual registration');return [name,schemaShape(tool.parameters)];}));
    assert.deepEqual(w.tools.filter(t=>t.name.startsWith('docs_')).map(t=>t.name).sort(),names.filter(n=>n.startsWith('docs_')).sort(),'unjoined semantic registration');
    return {schemas,bindings:adapterBindings(),serving:w.serving,semanticExposure:[],runtimeApplied:'notObserved'};
  } finally {await w.close();}
}
export function compareInventory(inventory) {
  assert.ok(inventory,'missing actual offline inventory');
  assert.deepEqual(inventory.bindings,adapterBindings(),'implementation registry differs in either direction');
  assert.deepEqual(Object.keys(inventory.schemas).sort(),['docs_find','docs_inspect','docs_read','gdrive_get_file'],'schema registry differs in either direction');
  assert.deepEqual(inventory.semanticExposure,[],'unreviewed serving exposure');
}
function nodeFacts(snapshot) {
  return Object.values(snapshot.nodes).map(n=>({id:n.id,kind:n.kind,parent:n.parent,tabId:n.tabId,segment:n.segment,extent:n.extent,...n.text!==undefined?{text:n.text}:{}}));
}
function substitute(args) {return JSON.parse(JSON.stringify(args).replaceAll('"$snapshot"','"snap-d"'));}
export async function executeAdapter(record,fixture,inventory) {
  const route=implementedRoute(record),http=[],authentication=[],faults=[];
  if(route.action==='c015'){
    const trace=await executeC015(record,fixture,inventory);
    compareC015(record,fixture,trace);
    return trace;
  }
  if(route.action==='c013'){
    const trace=await executeC013(record,fixture,inventory);
    compareC013(record,fixture,trace);
    return trace;
  }
  if(route.action==='c012'){
    const trace=await executeC012(record,fixture,inventory);
    compareC012(record,fixture,trace);
    return trace;
  }
  if(route.action==='c011'){
    const trace=await executeC011(record,fixture,inventory);
    compareC011(record,fixture,trace);
    return trace;
  }
  if(route.action==='c010'){
    const trace=await executeC010(record,fixture,inventory);
    compareC010(record,fixture,trace);
    return trace;
  }
  if(route.action==='c003'){
    const trace=await executeC003(record,fixture,inventory);
    compareC003(record,fixture,trace);
    return trace;
  }
  if(route.action==='c008'){
    const trace=await executeC008(record,fixture,inventory);
    compareC008(record,fixture,trace);
    return trace;
  }
  if(route.action==='c007'){
    const trace=await executeC007(record,fixture,inventory);
    compareC007(record,fixture,trace);
    return trace;
  }
  if(route.action==='c006'){
    const trace=await executeC006(record,fixture,inventory);
    compareC006(record,fixture,trace);
    return trace;
  }
  if(route.action==='c005'||(record.operation==='docs_read.projection'&&record.bridgeCandidate===false)){
    const trace=await executeC005(record,fixture,inventory);
    compareC005(record,fixture,trace);
    return trace;
  }
  if(route.action==='c009'||(record.operation==='snapshot.coverage'&&record.bridgeCandidate===false)){
    const trace=await executeC009(record,fixture,inventory);
    compareC009(record,fixture,trace);
    return trace;
  }
  // Fixed scripted sequence, exact method/URL; provider values are inert fixture
  // bytes, never planner/simulator output. No network fallback exists.
  const original=structuredClone(fixture.provider);
  const fetchImpl=async(url,init={})=>{
    const observed={method:init.method??'GET',url:String(url)};http.push(observed);
    try {
      const expected=fixture.http[http.length-1];assert.ok(expected,'unexpected HTTP');
      assert.deepEqual(observed,{method:expected.method,url:expected.url},'HTTP method/URL');
      assert.equal(observed.method,'GET','reads cannot mutate');assert.equal(init.body,undefined);
      assert.equal(init.headers.authorization,expected.response==='otherIdentity'?'Bearer PRIVATE_OTHER_TOKEN':'Bearer PRIVATE_TOKEN');
      const value=fixture.provider[expected.response];assert.ok(value,'missing independent response');
      if(observed.url==='https://openidconnect.googleapis.com/v1/userinfo')authentication.push({subject:value.sub,account:value.email,verified:value.email_verified});
      return Response.json(value,{status:expected.status??200});
    } catch(error){faults.push('HTTP contract');throw error;}
  };
  const w=await productionHost(fetchImpl),calls=[];
  const {resolveSelector,evaluateWitness}=w.local;
  let trace;
  try {
    assert.ok(existsSync(w.host.bb.storage.database().name));assert.notEqual(w.host.bb.storage.database().name,':memory:');
    for(const [name,shape] of Object.entries(inventory.schemas))assert.deepEqual(schemaShape(w.tools.find(t=>t.name===name).parameters),shape,'captured schema drift');
    async function call(name,args,threadId=owner.threadId) {
      const raw=substitute(args),before=w.invocations.length;
      const tool=w.tools.find(t=>t.name===name);assert.ok(tool,'no actual native registration');
      const parsed=tool.parameters.safeParse(raw);
      let result,error;
      try {result=route.action==='rawMask'?await w.invokeNative(name,raw,threadId):await w.host.harness.behavior.callAgentTool(name,raw,{threadId});}
      catch {error='schema';assert.equal(parsed.success,false,'unexpected native host exception');}
      const invocation=w.invocations.slice(before);
      assert.equal(invocation.length,parsed.success?1:0,'driver without actual invocation');
      if(parsed.success)assert.deepEqual(invocation[0].parsedArgs,parsed.data,'parsed arguments');
      let value=null;
      if(result)try{value=JSON.parse(result.content[0].text);}catch{value={errorText:result.content[0].text};}
      calls.push({name,args:raw,parsed:parsed.success?parsed.data:null,threadId,invocation:invocation[0]??null,result:result??null,error:error??null,value});
      return value;
    }
    let setup=null,output,snapshot=null,deliveries=[],internal=null;
    if(route.action==='rawMask')w.storage.capture();
    if(!['metadata','rawMask'].includes(route.action))setup=await call('docs_inspect',fixture.inspect);
    if(route.action==='rawMask'){
      for(const attempt of fixture.calls)await call(attempt.name,attempt.args,attempt.threadId);
      output=null;
    }
    if(setup?.snapshotId)snapshot=w.store.semanticSnapshots.get(setup.snapshotId,owner,0);
    if(route.action==='inspect')output=setup;
    else if(route.action==='metadata')output=await call('gdrive_get_file',fixture.args);
    else if(route.action==='read'||route.action==='find')output=await call(route.native,fixture.args,fixture.threadId??owner.threadId);
    else if(route.action==='snapshot'){
      const actualOwner=record.outcomeVariant==='counterexample'?{...owner,threadId:'other-thread'}:owner;
      try {const read=w.local.getSnapshot(setup.snapshotId,actualOwner,0);output={snapshotId:read.binding.snapshotId};}
      catch(error){output={category:error.semanticCode};}
      internal={function:'semanticSnapshots.get',owner:actualOwner,snapshotId:setup.snapshotId};
    } else if(route.action==='selector'){
      output=resolveSelector(snapshot,fixture.args.scope,fixture.args.selector);
      internal={function:'resolveSelector',args:fixture.args,snapshotId:setup.snapshotId};
    } else if(route.action==='witness'){
      const read=await call('docs_read',fixture.args);
      deliveries=w.store.semanticSnapshots.deliveries(setup.snapshotId,owner,0,[read.coverage.deliveryToken]);
      const fp=footprint(snapshot,fixture.footprint);
      output=evaluateWitness(snapshot,fp,{deliveries:record.outcomeVariant==='counterexample'?[]:deliveries});
      internal={function:'coverage.evaluateWitness',footprint:fp,deliveryTokens:record.outcomeVariant==='counterexample'?[]:[read.coverage.deliveryToken]};
    }
    if(route.action==='read'&&output?.coverage?.deliveryToken)deliveries=w.store.semanticSnapshots.deliveries(setup.snapshotId,owner,0,[output.coverage.deliveryToken]);
    if(snapshot)assert.deepEqual(w.store.semanticSnapshots.get(setup.snapshotId,owner,0),snapshot,'stored original model preserved');
    const db=w.host.bb.storage.database();
    const persisted={snapshots:db.prepare('SELECT id,subject,account,thread,evidence_digest FROM docs_semantic_snapshots ORDER BY id').all(),
      deliveries:db.prepare('SELECT id,snapshot,data FROM docs_semantic_delivery ORDER BY id').all().map(r=>({...r,data:JSON.parse(r.data)}))};
    assert.ok(!JSON.stringify(w.host.harness.logEntries).includes('PRIVATE_'),'private sentinel in native diagnostics');
    trace={calls,http,authentication,snapshotAccess:structuredClone(w.snapshotAccess),internal,localCalls:w.local.records(),output,snapshot:snapshot?{modelDigest:modelBinding(snapshot).modelDigest,binding:snapshot.binding,revision:snapshot.revision,nodes:nodeFacts(snapshot),evidence:snapshot.evidence,metadata:snapshot.metadata}:null,deliveries,persisted,providerAfter:structuredClone(fixture.provider)};
    if(route.action==='rawMask'){
      trace.nativeCalls=w.nativeCalls();
      w.storage.capture();
      trace.storageObservations=w.storage.records();
      trace.storageChanges={before:trace.storageObservations[0].totalChanges,after:trace.storageObservations[1].totalChanges};
    }
    compareExecution(record,fixture,trace);
    assert.deepEqual(fixture.provider,original,'provider state changed');
  } finally {
    try {assert.deepEqual(faults,[],'unacknowledged transport journal fault');assert.equal(http.length,fixture.http.length,'missing actual HTTP');}
    finally {await w.close();}
  }
  return trace;
}
function compareRawMask(record,f,t) {
  assert.equal(record.operation,'policy.publicRawMask');
  assert.equal(record.base,'refuseRawMask');
  assert.equal(record.requestedMode,'capability');
  assert.ok(['refused','noMutation'].includes(record.outcomeVariant));
  // All currently bound native read entry branches are tested, not just a
  // generic invalid payload. The paired inputs differ ONLY by the raw mask.
  assert.deepEqual(t.calls.map(c=>c.name),['docs_inspect','docs_read','docs_find','docs_find','docs_inspect','docs_read'],'raw-mask branch inventory');
  assert.equal(t.nativeCalls?.length,6,'actual raw-mask host calls');
  assert.equal(f.expected.controls.length,6);
  for(const [i,c] of t.calls.entries()){
    const actual=t.nativeCalls[i],{fields,...control}=c.args;
    assert.equal(typeof fields,'string');assert.ok(fields.length>0,'raw mask actually supplied');
    assert.match(actual.id,/^[0-9a-f-]{36}$/);assert.equal(actual.sequence,i+1);
    assert.deepEqual({name:actual.name,args:actual.args,threadId:actual.threadId},{name:c.name,args:c.args,threadId:c.threadId},'captured native schema input');
    const keys=[['account','document','scope'],['account','format','scope','snapshotId'],
      ['account','query','scope','snapshotId'],['account','scope','selector','snapshotId'],
      ['account','cursor','snapshotId'],['account','cursor','snapshotId']];
    assert.deepEqual(Object.keys(control).sort(),keys[i],'exact raw-mask input branch');
    assert.deepEqual(control,f.expected.controls[i],'independent permitted schema control');
    assert.deepEqual(actual.control,{args:control,parsed:control},'actual paired schema acceptance');
    assert.deepEqual(actual.error,{name:'Error',message:`tool "${c.name}" arguments are invalid: (input): Unrecognized key: "fields"`},'exact actual raw-mask schema rejection');
    assert.equal(actual.result,undefined,'schema refusal cannot return native output');
    assert.equal(c.error,'schema');assert.equal(c.parsed,null);assert.equal(c.invocation,null);
    assert.equal(c.result,null);assert.equal(c.value,null);
  }
  assert.equal(new Set(t.nativeCalls.map(c=>c.id)).size,6,'distinct native schema attempts');
  assert.deepEqual(t.http,[],'raw mask must not contact provider');
  assert.deepEqual(t.authentication,[],'raw mask must not resolve any account');
  assert.deepEqual(t.snapshotAccess,[],'raw mask must not access snapshot');
  assert.deepEqual(t.localCalls,[]);assert.equal(t.internal,null);assert.equal(t.snapshot,null);assert.equal(t.output,null);
  assert.deepEqual(t.persisted,{snapshots:[],deliveries:[]});assert.deepEqual(t.deliveries,[]);
  assert.ok(Number.isSafeInteger(t.storageChanges?.before)&&t.storageChanges.before>=0,'actual SQLite change counter');
  assert.equal(t.storageChanges.after,t.storageChanges.before,'raw mask cannot change SQLite');
  assert.equal(t.storageObservations?.length,2,'actual storage observation pair');
  const [before,after]=t.storageObservations;
  assert.match(before.connectionId,/^[0-9a-f-]{36}$/);assert.equal(after.connectionId,before.connectionId,'same actual storage connection');
  assert.equal(before.sequence,1);assert.equal(after.sequence,2);
  assert.deepEqual(t.storageChanges,{before:before.totalChanges,after:after.totalChanges},'actual row-change observation binding');
  for(const observation of [before,after]){
    assert.deepEqual(observation.databases.map(d=>d.name),['main','temp'],'actual storage scope');
    assert.deepEqual(Object.keys(observation.state),['main','temp']);
    for(const d of observation.databases)assert.match(d.fileDigest,/^[a-f0-9]{64}$/);
    for(const state of Object.values(observation.state)){
      assert.ok(Number.isSafeInteger(state.entries)&&state.entries>=0&&state.entries<=128);
      assert.match(state.schemaDigest,/^[a-f0-9]{64}$/);
      assert.deepEqual(Object.keys(state.metadata).sort(),['application_id','auto_vacuum','encoding','freelist_count','journal_mode','page_count','page_size','schema_version','user_version']);
      for(const value of Object.values(state.metadata))assert.ok(Number.isSafeInteger(value)||(typeof value==='string'&&value.length<=64));
    }
  }
  assert.deepEqual(after.databases,before.databases,'raw mask cannot change SQLite database scope');
  assert.deepEqual(after.state,before.state,'raw mask cannot change SQLite schema or metadata');
}
function compareLocalInvocation(record,t) {
  const action=implementedRoute(record).action;
  const operation={snapshot:'semanticSnapshots.get',selector:'resolveSelector',witness:'coverage.evaluateWitness'}[action];
  assert.equal(t.localCalls?.length,operation?1:0,'exact actual local invocation count');
  if(!operation)return;
  const call=t.localCalls[0];
  assert.match(call.id,/^[0-9a-f-]{36}$/,'local invocation identity');
  assert.equal(call.sequence,1);assert.equal(call.operation,operation,'actual local function');
  if(action==='snapshot'){
    assert.deepEqual(call.args,{snapshotId:t.snapshot.binding.snapshotId,owner:record.outcomeVariant==='counterexample'?{...owner,threadId:'other-thread'}:owner,now:0},'actual store invocation arguments');
    assert.equal(call.model,null);
    if(call.error){assert.deepEqual(call.error,{category:'snapshot'});assert.deepEqual(t.output,{category:call.error.category},'actual store typed error');assert.equal(call.result,undefined);}
    else {assert.equal(modelBinding(call.result).modelDigest,t.snapshot.modelDigest,'actual store returned model');assert.deepEqual(t.output,{snapshotId:call.result.binding.snapshotId},'actual store returned result');}
  }else{
    assert.deepEqual(call.model,{binding:t.snapshot.binding,revision:t.snapshot.revision,modelDigest:t.snapshot.modelDigest},'actual local model binding');
    const args=action==='selector'?t.internal.args:{footprint:t.internal.footprint,options:{deliveries:record.outcomeVariant==='counterexample'?[]:t.deliveries}};
    assert.deepEqual(call.args,args,'actual local immutable arguments');
    assert.equal(call.error,undefined,'unexpected local error');
    assert.deepEqual(call.result,t.output,'actual local return binding');
  }
}
// Re-run by the parent on the captured observations, independently of any
// Cucumber attachment flags. Every expectation below originates in inert data.
export function compareExecution(record,f,t) {
  const route=implementedRoute(record);
  if(route.action==='c015'){compareC015(record,f,t);return;}
  if(route.action==='c013'){compareC013(record,f,t);return;}
  if(route.action==='c012'){compareC012(record,f,t);return;}
  if(route.action==='c011'){compareC011(record,f,t);return;}
  if(route.action==='c010'){compareC010(record,f,t);return;}
  if(route.action==='c003'){compareC003(record,f,t);return;}
  if(route.action==='c008'){compareC008(record,f,t);return;}
  if(route.action==='c007'){compareC007(record,f,t);return;}
  if(route.action==='c006'){compareC006(record,f,t);return;}
  if(route.action==='c005'||(record.operation==='docs_read.projection'&&record.bridgeCandidate===false)){compareC005(record,f,t);return;}
  if(route.action==='c009'||(record.operation==='snapshot.coverage'&&record.bridgeCandidate===false)){compareC009(record,f,t);return;}
  compareLocalInvocation(record,t);
  assert.deepEqual(t.http,f.http.map(({method,url})=>({method,url})),'actual HTTP sequence');
  assert.deepEqual(t.providerAfter,f.provider,'preserved provider state');
  assert.ok(t.calls.length,'driver without actual invocation');
  for(const c of t.calls){
    if(c.parsed===null){assert.equal(c.invocation,null,'schema refusal cannot invoke');continue;}
    assert.equal(c.invocation?.name,c.name,'missing actual invocation');assert.deepEqual(c.invocation.parsedArgs,c.parsed,'invocation arguments');
    assert.equal(c.invocation.threadId,c.threadId,'invocation owner');assert.deepEqual(c.invocation.output,c.result,'invocation output');
    let decoded;try{decoded=JSON.parse(c.result.content[0].text);}catch{decoded={errorText:c.result.content[0].text};}
    assert.deepEqual(c.value,decoded,'actual native output decoding');
  }
  assert.deepEqual(t.calls.map(c=>({name:c.name,args:c.args,threadId:c.threadId})),f.calls.map(c=>({...c,args:substitute(c.args)})),'fixture/native invocation binding');
  if(route.action==='rawMask'){
    compareRawMask(record,f,t);return;
  }
  if(['inspect','read','find','metadata'].includes(route.action))assert.deepEqual(t.output,t.calls.at(-1).value,'actual native result binding');
  if(route.action==='read')assert.equal(t.calls.at(-1).args.format,'text','actual text discriminator');
  if(route.action==='find'){
    assert.ok(t.calls.at(-1).args.query?.literal,'actual literal discriminator');
    assert.ok(t.output.candidates?.some(c=>c.runs.filter(id=>t.snapshot.nodes.some(n=>n.id===id&&n.kind==='text'&&n.parent===c.node&&n.extent.start<c.extent.end&&n.extent.end>c.extent.start)).length>1),'actual cross-run discriminator');
  }
  if(route.action==='selector')assert.deepEqual(t.internal.args.selector.text.cardinality,{exactly:1},'actual exactly-one discriminator');
  if(route.action==='witness'){
    const args=t.calls.at(-1).args;assert.equal(args.format,'structured');assert.equal(args.styles,true);assert.equal(args.review,true);
    assert.deepEqual(t.deliveries[0].nodes,t.snapshot.nodes.map(n=>n.id),'actual broad-delivery discriminator');
  }
  if(route.action==='metadata'){
    assert.deepEqual(t.output,f.expected.output,'existing metadata output');assert.equal(t.snapshot,null);assert.deepEqual(t.persisted,{snapshots:[],deliveries:[]});return;
  }
  assert.ok(t.snapshot,'actual persisted snapshot required');
  const s=t.snapshot;
  assert.deepEqual(s.binding,{...f.expected.binding,responseDigest:digest(JSON.stringify(f.provider.document)),responseBytes:Buffer.byteLength(JSON.stringify(f.provider.document))},'verified owner/view/provenance');
  assert.deepEqual(s.revision,f.expected.revision,'revision namespace/subject');
  assert.deepEqual(s.evidence,f.provider.document,'original GET evidence');assert.deepEqual(s.metadata,f.provider.metadata,'metadata preserved');
  assert.deepEqual(s.nodes,f.expected.nodes,'independent expected nodes/text/extents');
  assert.deepEqual(t.persisted.snapshots,[{id:'snap-d',subject:owner.subject,account:owner.account,thread:owner.threadId,evidence_digest:digest(JSON.stringify(f.provider.document))}],'persisted owner/evidence');
  if(['invalid','wrongSubject'].includes(record.outcomeVariant)){
    assert.ok(['read','find','inspect','metadata'].includes(route.action),'unsupported negative route');
    assert.deepEqual(t.output,f.expected.output,'independent refusal result');
    const last=t.calls.at(-1);
    if(record.outcomeVariant==='invalid'){
      assert.equal(last.parsed,null,'invalid must reach actual schema refusal');assert.equal(last.invocation,null);assert.equal(last.error,'schema');
    }else {
      assert.ok(last.result?.isError,'wrong subject must fail actual access boundary');
      assert.equal(last.threadId,t.calls[0].threadId,'wrongSubject must preserve thread');
      const principal=t.authentication.at(-1);
      assert.deepEqual(principal,{subject:'subject-other',account:'other@example.test',verified:true},'actual second verified principal');
      assert.notEqual(principal.subject,s.binding.subject);assert.notEqual(principal.account,s.binding.account);
      assert.equal(last.args.account,principal.account,'actual second account request');
      assert.deepEqual(t.snapshotAccess,[{native:'docs_read',snapshotId:s.binding.snapshotId,owner:{subject:principal.subject,account:principal.account,threadId:last.threadId},category:'snapshot'}],'actual snapshot subject mismatch');
    }
    assert.deepEqual(t.persisted.deliveries,[],'refusal cannot mint delivery');return;
  }
  if(route.action==='inspect'){
    assert.equal(t.output.kind,'nativeDoc');assert.equal(t.output.snapshotId,'snap-d');
    assert.deepEqual(t.output.coverage,f.expected.coverage);assert.deepEqual(t.output.provenance,f.expected.provenance?{...f.expected.provenance,responseDigest:s.binding.responseDigest}:null);
  } else if(route.action==='read'){
    assert.equal(t.output.view,'inline');assert.equal(t.output.snapshotId,'snap-d');assert.equal(t.output.complete,true);assert.equal(t.output.nextCursor,null);
    assert.deepEqual(t.output.records,f.expected.records,'independent text output');assert.deepEqual(t.output.losses,f.expected.losses,'independent omissions');
  } else assert.deepEqual(t.output,f.expected.output,'independent local/search result');
  if(['snapshot','selector','witness'].includes(route.action)){
    const fn={snapshot:'semanticSnapshots.get',selector:'resolveSelector',witness:'coverage.evaluateWitness'}[route.action];
    assert.equal(t.internal?.function,fn,'local control substitution');
    if(route.action==='witness'){
      assert.equal(t.output.authoringAuthority,'notEstablished');
      assert.deepEqual(t.internal.footprint,{snapshotId:'snap-d',evidenceDigest:digest(JSON.stringify(f.provider.document)),nodes:['snap-d:2','snap-d:3','snap-d:4'],targets:f.footprint.nodes,dependencies:[],aspects:f.footprint.aspects,destructive:true},'actual witness footprint');
      assert.deepEqual(t.internal.deliveryTokens,record.outcomeVariant==='counterexample'?[]:[t.calls.find(c=>c.name==='docs_read').value.coverage.deliveryToken],'actual witness read tokens');
    }
    if(route.action==='snapshot')assert.deepEqual(t.internal,{function:'semanticSnapshots.get',owner:record.outcomeVariant==='counterexample'?{...owner,threadId:'other-thread'}:owner,snapshotId:'snap-d'},'actual store owner');
    if(route.action==='selector')assert.deepEqual(t.internal,{function:'resolveSelector',args:f.args,snapshotId:'snap-d'},'actual selector arguments');
  }
  if(['read','witness'].includes(route.action)){
    assert.equal(t.deliveries.length,1,'stored read delivery');const d=t.deliveries[0];
    assert.equal(t.persisted.deliveries.length,1);assert.deepEqual(t.persisted.deliveries[0].data,d,'actual persisted read state');
    const read=t.calls.find(c=>c.name==='docs_read').value;
    assert.equal(t.persisted.deliveries[0].id,read.coverage.deliveryToken,'read delivery token');
    assert.equal(d.readId,f.expected.readId,'actual read identity');
    assert.deepEqual(read.coverage,{materialized:'complete',delivered:{nodes:d.nodes,aspects:d.aspects,nodeAspects:d.nodeAspects},
      missingAspects:route.action==='read'?['styles','review']:[],missingReviewCoverage:false,readProof:'scope_and_aspect_only',editReady:false,
      deliveryToken:t.persisted.deliveries[0].id},'independent public coverage and stored delivery');
    assert.deepEqual(d.aspects,route.action==='read'?['content']:['content','styles','review'],'independent delivered aspects');
    assert.deepEqual(read.records.map(r=>r.node??r.id),f.expected.deliveredNodes,'actual returned node identities');
    assert.equal(d.snapshotId,'snap-d');assert.equal(d.view,'inline');assert.equal(d.evidenceDigest,digest(JSON.stringify(f.provider.document)));
    assert.deepEqual(d.scope,f.args.scope);assert.deepEqual(d.nodes,f.expected.deliveredNodes);assert.deepEqual(d.nodeAspects,f.expected.nodeAspects);
    assert.deepEqual(d.losses,f.expected.losses);assert.equal(d.complete,true);assert.equal(d.offset,0);
    assert.equal(read.coverage.editReady,false);assert.equal(read.thisCall.providerMutationCount,0);
  }else assert.deepEqual(t.persisted.deliveries,[],'non-read cannot mint delivery');
}
