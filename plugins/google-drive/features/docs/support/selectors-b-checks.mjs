import assert from 'node:assert/strict';
import { SemanticWorld, semanticAccount, semanticScope } from './semantic-world.mjs';

// Original provider READ facts. Coordinates below are literal fixture facts,
// not output from the production normalizer/selector. No mutations or assets.
export function selectorDocument() {
  return {documentId:'doc-a',revisionId:'b-read-1',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{
    tabProperties:{tabId:'tab-a',title:'Main',index:7},documentTab:{body:{content:[
      {startIndex:1,endIndex:8,paragraph:{paragraphStyle:{headingId:'market',namedStyleType:'HEADING_1'},elements:[{startIndex:1,endIndex:8,textRun:{content:'Market\n'}}]}},
      {startIndex:8,endIndex:20,paragraph:{elements:[
        {startIndex:8,endIndex:12,textRun:{content:'A😀 ',textStyle:{bold:true}}},
        {startIndex:12,endIndex:20,textRun:{content:'e\u0301\u00a0\u2009אב!\n',textStyle:{italic:true}}}
      ]}},
      {startIndex:20,endIndex:25,paragraph:{paragraphStyle:{headingId:'next',namedStyleType:'HEADING_1'},elements:[{startIndex:20,endIndex:25,textRun:{content:'Next\n'}}]}}
    ]},inlineObjects:{logo:{inlineObjectProperties:{embeddedObject:{imageProperties:{contentUri:'https://unused.invalid/logo.png'}}}}}}
  }]};
}
export async function checkSelectorB(name) {
  const world=new SemanticWorld();world.document=selectorDocument();
  await world.init({pageBytes:name.includes('corruption')?3000:65536});
  try {
    const inspected=await world.inspect();assert.ok(inspected.snapshotId,JSON.stringify(inspected));
    const base={account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope};
    const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
    const db=world.host.bb.storage.database();
    if(name==='exact heading text') {
      const result=await world.call('docs_find',{...base,selector:{heading:{text:'Market',level:1,depth:0}}});
      assert.equal(result.status,'resolved');assert.equal(result.nodes.length,1);
      const read=await world.call('docs_read',{...base,selector:{section:{text:'Market',includeHeading:false}},format:'text'});
      assert.equal(read.records.map(r=>r.text).join(''),'A😀 e\u0301\u00a0\u2009אב!\n');assert.equal(read.coverage.editReady,false);
    } else if(name==='typed heading level') {
      await assert.rejects(world.call('docs_find',{...base,selector:{heading:{headingId:'market',level:'1'}}}));
      const result=await world.call('docs_find',{...base,selector:{heading:{headingId:'market',level:1}}});assert.equal(result.status,'resolved');
    } else if(name==='literal source map') {
      for(const [literal,normalization,start,end,text] of [['😀 e\u0301','exact',9,14,'😀 e\u0301'],['é','nfc',12,14,'e\u0301'],['e\u0301 אב','typographic',12,18,'e\u0301\u00a0\u2009אב']]) {
        const result=await world.call('docs_find',{...base,query:{literal,normalization}});
        assert.equal(result.count,1);assert.deepEqual(result.candidates[0].extent,{start,end});assert.equal(result.candidates[0].text,text);
      }
    } else if(name==='normalization budget') {
      // Attack-shaped combining cluster: refusal is a resource bound, not a
      // ban on NFC or valid Unicode. It must happen before normalization work.
      const {normalizeMapped}=await import('../../../core/docs-semantic/selectors.mjs');
      assert.throws(()=>normalizeMapped('a'+'\u0301'.repeat(4097),'nfc'),/budget/);
    } else {
      const first=await world.call('docs_read',{...base,format:'structured'});assert.ok(first.coverage,JSON.stringify(first));
      if(name==='cursor corruption') {
        assert.ok(first.nextCursor);
        const row=db.prepare('SELECT state FROM docs_semantic_cursors WHERE id=?').get(first.nextCursor);
        const state=JSON.parse(row.state);state.offset=0;state.request.format='text';
        db.prepare('UPDATE docs_semantic_cursors SET state=? WHERE id=?').run(JSON.stringify(state),first.nextCursor);
        const result=await world.call('docs_read',{account:semanticAccount,snapshotId:base.snapshotId,cursor:first.nextCursor});
        assert.equal(result.category,'corrupt');
      } else if(name==='delivery corruption') {
        const token=first.coverage.deliveryToken;
        const row=db.prepare('SELECT data FROM docs_semantic_delivery WHERE id=?').get(token);
        const data=JSON.parse(row.data);data.nodes=[];data.complete=true;
        db.prepare('UPDATE docs_semantic_delivery SET data=? WHERE id=?').run(JSON.stringify(data),token);
        assert.throws(()=>world.store.semanticSnapshots.deliveries(base.snapshotId,owner,0,[token]),/corrupt/);
      } else assert.fail('Unknown B fixture');
    }
    assert.deepEqual(world.store.semanticSnapshots.get(base.snapshotId,owner,0).evidence,world.document);
    assert.ok(world.calls.every(c=>c.method==='GET'));
  } finally {await world.close();}
}
