// C009-I1: implementation identity, not a response-shaped provenance label.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,readdirSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {makePluginAgentConfigurationContext} from '@get-bb/plugin-sdk/testing';
import {productionHost,schemaShape} from '../features/docs/support/production-host.mjs';
import {packageRoot} from '../features/docs/coverage/runner.mjs';
const fixture=name=>JSON.parse(readFileSync(join(packageRoot,'features/docs/coverage/fixtures/bridge',name+'.json')));
const metadata=fixture('C165.fileMetadata__read.success'),find=fixture('C012.crossRun__read.success'),thread='thread-d';
async function hosted(fn){
 const http=[],w=await productionHost(async(url,init={})=>{
  assert.equal(init.method??'GET','GET');const s=String(url),key=s==='https://openidconnect.googleapis.com/v1/userinfo'?'identity':s.startsWith('https://www.googleapis.com/drive/v3/files/doc-d?')?'metadata':s==='https://docs.googleapis.com/v1/documents/doc-d?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED'?'document':null;
  assert.ok(key,'closed synthetic GET');http.push(key);return new Response(JSON.stringify(metadata.provider[key]));
 },{c009:true,pageBytes:65536});try{await fn(w,http);assert.doesNotMatch(JSON.stringify(w.host.harness.logEntries),/PRIVATE_/);}finally{await w.close();}
}
const decode=r=>JSON.parse(r.content[0].text);
for(const name of ['docs_inspect','docs_read','docs_find','gdrive_get_file'])test(`${name}: all exposed target aliases refuse replacement, then original executes exactly once`,()=>hosted(async(w,http)=>{
 if(name==='docs_read'||name==='docs_find')await w.invokeNative('docs_inspect',metadata.inspect,thread);
 const originals=w.tools,records=w.host.harness.registrations.agentTools,tool=originals.find(t=>t.name===name),record=records.find(t=>t.name===name),execute=tool.execute,normalized=record.execute,shape=schemaShape(tool.parameters),count=w.nativeCalls().length,calls=w.invocations.length,requests=http.length;
 let substitutes=0;const fake=async()=>{substitutes++;return {content:[]};};
 const mutations=[()=>{tool.execute=fake;},()=>Object.defineProperty(tool,'execute',{value:fake}),()=>{record.execute=fake;},()=>{record.parse=()=>({ok:true,value:{}});},()=>{originals[originals.indexOf(tool)]={...tool,execute:fake};},()=>originals.splice(0,1),()=>{w.tools=[{...tool,execute:fake}];},()=>{records[records.indexOf(record)]={...record,execute:fake};},()=>records.splice(0,1),()=>{w.host.harness.registrations.agentTools=[{...record,execute:fake}];},()=>{w.host.harness.registrations={agentTools:[{...record,execute:fake}]};}];
 if(name==='gdrive_get_file'){
  const config=await w.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext()),alias=config.tools.find(t=>t.name===name);assert.equal(alias,record);mutations.push(()=>{alias.execute=fake;});
 }
 for(const change of mutations){assert.throws(change,TypeError);assert.equal(substitutes,0);assert.equal(w.nativeCalls().length,count);assert.equal(w.invocations.length,calls);assert.equal(http.length,requests);}
 assert.equal(Reflect.set(tool,'execute',fake),false);assert.equal(Reflect.deleteProperty(record,'execute'),false);assert.equal(tool.execute,execute);assert.equal(record.execute,normalized);assert.deepEqual(schemaShape(tool.parameters),shape);
 const args=name==='docs_inspect'?metadata.inspect:name==='gdrive_get_file'?metadata.args:name==='docs_find'?{...find.args,snapshotId:'snap-d'}:{account:metadata.args.account,snapshotId:'snap-d',scope:metadata.inspect.scope,format:'text'};
 const result=await w.invokeNative(name,args,thread),value=decode(result);assert.equal(result.isError,undefined);assert.equal(substitutes,0);assert.equal(w.nativeCalls().length,count+1);assert.equal(w.invocations.length,calls+1);
 assert.deepEqual(w.invocations.at(-1),{name,parsedArgs:args,threadId:thread,output:result});const captured=w.nativeCalls().at(-1);assert.deepEqual(captured.args,args);assert.deepEqual(captured.result,result);assert.equal(captured.name,name);assert.equal(captured.threadId,thread);assert.equal(captured.clock,0);assert.match(captured.id,/^[a-f0-9-]{36}$/);
 if(name==='gdrive_get_file'){assert.deepEqual(value,metadata.expected.output);assert.deepEqual(http.slice(requests),['identity','metadata']);}
 if(name==='docs_find')assert.deepEqual(value,find.expected.output);
 if(name==='docs_read'){assert.deepEqual(value.records.map(r=>r.text),['Br','idge\n']);assert.equal(value.complete,true);}
 if(name==='docs_inspect'){assert.equal(value.snapshotId,'snap-d');assert.equal(value.kind,'nativeDoc');assert.deepEqual(http.slice(requests),['identity','identity','metadata','identity','document']);assert.equal(w.store.semanticSnapshots.get('snap-d',{subject:'subject-d',account:metadata.args.account,threadId:thread},0).revision.id,'rev-d');}
}));
test('completed registration phase refuses late/duplicate/cached registration before inspecting implementations',()=>hosted(async(w,http)=>{
 const agents=w.host.bb.agents,register=agents.registerTool,tools=w.tools,records=w.host.harness.registrations.agentTools,n=tools.length;let accessed=0,substitutes=0;
 for(const name of ['docs_inspect','gdrive_get_file','injected']){
  const late={name,description:'late',parameters:tools[0].parameters,get execute(){accessed++;return ()=>{substitutes++;};}};
  assert.throws(()=>register(late),/native registration closed after inventory/);assert.throws(()=>agents.registerTool(late),/native registration closed after inventory/);
 }
 assert.throws(()=>{agents.registerTool=()=>{substitutes++;};},TypeError);assert.throws(()=>{w.host.bb.agents={...agents,registerTool:()=>{substitutes++;}};},TypeError);
 assert.equal(accessed,0);assert.equal(substitutes,0);assert.equal(tools.length,n);assert.equal(records.length,n);assert.equal(new Set(tools.map(t=>t.name)).size,n);assert.equal(http.length,0);assert.equal(w.nativeCalls().length,0);assert.equal(w.invocations.length,0);
 assert.deepEqual(decode(await w.invokeNative('gdrive_get_file',metadata.args,thread)),metadata.expected.output);
}));
test('sealed registrations preserve semantic rejection and legacy strip policy',()=>hosted(async(w,http)=>{
 const before=w.invocations.length;await assert.rejects(()=>w.invokeNative('docs_inspect',{...metadata.inspect,unknown:true},thread),/Unrecognized key/);assert.equal(w.invocations.length,before);assert.equal(http.length,0);
 assert.deepEqual(decode(await w.invokeNative('gdrive_get_file',{...metadata.args,unknown:true},thread)),metadata.expected.output);assert.deepEqual(w.invocations.at(-1).parsedArgs,metadata.args);
}));
const caseId='C009.overrun__local.counterexample',key='C009/snapshot.coverage/overrun__local/counterexample';
function replace(root,p,oldText,newText){const path=join(root,p),s=readFileSync(path,'utf8');assert.equal(s.split(oldText).length,2,oldText);writeFileSync(path,s.replace(oldText,newText));}
function run(mutate,{parentOnly=false}={}){
 const root=mkdtempSync(join(tmpdir(),'native-target-c009-'));try{
  for(const n of readdirSync(packageRoot))if(n==='features'||/\.(ts|tsx|mjs|json|css)$/.test(n))cpSync(join(packageRoot,n),join(root,n),{recursive:true});else symlinkSync(join(packageRoot,n),join(root,n));
  const load=p=>JSON.parse(readFileSync(join(root,p))),save=(p,x)=>writeFileSync(join(root,p),JSON.stringify(x));
  writeFileSync(join(root,'cucumber.mjs'),"export default {};export const docs={paths:['features/docs/semantic-c009-e.feature'],import:['features/docs/steps/bridge-d.steps.mjs'],format:['progress']};\n");
  writeFileSync(join(root,'features/docs/semantic-c009-e.feature'),`@docs @bridgeExecution @C009 @F_READ @S_COVERAGE\nFeature: Native execution target\n Scenario: Original boundary [${caseId}]\n  When the offline production bridge executes "${caseId}"\n`);
  save('features/docs/coverage/baseline.json',{cases:[]});save('features/docs/coverage/bridge-cases.json',{});const index=load('features/docs/coverage/fixtures/index.json');save('features/docs/coverage/fixtures/index.json',{[caseId]:index[caseId]});const registry=load('features/docs/coverage/registry.json');save('features/docs/coverage/registry.json',{operations:{'snapshot.coverage':{variants:{overrun__local:registry.operations['snapshot.coverage'].variants.overrun__local}}},exposed:[]});const m=load('features/docs/coverage/obligations.json');m.expansion.deliveryOverrides={[key]:m.expansion.deliveryOverrides[key]};save('features/docs/coverage/obligations.json',m);
  if(parentOnly)replace(root,'features/docs/coverage/execution-adapters.mjs','    compareC009(record,fixture,trace);','    // Parent-only native provenance control.');
  mutate?.(root);return spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 }finally{rmSync(root,{recursive:true,force:true});}
}
const host='features/docs/support/production-host.mjs',route='features/docs/coverage/c009-execution.mjs',marker='p.state();const setup=await native';
for(const target of ['visible','normalized','collection','late'])test(`actual child ${target} target substitution refuses before publication`,{timeout:90000},()=>{
 const code={visible:"w.tools.find(t=>t.name==='docs_inspect').execute=async()=>({content:[]});",normalized:"w.host.harness.registrations.agentTools.find(t=>t.name==='docs_inspect').execute=async()=>({content:[]});",collection:"w.host.harness.registrations.agentTools=[];",late:"w.host.bb.agents.registerTool({...w.tools.find(t=>t.name==='docs_inspect'),name:'injected'});"}[target];
 const r=run(root=>replace(root,route,marker,code+marker));assert.equal(r.signal,null);assert.notEqual(r.status,0);assert.match(r.stdout,/read only|Cannot assign|native registration closed/);const dir=r.stdout.match(/Docs current-run evidence: (.+)/)[1];assert.equal(readFileSync(join(dir,'executions.ndjson'),'utf8'),'');
});
test('private binding independently runs original with fixed receiver, never a substituted visible function',{timeout:90000},()=>{
 const r=run(root=>{
  replace(root,host,'const name=tool.name,execute=tool.execute.bind(tool);',"const original=tool.execute;tool.execute=async function(...args){assert.equal(this,tool,'fixed original receiver');return original.apply(this,args);};const name=tool.name,execute=tool.execute.bind(tool);");
  replace(root,host,'tools.push(tool);return result;',"tool.execute=()=>{throw new Error('SUBSTITUTE_MUST_NEVER_RUN');};tools.push(tool);return result;");
 });assert.equal(r.signal,null);assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/"executedObligations":1/);
});
test('missing original invocation cannot be replaced by output shape after child comparator is disabled',{timeout:90000},()=>{
 const r=run(root=>replace(root,route,marker,"const originalNative=native; // Deliberately omit the captured setup invocation.\n"+marker.replace('await native','await (async()=>({category:\'budget\'}))')),{parentOnly:true});
 assert.equal(r.signal,null);assert.notEqual(r.status,0);assert.match(r.stdout,/1 scenario \(1 passed\)/);assert.match(r.stderr,/C009 missing actual native call/);
});
