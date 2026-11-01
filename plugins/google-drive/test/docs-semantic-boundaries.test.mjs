import test from 'node:test';
import assert from 'node:assert/strict';
import {structuralBoundary,terminalBoundary} from '../features/docs/support/boundary-checks.mjs';
import {extentResidual} from '../features/docs/support/residual-checks.mjs';
import {packReadProjection} from '../core/docs-semantic/reader.mjs';
import {materialize} from '../core/docs-semantic/model.mjs';
import {footprint,evaluateWitness,previewWitness} from '../core/docs-semantic/coverage.mjs';
import {digest,evidenceAt} from '../core/docs-semantic/common.mjs';
import {semanticVector} from '../features/docs/support/semantic-world.mjs';
for(const kind of ['nextSibling','descendant','precedingSibling','nestedParagraph','row','cell','table','toc','inlineSibling','missingStartDescendant','invalidStart','rowSiblings','cellSiblings'])
  test(`contradictory partial structural constraints: ${kind}`,()=>structuralBoundary(kind));
for(const kind of ['laterSibling','earlierUnbounded','otherContainer','otherTab'])test(`valid partial-start control: ${kind}`,()=>extentResidual(kind));
test('witness entry revalidates partial facts in an internally hashed older model',()=>{
  const document=structuredClone(semanticVector.document);delete document.tabs[0].documentTab.body.content[0].endIndex;
  const s=structuredClone(materialize({document,metadata:{},binding:{snapshotId:'old',documentId:'doc-a',view:'inline',account:'a',subject:'s',threadId:'t',retrievedAt:0},reviewIncluded:true}));
  s.evidence.tabs[0].documentTab.body.content[0].startIndex=1000;
  s.evidenceDigest=digest(s.evidence);
  for(const n of Object.values(s.nodes))n.evidence.digest=digest(evidenceAt(s,n.evidence.path));
  const heading=Object.values(s.nodes).find(n=>n.kind==='paragraph'&&n.extent?.start===1);
  const fp=footprint(s,{nodes:[heading.id],destructive:true,aspects:['content','styles','review']});
  assert.throws(()=>evaluateWitness(s,fp),/extent/);
  assert.throws(()=>previewWitness(s,fp,fp.nodes.map(node=>({node,providerEvidence:evidenceAt(s,s.nodes[node].evidence.path)}))),/extent/);
});
for(const length of [1,36,128])for(const delta of [-1,0,1])test(`native terminal envelope tokens=${length}, limit delta=${delta}`,()=>terminalBoundary(length,delta));
for(const mode of ['recordAndOmission','lossOnly'])for(const tokenLength of [1,36,128])for(const delta of [-1,0,1])
  test(`JSON UTF-8 terminal oracle: ${mode}, token=${tokenLength}, delta=${delta}`,()=>{
    const limit=2048,records=mode==='recordAndOmission'?[{id:'r',text:'é😀'}]:[];
    const nodeAspects=records.length?{r:['content']}:{},nodes=records.map(r=>r.id),aspects=records.length?['content']:[];
    const loss={node:'omitted-a',kind:'omitted',detail:'é😀\\\n'},tail={node:'omitted-b',kind:'omitted'};
    const response=(r,l,n,m,a,complete)=>({records:r,losses:l,complete,nextCursor:complete?null:'c'.repeat(tokenLength),
      coverage:{delivered:{nodes:n,nodeAspects:m},aspects:a,deliveryToken:'d'.repeat(tokenLength)}});
    const empty=response(records,[loss,tail],nodes,nodeAspects,aspects,true);
    loss.detail+='x'.repeat(limit+delta-Buffer.byteLength(JSON.stringify(empty)));
    const expected=response(records,[loss,tail],nodes,nodeAspects,aspects,true);
    assert.equal(Buffer.byteLength(JSON.stringify(expected)),limit+delta);
    const projection={records,losses:[loss,tail],nodeAspects};let builds=0;
    const build=p=>{
      builds++;
      return {result:response(p.records,p.losses,p.nodes,p.nodeAspects,p.aspects,p.complete),
        delivery:{nodes:p.nodes,nodeAspects:p.nodeAspects,losses:p.losses,complete:p.complete},
        nextState:p.complete?null:{offset:p.nextOffset,lossOffset:p.nextLossOffset}};
    };
    let packed;
    try{packed=packReadProjection(projection,{},limit,build);}catch(error){assert.equal(delta,1);assert.equal(error.semanticCode,'budget');return;}
    if(delta<=0)assert.deepEqual(packed.result,expected);
    else {
      assert.equal(packed.result.complete,false);const seenRecords=[],seenLosses=[];let pages=0;
      while(packed){
        assert.ok(Buffer.byteLength(JSON.stringify(packed.result))<=limit);seenRecords.push(...packed.result.records);seenLosses.push(...packed.result.losses);
        assert.ok(++pages<=3);packed=packed.nextState?packReadProjection(projection,packed.nextState,limit,build):null;
      }
      assert.deepEqual(seenRecords,records);assert.deepEqual(seenLosses,[loss,tail]);
    }
    assert.ok(builds<=14,'no growing-prefix serialization loop');
  });
