// Independently authored raw observations and literal expected K3 disclosures.
// No production resolver, model, effect builder or comparator imports.
import { createHash } from 'node:crypto';
import { documentVector,paragraph,scope,styleRequest,literalRequest,broadRequest,binding } from '../support/witness-c-vectors.mjs';
export { scope,styleRequest,literalRequest,broadRequest };
export const witnessVariants=Object.freeze(['narrowLiteral','styleFromMetadata','broadDelivered','completePreview','generatedNode','namedStyleIndirect','historyNotCurrent','siblingNotCovered']);
export const witnessOwner=Object.freeze({subject:'subject-d',account:'reader@example.test',threadId:'thread-d'});
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export const metadata={id:'doc-a',name:'Synthetic witness',mimeType:'application/vnd.google-apps.document',capabilities:{canEdit:true}};
export function descriptor(document,snapshotId='witness-a',retrievedAt=0,source='current') {return {binding:{snapshotId,...witnessOwner,documentId:'doc-a',view:'inline',retrievedAt,...source==='historical'?{source}:{}},evidenceDigest:hash(document),evidence:document};}
export function generatedDocuments(){
 const before={documentId:'doc-a',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Main'},documentTab:{body:{content:[paragraph(1,'A\n'),paragraph(3,'B\n')]},unknownPayload:{startIndex:73,endIndex:91,label:'untouched'}}}]};
 const table={startIndex:3,endIndex:9,table:{rows:1,columns:1,tableRows:[{startIndex:4,endIndex:8,tableCells:[{startIndex:5,endIndex:8,content:[paragraph(6,'\n')]}]}]}};
 const after=structuredClone(before);after.revisionId='r2';after.tabs[0].documentTab.body.content=[paragraph(1,'A\n'),table,paragraph(9,'B\n')];return {before,after,table};
}
export function generatedRequest(before,after,table){return {kind:'generatedReadComparison',predecessor:{binding:binding(before)},observation:{binding:binding(after),predecessorRevision:'r1'},binding:{kind:'exactAnchor',tabId:'tab-a',segment:{kind:'body'},nodeKind:'table',startIndex:3},expectedOriginal:table,preservation:[[1,1,'segment',null,null],[2,2,'paragraph',{start:1,end:3},{start:1,end:3}],[3,3,'text',{start:1,end:3},{start:1,end:3}],[4,9,'paragraph',{start:3,end:5},{start:9,end:11}],[5,10,'text',{start:3,end:5},{start:9,end:11}]].map(([a,b,kind,from,to])=>({source:`${before.binding.snapshotId}:${a}`,target:`${after.binding.snapshotId}:${b}`,kind,tabId:'tab-a',segment:{kind:'body'},before:from,after:to}))};}
export function witnessFixture(r){
 if(!witnessVariants.includes(r.base)||!['success','counterexample'].includes(r.outcomeVariant))throw Error('unsupported witness case');
 const generated=generatedDocuments();return {caseId:r.caseId,variant:r.base,outcome:r.outcomeVariant,provenance:{source:'witness-fixtures.mjs and inert witness-c-vectors.mjs',authorship:'S02 independent original raw source and typed disclosures; legacy broad pair remains separate immutable native primary'},document:r.base==='generatedNode'?generated.before:documentVector(),metadata,...r.base==='generatedNode'?{after:generated.after,table:generated.table}:{}};
}
// Independent oracle reviewed in the source-only witness oracle report. Hash
// literal complete provider blocks, not production inspector output.
export function namedStyleOracle(s){
 const S=s.binding.snapshotId,N=n=>`${S}:${n}`,R=n=>`${S}:registry:${n}`,F=n=>`${S}:reference:${n}`;
 const request={tabId:'tab-a',namedType:'HEADING_1',family:'text',property:'bold',value:false};
 const definition={id:R(2),original:{namedStyleType:'HEADING_1',textStyle:{bold:true}},property:'bold',before:true,after:false};
 const usages=[[3,2,1,3,paragraph(1,'Terms\n',{}, {namedStyleType:'HEADING_1',headingId:'terms'})],[7,6,7,9,paragraph(20,'End\n',{}, {namedStyleType:'HEADING_1',headingId:'end'})]].map(([n,p,ownerRef,childRef,block])=>({node:N(n),kind:'text',tabId:'tab-a',segment:{kind:'body'},namedType:'HEADING_1',directOverride:null,before:true,after:false,affected:true,provenance:'named',source:'HEADING_1',inheritedSource:'HEADING_1',status:'observed',dependencies:[[childRef,'HEADING_1',2],[childRef+1,'NORMAL_TEXT',1]].map(([id,providerId,target])=>({id:F(id),providerId,targets:[R(target)],status:'resolved',dependencyOwner:N(p),dependencyEvidenceDigest:hash(block)})),inheritanceOwners:[{node:N(p),kind:'paragraph',evidenceDigest:hash(block),namedStyleType:'HEADING_1',review:{},unknownFields:[],references:[[ownerRef,'HEADING_1',2],[ownerRef+1,'NORMAL_TEXT',1]].map(([id,providerId,target])=>({id:F(id),definitionKind:'namedStyle',providerId,targets:[R(target)],status:'resolved',dependencyOwner:null,dependencyEvidenceDigest:null}))}],review:{},unknownFields:[]}));
 const facts={binding:binding(s),request,definition,usages,missingAspects:[],indirect:true,contentDeletion:false},witnessDigest=hash(facts);
 const pages=usages.map((usage,offset)=>({binding:facts.binding,request,definition,usages:[usage],offset,total:2,nextOffset:offset?null:1,witnessDigest,complete:offset===1,missingAspects:[],materialized:'complete',delivered:'propertyPage',witnessSatisfied:false,indirect:true,contentDeletion:false,editReady:false,authoringAuthority:'notEstablished'}));
 const result={materialized:'complete',delivered:'propertySummary',binding:facts.binding,comparisonDigest:witnessDigest,usageCount:2,indirect:true,contentDeletion:false,witnessSatisfied:true,missingAspects:[],editReady:false,authoringAuthority:'notEstablished'};
 return {request,pages,result,partial:{...result,delivered:'partial',witnessSatisfied:false,missingAspects:['usageEnumeration']}};
}
export function requestFor(f,s=descriptor(f.document)) {return f.variant==='narrowLiteral'?literalRequest(s):['styleFromMetadata','historyNotCurrent'].includes(f.variant)?styleRequest(s):broadRequest(s);}
