// Fixed producer-marker interpretation. Observation is never ACK, authority or
// full ancestry/origin closure. Unmarked files keep only their legacy contract.
import {boundedTree,LIMITS} from './common.mjs';
import {writerCheck,writerDigest,WRITER_LIMITS,validateWriter} from './writer-coordination.mjs';
const DOC='application/vnd.google-apps.document',SHEET='application/vnd.google-apps.spreadsheet',FOLDER='application/vnd.google-apps.folder';
const definitions=Object.freeze({paDocsCreation:['docs_creations','document','documentId',DOC],paSheetsCreation:['docs_creations','spreadsheet','spreadsheetId',SHEET],paCopyCreation:['docs_creations','copy','fileId',null],paLocalUpload:['docs_creations','upload','fileId',null],paFilingCreation:['drive_filing_operations','folder','fileId',FOLDER]});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[\w-]{1,256}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const v4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function targetMarker(metadata){
 writerCheck(object(metadata),'marker');const props=metadata.appProperties;
 if(props===undefined)return null;writerCheck(object(props)&&Object.values(props).every(value=>typeof value==='string'),'marker');const found=Object.keys(definitions).filter(k=>Object.hasOwn(props,k));
 if(!found.length)return null;writerCheck(found.length===1,'marker_ambiguous');const marker=found[0],key=props[marker],definition=definitions[marker];
 writerCheck(typeof key==='string'&&(marker==='paFilingCreation'?uuid:v4).test(key),'marker');
 try{boundedTree(metadata,{...LIMITS,providerBytes:WRITER_LIMITS.recordBytes,nodes:10000,depth:16});}catch{writerCheck(false,'marker_budget');}
 writerCheck(id(metadata.id)&&metadata.trashed===false&&typeof metadata.mimeType==='string'&&metadata.mimeType.length<=255&&/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(metadata.mimeType),'marker');
 return Object.freeze({marker,key,namespace:definition[0],kind:definition[1],idField:definition[2],mimeType:definition[3]});
}
export function classifyWriterMarker(metadata,snapshot){
 const marker=targetMarker(metadata);if(!marker)return {kind:'unmarkedLegacy'};
 writerCheck(snapshot&&Array.isArray(snapshot.rows)&&snapshot.rows.length<=2,'marker');
 const rows=snapshot.rows;const seen=new Set();for(const row of rows){writerCheck(object(row)&&['docs_creations','drive_filing_operations'].includes(row.namespace)&&row.key===marker.key&&!seen.has(row.namespace),'marker');seen.add(row.namespace);}
 const eligible=rows.filter(r=>r.namespace===marker.namespace);writerCheck(eligible.length===1,eligible.length===0?'marker_missing':'marker_ambiguous');const row=eligible[0];
 writerCheck(typeof row.subject==='string'&&row.subject.length>0&&row.subject.length<=320&&typeof row.receipt==='string'&&Buffer.byteLength(row.receipt)<=WRITER_LIMITS.recordBytes,'marker');
 let p;try{p=JSON.parse(row.receipt);}catch{writerCheck(false,'marker');}
 writerCheck(object(p)&&p.subject===row.subject&&p.operationId===marker.key&&hash(p.requestHash),'marker');
 for(const k of ['version','schemaVersion'])if(Object.hasOwn(p,k))writerCheck(p[k]===1,'marker');
 const kind=p.kind??(row.namespace==='docs_creations'?'document':null);writerCheck(kind===marker.kind,'marker');
 writerCheck(id(p.destinationId),'marker');
 if(['document','spreadsheet','copy','folder'].includes(kind))writerCheck(hash(p.titleHash),'marker');
 if(kind==='document')writerCheck(hash(p.textHash),'marker');if(kind==='spreadsheet')writerCheck(hash(p.contentHash),'marker');
 if(kind==='folder')writerCheck(hash(p.fingerprint)&&hash(p.destinationFingerprint),'marker');
 if(kind==='upload')writerCheck(hash(p.nameHash)&&hash(p.sha256),'marker');
 for(const k of ['acknowledged','createAcknowledged','populateAcknowledged','writeAttempted'])if(Object.hasOwn(p,k))writerCheck(typeof p[k]==='boolean','marker');
 if(Object.hasOwn(p,'sharedVersion'))writerCheck(p.sharedVersion===1&&['document','spreadsheet'].includes(kind),'marker');
 const expectedMime=marker.mimeType??(kind==='copy'?p.mimeType:p.resultMime);writerCheck(expectedMime===metadata.mimeType,'marker');
 if(kind==='upload'){const results={xlsx_to_sheet:SHEET,docx_to_doc:DOC,pptx_to_slides:'application/vnd.google-apps.presentation'};writerCheck(p.mode==='binary'?typeof p.resultMime==='string'&&!p.resultMime.startsWith('application/vnd.google-apps.')&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(p.resultMime):Object.hasOwn(results,p.mode)&&p.resultMime===results[p.mode],'marker');}
 if(kind==='copy')writerCheck(![FOLDER,'application/vnd.google-apps.shortcut'].includes(p.mimeType),'marker');
 for(const k of ['documentId','spreadsheetId','fileId'])if(Object.hasOwn(p,k))writerCheck(k===marker.idField&&id(p[k]),'marker');
 const known=p[marker.idField];writerCheck(known===undefined||known===metadata.id,'marker');
 let state=p.outcome;
 if(row.namespace==='drive_filing_operations'){writerCheck(p.resource===row.resource&&typeof p.resource==='string'&&p.resource.startsWith('folder:'),'marker');state=row.state;const states=['proposed','reviewing','writing','uncertain','verified','rejected','not_submitted','expired','declined','cancelled','stale'];writerCheck(states.includes(state)&&(!Object.hasOwn(p,'state')||states.includes(p.state)),'marker');}
 else{const native=['reserved','created','verified','incomplete','not_created','uncertain','verification_unavailable'],access=['proposed','reviewing','writing','uncertain','verified','not_submitted','expired','declined','cancelled'];const states=kind==='copy'?['reserved','uncertain','verified','mismatch','not_created','verification_unavailable']:p.sharedVersion===1||kind==='upload'?[...native,...access]:native;writerCheck(states.includes(state),'marker');if(p.sharedVersion===1||kind==='upload')writerCheck(['proposed','reviewing','writing','uncertain','verified','not_submitted','expired','declined','cancelled'].includes(p.claimState),'marker');}
 if(['created','verified','incomplete','mismatch','verification_unavailable'].includes(state))writerCheck(known===metadata.id,'marker');
 if(state==='verified'&&p.sharedVersion===1)writerCheck(p.claimState==='verified'&&p.createAcknowledged===true&&p.populateAcknowledged===true,'marker');
 const owner=snapshot.owner??null;
 if(owner){validateWriter(owner);writerCheck(owner.namespace==='docs_creations'&&owner.operationId===marker.key,'marker');if(row.namespace==='docs_creations'){writerCheck(owner.subject===row.subject&&owner.operationKind===kind,'marker');writerCheck((owner.createdId===null||owner.createdId===metadata.id)&&owner.observedIds.every(value=>value===metadata.id),'marker');writerCheck(owner.disposition==='held'||owner.phase==='verified'&&owner.legacyVerified===true,'marker');}}
 // Historical completion is scoped to its own legacy contract. A modern held
 // owner always overrides that weaker output, never inferred ACK or release.
 const modernHeld=row.namespace==='docs_creations'&&owner?.disposition==='held';
 const historical=state==='verified'&&known===metadata.id&&(!p.sharedVersion||p.claimState==='verified'&&p.createAcknowledged===true&&p.populateAcknowledged===true)&&(kind!=='copy'||p.acknowledged===true)&&(kind!=='upload'||p.claimState==='verified'&&p.acknowledged===true);
 if(historical&&!modernHeld)return {kind:'historicalMarker',marker:marker.marker};
 // Contradictory no-effect/preview markers cannot manufacture a writer history.
 writerCheck(!['not_created','not_submitted','declined','cancelled','expired','proposed','reviewing','rejected','stale'].includes(state)||p.sharedVersion===1&&state==='incomplete','marker');
 if(marker.marker==='paDocsCreation'&&owner?.disposition==='held'&&owner.submission==='unknown'&&!owner.createAcknowledged&&owner.createdId===null&&['intent','uncertain'].includes(owner.phase)){
  writerCheck(id(p.destinationId)&&p.destinationId!=='root'&&Array.isArray(metadata.parents)&&metadata.parents.length===1&&metadata.parents[0]===p.destinationId,'marker');
  return {kind:'nativeObservation',operationId:marker.key,ownerSubject:row.subject,legacyDigest:writerDigest(row),ownerDigest:writerDigest(owner),metadataDigest:writerDigest(metadata),fileId:metadata.id};
 }
 return {kind:'blockedMarker'};
}
export function nativeMarkerFact(owner,observerSubject,metadata,decision){
 writerCheck(decision.kind==='nativeObservation'&&decision.ownerSubject===owner.subject&&decision.operationId===owner.operationId&&typeof observerSubject==='string'&&observerSubject.length>0&&observerSubject.length<=320,'owner');
 return {kind:'markerObservedId',id:metadata.id,marker:'paDocsCreation',observerSubject,legacyDigest:decision.legacyDigest,ownerDigest:decision.ownerDigest,metadataDigest:decision.metadataDigest};
}
