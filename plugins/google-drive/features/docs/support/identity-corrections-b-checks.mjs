import assert from 'node:assert/strict';
import { ApplicationWorld as SemanticWorld, semanticAccount } from './application-world.mjs';
import { evaluateLogicalIdentity } from '../../../core/docs-semantic/selectors.mjs';
import { digest } from '../../../core/docs-semantic/common.mjs';

const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
function paragraph(start,unknown) {
  return {startIndex:start,endIndex:start+5,paragraph:{elements:[
    {startIndex:start,endIndex:start+5,textRun:{content:'Keep\n',textStyle:{italic:true}}}
  ],...(unknown?{futurePayload:{startIndex:unknown,endIndex:unknown+2,meaning:'not a native coordinate'}}:{})}};
}
function document(content) {
  return {documentId:'doc-a',revisionId:'observed-only',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Evidence'},documentTab:{body:{content}}}]};
}
function identity(snapshot) {
  const b=snapshot.binding;
  return {snapshotId:b.snapshotId,subject:b.subject,account:b.account,threadId:b.threadId,documentId:b.documentId,view:b.view,evidenceDigest:snapshot.evidenceDigest};
}
function mapping(from,to,source,target) {
  const facts={version:1,id:'observed-continuity',provenance:{kind:'readEvidenceComparison',id:'original-native-fixture'},origin:identity(from),destination:identity(to),entries:[{
    source:source.id,target:target.id,kind:'paragraph',tabId:'tab-a',segment:{kind:'body'},sourceEvidenceDigest:source.evidence.digest,targetEvidenceDigest:target.evidence.digest
  }]};
  return {...facts,mappingDigest:digest(facts)};
}
export async function checkIdentityCorrectionB(name) {
  const unknown=['invented structure','changed unknown data'].includes(name);
  const duplicate=['actual duplicate','omitted duplicate','retyped duplicate','repaired omission'].includes(name);
  const before=document([paragraph(1,unknown?100:undefined)]);
  const after=document(duplicate?[paragraph(1),paragraph(9)]:[paragraph(9,unknown?200:undefined)]);
  const w=new SemanticWorld();await w.init();
  try {
    w.document=before;const first=await w.inspect();assert.ok(first.snapshotId);w.assertInitialPorts();
    w.document=after;const second=await w.inspect();assert.ok(second.snapshotId);
    const savedFrom=w.store.semanticSnapshots.get(first.snapshotId,owner,0),savedTo=w.store.semanticSnapshots.get(second.snapshotId,owner,0);
    assert.deepEqual(savedFrom.evidence,before);assert.deepEqual(savedTo.evidence,after);
    const from=structuredClone(savedFrom),to=structuredClone(savedTo);
    const source=Object.values(from.nodes).find(n=>n.kind==='paragraph');
    const paragraphs=Object.values(to.nodes).filter(n=>n.kind==='paragraph'),target=paragraphs.at(-1);
    if(name==='omitted duplicate'||name==='repaired omission'){
      const removed=paragraphs[0];
      for(const child of removed.children)delete to.nodes[child];delete to.nodes[removed.id];
      if(name==='repaired omission')to.nodes[removed.parent].children=to.nodes[removed.parent].children.filter(id=>id!==removed.id);
    }
    if(name==='retyped duplicate')paragraphs[0].kind='opaque';
    if(name==='invented structure')for(const [snapshot,node] of [[from,source],[to,target]]){
      const path=[...node.evidence.path,'paragraph','futurePayload'];
      const id=`${snapshot.binding.snapshotId}:invented`;
      snapshot.nodes[id]={id,kind:'opaque',parent:node.id,tabId:'tab-a',segment:{kind:'body'},extent:null,children:[],evidence:{path,digest:digest(path.reduce((v,k)=>v[k],snapshot.evidence))}};
      node.children.push(id);
    }
    if(name==='orphan')to.nodes[target.children[0]].parent=null;
    if(name==='cycle')target.children.push(target.id);
    if(name==='duplicate edge')target.children.push(target.children[0]);
    if(name==='duplicate path')to.nodes[target.children[0]].evidence=structuredClone(target.evidence);
    if(name==='wrong scope')to.nodes[target.children[0]].segment={kind:'header',id:'invented'};
    if(name==='wrong grid')target.grid=[[target.id]];
    if(name==='omitted source')delete from.nodes[source.children[0]];
    if(name==='retyped source')source.kind='opaque';
    if(name==='cyclic object')to.nodes.loop=to.nodes;
    // Evidence digests do not change in any derived-claim negative.
    assert.equal(digest(from.evidence),savedFrom.evidenceDigest);assert.equal(digest(to.evidence),savedTo.evidenceDigest);
    const request=mapping(from,to,source,target);
    if(name==='unique shift'){
      const result=evaluateLogicalIdentity(from,to,request,source.id);
      assert.equal(result.target,target.id);assert.equal(result.authoringAuthority,'notEstablished');
    } else assert.throws(()=>evaluateLogicalIdentity(from,to,request,source.id),/Docs semantic/);
    assert.deepEqual(w.store.semanticSnapshots.get(first.snapshotId,owner,0).evidence,before);
    assert.deepEqual(w.store.semanticSnapshots.get(second.snapshotId,owner,0).evidence,after);
  } finally {await w.close();}
}
