import assert from 'node:assert/strict';
import { SemanticWorld,semanticAccount as account,semanticScope as scope } from './semantic-world.mjs';
export const correctionOwner={subject:'subject-a',account,threadId:'thread-a'};
// Independently authored inert coordinates and definitions, not projection output.
export function correctionDocument(){
  return {documentId:'doc-a',revisionId:'r-corrections',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{
    tabProperties:{tabId:'tab-a',title:'Corrections'},documentTab:{
      namedStyles:{styles:[
        {namedStyleType:'NORMAL_TEXT',textStyle:{bold:false,fontSize:{magnitude:9,unit:'PT'}},paragraphStyle:{alignment:'END',spacingMode:'COLLAPSE_LISTS'}},
        {namedStyleType:'HEADING_1',textStyle:{bold:true,baselineOffset:'SUPERSCRIPT'},paragraphStyle:{alignment:'START'}},
        {namedStyleType:'HEADING_2',textStyle:{italic:true}},
      ]},
      body:{content:[
        {startIndex:1,endIndex:7,paragraph:{paragraphStyle:{namedStyleType:'HEADING_1',headingId:'start'},elements:[{startIndex:1,endIndex:7,textRun:{content:'Start\n'}}]}},
        {startIndex:7,endIndex:11,paragraph:{paragraphStyle:{namedStyleType:'NORMAL_TEXT'},elements:[{startIndex:7,endIndex:11,textRun:{content:'One\n'}}]}},
        {startIndex:11,endIndex:17,paragraph:{paragraphStyle:{namedStyleType:'HEADING_1',headingId:'final'},elements:[{startIndex:11,endIndex:17,textRun:{content:'Final\n'}}]}},
        {startIndex:17,endIndex:21,paragraph:{paragraphStyle:{namedStyleType:'NORMAL_TEXT'},elements:[{startIndex:17,endIndex:21,textRun:{content:'Two\n'}}]}},
      ]},
    },
  }]};
}
export const correctionRead=(snapshotId,extra={})=>({account,snapshotId,scope,format:'structured',styles:true,review:true,...extra});
export async function correctionWorld(fn){
  const w=new SemanticWorld();
  try {await w.init();w.document=correctionDocument();await fn(w);}finally{await w.close();}
}
export async function correctionExample(kind){
  await correctionWorld(async w=>{
    const tab=w.document.tabs[0].documentTab;
    if(kind==='terminalUnknown')tab.body.content.push({startIndex:21,futureBlock:{retain:'tail'}});
    if(kind==='absentInlineStyle')tab.body.content[0].paragraph.elements=[{startIndex:1,endIndex:2,autoText:{type:'PAGE_NUMBER'}},{startIndex:2,endIndex:7,textRun:{content:'tart\n'}}];
    if(kind==='wrongPropertyEnum')tab.body.content[1].paragraph.elements[0].textRun.textStyle={bold:'ALIGNMENT_UNSPECIFIED'};
    if(kind==='unknownDimension')tab.documentStyle={marginTop:{magnitude:72,unit:'FUTURE_UNIT'}};
    const original=structuredClone(w.document),snapshotId=(await w.inspect()).snapshotId;
    assert.ok(snapshotId);w.assertInitialWire();
    const snapshot=w.store.semanticSnapshots.get(snapshotId,correctionOwner,0);
    assert.deepEqual(snapshot.evidence,original);
    let extra;
    if(kind==='terminalUnknown')extra={selector:{section:{headingId:'final',includeHeading:false}}};
    else if(kind==='descendantStyles')extra={selector:{node:Object.values(snapshot.nodes).find(n=>n.text==='Start\n').id},registries:['styles']};
    else if(kind==='unknownDimension')extra={registries:['styles']};
    else extra={selector:{heading:{headingId:'start'}}};
    if(kind==='wrongPropertyEnum')extra={selector:{section:{headingId:'start',includeHeading:false}}};
    const result=await w.call('docs_read',correctionRead(snapshotId,extra));
    if(kind==='terminalUnknown'){
      assert.equal(result.selection.status,'unresolved');assert.equal(result.complete,false);
      assert.equal(w.host.bb.storage.database().prepare('SELECT count(*) AS n FROM docs_semantic_delivery').get().n,0);
    }else{
      assert.equal(result.complete,true);assert.equal(result.coverage.editReady,false);
      const [receipt]=w.store.semanticSnapshots.deliveries(snapshotId,correctionOwner,0,[result.coverage.deliveryToken]);
      assert.deepEqual(receipt.nodes,result.coverage.delivered.nodes);
      if(kind==='absentInlineStyle'){
        const style=result.records.find(r=>r.kind==='autoText').style;
        assert.deepEqual(style.properties.bold,{value:true,provenance:'named',source:'HEADING_1'});
        assert.deepEqual(style.properties.fontSize,{value:{magnitude:9,unit:'PT'},provenance:'named',source:'NORMAL_TEXT'});
      }
      if(kind==='descendantStyles'){
        assert.deepEqual(result.records.filter(r=>r.kind==='namedStyle').map(r=>r.providerId),['NORMAL_TEXT','HEADING_1']);
        assert.equal(result.records.filter(r=>r.kind==='registryReference').length,2);
        assert.ok(receipt.nodes.every(id=>!snapshot.nodes[id]));
      }
      if(kind==='wrongPropertyEnum'){
        const style=result.records.find(r=>r.text==='One\n').style;
        assert.equal(style.properties.bold.value,'ALIGNMENT_UNSPECIFIED');
        assert.equal(style.propertyEvidence.bold.effectiveStatus,'partialOrUnknown');
      }
      if(kind==='unknownDimension'){
        const property=result.records.find(r=>r.kind==='documentStyle').style.properties.marginTop;
        assert.equal(property.effective.status,'partialOrUnknown');
        assert.deepEqual(property.propertyEvidence.unknown,['marginTop.unit']);
      }
    }
  });
}
