// Disposable source strings only. No production imports are patched by this gate.
export function fixtureSource({ id, root, origin, workspace, receipts, updater = false, cloud = false }) {
  const value = JSON.stringify;
  return `import{z}from'zod';import{marker}from'./marker.ts';
import{appendFileSync,existsSync,readFileSync,writeFileSync,renameSync}from'node:fs';import{join}from'node:path';
${updater ? "import plugin from'./implementation/server.ts';import{applicationPorts}from'./implementation/adapters/application.ts';" : ''}
${cloud ? "import{UpdatePause}from'./pause/update-pause.ts';" : ''}
export default async bb=>{
const id=${value(id)},root=${value(root)},receipts=${value(receipts)};
const mode=()=>{try{return JSON.parse(readFileSync(join(root,'mode.json'),'utf8'))}catch{return{}}};
const event=(operation,extra={})=>{let receipt;try{receipt=JSON.parse(readFileSync(join(receipts,'receipt.json'),'utf8'))}catch{}
 appendFileSync(join(root,'events.jsonl'),JSON.stringify({id,operation,marker,jobId:receipt?.jobId??null,removalAttempted:receipt?.removalAttempted??false,...extra})+'\\n')};
const setting=bb.settings.define({note:{type:'string',label:'Synthetic setting',default:''},credential:{type:'string',label:'Synthetic secret',secret:true}});
const data=join(bb.server.experimental_dataDir,'plugins',id),once=join(root,id+'-schedule-once');
if(!existsSync(once)){bb.background.schedule('fixture-once','0 0 1 1 *',()=>{});writeFileSync(once,'registered')}
const database=()=>bb.storage.database();
const snapshot=async()=>{const settings=await setting.get(),db=database();const has=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixture'").get();
 return{marker,pid:process.pid,kv:await bb.storage.kv.get('fixture-sentinel')==='SYNTHETIC_KV',database:!!has&&db.prepare('SELECT value FROM fixture WHERE id=1').get()?.value==='SYNTHETIC_DB',note:existsSync(join(data,'fixture-note.txt'))&&readFileSync(join(data,'fixture-note.txt'),'utf8')==='SYNTHETIC_NOTE',setting:settings.note==='SYNTHETIC_SETTING',secret:settings.credential==='SYNTHETIC_SECRET'}};
const seed=async()=>{if(await bb.storage.kv.get('fixture-seeded'))throw Error('Fixture already seeded');
 await setting.experimental_set({note:'SYNTHETIC_SETTING',credential:'SYNTHETIC_SECRET'});
 await bb.storage.kv.set('fixture-seeded',true);await bb.storage.kv.set('fixture-sentinel','SYNTHETIC_KV');
 const db=database();db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');db.prepare('INSERT INTO fixture VALUES(1,?)').run('SYNTHETIC_DB');
 writeFileSync(join(data,'fixture-note.txt'),'SYNTHETIC_NOTE');return snapshot()};
${cloud ? `
let mirrors=await bb.storage.kv.get('fixture-mirrors')??[
 {id:'11111111-1111-4111-8111-111111111111',enabled:true,phase:'ready',failure:null,blocker:null},
 {id:'22222222-2222-4222-8222-222222222222',enabled:false,phase:'paused',failure:null,blocker:null},
 {id:'33333333-3333-4333-8333-333333333333',enabled:true,phase:'failed',failure:'sync_failed',blocker:null},
 {id:'44444444-4444-4444-8444-444444444444',enabled:false,phase:'retained',failure:null,blocker:null}];
const saveMirrors=()=>bb.storage.kv.set('fixture-mirrors',mirrors);
const sync={status:()=>({mirrors:mirrors.map((m,i)=>({...m,...(i===0&&mode().draining?{phase:'running'}:{})}))}),
 pause:async id=>{const mirror=mirrors.find(m=>m.id===id);mirror.enabled=false;if(mirror.phase!=='retained')mirror.phase='paused';await saveMirrors();event('mirror-pause',{mirrorId:id})},
 enable:async id=>{event('AUTOMATIC-ENABLE',{mirrorId:id});mirrors.find(m=>m.id===id).enabled=true;await saveMirrors()},disconnect:async()=>{}};
const pause=new UpdatePause(sync,{get:()=>bb.storage.kv.get('pa-update-pause-v1'),set:value=>bb.storage.kv.set('pa-update-pause-v1',value)});await pause.start();
const status=async()=>({...sync.status(),updatePause:pause.status()});
const updaterOnly=context=>{const caller=context.experimental_caller;if(caller.kind!=='plugin'||caller.pluginId!=='pa-updates')throw Error('Only host-verified PA updates can reserve an update Pause')};
const clientOnly=context=>{if(context.experimental_caller.kind!=='client')throw Error('Client only')};
const pauseHandler=async(input,context)=>{
 if('updateJob'in input){updaterOnly(context);event('reserve',{caller:context.experimental_caller.kind,callerPlugin:context.experimental_caller.pluginId,updateJob:input.updateJob});
  if(mode().failInitial){try{throw Error('PRIVATE_SENTINEL')}catch{bb.log.warn('icloud stage=update_pause outcome=unavailable');throw Error('Synthetic Pause unavailable')}}
  await pause.pause(input.updateJob);
 }else{clientOnly(context);event('user-pause',{caller:context.experimental_caller.kind,mirrorId:input.id});await pause.userPause(input.id)}return status()};
const enableHandler=async(input,context)=>{if('updateJob'in input){updaterOnly(context);const owned=await bb.storage.kv.get('pa-update-pause-v1');event('release',{ownedIds:owned?.ownedIds??[],updateJob:input.updateJob});await pause.resume(input.updateJob)}else{clientOnly(context);await pause.userEnable(input.id)}return status()};
const reset=async()=>{if(pause.held)throw Error('Cannot reset held fixture');mirrors=mirrors.map((m,i)=>({...m,enabled:i===0||i===2,phase:i===0?'ready':i===2?'failed':i===3?'retained':'paused'}));await saveMirrors();return status()};
const allPaused=async()=>{if(pause.held)throw Error('Cannot reset held fixture');for(const m of mirrors)await pause.userPause(m.id);return status()};
` : ''}
const contract={fixtureStatus:{input:z.null(),output:z.unknown()},seed:{input:z.null(),output:z.unknown()}${cloud ? ",status:{input:z.null(),output:z.unknown()},pause:{input:z.union([z.object({id:z.string().uuid()}),z.object({updateJob:z.string().uuid()})]),output:z.unknown()},enable:{input:z.union([z.object({id:z.string().uuid()}),z.object({updateJob:z.string().uuid()})]),output:z.unknown()},reset:{input:z.null(),output:z.unknown()},allPaused:{input:z.null(),output:z.unknown()}" : ''}};
const handlers={fixtureStatus:async()=>({...await snapshot()${cloud ? ",...await status(),owned:await bb.storage.kv.get('pa-update-pause-v1')??null" : ''}}),seed${cloud ? ',status,pause:pauseHandler,enable:enableHandler,reset,allPaused' : ''}};
bb.onDispose(async()=>{event('dispose-enter'${cloud ? ",{ownedIds:(await bb.storage.kv.get('pa-update-pause-v1'))?.ownedIds??[],mirrors:sync.status().mirrors}" : ''});
 if(mode().hideOriginOnDispose===id){renameSync(${value(origin)},${value(origin + '.offline')});event('origin-hidden')}
 const deadline=Date.now()+60000;while(mode().blockDispose===id){if(Date.now()>deadline)throw Error('Bounded fixture disposal expired');await new Promise(r=>setTimeout(r,25))}
 ${cloud ? 'await pause.stop();' : ''}event('dispose-exit')});event('load');
${updater ? `const ports=applicationPorts(bb,${value(origin)},async()=>${value(workspace)},receipts);
ports.runtime={inspect:async()=>({target:null,runningThreadCount:0,rows:[]}),updateCli:async()=>{throw Error('No runtime writes')},prepareBb:async()=>{throw Error('No runtime writes')},applyBb:async()=>{throw Error('No runtime writes')},reconcileBb:async()=>{throw Error('No runtime writes')}};
const api=new Proxy(bb,{get(target,key){if(key!=='rpc')return Reflect.get(target,key,target);return{...target.rpc,register(c,h){return target.rpc.register({...c,...contract},{...h,...handlers})}}}});
return plugin(api,undefined,ports);` : 'bb.rpc.register(contract,handlers);'}
};`;
}
