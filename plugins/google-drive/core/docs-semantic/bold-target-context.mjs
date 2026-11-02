// Private saved-draft observation application. No registration, seal or mutation.
import {checkContextDraft,checkInitialEvidence,contextCheck,contextError,CONTEXT_LIMITS,contextObservation,contextRights,markerKeysFor,interpretLocalContext,contextResult} from './target-context.mjs';
import {bytes,hashValid,keyValid,ownerCheck} from './draft-policy.mjs';
const categories=new Set(['invalid','unknown','owner','head','state','expired','unsupported','snapshot','corrupt','budget','capacity','metadata','parents','cycle','unavailable','denied','cancelled']);
function category(error){
 if(error?.name==='AbortError')return 'cancelled';
 if(['marker','marker_ambiguous'].includes(error?.writerCode))return 'corrupt';
 if(error?.writerCode==='marker_budget')return 'budget';
 const value=error?.contextCode??error?.draftCode??error?.semanticCode??error?.writerCode;
 return categories.has(value)?value:'unavailable';
}
export function createBoldTargetContextService({store,docs,journal=store.semanticDrafts,snapshots=store.semanticSnapshots,clock=Date.now,diagnose=()=>{}}){
 async function inspectBoldTargetContext(owner,input,signal){
  let stage='draft';
  try{
   ownerCheck(owner);
   contextCheck(keyValid(input?.operationId)&&hashValid(input?.planHash),'invalid');
   const saved=()=>{signal?.throwIfAborted();return checkContextDraft(journal.byId(owner,input.operationId),owner,input,clock());};
   const initial=saved(),account=initial.record.account;
   // This is the full pinned initial model, not merely the paragraph in the plan.
   checkInitialEvidence(initial,snapshots.readPinned(initial.record.snapshotId,owner,input.operationId,clock()));
   saved();
   async function currentAccount(){
    saved();const record=await store.byEmail(account);saved();
    contextCheck(record?.subject===initial.record.subject&&typeof record.email==='string'&&record.email.toLowerCase()===account.toLowerCase(),'owner');
    return record;
   }
   stage='authority';
   let record=await currentAccount();saved();
   const authority=await docs.authority(record);saved();
   contextCheck(authority?.subject===initial.record.subject,'owner');
   record=await currentAccount();saved();
   let calls=0,totalBytes=0;
   async function metadata(id){
    saved();record=await currentAccount();saved();
    contextCheck(calls<CONTEXT_LIMITS.calls&&totalBytes+CONTEXT_LIMITS.responseBytes<=CONTEXT_LIMITS.aggregateBytes,'budget');
    stage='metadata';calls++;
    const raw=await docs.contextMetadata(record,id,signal);saved();
    record=await currentAccount();saved();
    contextCheck(Number.isSafeInteger(raw?.responseBytes)&&raw.responseBytes>0&&raw.responseBytes<=CONTEXT_LIMITS.responseBytes,'budget');
    totalBytes+=raw.responseBytes;contextCheck(totalBytes<=CONTEXT_LIMITS.aggregateBytes,'budget');return raw;
   }
   const documentId=initial.plan.binding.documentId,observations=[],visited=new Set();
   const firstRaw=await metadata(documentId);saved();
   const driveId=firstRaw?.document?.driveId??null;
   let current=contextObservation(firstRaw,documentId,{driveId}),root=null,rootObservation=null;
   let rights=contextRights(documentId,[]);
   function append(observation){
    contextCheck(!visited.has(observation.metadata.id),'cycle');
    const next=[...observations,observation];
    rights=contextRights(documentId,next.map(o=>o.metadata));
    contextCheck(bytes(next)<=CONTEXT_LIMITS.resultBytes-8192,'budget');
    visited.add(observation.metadata.id);observations.push(observation);
   }
   append(current);
   if(driveId===null){
    const rootRaw=await metadata('root');saved();
    rootObservation=contextObservation(rootRaw,'root',{folder:true});root=rootObservation.metadata.id;
    contextCheck(root!==documentId,'metadata');
    contextCheck(rootObservation.metadata.parents===undefined||rootObservation.metadata.parents.length===0,'parents');
   }
   let ancestry;
   for(let depth=0;;depth++){
    const m=current.metadata;
    if(root!==null&&m.id===root){ancestry={status:'observed',boundary:{kind:'myDriveRoot',id:root,responseDigest:rootObservation.responseDigest},calls,responseBytes:totalBytes};break;}
    // This tranche deliberately has no independent drives.get authority/port.
    if(driveId!==null&&(m.id===driveId||!m.parents?.length)){
     ancestry={status:'unresolved',reason:'sharedDriveBoundaryNotIndependentlyObserved',driveId,calls,responseBytes:totalBytes};break;
    }
    if(!m.parents?.length){ancestry={status:'unresolved',reason:'unprovenBoundary',rootResolution:{id:root,responseDigest:rootObservation?.responseDigest??null},calls,responseBytes:totalBytes};break;}
    contextCheck(depth<CONTEXT_LIMITS.depth,'budget');
    const parent=m.parents[0];contextCheck(!visited.has(parent),'cycle');
    // Check actual prospective resource/event representability before another GET.
    contextRights(documentId,[...observations.map(o=>o.metadata),{id:parent}]);
    const raw=parent===root?null:await metadata(parent);saved();
    current=raw?contextObservation(raw,parent,{folder:true,driveId}):rootObservation;
    append(current);
   }
   stage='localCapture';
   record=await currentAccount();saved();
   checkInitialEvidence(initial,snapshots.readPinned(initial.record.snapshotId,owner,input.operationId,clock()));
   const resourceIds=[...new Set(rights.map(r=>r.id))].sort(),markerKeys=markerKeysFor(observations);
   // One synchronous raw SQLite cut AFTER all provider/account awaits.
   const raw=store.writers.readTargetContextFacts({resourceIds,markerKeys}),capturedAt=clock();saved();
   record=await currentAccount();saved();
   checkInitialEvidence(initial,snapshots.readPinned(initial.record.snapshotId,owner,input.operationId,clock()));
   const local=interpretLocalContext(raw,rights,observations);saved();
   return contextResult(initial,ancestry,observations,rights,local,capturedAt);
  }catch(error){
   const code=category(error);try{diagnose(stage,code);}catch{/* diagnostics cannot replace the safe failure */}
   throw contextError(code);
  }
 }
 return Object.freeze({inspectBoldTargetContext});
}
