// Production schemas/factory. Deliberately NOT registered/imported by server.ts.
import {z} from 'zod';
import {createCompositionService} from './core/docs-semantic/compositions.mjs';
import {createBoldApplyService} from './core/docs-semantic/bold-apply.mjs';
import {createAuthorityDispatch} from './core/docs-semantic/authority-dispatch.mjs';
import {boldApprovalDecision} from './core/docs-semantic/bold-consent.mjs';
import {demand} from './core/docs-semantic/draft-policy.mjs';
const id=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),account=z.string().min(1).max(320),requestId=z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),target=z.object({node:z.string().min(1).max(512)}).strict();
const draft=z.discriminatedUnion('kind',[z.object({kind:z.literal('new'),requestId,destination:z.object({snapshotId:z.string().min(1).max(128)}).strict(),mode:z.literal('direct')}).strict(),z.object({kind:z.literal('extend'),draftId:id,expectedDraftHash:hash}).strict()]);
export const compositionStyleSchema=z.object({account,draft,commands:z.array(z.object({op:z.literal('text'),target,set:z.object({bold:z.boolean()}).strict()}).strict()).min(1).max(8)}).strict();
export const compositionContentSchema=z.object({account,draft,commands:z.array(z.object({op:z.literal('replace'),target,oldText:z.string().min(1).max(2000),newText:z.string().max(2000)}).strict()).min(1).max(8)}).strict();
export const compositionCombineSchema=z.object({account,requestId,inputs:z.array(z.object({draftId:id,expectedDraftHash:hash}).strict()).min(2).max(16)}).strict().refine(v=>new Set(v.inputs.map(x=>x.draftId)).size===v.inputs.length);
export const compositionStatusSchema=z.union([z.object({account,draftId:id}).strict(),z.object({account,requestId}).strict()]);
export const compositionCancelSchema=z.object({account,draftId:id,expectedDraftHash:hash}).strict();
export const compositionApplySchema=z.object({account,operationId:id,planHash:hash}).strict();
export function createCompositionHandlers({bb,settings,store,adapter,clock=Date.now,ids,checkpoint=()=>{}}){
 const authority=createAuthorityDispatch({bb,settings,store}),diagnose=(stage,category)=>bb.log.warn(`Google Drive semantic_composition ${stage} ${category}`),planner=createCompositionService({snapshots:store.semanticSnapshots,journal:store.semanticDrafts,clock,...ids?{ids}:{},diagnose});
 const application=createBoldApplyService({store,docs:adapter.semanticDocs,batch:adapter.semanticBatch,authority,clock,checkpoint,diagnose,review:(payload,timeoutMs,signal,threadId,kind)=>bb.ui.requestInput({threadId,rendererId:kind==='paragraphComposition'?'docs-composition-approval':kind==='paragraphReplace'?'docs-replacement-approval':'docs-format-approval',title:'Review Google Docs edit program',payload,timeoutMs,describeSubmission:value=>({title:boldApprovalDecision({outcome:'submitted',value}).outcome==='approved'?'Edit program approved (not yet verified)':'Edit program not approved — no write'})},{signal})});
 bb.onDispose(()=>{authority.dispose();return application.drain();});
 const tool=(name,schema,action)=>({name,description:'Closed unregistered paragraph composition. No generated targets, collaboration, cross-document edits or automatic retry.',parameters:schema,async execute(args,ctx){let stage='resolve';try{
  const input=schema.parse(args),token=authority.capture(),check=()=>{authority.check(token);ctx.signal?.throwIfAborted();};check();const record=await store.byEmail(input.account);check();demand(record,'owner');// Planning/replay/status use the already verified subject of the saved S02
  // binding. Apply's EXISTING K5 pipeline performs fresh authority after the
  // local owner/head/expiry checks; stale Apply cannot cause provider access.
  const owner={subject:record.subject,account:input.account,threadId:ctx.threadId};stage='core';const result=await action(owner,input,ctx.signal);return {content:[{type:'text',text:JSON.stringify(result)}]};
 }catch(error){if(stage!=='core'||!error?.draftCode){try{diagnose(stage,'unavailable');}catch{}}return {isError:true,content:[{type:'text',text:'Paragraph program unavailable. Inspect the same request or operation; no automatic retry or replacement key.'}]};}}});
 const definitions=[tool('docs_plan_style',compositionStyleSchema,(o,i)=>planner.plan(o,i,'style')),tool('docs_plan_content',compositionContentSchema,(o,i)=>planner.plan(o,i,'content')),tool('docs_plan_combine',compositionCombineSchema,(o,i)=>planner.combine(o,i)),tool('docs_draft_status',compositionStatusSchema,(o,{account,...i})=>planner.status(o,i)),tool('docs_draft_cancel',compositionCancelSchema,(o,{account,...i})=>planner.cancel(o,i)),tool('docs_apply',compositionApplySchema,(o,{account,...i},s)=>application.apply(o,i,s))];
 return Object.freeze({definitions,planner,application,authority});
}
