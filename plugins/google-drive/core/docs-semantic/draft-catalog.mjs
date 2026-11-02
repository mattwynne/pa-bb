// Metadata-only legacy namespace interpretation. Recognition is NOT provider
// verification, acknowledgement, execution authority or permission to unlock.
import {DRAFT_LIMITS,demand,strict,keyValid,validateSaved} from './draft-policy.mjs';
export const LEGACY_KEY_TABLES=Object.freeze(['docs_creations','drive_sharing_operations','drive_formatting_operations','drive_sheets_edits','drive_filing_operations','docs_image_operations']);
export const CATALOG_NAMESPACES=Object.freeze(['semantic',...LEGACY_KEY_TABLES]);
// Old formatting/sharing z.uuid() accepted RFC UUID versions beyond v4 (and
// nil/max). Keep their lookup vocabulary without widening new key admission.
export const historicalKeyValid=x=>typeof x==='string'&&/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(x);
export function catalogHandle(namespace,operationId){return Buffer.from(JSON.stringify([namespace,operationId])).toString('base64url');}
export function parseCatalogHandle(handle){demand(typeof handle==='string'&&handle.length<=512&&/^[A-Za-z0-9_-]+$/.test(handle));let value;try{value=JSON.parse(Buffer.from(handle,'base64url').toString('utf8'));}catch{demand(false);}demand(Array.isArray(value)&&value.length===2&&CATALOG_NAMESPACES.includes(value[0])&&historicalKeyValid(value[1]));demand(catalogHandle(...value)===handle);return {namespace:value[0],operationId:value[1]};}
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const resource=x=>typeof x==='string'&&/^[\w-]{1,256}$/.test(x);
const states={
 drive_formatting_operations:['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','approval_unavailable','approval_required'],
 docs_image_operations:['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','approval_unavailable','approval_required'],
 drive_sharing_operations:['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','stale'],
 drive_sheets_edits:['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','approval_unavailable','unverified','conflict'],
 drive_filing_operations:['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','stale','preparing','interrupted','partial'],
};
const nativeOutcomes=['reserved','created','verified','incomplete','not_created','uncertain','verification_unavailable'];
const accessStates=['proposed','reviewing','writing','uncertain','verified','not_submitted','expired','declined','cancelled'];
function legacyMetadata(row,p){
 if(!object(p)||p.subject!==row.subject||p.operationId!==row.operationId)return null;
 if(!historicalKeyValid(p.operationId))return null;
 for(const k of ['version','schemaVersion'])if(Object.hasOwn(p,k)&&p[k]!==1)return null;
 for(const k of ['requestHash','titleHash','textHash','contentHash','beforeHash','afterHash','destinationFingerprint'])if(Object.hasOwn(p,k)&&!hash(p[k]))return null;
 if(Object.hasOwn(p,'createdAt')&&(!Number.isSafeInteger(p.createdAt)||p.createdAt<0))return null;
 for(const k of ['acknowledged','providerAcknowledged','createAcknowledged','populateAcknowledged','writeAttempted'])if(Object.hasOwn(p,k)&&typeof p[k]!=='boolean')return null;
 if(row.namespace==='docs_creations'){
  const kind=Object.hasOwn(p,'kind')?p.kind:'document';
  if(!['document','spreadsheet','copy','upload'].includes(kind)||!keyValid(p.operationId)||!hash(p.requestHash))return null;
  if(Object.hasOwn(p,'sharedVersion')&&(p.sharedVersion!==1||!['document','spreadsheet'].includes(kind)))return null;
  for(const k of ['documentId','spreadsheetId','fileId','destinationId'])if(Object.hasOwn(p,k)&&!resource(p[k]))return null;
  let allowed=nativeOutcomes;
  if(kind==='copy')allowed=['reserved','uncertain','verified','mismatch','not_created','verification_unavailable'];
  if(p.sharedVersion===1||kind==='upload')allowed=[...nativeOutcomes,...accessStates];
  if(!allowed.includes(p.outcome))return null;
  if((p.sharedVersion===1||kind==='upload')&&!accessStates.includes(p.claimState))return null;
  if(kind==='upload'&&!['binary','xlsx_to_sheet','docx_to_doc','pptx_to_slides'].includes(p.mode))return null;
  if(['created','verified','incomplete','mismatch','verification_unavailable'].includes(p.outcome)){
   const id=kind==='document'?p.documentId:kind==='spreadsheet'?p.spreadsheetId:p.fileId;if(!resource(id))return null;
  }
  return {kind:`docs_creations:${kind}`,state:p.outcome};
 }
 if(!['drive_formatting_operations','drive_sharing_operations'].includes(row.namespace)&&!keyValid(p.operationId))return null;
 const known=states[row.namespace];if(!known||!known.includes(row.state))return null;
 // SQL is intentionally authoritative: claim/cancel transitions may update
 // only the state column, leaving an older but valid JSON lifecycle value.
 if(Object.hasOwn(p,'state')&&!known.includes(p.state))return null;
 const field=row.namespace==='drive_sheets_edits'?'spreadsheetId':['docs_image_operations','drive_formatting_operations'].includes(row.namespace)?'documentId':row.namespace==='drive_sharing_operations'?'fileId':'resource';
 if(field==='resource'){
  if(!['move','folder','task'].includes(p.kind)||typeof p.resource!=='string'||!p.resource.length||p.resource.length>512)return null;
 }else if(!resource(p[field]))return null;
 if(row.resource!==undefined&&row.resource!==p[field])return null;
 if(Object.hasOwn(p,'sharedVersion'))return null;
 return {kind:row.namespace,state:row.state};
}
export function catalogCandidates(rows,subject,limits=DRAFT_LIMITS){
 demand(Array.isArray(rows)&&rows.length<=CATALOG_NAMESPACES.length,'corrupt');const seen=new Set();
 return rows.map(row=>{
  strict(row,['namespace','operationId','subject','state','receipt'],['resource','plan']);demand(row.subject===subject&&CATALOG_NAMESPACES.includes(row.namespace)&&historicalKeyValid(row.operationId)&&!seen.has(row.namespace),'corrupt');seen.add(row.namespace);
  let p,metadata;
  try{demand(typeof row.receipt==='string'&&Buffer.byteLength(row.receipt)<=limits.catalogBytes,'budget');p=JSON.parse(row.receipt);
   if(row.namespace==='semantic'){validateSaved({record:p,plan:row.plan??null},limits);if(p.operationId===row.operationId&&p.subject===subject)metadata={kind:'semantic',state:p.state};}
   else metadata=legacyMetadata(row,p);
  }catch{ /* malformed/oversized is unsupported, never repaired */ }
  return {receiptKind:metadata?.kind??row.namespace,recoveryHandle:catalogHandle(row.namespace,row.operationId),createdAt:metadata&&Number.isSafeInteger(p.createdAt)&&p.createdAt>=0?p.createdAt:null,status:metadata?.state??'unsupported',supported:Boolean(metadata),historicalEvidenceVersion:row.namespace==='semantic'?'semantic-draft-v1':'legacy',providerVerification:'notRun'};
 });
}
export function catalogResult(candidates){return {status:candidates.length>1?'ambiguous':candidates.length===0?'unknown':candidates[0].supported?'candidate':'unsupported',candidates,thisCall:{providerMutationCount:0},execution:'notImplemented',retrySafe:false};}
