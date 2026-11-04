// Actual production K6 definition; deliberately NOT registered in server.ts.
import {z} from 'zod';
import {historicalKeyValid,parseCatalogHandle} from './core/docs-semantic/draft-catalog.mjs';
import {createRecoveryService,RECOVERY_KINDS} from './core/docs-semantic/recovery.mjs';
import {createRecoveryReadStore} from './adapters/docs-recovery-store.mjs';
import {createRecoveryReadTransport} from './adapters/docs-recovery-read.mjs';
const account=z.string().min(1).max(320);
export const operationStatusSchema=z.union([
 z.object({account,operationId:z.string().refine(historicalKeyValid),receiptKind:z.enum(RECOVERY_KINDS).optional()}).strict(),
 z.object({account,recoveryHandle:z.string().max(512).refine(value=>{try{parseCatalogHandle(value);return true;}catch{return false;}})}).strict()
]);
export function createOperationStatusHandler({bb,db,store,fetchImpl=fetch,clock=Date.now}){
 const disposed=new AbortController();bb.onDispose(()=>disposed.abort());
 const service=createRecoveryService({store:createRecoveryReadStore(db,store),reads:createRecoveryReadTransport({fetchImpl}),clock,diagnose:(stage,category)=>bb.log.warn(`Google Drive operation_status ${stage} ${category}`)});
 const definition={name:'docs_operation_status',description:'Read retained operation history and separate current observation. Never writes, refreshes credentials, repairs, replays or releases claims. Unregistered.',parameters:operationStatusSchema,
  async execute(args,ctx){
   try{
    disposed.signal.throwIfAborted();
    const input=operationStatusSchema.parse(args),signal=ctx.signal?AbortSignal.any([ctx.signal,disposed.signal]):disposed.signal;
    const result=await service.status(input,{threadId:ctx.threadId,signal});
    return {content:[{type:'text',text:JSON.stringify(result)}]};
   }catch{
    try{bb.log.warn('Google Drive operation_status handler unavailable');}catch{/* no raw diagnostics */}
    return {content:[{type:'text',text:JSON.stringify({status:'unavailable',observation:{kind:'unavailable'},thisCall:{providerMutationCount:0},retrySafe:false})}],isError:true};
   }
  }};
 return Object.freeze({definition,service});
}
