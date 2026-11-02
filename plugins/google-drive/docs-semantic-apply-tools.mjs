// Production handler/schema; deliberately NOT registered by server.ts.
import {z} from 'zod';
import {createBoldApplyService} from './core/docs-semantic/bold-apply.mjs';
import {createAuthorityDispatch} from './core/docs-semantic/authority-dispatch.mjs';
import {boldApprovalDecision} from './core/docs-semantic/bold-consent.mjs';
import {demand} from './core/docs-semantic/draft-policy.mjs';
export const boldApplySchema=z.object({account:z.string().min(1).max(320),operationId:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),planHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function createBoldApplyHandler({bb,settings,store,adapter,clock=Date.now,checkpoint=()=>{}}){
 const authority=createAuthorityDispatch({bb,settings,store});
 const service=createBoldApplyService({store,docs:adapter.semanticDocs,batch:adapter.semanticBatch,authority,clock,checkpoint,
  diagnose:(stage,category)=>bb.log.warn(`Google Drive semantic_bold ${stage} ${category}`),
  review:(payload,timeoutMs,signal,threadId)=>bb.ui.requestInput({threadId,rendererId:'docs-format-approval',title:'Review Google Docs paragraph bold',payload,timeoutMs,describeSubmission:value=>({title:boldApprovalDecision({outcome:'submitted',value}).outcome==='approved'?'Paragraph bold approved (not yet verified)':'Paragraph bold not approved — no write'})},{signal})});
 bb.onDispose(()=>{authority.dispose();return service.drain();});
 async function resolve(args,ctx){
  const input=boldApplySchema.parse(args),token=authority.capture(),check=()=>{authority.check(token);ctx.signal?.throwIfAborted();};check();
  const record=await store.byEmail(input.account);check();demand(record,'owner');await adapter.semanticDocs.authority(record,check);check();const current=await store.byEmail(input.account);check();demand(current?.subject===record.subject,'owner');
  return {input,owner:{subject:record.subject,account:input.account,threadId:ctx.threadId}};
 }
 const unavailable=()=>{try{bb.log.warn('Google Drive semantic_bold handler unavailable');}catch{/* safe outcome wins */}return {content:[{type:'text',text:'Paragraph bold unavailable; inspect the same operation. No automatic retry or new key.'}],isError:true};};
 const definition={name:'docs_apply_bold_internal',description:'Internal paragraph-bold apply harness; not exposed by the serving plugin.',parameters:boldApplySchema,
  async execute(args,ctx){
   try{
    const {input,owner}=await resolve(args,ctx);
    const result=await service.apply(owner,{operationId:input.operationId,planHash:input.planHash},ctx.signal);
    return {content:[{type:'text',text:JSON.stringify(result)}]};
   }catch{return unavailable();}
  }};
 const statusDefinition={name:'docs_bold_status_internal',description:'Internal retained bold facts only; never dispatches or upgrades observations.',parameters:boldApplySchema,async execute(args,ctx){try{const {input,owner}=await resolve(args,ctx);return {content:[{type:'text',text:JSON.stringify(service.status(owner,{operationId:input.operationId,planHash:input.planHash}))}]};}catch{return unavailable();}}};
 return Object.freeze({definition,statusDefinition,service,authority});
}
