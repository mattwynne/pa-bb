// Purpose-specific local coordination, not a dispatcher or remote lock. Legacy
// evidence remains versioned: only explicit newly observed events add facts.
import {boundedTree,LIMITS,freeze,digest} from './common.mjs';
const immutable=value=>freeze(structuredClone(value));
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
export const WRITER_LIMITS=Object.freeze({version:1,owners:1024,totalBytes:8*1024*1024,recordBytes:65536,eventBytes:4096,eventsPerOwner:16,resourcesPerOwner:32,reservedBytes:262144,legacyRows:1024,legacyBytes:4*1024*1024});
export const WRITER_NAMESPACES=Object.freeze(['legacyReplacement','drive_formatting_operations','docs_image_operations','docs_creations','drive_sheets_edits','drive_sharing_operations','drive_filing_operations']);
const roles=['contentWrite','accessStable','accessMutation','uploadName'];
const grantOrder=(a,b)=>Buffer.compare(Buffer.from(a.id,'utf8'),Buffer.from(b.id,'utf8'))||Buffer.compare(Buffer.from(a.role,'utf8'),Buffer.from(b.role,'utf8'));
export const writerError=code=>Object.assign(new Error(`Writer coordination ${code}`),{writerCode:code});
export function writerCheck(c,code='invalid'){if(!c)throw writerError(code);}
const token=v=>typeof v==='string'&&v.length>0&&v.length<=256&&/^[\w-]+$/.test(v);
const key=v=>typeof v==='string'&&v.length>0&&v.length<=128;
const stableIds=(op)=>{const ids=op.contextIds??[];writerCheck(Array.isArray(ids)&&ids.length<=WRITER_LIMITS.resourcesPerOwner&&ids.every(token));return ids;};
export function writerResources(kind,op){
 writerCheck(op&&typeof op==='object');
 // The task parent is only an orchestration marker; each real child claims its own inspected resources.
 if(kind==='filing'&&op.kind==='task'){writerCheck(op.resource===`task:${op.operationId}`);return immutable([]);}
 // Historical identity-only copy tombstones cannot dispatch and declare no resource rights.
 if(kind==='copy'&&!['sourceId','destinationId','fileId','contextIds'].some(k=>Object.hasOwn(op,k)))return immutable([]);
 if(kind==='filing')kind=op.kind==='folder'||op.resource?.startsWith('folder:')?'folder':'move';const entries=[];
 const add=(id,role)=>{writerCheck(token(id));entries.push({id,role});};
 const file=op.documentId??op.spreadsheetId??op.fileId;
 if(['content','replacement'].includes(kind)){add(file,'contentWrite');add(file,'accessStable');}
 else if(kind==='sharing')add(op.fileId,'accessMutation');
 else if(kind==='move'){add(op.fileId??(op.resource?.startsWith('file:')?op.resource.slice(5):null),'accessMutation');}
 else if(['nativeCreate','upload','copy','folder'].includes(kind)){
  if(file){add(file,'accessStable');if(kind!=='copy')add(file,'contentWrite');}
  if(kind==='copy'&&op.sourceId)add(op.sourceId,'accessStable');
  if(op.destinationId??op.parentId)add(op.destinationId??op.parentId,'accessStable');
  if(kind==='upload'&&op.resource){writerCheck(typeof op.resource==='string'&&op.resource.length<=512);entries.push({id:op.resource,role:'uploadName'});}
 }else throw writerError('unsupported');
 for(const id of stableIds(op))add(id,'accessStable');
 const result=[...new Map(entries.map(r=>[`${r.id}\0${r.role}`,r])).values()].sort(grantOrder);
 writerCheck(result.length>0&&result.length<=WRITER_LIMITS.resourcesPerOwner,'capacity');return immutable(result);
}
// Full, closed grant commitments: IDs, roles and grant disposition include every
// ancestry right. Canonical facts fit the existing event cap or fail admission.
export function canonicalWriterGrants(input){
 writerCheck(Array.isArray(input)&&input.length<=WRITER_LIMITS.resourcesPerOwner,'capacity');
 const result=input.map(g=>{writerCheck(g&&Object.keys(g).length===3&&['id','role','grantKind'].every(k=>Object.hasOwn(g,k))&&roles.includes(g.role)&&['grant','pending'].includes(g.grantKind),'corrupt');writerCheck(g.role==='uploadName'?typeof g.id==='string'&&g.id.length>0&&g.id.length<=512&&!/[\p{Cc}\p{Cs}]/u.test(g.id):token(g.id),'corrupt');return {id:g.id,role:g.role,grantKind:g.grantKind};}).sort(grantOrder);
 writerCheck(new Set(result.map(g=>JSON.stringify([g.id,g.role]))).size===result.length,'corrupt');
 writerCheck(Buffer.byteLength(JSON.stringify({kind:'grants',resources:result}))<=WRITER_LIMITS.eventBytes,'capacity');return immutable(result);
}
export function extendWriterGrants(prior,requested,grantKind='grant'){
 const all=new Map(canonicalWriterGrants(prior).map(g=>[JSON.stringify([g.id,g.role]),g]));
 for(const r of requested){const k=JSON.stringify([r.id,r.role]),old=all.get(k);writerCheck(!old||old.grantKind===grantKind,'corrupt');if(!old)all.set(k,{id:r.id,role:r.role,grantKind});}return canonicalWriterGrants([...all.values()]);
}
export function assertWriterGrants(expected,actual){writerCheck(JSON.stringify(canonicalWriterGrants(expected))===JSON.stringify(expected)&&JSON.stringify(canonicalWriterGrants(actual))===JSON.stringify(expected),'corrupt');}
export function resourcePairConflict(a,b){writerCheck(roles.includes(a.role)&&roles.includes(b.role));if(a.id!==b.id)return false;if(a.role==='uploadName'||b.role==='uploadName')return a.role===b.role;return a.role==='accessMutation'||b.role==='accessMutation'||a.role==='contentWrite'&&b.role==='contentWrite';}
export const resourcesConflict=(a,b)=>a.some(x=>b.some(y=>resourcePairConflict(x,y)));
export function ownerRef(namespace,operationId){writerCheck(WRITER_NAMESPACES.includes(namespace)&&key(operationId));return `${namespace}/${operationId}`;}
export function writerOwner(namespace,op){
 ownerRef(namespace,op.operationId);writerCheck(['legacyReplacement','drive_formatting_operations','docs_image_operations','docs_creations'].includes(namespace),'unsupported');writerCheck(typeof op.subject==='string'&&op.subject.length>0&&op.subject.length<=320);
 const kind=namespace==='legacyReplacement'?'replacement':namespace==='docs_creations'?'nativeCreate':'content';
 const retainedUnknown=namespace==='docs_creations'&&(['writing','uncertain'].includes(op.claimState)||['reserved','created','incomplete','verification_unavailable','uncertain'].includes(op.outcome)&&Boolean(op.documentId??op.spreadsheetId??op.fileId));
 return immutable({version:1,namespace,operationId:op.operationId,subject:op.subject,kind,operationKind:namespace==='docs_creations'?(op.kind??'document'):namespace,phase:retainedUnknown?'uncertain':'claimed',disposition:'held',submission:retainedUnknown?'unknown':'not_sent',intentStage:null,acknowledgement:null,createAcknowledged:false,createdId:null,observedIds:retainedUnknown&&Boolean(op.documentId??op.spreadsheetId??op.fileId)?[op.documentId??op.spreadsheetId??op.fileId]:[],legacyVerified:false,blockedReason:null,evidence:namespace==='legacyReplacement'?(op.replacementEvidence??null):null,sequence:0,grants:canonicalWriterGrants(writerResources(kind,op).map(r=>({...r,grantKind:'grant'})))});
}
export function validateWriter(r){
 writerCheck(r&&r.version===1&&['legacyReplacement','drive_formatting_operations','docs_image_operations','docs_creations'].includes(r.namespace)&&key(r.operationId)&&typeof r.subject==='string','corrupt');
 const fields=['version','namespace','operationId','subject','kind','operationKind','phase','disposition','submission','intentStage','acknowledgement','createAcknowledged','createdId','observedIds','legacyVerified','blockedReason','evidence','sequence','grants'];
 writerCheck(Object.keys(r).length===fields.length&&fields.every(k=>Object.hasOwn(r,k)),'corrupt');
 writerCheck(['replacement','content','nativeCreate'].includes(r.kind)&&['claimed','intent','acknowledged','verified','not_sent','rejected','partial','uncertain'].includes(r.phase)&&['held','released'].includes(r.disposition)&&['not_sent','unknown','acknowledged','rejected'].includes(r.submission),'corrupt');
 writerCheck(Number.isSafeInteger(r.sequence)&&r.sequence>=0&&r.sequence<=WRITER_LIMITS.eventsPerOwner&&Array.isArray(r.observedIds)&&r.observedIds.length<=32&&r.observedIds.every(token),'corrupt');
 writerCheck(r.subject.length>0&&r.subject.length<=320&&r.kind===(r.namespace==='legacyReplacement'?'replacement':r.namespace==='docs_creations'?'nativeCreate':'content'),'corrupt');
 writerCheck(r.namespace==='docs_creations'?['document','spreadsheet'].includes(r.operationKind):r.operationKind===r.namespace,'corrupt');
 writerCheck(r.intentStage===null||['replace','content','create','populate'].includes(r.intentStage),'corrupt');
 writerCheck(r.createdId===null||token(r.createdId),'corrupt');writerCheck(typeof r.createAcknowledged==='boolean'&&typeof r.legacyVerified==='boolean','corrupt');
 if(r.acknowledgement!==null){const a=r.acknowledgement;writerCheck(a&&typeof a==='object'&&['replace','content','create','populate'].includes(a.stage)&&token(a.documentId)&&/^[a-f0-9]{64}$/.test(a.replyDigest),'corrupt');writerCheck(Object.keys(a).every(k=>['stage','documentId','replyDigest','revisionId'].includes(k)),'corrupt');if(a.stage!=='create')writerCheck(typeof a.revisionId==='string'&&a.revisionId.length>0&&a.revisionId.length<=2048,'corrupt');}
 writerCheck(!r.createAcknowledged||r.kind==='nativeCreate'&&token(r.createdId)&&r.acknowledgement?.stage==='create'&&r.acknowledgement.documentId===r.createdId,'corrupt');
 writerCheck(r.createdId===null||r.createAcknowledged,'corrupt');
 writerCheck(r.submission!=='acknowledged'||r.acknowledgement!==null,'corrupt');
 writerCheck(!r.legacyVerified||r.kind==='nativeCreate'&&r.createAcknowledged&&r.phase==='verified'&&r.disposition==='released','corrupt');
 writerCheck(r.disposition!=='released'||['verified','not_sent','rejected'].includes(r.phase),'corrupt');
 if(r.kind==='replacement'&&r.evidence!==null){const e=r.evidence;writerCheck(e&&e.version===1&&token(e.documentId)&&token(e.tabId)&&typeof e.expectedRevisionId==='string'&&e.expectedRevisionId.length>0&&e.expectedRevisionId.length<=2048&&e.verification==='legacy-all-tab-body-text-only'&&Array.isArray(e.expectedTabs)&&e.expectedTabs.length>0&&e.expectedTabs.every(t=>t&&token(t.tabId)&&/^[a-f0-9]{64}$/.test(t.textHash)),'corrupt');writerCheck(Object.keys(e).length===6&&new Set(e.expectedTabs.map(t=>t.tabId)).size===e.expectedTabs.length,'corrupt');}
 else writerCheck(r.evidence===null,'corrupt');
 assertWriterGrants(r.grants,r.grants);writerCheck(r.disposition==='released'?r.grants.length===0:r.grants.length>0,'corrupt');
 writerCheck(r.blockedReason===null||['resource_conflict','capacity','unsupported','corrupt','storage'].includes(r.blockedReason),'corrupt');
 boundedTree(r,{...LIMITS,providerBytes:WRITER_LIMITS.recordBytes,nodes:10000,depth:32});return r;
}
export function nextWriterFact(record,event){
 validateWriter(record);writerCheck(record.disposition==='held','terminal');writerCheck(event&&typeof event==='object','invalid');
 const fields={grants:['kind','resources'],intent:['kind','stage'],ack:['kind','stage','documentId','replyDigest'],observedId:['kind','id'],attachmentBlocked:['kind','id'],knownNotSent:['kind'],rejected:['kind','httpStatus'],verified:['kind'],legacyVerified:['kind'],stopped:['kind']};const required=fields[event.kind];writerCheck(required&&required.every(k=>Object.hasOwn(event,k))&&Object.keys(event).every(k=>required.includes(k)||event.kind==='ack'&&k==='revisionId'||event.kind==='attachmentBlocked'&&k==='reason'),'invalid');
 const r=structuredClone(record);r.sequence++;
 switch(event.kind){
 case 'grants':{const next=canonicalWriterGrants(event.resources);assertWriterGrants(next,event.resources);writerCheck(r.grants.every(old=>next.some(g=>g.id===old.id&&g.role===old.role&&g.grantKind===old.grantKind))&&next.length>r.grants.length,'transition');r.grants=next;break;}
 case 'intent':writerCheck((r.kind==='replacement'?['replace']:r.kind==='content'?['content']:['create']).includes(event.stage));writerCheck(r.phase==='claimed'||r.phase==='acknowledged'&&event.stage==='populate'&&r.createAcknowledged,'transition');r.intentStage=event.stage;r.phase='intent';r.submission='unknown';break;
 case 'ack':
  writerCheck(r.phase==='intent'&&event.stage===r.intentStage&&token(event.documentId)&&typeof event.replyDigest==='string'&&/^[a-f0-9]{64}$/.test(event.replyDigest),'transition');
  if(event.stage!=='create')writerCheck(typeof event.revisionId==='string'&&event.revisionId.length>0&&event.revisionId.length<=2048,'invalid');
  r.acknowledgement={stage:event.stage,documentId:event.documentId,replyDigest:event.replyDigest,...(event.revisionId?{revisionId:event.revisionId}:{})};r.phase='acknowledged';r.submission='acknowledged';if(event.stage==='create'){r.createdId=event.documentId;r.createAcknowledged=true;}break;
 case 'observedId':writerCheck(token(event.id)&&r.submission!=='not_sent','transition');r.observedIds=[...new Set([...r.observedIds,event.id])];break;
 case 'attachmentBlocked':writerCheck(token(event.id)&&(r.createdId===event.id||r.observedIds.includes(event.id)),'transition');r.blockedReason=event.reason??'resource_conflict';writerCheck(['resource_conflict','capacity','unsupported','corrupt','storage'].includes(r.blockedReason));r.observedIds=[...new Set([...r.observedIds,event.id])];r.phase=r.createAcknowledged?'partial':'uncertain';break;
 case 'knownNotSent':writerCheck(!r.createdId&&!r.createAcknowledged&&r.submission!=='acknowledged','transition');r.phase='not_sent';r.submission='not_sent';r.disposition='released';break;
 case 'rejected':writerCheck(r.phase==='intent'&&[400,401,403,404].includes(event.httpStatus),'transition');r.phase=r.createdId?'partial':'rejected';r.submission='rejected';if(!r.createdId)r.disposition='released';break;
 case 'verified':writerCheck(r.phase==='acknowledged'&&r.submission==='acknowledged'&&!r.createdId,'transition');r.phase='verified';r.disposition='released';break;
 case 'legacyVerified':writerCheck(r.kind==='nativeCreate'&&r.createAcknowledged&&r.createdId&&r.phase!=='partial','transition');r.legacyVerified=true;r.phase='verified';r.disposition='released';break;
 case 'stopped':r.phase=r.createdId?'partial':'uncertain';break;
 default:throw writerError('unsupported');
 }
 if(r.disposition==='released')r.grants=[];
 validateWriter(r);return immutable(r);
}
export function writerAdmission(usage,delta,count=0){writerCheck(usage.owners+count<=WRITER_LIMITS.owners&&usage.bytes+delta<=WRITER_LIMITS.totalBytes,'capacity');}
export function legacyWriterResources(row){
 let p;try{writerCheck(typeof row.receipt==='string'&&Buffer.byteLength(row.receipt)<=WRITER_LIMITS.legacyBytes,'unsupported');p=JSON.parse(row.receipt);}catch{throw writerError('unsupported');}
 writerCheck(p&&typeof p==='object'&&!Array.isArray(p)&&(!Object.hasOwn(p,'subject')||p.subject===row.subject)&&(!Object.hasOwn(p,'operationId')||p.operationId===row.key),'unsupported');
 if(Object.hasOwn(p,'version'))writerCheck(p.version===1,'unsupported');if(Object.hasOwn(p,'sharedVersion'))writerCheck(p.sharedVersion===1,'unsupported');
 const active=['reviewing','writing','uncertain','unverified'];
 if(row.namespace==='docs_creations'){
  const kind=p.kind??'document';writerCheck(['document','spreadsheet','copy','upload'].includes(kind),'unsupported');
  const id=p.documentId??p.spreadsheetId??p.fileId,held=active.includes(p.claimState)||['reserved','created','incomplete','verification_unavailable','uncertain'].includes(p.outcome)||p.claimState==='not_submitted'&&id&&p.outcome==='incomplete';
  writerCheck(p.outcome===undefined?['proposed','reviewing','writing','uncertain','verified','not_submitted','declined','cancelled'].includes(p.claimState):['reserved','created','incomplete','verification_unavailable','uncertain','verified','not_created','proposed','reviewing','writing','not_submitted','declined','cancelled','expired','mismatch'].includes(p.outcome),'unsupported');
  if(!held)return [];
  return writerResources(kind==='copy'?'copy':kind==='upload'?'upload':'nativeCreate',p);
 }
 writerCheck([...active,'proposed','verified','rejected','not_submitted','expired','declined','cancelled','approval_unavailable','approval_required','stale','conflict','preparing','interrupted','partial'].includes(row.state),'unsupported');
 if(!active.includes(row.state))return [];
 const field=['drive_formatting_operations','docs_image_operations'].includes(row.namespace)?'documentId':row.namespace==='drive_sheets_edits'?'spreadsheetId':row.namespace==='drive_sharing_operations'?'fileId':'resource';writerCheck(!Object.hasOwn(p,field)||p[field]===row.resource,'unsupported');
 const op={...p};
 if(['drive_formatting_operations','docs_image_operations'].includes(row.namespace))op.documentId=row.resource;
 else if(row.namespace==='drive_sheets_edits')op.spreadsheetId=row.resource;
 else if(row.namespace==='drive_sharing_operations')op.fileId=row.resource;
 else if(row.namespace==='drive_filing_operations'){op.resource=row.resource;if(op.kind==='task')return [];if(op.resource?.startsWith('file:'))op.fileId=op.resource.slice(5);}
 else throw writerError('unsupported');
 return writerResources(row.namespace==='drive_sharing_operations'?'sharing':row.namespace==='drive_filing_operations'?'filing':'content',op);
}
export const attachmentReason=error=>['capacity','unsupported','corrupt'].includes(error?.writerCode)?error.writerCode:'storage';
export const writerDigest=value=>digest(JSON.stringify(ordered(value)));
