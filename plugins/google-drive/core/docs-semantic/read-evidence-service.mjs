// Internal application seam. owner is supplied by the verified account/thread
// boundary, never by a native argument. This service makes no provider calls.
// Only stored tokens can supply delivery; a presentation is compared as data.
import { randomUUID } from 'node:crypto';
import { semanticFailureCategory } from './failures.mjs';
import { requireValue, digest, freeze, semanticError } from './common.mjs';
import { validatedReadModel, resolveScope } from './selectors.mjs';
import { thawReadSelection, project } from './reader.mjs';
import { compareReadEvidence, closed, boundedWitness, readBinding } from './read-effects.mjs';

function coherentDeliveries(snapshot,records) {
  if(!records.length)return [];
  const first=records[0];requireValue(typeof first.readId==='string'&&first.readId.length>0,'corrupt');
  const identity=record=>digest({readId:record.readId,scope:record.scope,selection:record.selection??null,format:record.format});
  const sorted=[...records].sort((a,b)=>a.offset-b.offset||a.lossOffset-b.lossOffset);
  let offset=0,lossOffset=0,terminal=false;
  const selected=first.selection?thawReadSelection(snapshot,first.selection):resolveScope(snapshot,first.scope);
  requireValue(selected.status==='resolved','scope');
  const scoped=resolveScope(snapshot,first.scope),allowed=new Set(scoped.nodes);
  requireValue(selected.nodes.every(id=>allowed.has(id)),'scope');
  const membership=new Set(selected.nodes);
  const maximum=first.format==='diagnostic'?null:project(snapshot,selected,{format:first.format,styles:true,review:true});
  const projectedIds=maximum?new Set(maximum.records.map(r=>r.node??r.id)):null;
  const filtered=[];
  for(const record of sorted){
    requireValue(record.snapshotId===snapshot.binding.snapshotId&&record.evidenceDigest===snapshot.evidenceDigest&&record.view===snapshot.binding.view,'snapshot');
    requireValue(identity(record)===identity(first)&&!terminal,'conflict');
    requireValue(record.offset===offset&&(record.lossOffset??0)===lossOffset,'scope');
    requireValue(typeof record.complete==='boolean'&&Array.isArray(record.nodes)&&Array.isArray(record.losses),'corrupt');
    const nodes=[],nodeAspects={};
    for(const id of record.nodes){
      if(!snapshot.nodes[id])continue; // diagnostic identities never become content
      requireValue(membership.has(id),'scope');
      const aspects=record.nodeAspects?.[id];requireValue(Array.isArray(aspects),'corrupt');
      requireValue(maximum&&aspects.every(a=>maximum.nodeAspects[id]?.includes(a)),'scope');
      nodes.push(id);nodeAspects[id]=aspects;
    }
    filtered.push({...record,nodes,nodeAspects});
    offset+=record.nodes.length;
    // A final record page may also carry some orphan omissions before a
    // loss-only continuation. Count those from the actual projection, not from
    // the absence of records on this page. Image omission is explicit.
    lossOffset+=record.losses.filter(loss=>loss.kind==='omittedImage'||!(projectedIds??new Set(record.nodes)).has(loss.node)).length;
    terminal=record.complete;
  }
  return filtered;
}
export function createReadEvidenceService({snapshots,clock=Date.now,ids=randomUUID,diagnose=()=>{}}) {
  function boundary(operation,run) {
    try{return run();}catch(error){
      const category=semanticFailureCategory(error,{cancellation:false});
      diagnose(operation,semanticError(category));throw semanticError(category);
    }
  }
  function evaluateOwned(owner,args) {
      closed(args,['snapshotId','scope','selector','effect'],['presentation','originalRecords','deliveryTokens']);boundedWitness(args);
      const snapshot=validatedReadModel(snapshots.get(args.snapshotId,owner,clock()));
      const tokens=args.deliveryTokens??[];
      const deliveries=coherentDeliveries(snapshot,snapshots.deliveries(args.snapshotId,owner,clock(),tokens));
      const {snapshotId,deliveryTokens,...request}=args;
      return compareReadEvidence(snapshot,request,deliveries);
  }
  function evaluate(owner,args) {
    return boundary('docs_read_evidence',()=>evaluateOwned(owner,args));
  }
  function retain(owner,args) {
    return boundary('docs_retain_evidence',()=>{
      closed(args,['request','expires']);boundedWitness(args);
      const {request,expires}=args;
      const result=evaluateOwned(owner,request);requireValue(result.witnessSatisfied,'unavailable');
      const now=clock(),snapshot=snapshots.get(request.snapshotId,owner,now),pinId=ids();
      const binding=readBinding(snapshot);
      const references={target:result.target,footprint:result.footprint,comparisonDigest:result.comparisonDigest,
        deliveryTokens:[...(request.deliveryTokens??[])],presentationDigest:digest(request.presentation),originalDigest:digest(request.originalRecords??[])};
      const record={snapshotId:request.snapshotId,evidenceDigest:snapshot.evidenceDigest,view:snapshot.binding.view,
        format:'retainedWitness',nodes:[],nodeAspects:{},aspects:[],retention:{pinId,expires},binding,references,result};
      boundedWitness(record);
      const saved=snapshots.retainWitness(request.snapshotId,owner,pinId,record,now,expires);
      return freeze({kind:'pinnedReadEvidence',binding,pinId:saved.pinId,expires:saved.expires,witnessToken:saved.deliveryToken,
        witnessDigest:digest(record),references,retainedEvidenceOnly:true,editReady:false,authoringAuthority:'notEstablished'});
    });
  }
  function consume(owner,handle) {
    return boundary('docs_consume_evidence',()=>{
      closed(handle,['kind','binding','pinId','expires','witnessToken','witnessDigest','references','retainedEvidenceOnly','editReady','authoringAuthority']);boundedWitness(handle);
      requireValue(handle.kind==='pinnedReadEvidence'&&handle.retainedEvidenceOnly===true&&handle.editReady===false&&handle.authoringAuthority==='notEstablished','invalid');
      const saved=snapshots.pinnedWitness(handle.binding.snapshotId,owner,handle.pinId,handle.witnessToken,clock());
      const snapshot=validatedReadModel(saved.snapshot);
      requireValue(digest(handle.binding)===digest(readBinding(snapshot))&&handle.expires===saved.expires&&handle.witnessDigest===digest(saved.record),'conflict');
      requireValue(digest(handle.references)===digest(saved.record.references),'conflict');
      // No resolver, effect builder, new coverage or TTL extension here. Return
      // only the exact bounded witness saved while ordinary evidence was live.
      return freeze({...saved.record.result,retainedEvidenceOnly:true,pinId:handle.pinId,expires:handle.expires,
        references:saved.record.references,currentReadAuthority:false,authoringAuthority:'notEstablished',editReady:false});
    });
  }
  return {evaluate,retain,consume};
}
