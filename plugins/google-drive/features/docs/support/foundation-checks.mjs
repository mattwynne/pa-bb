// Independent synthetic regression facts. No production projection supplies an
// expected value. These supplemental cases are not ledger/product-intake joins.
import assert from 'node:assert/strict';
import { SemanticWorld, semanticAccount, semanticScope, semanticVector } from './semantic-world.mjs';
import { footprint, evaluateWitness, previewWitness } from '../../../core/docs-semantic/coverage.mjs';
import { evidenceAt } from '../../../core/docs-semantic/common.mjs';
export function gridDocument(widths) {
  const content=widths.map((columns,i)=>{
    const start=i*10;
    return {startIndex:start,endIndex:start+10,table:{rows:1,columns,tableRows:[{
      startIndex:start+1,endIndex:start+10,tableCells:[{startIndex:start+2,endIndex:start+10,
        tableCellStyle:{rowSpan:1,columnSpan:columns},content:[{startIndex:start+3,endIndex:start+5,
          paragraph:{elements:[{startIndex:start+3,endIndex:start+5,textRun:{content:'x\n'}}]}}]}]}]}};
  });
  return {documentId:'doc-a',revisionId:'rev-a',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',
    tabs:[{tabProperties:{tabId:'tab-a',title:'Grid'},documentTab:{body:{content}}}]};
}
export async function checkFoundation(kind) {
  const w=new SemanticWorld();
  try {
    await w.init();w.document=structuredClone(semanticVector.document);
    const content=w.document.tabs[0].documentTab.body.content;
    if(kind==='aggregateGrid')w.document=gridDocument([60000,60000]); // bounded safe reproduction, not an OOM test
    if(kind==='outsideParent')content[4].table.tableRows[0].tableCells[0].content=[{startIndex:1000,endIndex:1008,
      paragraph:{elements:[{startIndex:1000,endIndex:1008,textRun:{content:'Outside\n'}}]}}];
    if(kind==='scopedReview'){
      const table=content[4].table;
      table.suggestedInsertionIds=['table-insert'];table.suggestedDeletionIds=['table-delete'];
      table.tableRows[0].suggestedDeletionIds=['row-delete'];
      table.tableRows[0].suggestedTableRowStyleChanges={'row-style':{tableRowStyle:{minRowHeight:{magnitude:20,unit:'PT'}},tableRowStyleSuggestionState:{minRowHeightSuggested:true}}};
      table.tableRows[0].tableCells[0].suggestedInsertionIds=['cell-insert'];
      table.tableRows[0].tableCells[0].suggestedTableCellStyleChanges={'cell-style':{tableCellStyle:{contentAlignment:'BOTTOM'},tableCellStyleSuggestionState:{contentAlignmentSuggested:true}}};
      table.tableRows[0].tableCells[0].content[1].table.suggestedInsertionIds=['nested-insert'];
    }
    if(kind==='unknownReview')content[4].table.tableRows[0].tableCells[0].suggestedFutureChanges={future:{secret:'not-projected'}};
    if(kind==='unknownContent'){
      content[2].paragraph.futureInlineSemantic={text:'ORIGINAL_UNKNOWN_CONTENT'};
      content[2].paragraph.elements[0].textRun.futureNested={shape:{text:'RUN_UNKNOWN_CONTENT'}};
      content[4].table.tableRows[0].tableCells[0].futureCell={nested:{text:'CELL_UNKNOWN_CONTENT'}};
      content[4].table.tableRows[0].futureRow={unknown:'ROW_UNKNOWN_CONTENT'};
      content[8].paragraph.elements[0].textRun.textStyle={futureDecorations:{nested:'STYLE_ACTUALLY_DELIVERED'}};
    }
    const inspected=await w.inspect({scope:kind==='ordinalRoundTrip'?{tabs:{all:true},segments:[{kind:'body'}]}:semanticScope});
    if(['aggregateGrid','outsideParent'].includes(kind)){
      assert.equal(w.last.result.isError,true);assert.equal(inspected.outcome,'unavailable');
      assert.equal(w.store.semanticSnapshots.stats().snapshots,0);return;
    }
    if(kind==='ordinalRoundTrip'){
      const expected={'tab-a':semanticVector.expected.bodyText,'tab-child':'Child\n','tab-b':'Sibling\n'};
      assert.deepEqual(inspected.tabs.map(t=>[t.id,t.ordinal,t.siblingIndex]),[['tab-a',0,0],['tab-child',1,0],['tab-b',2,1]]);
      for(const tab of inspected.tabs){
        const r=await w.call('docs_read',{account:semanticAccount,snapshotId:inspected.snapshotId,
          scope:{tabs:{ordinal:tab.ordinal,snapshotId:inspected.snapshotId},segments:[{kind:'body'}]},format:'text'});
        assert.equal(r.records.map(x=>x.text).join(''),expected[tab.id]);
      }
      return;
    }
    const page=await w.call('docs_read',{account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope,format:'structured',styles:true,review:true});
    assert.equal(page.complete,true);
    const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
    const snapshot=w.store.semanticSnapshots.get(inspected.snapshotId,owner,0);
    const deliveries=w.store.semanticSnapshots.deliveries(inspected.snapshotId,owner,0,[page.coverage.deliveryToken]);
    if(kind==='scopedReview'){
      const table=page.records.find(n=>n.kind==='table'),row=page.records.find(n=>n.kind==='tableRow'),cell=page.records.find(n=>n.kind==='tableCell');
      assert.deepEqual(table.review.suggestedInsertionIds,['table-insert']);assert.deepEqual(table.review.suggestedDeletionIds,['table-delete']);
      assert.deepEqual(row.review.suggestedDeletionIds,['row-delete']);assert.equal(row.review.suggestedTableRowStyleChanges['row-style'].tableRowStyle.minRowHeight.magnitude,20);
      assert.deepEqual(cell.review.suggestedInsertionIds,['cell-insert']);assert.equal(cell.review.suggestedTableCellStyleChanges['cell-style'].tableCellStyle.contentAlignment,'BOTTOM');
      assert.deepEqual(page.records.filter(n=>n.kind==='table')[1].review.suggestedInsertionIds,['nested-insert']);
      for(const n of [table,row,cell]){
        assert.equal(n.tabId,'tab-a');assert.deepEqual(n.segment,{kind:'body'});
        assert.ok(deliveries[0].nodeAspects[n.id].includes('review'));
      }
      assert.equal(evaluateWitness(snapshot,footprint(snapshot,{nodes:[table.id],aspects:['content','styles','review'],destructive:true}),{deliveries}).witnessSatisfied,true);
    }else if(['unknownContent','unknownReview'].includes(kind)){
      const affected=kind==='unknownContent'?page.records.find(n=>n.kind==='paragraph'&&n.extent?.start===7):page.records.find(n=>n.kind==='tableCell');
      const fp=footprint(snapshot,{nodes:[affected.id],aspects:['content','styles','review'],destructive:true});
      assert.ok(page.losses.some(l=>l.node===affected.id&&l.kind==='unknownFieldOmitted'));
      assert.equal(evaluateWitness(snapshot,fp,{deliveries}).witnessSatisfied,false);
      assert.ok(!deliveries[0].nodeAspects[affected.id].includes('review'));
      const original=fp.nodes.map(node=>({node,providerEvidence:evidenceAt(snapshot,snapshot.nodes[node].evidence.path)}));
      assert.equal(evaluateWitness(snapshot,fp,{preview:previewWitness(snapshot,fp,original)}).witnessSatisfied,true);
      const unaffected=page.records.find(n=>n.kind==='paragraph'&&n.extent?.start===51);
      assert.equal(evaluateWitness(snapshot,footprint(snapshot,{nodes:[unaffected.id],aspects:['content','styles','review'],destructive:true}),{deliveries}).witnessSatisfied,true);
      if(kind==='unknownContent'){
        const run=page.records.find(n=>n.text==='Old '),cell=page.records.find(n=>n.kind==='tableCell'),row=page.records.find(n=>n.kind==='tableRow');
        assert.equal(page.records.find(n=>n.text==='Tail\n').style.explicit.futureDecorations.nested,'STYLE_ACTUALLY_DELIVERED');
        for(const node of [run,cell,row])assert.ok(page.losses.some(l=>l.node===node.id&&l.kind==='unknownFieldOmitted'));
      }
    }else assert.fail(`Unrecognized foundation regression ${kind}`);
  }finally{await w.close();}
}
