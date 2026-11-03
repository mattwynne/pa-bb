// Observation policy only. No execution authority, provider I/O or persistence.
import {family} from './family.mjs';
import {boundedTree,LIMITS} from './common.mjs';
import {bytes,draftHash,immutable,ownerCheck,strict,timeCheck,validateSaved,requireDraftEvidence} from './draft-policy.mjs';
import {WRITER_LIMITS,writerResources,canonicalWriterGrants,validateWriter,nextWriterFact,assertWriterGrants,writerDigest,legacyWriterResources,resourcesConflict} from './writer-coordination.mjs';
import {targetMarker,classifyWriterMarker} from './writer-markers.mjs';
export const CONTEXT_LIMITS=Object.freeze({responseBytes:65536,aggregateBytes:262144,depth:30,calls:33,resultBytes:65536,localBytes:8*1024*1024});
export const contextError=code=>Object.assign(new Error(`Semantic target context ${code}`),{contextCode:code});
export function contextCheck(condition,code='invalid'){if(!condition)throw contextError(code);}
const id=value=>typeof value==='string'&&/^[\w-]{1,256}$/.test(value)&&value!=='root';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function checkContextDraft(saved,owner,input,now){
 ownerCheck(owner);strict(input,['operationId','planHash']);timeCheck(now);
 contextCheck(saved,'unknown');validateSaved(saved);contextCheck(!saved.execution,'state');
 const {record:r,plan}=saved;
 contextCheck(r.subject===owner.subject&&r.account===owner.account&&r.threadId===owner.threadId,'owner');
 contextCheck(r.operationId===input.operationId&&r.headHash===input.planHash,'head');
 contextCheck(r.state==='draft','state');contextCheck(now<r.expiresAt,'expired');
 family(plan);
 contextCheck(id(plan.binding.documentId),'invalid');return saved;
}
export function checkInitialEvidence(saved,snapshot){requireDraftEvidence(saved.plan,snapshot);return snapshot;}
export function contextRights(documentId,metadata){
 const rights=writerResources('content',{documentId,contextIds:metadata.map(m=>m.id)});
 // Actual rights, not a hypothetical maximum graph, must fit future C1 facts.
 canonicalWriterGrants(rights.map(r=>({...r,grantKind:'grant'})));
 contextCheck(bytes({resources:rights})<=WRITER_LIMITS.recordBytes,'budget');return rights;
}
export function contextObservation(raw,requested,{folder=false,driveId=null}={}){
 contextCheck(object(raw)&&object(raw.document)&&/^[a-f0-9]{64}$/.test(raw.responseDigest),'corrupt');
 contextCheck(Number.isSafeInteger(raw.responseBytes)&&raw.responseBytes>0&&raw.responseBytes<=CONTEXT_LIMITS.responseBytes,'budget');
 boundedTree(raw.document,{...LIMITS,providerBytes:CONTEXT_LIMITS.responseBytes,nodes:10000,depth:16});
 contextCheck(bytes(raw.document)<=raw.responseBytes,'corrupt');
 const m=raw.document;
 contextCheck(id(m.id)&&(requested==='root'||m.id===requested),'metadata');
 contextCheck(m.trashed===false&&m.mimeType===(folder?'application/vnd.google-apps.folder':'application/vnd.google-apps.document'),'metadata');
 contextCheck(m.driveId===undefined||id(m.driveId),'metadata');
 contextCheck((m.driveId??null)===driveId,'metadata');
 if(m.parents!==undefined){
  contextCheck(Array.isArray(m.parents)&&m.parents.length<=1&&m.parents.every(id)&&new Set(m.parents).size===m.parents.length,'parents');
  contextCheck(!m.parents.includes(m.id),'cycle');
 }
 targetMarker(m); // malformed/ambiguous declarations must not become unmarked
 return immutable({metadata:m,responseDigest:raw.responseDigest,responseBytes:raw.responseBytes});
}
export function markerKeysFor(observations){return [...new Set(observations.map(o=>targetMarker(o.metadata)?.key).filter(Boolean))].sort();}
function decode(value){try{return JSON.parse(value);}catch{throw contextError('corrupt');}}
export function interpretLocalContext(raw,rights,observations,ownedExecution=null){
 contextCheck(raw?.version===1&&Array.isArray(raw.owners)&&Array.isArray(raw.legacy)&&Array.isArray(raw.markers),'corrupt');
 const {capturedBytes,digest,...body}=raw;
 contextCheck(digest===writerDigest(body)&&Number.isSafeInteger(capturedBytes)&&capturedBytes>=0&&capturedBytes<=CONTEXT_LIMITS.localBytes,'corrupt');
 contextCheck(bytes(raw)<=CONTEXT_LIMITS.localBytes+65536,'budget');
 contextCheck(raw.owners.length<=WRITER_LIMITS.owners&&raw.legacy.length<=WRITER_LIMITS.legacyRows&&raw.markers.length<=WRITER_LIMITS.resourcesPerOwner,'budget');
 contextCheck(JSON.stringify(raw.resourceIds)===JSON.stringify([...new Set(rights.map(r=>r.id))].sort()),'corrupt');
 contextCheck(JSON.stringify(raw.markers.map(m=>m.key))===JSON.stringify(markerKeysFor(observations)),'corrupt');
 const blockers=[],seen=new Set();
 function consider(namespace,key,subject,resources,source){
  const conflicting=resources.filter(resource=>resourcesConflict(rights,[resource]));
  if(!conflicting.length)return;
  const ownerDigest=writerDigest({namespace,key,subject}),unique=writerDigest({ownerDigest,source,resources:conflicting});
  if(!seen.has(unique)){seen.add(unique);blockers.push({namespace,ownerDigest,source,resources:conflicting});}
 }
 for(const row of raw.owners){
  const initial=decode(row.initial_record),record=decode(row.record);validateWriter(initial);validateWriter(record);
  contextCheck(initial.sequence===0&&record.namespace===row.namespace&&record.operationId===row.key&&record.subject===row.subject,'corrupt');
  contextCheck(initial.namespace===row.namespace&&initial.operationId===row.key&&initial.subject===row.subject,'corrupt');
  contextCheck(Array.isArray(row.events)&&row.events.length<=WRITER_LIMITS.eventsPerOwner,'corrupt');
  let replay=initial;
  row.events.forEach((e,index)=>{contextCheck(e.sequence===index+1&&Buffer.byteLength(e.event)<=WRITER_LIMITS.eventBytes,'corrupt');replay=nextWriterFact(replay,decode(e.event));});
  contextCheck(writerDigest(record)===row.digest&&writerDigest(replay)===row.digest,'corrupt');assertWriterGrants(record.grants,row.resources);
  const owned=ownedExecution&&row.namespace==='semantic'&&row.key===ownedExecution.operationId;
  if(owned)contextCheck(row.subject===ownedExecution.subject&&record.semanticHeaderDigest===ownedExecution.headerDigest,'corrupt');
  else consider(row.namespace,row.key,row.subject,row.resources,'physicalRights');
  if(record.disposition==='held')for(const known of [...new Set([record.createdId,...record.observedIds].filter(Boolean))]){
   consider(row.namespace,row.key,row.subject,[{id:known,role:'contentWrite'},{id:known,role:'accessStable'}],'heldKnownId');
  }
 }
 for(const row of raw.legacy)consider(row.namespace,row.key,row.subject,legacyWriterResources(row),'legacyFacts');
 const origins=observations.map(({metadata})=>{
  const marker=targetMarker(metadata);
  if(!marker)return {id:metadata.id,kind:'unmarked',origin:'unresolved'};
  const snapshot=raw.markers.find(s=>s.key===marker.key);contextCheck(snapshot,'corrupt');
  let decision;
  try{decision=classifyWriterMarker(metadata,snapshot);}catch(error){if(error.writerCode!=='marker_missing')throw error;decision={kind:'missingLocalMarker'};}
  return {id:metadata.id,marker:marker.marker,kind:decision.kind,origin:'unresolved',scope:decision.kind==='historicalMarker'?'legacyOnly':'observationOnly'};
 });
 return immutable({captureDigest:digest,counts:{owners:raw.owners.length,legacy:raw.legacy.length,markers:raw.markers.length},blockers,origins});
}
export function contextResult(saved,ancestry,observations,rights,local,capturedAt){
 const p=saved.plan,r=saved.record;
 const result={version:1,kind:family(saved.plan).contextKind,ephemeral:true,
  binding:{operationId:r.operationId,headHash:r.headHash,subject:r.subject,account:r.account,threadId:r.threadId,documentId:p.binding.documentId,snapshotId:r.snapshotId,initialRevision:p.binding.revision,initialEvidenceDigest:p.binding.evidenceDigest},
  initialEvidence:'validatedDraftPin',currentDocsRevision:'notObserved',ancestry,observations,resources:rights,
  origin:{observations:local.origins,policy:'unresolved'},localCoordination:{capturedAt,digest:local.captureDigest,counts:local.counts,blockers:local.blockers},
  missingPrerequisites:[...ancestry.status!=='observed'?['ancestryBoundary']:[], 'semanticOriginPolicy','completeLegacyContextFacts','allFamilyMarkerAssociation','historicalCopySourceAndIntegrity','taskChildOwnership','sealAndExecutionEvidence','authorityDispatch','independentExecutionVerification','processDeathProof'],
  guarantees:{atomicWithGoogle:false,lease:false,validAfterReturn:false},claim:'none',seal:'absent',approval:'notRequested',execution:'notImplemented',thisCall:{providerMutationCount:0}};
 contextCheck(bytes(result)<=CONTEXT_LIMITS.resultBytes,'budget');return immutable(result);
}
