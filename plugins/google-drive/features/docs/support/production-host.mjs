// Offline-only source factory capture. Never import dist or change the serving
// composition root. Transpile current source into an owned disposable directory.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../../../adapters/bb-store.mjs';
import { createGoogleAdapter } from '../../../adapters/google.mjs';
import { registerSemanticReadTools } from '../../../docs-semantic-registration.mjs';
import { SEMANTIC_READ_SCHEMAS } from '../../../docs-semantic-schemas.mjs';
import { z } from 'zod';
import { closeAmbientNetwork } from './offline-network.mjs';
import { localInvocationBoundary } from './local-invocations.mjs';
import { storageObservationBoundary } from './storage-observations.mjs';
import { c009InvocationBoundary } from './c009-invocations.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
let factory;
async function sourceFactory() {
  if(!factory) factory=(async()=>{
    const dir=mkdtempSync(join(tmpdir(),'docs-source-factory-'));
    try {
      for(const name of readdirSync(root)) {
        if(name.endsWith('.ts'))writeFileSync(join(dir,name.replace(/\.ts$/,'.js')),ts.transpileModule(readFileSync(join(root,name),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
        else if(['node_modules','adapters','core','skills'].includes(name)||name.endsWith('.mjs'))symlinkSync(join(root,name),join(dir,name));
      }
      writeFileSync(join(dir,'package.json'),'{"type":"module"}');
      // One fixed package-local test entry resolves only for this importer to
      // the source we just transpiled. No user-controlled module specifier.
      const hooks=registerHooks({resolve(specifier,context,next){
        return next(specifier==='./offline-production-factory.js'&&context.parentURL===import.meta.url
          ?pathToFileURL(join(dir,'server.js')).href:specifier,context);
      }});
      try {return (await import('./offline-production-factory.js')).default;}
      finally {hooks.deregister();}
    } finally {rmSync(dir,{recursive:true,force:true});}
  })();
  return factory;
}
export const schemaShape=(schema,io='output')=>z.toJSONSchema(schema,{unrepresentable:'any',io});
export async function productionHost(fetchImpl,options={}) {
  assert.ok(Object.keys(options).every(k=>['c009','pageBytes'].includes(k)));
  if(options.c009)assert.ok([3000,6000,65536].includes(options.pageBytes));
  let c009=null;
  const plugin=await sourceFactory(),host=createFakePluginHost({pluginId:'google-drive',agentSkillIds:['google-docs-editing','google-drive-sharing','google-sheets','google-sheets-editing','google-drive-filing','google-drive-copy','google-drive-upload']});
  // Retain the official dispatcher before the mutable host reaches any route.
  const behavior=host.harness.behavior,officialDispatch=behavior.callAgentTool;
  const dispatch=officialDispatch.bind(behavior);
  const restoreNetwork=closeAmbientNetwork();
  const close=async()=>{try{await host.harness.lifecycle.dispose();}finally{restoreNetwork();}};
  const invocations=[],tools=[],snapshotAccess=[],nativeCalls=[],nativeSnapshotCalls=[];
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const copy=value=>freeze(structuredClone(value));
  // Fixed actual host call, not a callback or an adapter-authored receipt.
  // A raw-mask refusal records the native host's error AND a paired parse of
  // exactly the same input without fields, using the actual registered schema.
  async function invokeNative(name,args,threadId) {
    assert.ok(host.harness.behavior===behavior&&behavior.callAgentTool===officialDispatch,'native host dispatcher replaced');
    c009?.guard();
    const tool=tools.find(t=>t.name===name);assert.ok(tool,'missing native schema capture');
    const {fields,...withoutFields}=args;
    const control=tool.parameters.safeParse(withoutFields);
    const observed={id:randomUUID(),sequence:nativeCalls.length+1,name,args:copy(args),threadId,...c009?{clock:c009.clock(),localSequence:c009.sequence()}:{},
      control:{args:copy(withoutFields),parsed:control.success?copy(control.data):null}};
    activeNativeCall=observed;
    try {
      const result=await dispatch(name,args,{threadId});
      nativeCalls.push(copy({...observed,result}));return result;
    } catch(error) {
      // Synthetic-only harness diagnostics, never provider or account errors.
      assert.ok(typeof error.message==='string'&&error.message.length<=2048,'bounded native schema error');
      nativeCalls.push(copy({...observed,error:{name:error.name,message:error.message}}));throw error;
    } finally {activeNativeCall=null;}
  }
  let activeInvocation=null,activeNativeCall=null;
  const agents=host.bb.agents,register=agents.registerTool.bind(agents);
  let registrationOpen=true;
  agents.registerTool=tool=>{
    assert.ok(registrationOpen,'native registration closed after inventory');
    // Retain the actual implementation and its receiver BEFORE exposing tools.
    // Never dynamically look up a caller-visible execute during dispatch.
    const name=tool.name,execute=tool.execute.bind(tool);
    const result=register({...tool,async execute(args,ctx){
      const observed={name,parsedArgs:structuredClone(args),threadId:ctx.threadId};invocations.push(observed);
      activeInvocation=observed;
      try {const output=await execute(args,ctx);observed.output=structuredClone(output);return output;}
      finally {activeInvocation=null;}
    }});
    tools.push(tool);return result; // Failed/duplicate registrations never enter capture.
  };
  // The legacy factory captures fetch at adapter construction. No provider call
  // occurs during construction. Restore immediately; never install a live port.
  const previous=globalThis.fetch;
  try {globalThis.fetch=fetchImpl;await plugin(host.bb);} catch(error){globalThis.fetch=previous;await close();throw error;} finally {if(globalThis.fetch===fetchImpl)globalThis.fetch=previous;}
  try {
    const serving=(await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext())).tools.map(t=>typeof t==='string'?t:t.name);
    const store=createBbStore(host.bb.storage.database(),host.bb.storage.migrate);
    const getSnapshot=store.semanticSnapshots.get.bind(store.semanticSnapshots);
    const peekCursor=store.semanticSnapshots.peekCursor.bind(store.semanticSnapshots);
    function observeSnapshot(method,key,owner,now,expectedSnapshot,call){
      if(!activeInvocation)return call();
      const observed={nativeCallId:activeNativeCall?.id??null,nativeSequence:activeNativeCall?.sequence??null,native:activeInvocation.name,method,key,owner:{subject:owner.subject,account:owner.account,threadId:owner.threadId},clock:now,...expectedSnapshot?{expectedSnapshot}:{}};
      try{const result=call(),model=method==='get'?result:result.snapshot;observed.result={binding:model.binding,evidenceDigest:model.evidenceDigest,...method==='peekCursor'?{state:result.state}:{}};return result;}
      catch(error){observed.error={category:error.semanticCode??null};throw error;}
      finally{nativeSnapshotCalls.push(copy(observed));}
    }
    store.semanticSnapshots.peekCursor=(cursor,owner,now,snapshotId)=>observeSnapshot('peekCursor',cursor,owner,now,snapshotId,()=>peekCursor(cursor,owner,now,snapshotId));
    store.semanticSnapshots.get=(snapshotId,owner,now)=>{
      const observation=activeInvocation?{native:activeInvocation.name,snapshotId,owner:{subject:owner.subject,account:owner.account,threadId:owner.threadId}}:null;
      if(observation)snapshotAccess.push(observation);
      try{return observeSnapshot('get',snapshotId,owner,now,null,()=>getSnapshot(snapshotId,owner,now));}catch(error){if(observation)observation.category=error.semanticCode;throw error;}
    };
    await store.addAccount({subject:'subject-d',email:'reader@example.test',refreshToken:'PRIVATE_REFRESH',accessToken:'PRIVATE_TOKEN',expiresAt:Date.now()+3600000});
    await store.addAccount({subject:'subject-other',email:'other@example.test',refreshToken:'PRIVATE_OTHER_REFRESH',accessToken:'PRIVATE_OTHER_TOKEN',expiresAt:Date.now()+3600000});
    if(options.c009)c009=c009InvocationBoundary(host.bb.storage.database(),store);
    const clock=c009?c009.clock:()=>0;
    const adapter=createGoogleAdapter({store,fetchImpl,getClient:async()=>{throw new Error('Unexpected refresh');},clock});
    const legacyCount=tools.length;let identity=0;
    registerSemanticReadTools(host.bb,store,adapter,{clock,ids:()=>options.c009?(++identity===1?'snap-d':`read-d-${identity}`):'snap-d',...options.c009?{pageBytes:options.pageBytes}:{}});
    assert.deepEqual(tools.slice(legacyCount).map(t=>t.name).sort(),['docs_find','docs_inspect','docs_read'],'unjoined semantic native registration');
    assert.equal(new Set(tools.map(t=>t.name)).size,tools.length,'duplicate native registration');
    for(const [name,schema] of Object.entries(SEMANTIC_READ_SCHEMAS)) {
      assert.ok(!serving.includes(name),'semantic serving exposure remains unwired');
      assert.deepEqual(schemaShape(tools.find(t=>t.name===name).parameters),schemaShape(schema),'actual registrar/schema mismatch');
    }
    assert.ok(serving.includes('gdrive_get_file'),'existing metadata serving configuration');
    registrationOpen=false;
    // The SDK exposes its normalized records both in registrations and agent
    // configuration. Seal those aliases too: its official dispatcher reads that
    // actual array. Only this completed disposable host is sealed; no SDK patch,
    // schema rewriting or change to production registration/lifecycle behavior.
    const registrations=host.harness.registrations;
    for(const tool of [...tools,...registrations.agentTools])Object.freeze(tool);
    Object.freeze(tools);Object.freeze(registrations.agentTools);
    for(const [object,key] of [[agents,'registerTool'],[host.bb,'agents'],[registrations,'agentTools'],[host.harness,'registrations']])
      Object.defineProperty(object,key,{writable:false,configurable:false});
    const completed=Object.defineProperty({host,store,local:localInvocationBoundary(store),invocations,snapshotAccess,tools,serving,close,
      invokeNative,nativeCalls:()=>copy(nativeCalls),nativeSnapshotCalls:()=>copy(nativeSnapshotCalls),storage:storageObservationBoundary(host.bb.storage.database()),...c009?{c009}:{}},'tools',{writable:false,configurable:false});
    Object.defineProperty(completed,'nativeSnapshotCalls',{writable:false,configurable:false});
    return completed;
  } catch(error){await close();throw error;}
}
