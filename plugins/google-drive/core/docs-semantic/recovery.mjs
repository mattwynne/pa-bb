// Closed K6 read-only recovery. No lifecycle transition, compiler or write port.
import {createHash} from 'node:crypto';
import {historicalKeyValid,catalogHandle,parseCatalogHandle,CATALOG_NAMESPACES} from './draft-catalog.mjs';
import {draftHash,immutable,validateSaved} from './draft-policy.mjs';
import {validateSeal,checkSealLineage} from './seal-policy.mjs';
import {family} from './family.mjs';
import {runtimeResult} from './execution-policy.mjs';
import {formatSchema,formattingReadbackMatches,inspectFormatting,inspectPageDocument} from '../docs-format.mjs';
import {imageSchema,imageReadback,inspectImages} from '../docs-image.mjs';
import {docsCreationReadbackMatches} from '../docs-create.mjs';
import {copyReadbackMatches} from '../copy.mjs';
import {readCopySourceBinding} from '../copy-source-binding.mjs';
import {writerDigest,validateWriter} from './writer-coordination.mjs';
export const RECOVERY_KINDS=Object.freeze([...CATALOG_NAMESPACES,...['document','spreadsheet','copy','upload'].map(k=>`docs_creations:${k}`)]);
const textHash=x=>createHash('sha256').update(x).digest('hex');
const legacyHash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const resource=x=>typeof x==='string'&&/^[\w-]{1,256}$/.test(x);
const lifecycle=new Set(['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','approval_unavailable','approval_required','stale','unverified','conflict','preparing','interrupted','partial','reserved','created','incomplete','not_created','verification_unavailable','mismatch','published','planning','draft','sealed']);
const editStates=new Set(['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','approval_unavailable','approval_required']);
const accessStates=new Set(['proposed','reviewing','writing','uncertain','verified','not_submitted','expired','declined','cancelled']);
const nativeStates=new Set(['reserved','created','verified','incomplete','not_created','uncertain','verification_unavailable']);
const legacyStates={drive_formatting_operations:editStates,docs_image_operations:editStates,drive_sharing_operations:new Set(['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','stale']),drive_sheets_edits:new Set([...editStates,'unverified','conflict']),drive_filing_operations:new Set(['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','stale','preparing','interrupted','partial'])};
const factKeys=['createdAt','copyBindingVersion','sourceId','mimeType','state','outcome','kind','version','schemaVersion','sharedVersion','claimState','writeAttempted','acknowledged','providerAcknowledged','createAcknowledged','populateAcknowledged','appliedRevision','documentId','spreadsheetId','fileId','objectId','requestHash','titleHash','textHash','contentHash','beforeHash','afterHash','before','destinationFingerprint'];
const fields=p=>Object.fromEntries(factKeys.filter(k=>Object.hasOwn(p,k)&&(p[k]===null||typeof p[k]==='boolean'||Number.isSafeInteger(p[k])||typeof p[k]==='string'&&p[k].length<=(k==='appliedRevision'?2048:256))).map(k=>[k,p[k]]));
function request(input){
 if(!object(input)||typeof input.account!=='string'||!input.account.length||input.account.length>320)throw new Error('Invalid recovery request');
 if(Object.hasOwn(input,'recoveryHandle')){
  if(Object.keys(input).some(k=>!['account','recoveryHandle'].includes(k)))throw new Error('Invalid recovery request');
  return {...parseCatalogHandle(input.recoveryHandle),handle:true};
 }
 if(Object.keys(input).some(k=>!['account','operationId','receiptKind'].includes(k))||!historicalKeyValid(input.operationId)||input.receiptKind!==undefined&&!RECOVERY_KINDS.includes(input.receiptKind))throw new Error('Invalid recovery request');
 return {operationId:input.operationId,receiptKind:input.receiptKind};
}
export function decodeRecoveryRow(row,semanticLocal,account){
 let p=null,codec='unsupported',reason='corrupt',writerFacts;
 try{
  p=JSON.parse(row.receipt);if(!CATALOG_NAMESPACES.includes(row.namespace)||!historicalKeyValid(row.operationId)||!object(p)||p.subject!==row.subject||p.operationId!==row.operationId)throw 0;
  // Presence declares the copy codec, even with missing/wrong kind or null data.
  // Apply the existing no-downgrade guard BEFORE any family/default-kind branch.
  if(Object.hasOwn(p,'copyBindingVersion')||Object.hasOwn(p,'copySource'))readCopySourceBinding(p);
  if(row.writer){const current=JSON.parse(row.writer.record),initial=JSON.parse(row.writer.initial_record);validateWriter(current);validateWriter(initial);if(!object(current)||!object(initial)||[current,initial].some(w=>w.version!==1||w.namespace!==row.namespace||w.operationId!==row.operationId||w.subject!==row.subject)||writerDigest(current)!==row.writer.digest)throw 0;writerFacts=Object.fromEntries(['version','phase','disposition','submission','acknowledgement','createAcknowledged','createdId','legacyVerified'].map(k=>[k,current[k]]));}
  if(['version','schemaVersion'].some(k=>Object.hasOwn(p,k)&&p[k]!==1)){reason='version';throw 0;}
  if(Object.hasOwn(p,'createdAt')&&p.createdAt!==null&&(!Number.isSafeInteger(p.createdAt)||p.createdAt<0))throw 0;
  if(['requestHash','titleHash','textHash','contentHash','beforeHash','afterHash','destinationFingerprint'].some(k=>Object.hasOwn(p,k)&&!hash(p[k])))throw 0;
  if(['writeAttempted','acknowledged','providerAcknowledged','createAcknowledged','populateAcknowledged'].some(k=>Object.hasOwn(p,k)&&p[k]!==null&&typeof p[k]!=='boolean'))throw 0;
  if(row.namespace==='semantic'){
   if(!hash(row.draftDigest)||draftHash(p)!==row.draftDigest||!semanticLocal||draftHash(semanticLocal.draft)!==draftHash(p))throw 0;
   validateSaved({record:semanticLocal.draft,plan:semanticLocal.plan});
   if(row.execution){if(!hash(row.execution.digest)||!hash(row.execution.record_digest))throw 0;const header=JSON.parse(row.execution.header),runtime=JSON.parse(row.execution.record);if(header.subject!==row.subject||header.operationId!==row.operationId||draftHash(header)!==row.execution.digest||draftHash(runtime)!==row.execution.record_digest||![1,2].includes(runtime.version)||!lifecycle.has(runtime.status))throw 0;validateSeal(semanticLocal.saved);if(draftHash(semanticLocal.saved.header)!==draftHash(header)||draftHash(semanticLocal.saved.record)!==draftHash(runtime))throw 0;checkSealLineage(semanticLocal.saved,{record:semanticLocal.draft,plan:semanticLocal.plan},semanticLocal.before);codec=runtime.version===2?'semantic-execution-v2':'semantic-seal-v1';}
   else {if(!lifecycle.has(p.state))throw 0;codec='semantic-draft-v1';}
  }else if(row.namespace==='docs_creations'){
   const kind=Object.hasOwn(p,'kind')?p.kind:'document';if(!['document','spreadsheet','copy','upload'].includes(kind)||p.sharedVersion!==undefined&&p.sharedVersion!==1)throw 0;
   const outcomes=kind==='copy'?new Set(['reserved','uncertain','verified','mismatch','not_created','verification_unavailable']):p.sharedVersion===1||kind==='upload'?new Set([...nativeStates,...accessStates]):nativeStates;
   if(!hash(p.requestHash)||!outcomes.has(p.outcome)||p.sharedVersion===1&&!['document','spreadsheet'].includes(kind)||kind==='copy'&&p.copyBindingVersion!==undefined&&p.copyBindingVersion!==1||kind==='upload'&&!['binary','xlsx_to_sheet','docx_to_doc','pptx_to_slides'].includes(p.mode))throw 0;
   for(const k of ['documentId','spreadsheetId','fileId','destinationId'])if(Object.hasOwn(p,k)&&!resource(p[k]))throw 0;
   if((p.sharedVersion===1||kind==='upload')&&!accessStates.has(p.claimState))throw 0;
   if(kind==='copy')readCopySourceBinding(p);
   const id=p[kind==='document'?'documentId':kind==='spreadsheet'?'spreadsheetId':'fileId'];if(['created','verified','incomplete','mismatch','verification_unavailable'].includes(p.outcome)&&!resource(id))throw 0;
   codec=`legacy-creation-${kind}${p.sharedVersion===1?'-shared1':'-private1'}`;
  }else{
   if(!legacyStates[row.namespace]?.has(row.state)||p.state!==undefined&&!legacyStates[row.namespace].has(p.state)||p.sharedVersion!==undefined)throw 0;
   const id=row.namespace==='drive_sheets_edits'?p.spreadsheetId:['docs_image_operations','drive_formatting_operations'].includes(row.namespace)?p.documentId:row.namespace==='drive_sharing_operations'?p.fileId:p.resource;
   if(id!==row.resource||typeof id!=='string'||!id.length||id.length>512||row.namespace!=='drive_filing_operations'&&!resource(id)||row.namespace==='drive_filing_operations'&&!['move','folder','task'].includes(p.kind))throw 0;
   if(['drive_formatting_operations','docs_image_operations'].includes(row.namespace)&&(!editStates.has(row.state)||p.state!==undefined&&!editStates.has(p.state)))throw 0;
   if(row.namespace==='drive_formatting_operations'&&Object.hasOwn(p,'expected')&&!validFormatEvidence(p,account))throw 0;
   if(row.namespace==='docs_image_operations'&&(Object.hasOwn(p,'beforeDocument')||Object.hasOwn(p,'objectId')||Object.hasOwn(p,'appliedRevision'))&&!validImageEvidence(p,account))throw 0;
   codec=row.namespace==='drive_formatting_operations'?'legacy-format-v1':row.namespace==='docs_image_operations'?'legacy-image-v1':`legacy-${row.namespace}-metadata1`;
  }
 }catch{codec='unsupported';}
 const kind=codec!=='unsupported'&&row.namespace==='docs_creations'&&object(p)&&p.subject===row.subject&&p.operationId===row.operationId&&['document','spreadsheet','copy','upload'].includes(p.kind??'document')?p.kind??'document':null;
 const legacyFacts={sql:{state:row.state,resource:row.resource},...(writerFacts?{writer:writerFacts}:{}),json:p&&object(p)&&p.subject===row.subject?fields(p):{}};
 const status=codec==='unsupported'?'unsupported':row.namespace==='docs_creations'?p.outcome:row.namespace==='semantic'?(row.execution?JSON.parse(row.execution.record).status:p.state):row.state;
 const candidate={receiptKind:kind?`docs_creations:${kind}`:row.namespace,recoveryHandle:catalogHandle(row.namespace,row.operationId),createdAt:codec!=='unsupported'&&Number.isSafeInteger(p?.createdAt)&&p.createdAt>=0?p.createdAt:null,status:status??'unsupported',historicalEvidenceVersion:codec,supported:codec!=='unsupported'};
 return {row,p,codec,reason,kind,candidate,legacyFacts};
}
function validFormatEvidence(p,account){
 try{
  if(!object(p.request)||p.request.document!==p.documentId||p.request.operationId!==p.operationId||p.requestHash!==legacyHash(p.request)||!hash(p.before)||!object(p.expected)||Object.hasOwn(p.expected,'revisionId')||Buffer.byteLength(JSON.stringify(p.expected))>1048576||!resource(p.documentId)||!formatSchema.safeParse({...p.request,account,preview:true}).success)return false;
  if(Object.hasOwn(p,'pageOnly')&&typeof p.pageOnly!=='boolean'||p.pageOnly===true&&(!p.request.page||p.request.ranges?.length!==0)||p.pageOnly!==true&&!p.request.ranges?.length)return false;
  const raw=structuredClone(p.expected);raw.revisionId=p.request.expectedRevisionId;
  if(p.pageOnly===true)inspectPageDocument(raw,p.documentId);
  else {
   function visit(nodes){for(const tab of nodes){for(const item of tab.documentTab.body.content){if(!item.paragraph)continue;let index=item.startIndex;item.paragraph.elements=item.paragraph.elements.map(run=>{if(!object(run)||Object.keys(run).some(k=>!['text','style'].includes(k))||typeof run.text!=='string'||!object(run.style))throw 0;const start=index;index+=run.text.length;return {startIndex:start,endIndex:index,textRun:{content:run.text,textStyle:run.style}};});if(index!==item.endIndex)throw 0;}if(tab.childTabs)visit(tab.childTabs);}}
   visit(raw.tabs);inspectFormatting(raw,p.documentId);
  }
  return formattingReadbackMatches(raw,p);
 }catch{return false;}
}
function validImageEvidence(p,account){
 try{
  if(!object(p.request)||p.request.document!==p.documentId||p.request.operationId!==p.operationId||p.requestHash!==legacyHash(p.request)||!object(p.beforeDocument)||Object.hasOwn(p.beforeDocument,'revisionId')||p.before!==legacyHash(p.beforeDocument)||!object(p.proposal)||!Number.isFinite(p.proposal.heightPt)||p.proposal.heightPt<1||p.proposal.heightPt>648||!resource(p.documentId)||!imageSchema.safeParse({...p.request,account,preview:true}).success)return false;
  const uri=new URL(p.request.uri);
  if(uri.href!==p.request.uri||uri.protocol!=='https:'||uri.port||uri.username||uri.password||uri.search||uri.hash||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(uri.hostname))return false;
  const asset=p.proposal.asset;
  if(!object(asset)||asset.mimeType!=='image/png'||!Number.isInteger(asset.width)||!Number.isInteger(asset.height)||asset.width<1||asset.height<1||asset.width>8192||asset.height>8192||asset.width*asset.height>4000000||!Number.isInteger(asset.bytes)||asset.bytes<1||asset.bytes>2097152||!hash(asset.sha256)||p.proposal.heightPt!==p.request.widthPt*asset.height/asset.width)return false;
  const revision=typeof p.appliedRevision==='string'&&p.appliedRevision.length>0&&p.appliedRevision.length<=2048,objectId=typeof p.objectId==='string'&&p.objectId.length>0&&p.objectId.length<=256;
  if(p.appliedRevision!=null&&!revision||p.objectId!=null&&!objectId||revision!==objectId)return false;
  if(p.proposal.documentId!==p.request.document)return false;
  for(const k of ['tabId','index','uri','widthPt','expectedRevisionId'])if(p.proposal[k]!==p.request[k])return false;
  const raw=structuredClone(p.beforeDocument);raw.revisionId=p.request.expectedRevisionId;
  const inspected=inspectImages(raw,p.documentId);return inspected.tabs.find(t=>t.tabId===p.request.tabId)?.paragraphs.some(t=>t.index===p.request.index)===true;
 }catch{return false;}
}
function legacyObserver(c,account){
 const p=c.p;
 if(c.codec==='legacy-creation-document-private1'&&hash(p.requestHash)&&resource(p.documentId)&&resource(p.destinationId)&&hash(p.titleHash)&&hash(p.textHash))return {
  documentId:p.documentId,metadataMatches:f=>f.parents?.length===1&&f.parents[0]===p.destinationId&&typeof f.name==='string'&&textHash(f.name)===p.titleHash,
  compare:doc=>docsCreationReadbackMatches(doc,p),scope:'legacy-document-title-text-hashes-and-destination; no inferred-populate-ACK'
 };
 if(c.codec==='legacy-creation-copy-private1'&&hash(p.requestHash)&&resource(p.fileId)&&resource(p.destinationId)&&typeof p.mimeType==='string'&&p.mimeType.length<=255&&hash(p.titleHash)){
  try{readCopySourceBinding(p);}catch{return null;}
  return {documentId:p.fileId,mimeType:p.mimeType,metadataOnly:true,metadataMatches:f=>copyReadbackMatches(f,p,p.fileId),scope:'copy-id-MIME-title-destination-marker; not content or access equivalence'};
 }
 if(c.codec==='legacy-format-v1'){
  if(!validFormatEvidence(p,account))return null;
  return {documentId:p.documentId,compare:doc=>{(p.pageOnly===true?inspectPageDocument:inspectFormatting)(doc,p.documentId);return formattingReadbackMatches(doc,p);},savedRevision:p.appliedRevision,scope:p.pageOnly===true?'page-and-structured-preservation':'format-and-preservation'};
 }
 if(c.codec==='legacy-image-v1'){
  if(!validImageEvidence(p,account))return null;
  return {documentId:p.documentId,compare:doc=>{inspectImages(doc,p.documentId);return imageReadback(doc,p).matches;},savedRevision:typeof p.objectId==='string'?p.appliedRevision:null,scope:'image-location-sourceURI-dimensions-and-preservation; not bytes/rendering/alt-text'};
 }
 return null;
}
function k4StageFacts(historical){
 const stage={...historical.stage},response=historical.response;
 // The native persisted stage is closed and deliberately contains no response
 // fields. Project ONLY its validated attributable response into the K4 DTO.
 if(stage.submission==='acknowledged'&&response?.kind==='acknowledged'){
  stage.dispatchObserved=true;
  stage.acknowledgement={documentId:response.documentId,revisionId:response.revisionId,replyDigest:response.replyDigest};
  stage.collaborationSave=response.save==='UNKNOWN'?'UNSPECIFIED':response.save;
 }else if(stage.submission==='rejected'&&response?.kind==='rejected'){
  stage.dispatchObserved=true;
  stage.rejection={httpStatus:response.httpStatus,category:'provider_rejected'};
 }
 return stage;
}
export function createRecoveryService({store,reads,clock=Date.now,diagnose=()=>{}}){
 const warn=(stage,category)=>{try{diagnose(stage,category);}catch{/* diagnostics do not alter facts */}};
 async function status(input,context){
  const selected=request(input),account=await store.byEmail(input.account),call={providerMutationCount:0};
  const empty=state=>immutable({status:state,candidates:[],thisCall:call,retrySafe:false});
  if(!account||typeof account.subject!=='string'||!account.subject.length||typeof account.email!=='string'||!account.email.length)return empty('unknown');
  // ALL namespaces before choosing a verifier or making an authentication GET.
  const raw=store.discover(account.subject,selected.operationId);
  if(raw.length>7||raw.some(row=>row.subject!==account.subject))return empty('unknown');
  const resolved=await store.byEmail(input.account);
  if(!resolved||resolved.subject!==account.subject||resolved.email!==account.email)return empty('unknown');
  const all=raw.map(row=>{
   let local;
   if(row.namespace==='semantic'&&typeof row.receipt==='string'&&hash(row.draftDigest)&&(!row.execution||typeof row.execution.header==='string'&&typeof row.execution.record==='string'&&hash(row.execution.digest)&&hash(row.execution.record_digest)))try{local=store.semanticEvidence({subject:account.subject,account:account.email,threadId:context.threadId},selected.operationId);}catch{/* retained unsupported local history */}
   return {...decodeRecoveryRow(row,local,account.email),local};
  });
  if(draftHash(store.discover(account.subject,selected.operationId))!==draftHash(raw))return immutable({status:'changedDuringObservation',observation:{kind:'changedDuringObservation',attribution:'invalidated'},thisCall:call,retrySafe:false});
  const eligible=all.filter(c=>selected.handle?c.row.namespace===selected.namespace:selected.receiptKind?c.row.namespace===selected.receiptKind||c.candidate.receiptKind===selected.receiptKind||c.row.namespace==='docs_creations'&&!c.kind&&selected.receiptKind.startsWith('docs_creations:'):true);
  if(!eligible.length)return empty('unknown');
  if(eligible.length>1)return immutable({status:'ambiguous',candidates:eligible.map(c=>c.candidate),thisCall:call,retrySafe:false});
  const c=eligible[0],base={operationId:selected.operationId,receiptKind:c.candidate.receiptKind,status:c.candidate.status,createdAt:c.candidate.createdAt,claim:'retainedUnknown',historicalEvidenceVersion:c.codec,legacyFacts:c.legacyFacts,thisCall:call,retrySafe:false};
  let observer,evidence;
  if(c.codec==='semantic-draft-v1'){base.claim=c.row.writer?'retainedUnknown':'none';base.legacyFacts.semantic={originThreadId:c.local.draft.threadId,status:c.local.draft.state};}
  if(c.codec==='semantic-execution-v2'||c.codec==='semantic-seal-v1'){
   try{
    evidence=c.local;
    if(!evidence||![1,2].includes(evidence.saved.record.version))throw 0;
    base.legacyFacts.semantic={runtimeVersion:evidence.saved.record.version,originThreadId:evidence.saved.header.threadId,status:evidence.saved.record.status,claim:evidence.saved.record.claim};
    if(evidence.saved.record.version===1){base.status=evidence.saved.record.status;base.claim=evidence.saved.record.claim;}
    else {
    const historical=runtimeResult(evidence.saved,0);Object.assign(base,{status:historical.state,claim:historical.claim,stages:[k4StageFacts(historical)],submission:historical.submission,response:historical.response});
    const profile=family(evidence.plan);observer={documentId:evidence.saved.header.documentId,compare:doc=>profile.compare({plan:evidence.plan,before:evidence.before,after:doc}).matched,savedRevision:historical.submission==='acknowledged'&&historical.response?.kind==='acknowledged'?historical.response.revisionId:null,scope:profile.kind};
    }
   }catch{base.status='unsupported';base.historicalEvidenceVersion='semantic-execution-unsupported';warn('decode','unsupported');}
  }else if(c.codec!=='unsupported')observer=legacyObserver(c,account.email);
  const finish=observation=>immutable(observation.kind==='changedDuringObservation'?{operationId:selected.operationId,status:'changedDuringObservation',observation,thisCall:call,retrySafe:false}:{...base,observation});
  if(!observer){if(c.codec==='unsupported')warn('decode','unsupported');return finish({kind:'unsupported',reason:c.codec==='unsupported'?c.reason:'missing_supported_observation_evidence'});}
  const before=draftHash(raw),accountBefore=draftHash(account),evidenceBefore=evidence?draftHash(evidence):null;
  async function unchanged(){
   const current=await store.byEmail(input.account);if(!current||draftHash(current)!==accountBefore||draftHash(store.discover(account.subject,selected.operationId))!==before)return false;
   if(evidenceBefore&&draftHash(store.semanticEvidence({subject:account.subject,account:account.email,threadId:context.threadId},selected.operationId))!==evidenceBefore)return false;
   return true;
  }
  let observation={kind:'unavailable'},stage='credential';
  const credential=()=>{context.signal?.throwIfAborted();if(typeof account.accessToken!=='string'||!account.accessToken||!Number.isFinite(account.expiresAt)||account.expiresAt<=clock()+60000)throw 0;};
  try{
   context.signal?.throwIfAborted();
   if(!await unchanged())return finish({kind:'changedDuringObservation',attribution:'invalidated'});
   credential();
   stage='identity';const info=await reads.identity(account.accessToken,context.signal);
   if(info?.sub!==account.subject||info?.email!==account.email||info?.email_verified!==true)throw 0;
   if(!await unchanged())return finish({kind:'changedDuringObservation',attribution:'invalidated'});
   stage='credential';credential();
   stage='metadata';const metadata=await reads.metadata(account.accessToken,observer.documentId,context.signal);
   if(metadata?.id!==observer.documentId||metadata.trashed!==false||metadata.mimeType!==(observer.mimeType??'application/vnd.google-apps.document')||metadata.driveId!==undefined)throw 0;
   if(!await unchanged())return finish({kind:'changedDuringObservation',attribution:'invalidated'});
   stage='credential';credential();
   stage='document';const document=observer.metadataOnly?null:await reads.document(account.accessToken,observer.documentId,context.signal);
   stage='credential';credential();
   stage='comparison';const matches=(!observer.metadataMatches||observer.metadataMatches(metadata))&&(observer.metadataOnly||observer.compare(document));
   observation={kind:matches?'observed_matching':'observed_mismatch',savedRevisionMatch:typeof observer.savedRevision==='string'&&observer.savedRevision.length>0&&document?.revisionId===observer.savedRevision,attribution:'notEstablished',scope:observer.scope};
  }catch{warn(stage,'unavailable');}
  try{if(!await unchanged())observation={kind:'changedDuringObservation',attribution:'invalidated'};}catch{observation={kind:'changedDuringObservation',attribution:'invalidated'};}
  return finish(observation);
 }
 return Object.freeze({status});
}
