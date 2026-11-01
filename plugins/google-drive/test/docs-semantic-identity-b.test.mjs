import test from 'node:test';
import assert from 'node:assert/strict';
import * as selectors from '../core/docs-semantic/selectors.mjs';
import { digest } from '../core/docs-semantic/common.mjs';
import { SemanticWorld, semanticScope } from '../features/docs/support/semantic-world.mjs';
import { selectorDocument } from '../features/docs/support/selectors-b-checks.mjs';

// Independent before/after provider READ fixtures, not generated authoring.
// The original logical B cell shifts from row 1 to row 2 after an illustrative
// row insertion. No compiler, submitted-stage or approval facts exist here.
function observedTable(after) {
  const cells=after?[
    {startIndex:2,endIndex:7,tableCells:[{startIndex:3,endIndex:7,content:[{startIndex:4,endIndex:6,paragraph:{elements:[{startIndex:4,endIndex:6,textRun:{content:'X\n'}}]}}]}]},
    {startIndex:7,endIndex:12,tableCells:[{startIndex:8,endIndex:12,content:[{startIndex:9,endIndex:11,paragraph:{elements:[{startIndex:9,endIndex:11,textRun:{content:'A\n'}}]}}]}]},
    {startIndex:12,endIndex:17,tableCells:[{startIndex:13,endIndex:17,content:[{startIndex:14,endIndex:16,paragraph:{elements:[{startIndex:14,endIndex:16,textRun:{content:'B\n'}}]}}]}]}
  ]:[
    {startIndex:2,endIndex:7,tableCells:[{startIndex:3,endIndex:7,content:[{startIndex:4,endIndex:6,paragraph:{elements:[{startIndex:4,endIndex:6,textRun:{content:'A\n'}}]}}]}]},
    {startIndex:7,endIndex:12,tableCells:[{startIndex:8,endIndex:12,content:[{startIndex:9,endIndex:11,paragraph:{elements:[{startIndex:9,endIndex:11,textRun:{content:'B\n'}}]}}]}]}
  ];
  return {documentId:'doc-a',revisionId:after?'after-read':'before-read',suggestionsViewMode:'SUGGESTIONS_INLINE',commentsViewMode:'COMMENTS_VIEW_MODE_INCLUDED',tabs:[{tabProperties:{tabId:'tab-a',title:'Rows'},documentTab:{body:{content:[{startIndex:1,endIndex:after?18:13,table:{rows:after?3:2,columns:1,tableRows:cells}}]}}}]};
}
const owner={subject:'subject-a',account:'writer@example.test',threadId:'thread-a'};
const binding=s=>({snapshotId:s.binding.snapshotId,evidenceDigest:s.evidenceDigest,subject:s.binding.subject,account:s.binding.account,threadId:s.binding.threadId,documentId:s.binding.documentId,view:s.binding.view});
const seal=m=>({...m,mappingDigest:digest(m)});
async function fixture(run) {
  const w=new SemanticWorld();await w.init();
  try {
    w.document=observedTable(false);const a=await w.inspect();
    w.document=observedTable(true);const b=await w.inspect();
    const from=w.store.semanticSnapshots.get(a.snapshotId,owner,0),to=w.store.semanticSnapshots.get(b.snapshotId,owner,0);
    const source=Object.values(from.nodes).find(n=>n.kind==='tableCell'&&n.origin.row===1);
    const target=Object.values(to.nodes).find(n=>n.kind==='tableCell'&&n.origin.row===2);
    const mapping={version:1,id:'observed-row-shift',provenance:{kind:'readEvidenceComparison',id:'independent-before-after'},origin:binding(from),destination:binding(to),entries:[{
      source:source.id,target:target.id,kind:'tableCell',tabId:'tab-a',segment:{kind:'body'},sourceEvidenceDigest:source.evidence.digest,targetEvidenceDigest:target.evidence.digest
    }]};
    await run({w,from,to,source,target,mapping});
  } finally {await w.close();}
}
test('B read-evidence identity: original cell survives observed row insertion, not stale ordinal retargeting',()=>fixture(({from,to,source,target,mapping})=>{
  assert.equal(typeof selectors.evaluateLogicalIdentity,'function');
  const result=selectors.evaluateLogicalIdentity(from,to,seal(mapping),source.id);
  assert.equal(result.status,'resolved');assert.equal(result.logicalSource,source.id);assert.equal(result.target,target.id);
  assert.equal(result.authoringAuthority,'notEstablished');assert.equal(result.evidenceKind,'readSideIdentityComparison');
  assert.equal(selectors.resolveSelector(to,semanticScope,{node:source.id}).status,'missing');
}));
test('B read-evidence identity refuses indistinguishable destination cells rather than selecting an occurrence',()=>fixture(async({w,from,source,mapping})=>{
  const duplicate=observedTable(true);
  duplicate.tabs[0].documentTab.body.content[0].table.tableRows[1].tableCells[0].content[0].paragraph.elements[0].textRun.content='B\n';
  w.document=duplicate;const read=await w.inspect(),to=w.store.semanticSnapshots.get(read.snapshotId,owner,0);
  const target=Object.values(to.nodes).find(n=>n.kind==='tableCell'&&n.origin.row===2);
  mapping.destination=binding(to);mapping.entries[0].target=target.id;mapping.entries[0].targetEvidenceDigest=target.evidence.digest;
  assert.throws(()=>selectors.evaluateLogicalIdentity(from,to,seal(mapping),source.id),/conflict/);
}));
test('B read-evidence identity preserves a uniquely identified heading after an observed section shift',async()=>{
  const w=new SemanticWorld();await w.init();
  try {
    w.document=selectorDocument();const a=await w.inspect();
    const after=selectorDocument();after.revisionId='shifted-read';
    after.tabs[0].documentTab.body.content=[
      {startIndex:1,endIndex:4,paragraph:{elements:[{startIndex:1,endIndex:4,textRun:{content:'Hi\n'}}]}},
      {startIndex:4,endIndex:11,paragraph:{paragraphStyle:{headingId:'market',namedStyleType:'HEADING_1'},elements:[{startIndex:4,endIndex:11,textRun:{content:'Market\n'}}]}},
      {startIndex:11,endIndex:23,paragraph:{elements:[{startIndex:11,endIndex:15,textRun:{content:'A😀 ',textStyle:{bold:true}}},{startIndex:15,endIndex:23,textRun:{content:'e\u0301\u00a0\u2009אב!\n',textStyle:{italic:true}}}]}},
      {startIndex:23,endIndex:28,paragraph:{paragraphStyle:{headingId:'next',namedStyleType:'HEADING_1'},elements:[{startIndex:23,endIndex:28,textRun:{content:'Next\n'}}]}}
    ];
    w.document=after;const b=await w.inspect();
    const from=w.store.semanticSnapshots.get(a.snapshotId,owner,0),to=w.store.semanticSnapshots.get(b.snapshotId,owner,0);
    const source=from.nodes[from.outline.find(h=>h.providerId==='market').node],target=to.nodes[to.outline.find(h=>h.providerId==='market').node];
    const mapping={version:1,id:'heading-shift',provenance:{kind:'readEvidenceComparison',id:'independent-shift'},origin:binding(from),destination:binding(to),entries:[{source:source.id,target:target.id,kind:'paragraph',tabId:'tab-a',segment:{kind:'body'},sourceEvidenceDigest:source.evidence.digest,targetEvidenceDigest:target.evidence.digest}]};
    assert.equal(selectors.evaluateLogicalIdentity(from,to,seal(mapping),source.id).target,target.id);
    assert.deepEqual(source.extent,{start:1,end:8});assert.deepEqual(target.extent,{start:4,end:11});
    assert.deepEqual(to.evidence.tabs[0].documentTab.inlineObjects,from.evidence.tabs[0].documentTab.inlineObjects);
  } finally {await w.close();}
});
for(const fault of ['digest','snapshot','missing','wrongKind','wrongScope','duplicateSource','mergedTarget','ordinal','wrongCell','provenance']) {
  test(`B read-evidence identity rejects ${fault}`,()=>fixture(({from,to,source,mapping})=>{
    const bad=structuredClone(mapping),entry=bad.entries[0];
    if(fault==='digest')bad.origin.evidenceDigest='0'.repeat(64);
    if(fault==='snapshot')bad.destination.snapshotId=from.binding.snapshotId;
    if(fault==='missing')entry.target='missing';
    if(fault==='wrongKind')entry.kind='paragraph';
    if(fault==='wrongScope')entry.segment={kind:'header',id:'h'};
    if(fault==='duplicateSource')bad.entries.push({...entry});
    if(fault==='mergedTarget')bad.entries.push({...entry,source:Object.values(from.nodes).find(n=>n.kind==='tableCell'&&n.origin.row===0).id});
    if(fault==='ordinal')entry.target=2;
    if(fault==='wrongCell'){
      const wrong=Object.values(to.nodes).find(n=>n.kind==='tableCell'&&n.origin.row===1);
      entry.target=wrong.id;entry.targetEvidenceDigest=wrong.evidence.digest;
    }
    if(fault==='provenance')bad.provenance={verifiedStage:true};
    assert.equal(typeof selectors.evaluateLogicalIdentity,'function');
    assert.throws(()=>selectors.evaluateLogicalIdentity(from,to,seal(bad),source.id));
  }));
}
