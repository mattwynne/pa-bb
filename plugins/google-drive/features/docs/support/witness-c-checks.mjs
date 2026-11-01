import assert from 'node:assert/strict';
import { ApplicationWorld, semanticAccount } from './application-world.mjs';
import { documentVector, node, binding, paragraph, scope, styleRequest, literalRequest, broadRequest } from './witness-c-vectors.mjs';
import { compareReadEvidence, inspectNamedStyleEvidence, compareNamedStyleEvidence, compareGeneratedEvidence } from '../../../core/docs-semantic/coverage.mjs';
import { createReadEvidenceService } from '../../../core/docs-semantic/read-evidence-service.mjs';
export const witnessCases=['narrowLiteral','styleFromMetadata','broadDelivered','completePreview','generatedNode','namedStyleIndirect','historyNotCurrent','siblingNotCovered'];
export async function withWitnessIntegrationWorld(run,options={}) {
  const { SemanticWorld }=await import('./semantic-world.mjs');
  return withWitnessWorld(run,{...options,World:SemanticWorld});
}
export async function withWitnessWorld(run,{document=documentVector(),pageBytes,World=ApplicationWorld}={}) {
  const world=new World();world.document=document;await world.init(pageBytes?{pageBytes}:{});
  try {
    const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
    const observed=await world.inspect();assert.ok(observed.snapshotId,JSON.stringify(observed));
    const snapshot=world.store.semanticSnapshots.get(observed.snapshotId,owner,world.clock);
    const service=createReadEvidenceService({snapshots:world.store.semanticSnapshots,clock:()=>world.clock,
      diagnose:(operation,error)=>world.logs.push({operation,category:error.semanticCode,message:error.message})});
    return await run({world,owner,snapshot,service});
  }finally{await world.close();}
}
export async function readTokens(world,snapshot,selector,options={}) {
  let page=await world.call('docs_read',{account:semanticAccount,snapshotId:snapshot.binding.snapshotId,scope,selector,format:'structured',styles:true,review:true,...options});
  const tokens=[],pages=[];
  for(let i=0;;i++){
    assert.ok(i<100);assert.ok(page.coverage,JSON.stringify(page));tokens.push(page.coverage.deliveryToken);pages.push(page);
    if(!page.nextCursor)break;
    page=await world.call('docs_read',{account:semanticAccount,snapshotId:snapshot.binding.snapshotId,cursor:page.nextCursor});
  }
  return {tokens,pages};
}
function verdict(result,success) {
  assert.equal(result.witnessSatisfied,success,JSON.stringify(result.missingAspects));
  assert.equal(result.editReady,false);assert.equal(result.authoringAuthority,'notEstablished');
}
export function generatedDocuments() {
  const before={documentId:'doc-a',revisionId:'r1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Main'},documentTab:{body:{content:[paragraph(1,'A\n'),paragraph(3,'B\n')]}}}]};
  const table={startIndex:3,endIndex:9,table:{rows:1,columns:1,tableRows:[{startIndex:4,endIndex:8,tableCells:[{startIndex:5,endIndex:8,content:[paragraph(6,'\n')]}]}]}};
  const after=structuredClone(before);after.revisionId='r2';after.tabs[0].documentTab.body.content=[paragraph(1,'A\n'),table,paragraph(9,'B\n')];
  return {before,after,table};
}
export function generatedRequest(before,after,table) {
  const pairs=[[1,1,'segment',null,null],[2,2,'paragraph',{start:1,end:3},{start:1,end:3}],
    [3,3,'text',{start:1,end:3},{start:1,end:3}],[4,9,'paragraph',{start:3,end:5},{start:9,end:11}],
    [5,10,'text',{start:3,end:5},{start:9,end:11}]];
  return {kind:'generatedReadComparison',predecessor:{binding:binding(before)},observation:{binding:binding(after),predecessorRevision:'r1'},
    binding:{kind:'exactAnchor',tabId:'tab-a',segment:{kind:'body'},nodeKind:'table',startIndex:3},expectedOriginal:table,
    preservation:pairs.map(([a,b,kind,from,to])=>({source:node(before,a),target:node(after,b),kind,tabId:'tab-a',segment:{kind:'body'},before:from,after:to}))};
}
export async function checkWitnessCase(kind) {
  if(kind==='generatedNode'){
    const docs=generatedDocuments();return withWitnessWorld(async({world,owner,snapshot:before})=>{
      world.document=docs.after;world.clock=1;
      const result=await world.inspect(),after=world.store.semanticSnapshots.get(result.snapshotId,owner,1),request=generatedRequest(before,after,docs.table);
      const compared=compareGeneratedEvidence(before,after,request);verdict(compared,true);
      assert.equal(compared.generated.node,node(after,4));assert.equal(compared.protocolProvenance,'notEstablished');
      assert.throws(()=>compareGeneratedEvidence(before,after,{...request,observation:{...request.observation,predecessorRevision:'r0'}}),/conflict/);
      assert.throws(()=>compareGeneratedEvidence(before,after,{...request,binding:{...request.binding,startIndex:2}}),/scope/);
    },{document:docs.before});
  }
  return withWitnessWorld(async({world,snapshot:s,owner,service})=>{
    if(kind==='narrowLiteral'||kind==='styleFromMetadata'){
      const request=kind==='narrowLiteral'?literalRequest(s):styleRequest(s);
      verdict(compareReadEvidence(s,request),true);
      const bad=structuredClone(request);bad.presentation.changes[0][kind==='narrowLiteral'?'before':'after']='PRIVATE_INVENTED';
      const rejected=compareReadEvidence(s,bad);verdict(rejected,false);assert.ok(rejected.missingAspects.includes('effectPresentation'));
    }else if(['broadDelivered','siblingNotCovered'].includes(kind)){
      const {originalRecords,...request}=broadRequest(s);
      const none=service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request});verdict(none,false);assert.ok(none.missingAspects.includes('fullOriginals'));
      const sibling=await readTokens(world,s,{heading:{headingId:'end'}});
      verdict(service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:sibling.tokens}),false);
      const selected=await readTokens(world,s,request.selector);
      const result=service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,deliveryTokens:selected.tokens});verdict(result,true);assert.equal(result.delivered,'storedContent');
      assert.equal(world.document.tabs[0].documentTab.inlineObjects.logo.inlineObjectProperties.embeddedObject.imageProperties.contentUri,'https://example.test/logo.png');
    }else if(kind==='completePreview'){
      const request=broadRequest(s);verdict(service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request}),true);
      assert.throws(()=>service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,originalRecords:request.originalRecords.slice(1)}),/scope/);
      assert.throws(()=>service.evaluate(owner,{snapshotId:s.binding.snapshotId,...request,originalRecords:request.originalRecords.map(r=>({...r,providerEvidence:JSON.stringify(r.providerEvidence)}))}),/invalid/);
    }else if(kind==='historyNotCurrent'){
      verdict(compareReadEvidence(s,styleRequest(s)),true);
      const historical=structuredClone(s);historical.binding.source='historical';
      const result=compareReadEvidence(historical,styleRequest(historical));verdict(result,false);assert.ok(result.missingAspects.includes('currentEditorRevision'));
    }else if(kind==='namedStyleIndirect'){
      const request={tabId:'tab-a',namedType:'HEADING_1',family:'text',property:'bold',value:false};
      const first=inspectNamedStyleEvidence(s,request,{limit:1}),second=inspectNamedStyleEvidence(s,request,{offset:1,limit:1});
      assert.deepEqual([first.usages[0].node,second.usages[0].node],[node(s,3),node(s,7)]);
      assert.deepEqual([first.usages[0].before,first.usages[0].after,first.usages[0].source,first.usages[0].status],[true,false,'HEADING_1','observed']);
      assert.deepEqual(first.definition.original,{namedStyleType:'HEADING_1',textStyle:{bold:true}});
      verdict(compareNamedStyleEvidence(s,request,[first,second]),true);
      verdict(compareNamedStyleEvidence(s,request,[first]),false);
      const forged=structuredClone(second);forged.usages[0].after=true;
      verdict(compareNamedStyleEvidence(s,request,[first,forged]),false);
    }else throw new Error('Unknown synthetic C case');
  });
}
