import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticWorld, semanticAccount, semanticScope } from '../features/docs/support/semantic-world.mjs';
import { selectorDocument } from '../features/docs/support/selectors-b-checks.mjs';
import { resolveSelector, normalizeMapped, SEARCH_LIMITS } from '../core/docs-semantic/selectors.mjs';
const owner={subject:'subject-a',account:semanticAccount,threadId:'thread-a'};
async function native(document,run) {
  const w=new SemanticWorld();w.document=document;await w.init();
  try {
    const inspected=await w.inspect();assert.ok(inspected.snapshotId,JSON.stringify(inspected));
    const input={account:semanticAccount,snapshotId:inspected.snapshotId,scope:semanticScope};
    await run(w,input,inspected);
    assert.deepEqual(w.store.semanticSnapshots.get(input.snapshotId,owner,0).evidence,document);
  } finally {await w.close();}
}
const heading=(start,end,text,id,level)=>({startIndex:start,endIndex:end,paragraph:{paragraphStyle:{headingId:id,namedStyleType:`HEADING_${level}`},elements:[{startIndex:start,endIndex:end,textRun:{content:text}}]}});
function nestedDocument() {
  const d=selectorDocument(),tab=d.tabs[0].documentTab;
  tab.body.content=[heading(1,5,'Top\n','top',1),{startIndex:5,endIndex:20,table:{rows:1,columns:1,tableRows:[{startIndex:6,endIndex:20,tableCells:[{startIndex:7,endIndex:20,content:[heading(8,13,'Deep\n','deep',3),heading(13,18,'Peer\n','peer',2)]}]}]}},heading(20,25,'Stop\n','stop',1)];
  tab.headers={header:{content:[heading(1,5,'Top\n','top',1)]}};
  return d;
}
test('B native nested heading levels/depth and exclusive next peer/higher boundaries stay segment-local',()=>native(nestedDocument(),async(w,input)=>{
  for(const [selector,expected] of [
    [{section:{headingId:'top',includeHeading:false}},'Deep\nPeer\n'],
    [{section:{path:['Top'],includeHeading:true}},'Top\nDeep\nPeer\n'],
    [{section:{path:['Top','Deep'],level:3,depth:1,includeHeading:false}},''],
    [{section:{headingId:'deep',includeHeading:true}},'Deep\n'],
    [{section:{headingId:'deep',before:{headingId:'stop'},includeHeading:false}},'Peer\n'],
    [{section:{headingId:'peer',includeHeading:false}},'']
  ]) {
    const r=await w.call('docs_read',{...input,selector,format:'text'});
    assert.equal(r.complete,true,JSON.stringify(r));assert.equal(r.records.map(n=>n.text??'').join(''),expected);
    assert.equal(r.coverage.editReady,false);
    const [receipt]=w.store.semanticSnapshots.deliveries(input.snapshotId,owner,0,[r.coverage.deliveryToken]);
    assert.deepEqual(receipt.nodes,r.coverage.delivered.nodes);assert.deepEqual(receipt.nodeAspects,r.coverage.delivered.nodeAspects);
  }
  const r=await w.call('docs_find',{...input,scope:{tabs:{ids:['tab-a']},segments:[{kind:'body'},{kind:'header'}]},selector:{heading:{headingId:'top'}}});
  assert.equal(r.status,'ambiguous');assert.equal(r.candidates.length,2);
  const bad=await w.call('docs_read',{...input,selector:{section:{headingId:'top',before:{headingId:'absent'},includeHeading:false}},format:'text'});
  assert.equal(bad.selection.status,'missing');assert.equal(bad.selection.boundary,'explicitEnd');assert.equal(bad.coverage,undefined);
}));
test('B native duplicate heading text/path never becomes first substring',()=>{
  const d=selectorDocument();d.tabs[0].documentTab.body.content.push(heading(25,32,'Market\n','second',1));
  return native(d,async(w,input)=>{
    for(const selector of [{heading:{text:'Market'}},{heading:{path:['Market']}}]){
      const r=await w.call('docs_find',{...input,selector});assert.equal(r.status,'ambiguous');assert.equal(r.candidates.length,2);
    }
    const missing=await w.call('docs_find',{...input,selector:{heading:{text:'Mark'}}});assert.equal(missing.status,'missing');
    const exact=await w.call('docs_find',{...input,selector:{heading:{headingId:'second'}}});assert.equal(exact.status,'resolved');
  });
});
test('B native inclusive sibling span and wrong-parent/reversed/missing/stale handles',()=>native(selectorDocument(),async(w,input,inspected)=>{
  const snapshot=w.store.semanticSnapshots.get(input.snapshotId,owner,0);
  const blocks=snapshot.nodes[snapshot.tabs[0].segments[0]].children;
  const from=blocks[0],to=blocks[1];
  const result=await w.call('docs_read',{...input,selector:{span:{from,to}},format:'text'});
  assert.equal(result.records.map(n=>n.text??'').join(''),'Market\nA😀 e\u0301\u00a0\u2009אב!\n');
  const reversed=await w.call('docs_find',{...input,selector:{span:{from:to,to:from}}});assert.equal(reversed.category,'scope');
  const child=snapshot.nodes[from].children[0];
  for(const selector of [{span:{from,to:child}},{span:{from,to:'missing'}},{node:'missing'}]){
    const r=await w.call('docs_find',{...input,selector});assert.equal(r.status,'missing');
  }
  const next=await w.inspect();
  const stale=await w.call('docs_find',{...input,snapshotId:next.snapshotId,selector:{node:from}});assert.equal(stale.status,'missing');
  const ordinal=await w.call('docs_find',{...input,snapshotId:next.snapshotId,scope:{...semanticScope,tabs:{ordinal:0,snapshotId:inspected.snapshotId}},selector:{heading:{text:'Market'}}});assert.equal(ordinal.category,'snapshot');
}));
test('B native preorder ordinal differs from provider sibling index; URL conflict and no implicit tab',()=>{
  const d=selectorDocument();
  const child=structuredClone(d.tabs[0]);child.tabProperties={tabId:'child',title:'Child',parentTabId:'tab-a',index:9,nestingLevel:1};d.tabs[0].childTabs=[child];
  const sibling=structuredClone(child);sibling.tabProperties={tabId:'sibling',title:'Sibling',index:1,nestingLevel:0};d.tabs.push(sibling);
  return native(d,async(w,input)=>{
    const all=await w.inspect({scope:{...semanticScope,tabs:{all:true}}});
    assert.deepEqual(all.tabs.map(t=>[t.id,t.ordinal,t.siblingIndex]),[['tab-a',0,7],['child',1,9],['sibling',2,1]]);
    const r=await w.call('docs_find',{...input,scope:{...semanticScope,tabs:{ordinal:1,snapshotId:input.snapshotId}},selector:{heading:{text:'Market'}}});
    assert.equal(r.status,'resolved');const s=w.store.semanticSnapshots.get(input.snapshotId,owner,0);assert.equal(s.nodes[r.nodes[0]].tabId,'child');
    const conflict=await w.inspect({document:'https://docs.google.com/document/d/doc-a/edit?tab=child'});assert.equal(conflict.category,'conflict');
    const good=await w.inspect({document:'https://docs.google.com/document/d/doc-a/edit?tab=tab-a'});assert.ok(good.snapshotId);
    await assert.rejects(w.call('docs_inspect',{account:semanticAccount,document:'doc-a',scope:{segments:[{kind:'body'}]}}));
  });
});
test('B cardinality default one, occurrence zero, all exact count, type boundaries',()=>{
  const d=selectorDocument();d.tabs[0].documentTab.body.content[1]={startIndex:8,endIndex:16,paragraph:{elements:[{startIndex:8,endIndex:16,textRun:{content:'cat cat\n'}}]}};
  return native(d,async(w,input)=>{
    for(const [cardinality,status,count,starts] of [[undefined,'ambiguous',2,[8,12]],[{exactly:1},'ambiguous',2,[8,12]],[{occurrence:0},'resolved',2,[8]],[{occurrence:1},'resolved',2,[12]],[{occurrence:2},'missing',2,[]],[{all:2},'resolved',2,[8,12]],[{all:3},'ambiguous',2,[8,12]]]){
      const r=await w.call('docs_find',{...input,selector:{text:{literal:'cat',...(cardinality?{cardinality}:{})}}});
      assert.equal(r.status,status);assert.equal(r.count,count);assert.deepEqual(r.candidates.map(c=>c.extent.start),starts);
    }
    const model=w.store.semanticSnapshots.get(input.snapshotId,owner,0);
    for(const value of [0,-1,1.1,'1',Number.MAX_SAFE_INTEGER+1]){
      assert.throws(()=>resolveSelector(model,semanticScope,{heading:{headingId:'market',level:value}}));
      assert.throws(()=>resolveSelector(model,semanticScope,{text:{literal:'cat',cardinality:{exactly:value}}}));
    }
    for(const cardinality of [{all:0},{occurrence:'0'},{exactly:1,all:2}])await assert.rejects(w.call('docs_find',{...input,selector:{text:{literal:'cat',cardinality}}}));
  });
});

// Expected source UTF-16 intervals are authored alongside small literal inputs.
const vectors=[
  ['nonBMP','x😀y','😀','exact','exact',[[2,4,'😀']]],
  ['NFC composed','e\u0301','é','nfc','exact',[[1,3,'e\u0301']]],
  ['no implicit NFC','e\u0301','é','exact','exact',[]],
  ['no accent removal','é','e','nfc','exact',[]],
  ['reordered whole','a\u0315\u0300','à\u0315','nfc','exact',[[1,4,'a\u0315\u0300']]],
  ['reordered partial','a\u0315\u0300','à','nfc','exact',[]],
  ['typographic spaces','a\u00a0 \u2009b','a b','typographic','exact',[[1,6,'a\u00a0 \u2009b']]],
  ['typographic space boundary','a\u00a0 \u2009b',' ','typographic','exact',[[2,5,'\u00a0 \u2009']]],
  ['typographic punctuation','“a”—b','"a"-b','typographic','exact',[[1,6,'“a”—b']]],
  ['no implicit fold','CAT','cat','exact','exact',[]],
  ['simple fold','CAT','cat','exact','simpleCaseFold',[[1,4,'CAT']]],
  ['simple not full fold','ß','ss','exact','simpleCaseFold',[]],
  ['capital sharp S','ẞ','ß','exact','simpleCaseFold',[[1,2,'ẞ']]],
  ['sigma','ςΣ','σσ','exact','simpleCaseFold',[[1,3,'ςΣ']]],
  ['Turkic distinct','ıİ','ii','exact','simpleCaseFold',[]],
  ['RTL exact','אבג','ב','exact','exact',[[2,3,'ב']]],
  ['combining exact','e\u0301','\u0301','exact','exact',[[2,3,'\u0301']]]
];
for(const [name,text,literal,normalization,casePolicy,expected] of vectors)test(`B native source mapping ${name}`,()=>{
  const d=selectorDocument();d.tabs[0].documentTab.body.content=[{startIndex:1,endIndex:text.length+2,paragraph:{elements:[{startIndex:1,endIndex:text.length+2,textRun:{content:text+'\n'}}]}}];
  return native(d,async(w,input)=>{
    const r=await w.call('docs_find',{...input,query:{literal,normalization,casePolicy}});
    assert.equal(r.count,expected.length,JSON.stringify(r));assert.deepEqual(r.candidates.map(c=>[c.extent.start,c.extent.end,c.text]),expected);
    assert.equal(r.readProof,false);
  });
});
for(const boundary of ['adjacent','gap','chip','paragraph'])test(`B native literal boundary ${boundary}`,()=>{
  const d=selectorDocument();
  const first={startIndex:1,endIndex:2,textRun:{content:'a',textStyle:{bold:true}}};
  const second={startIndex:boundary==='adjacent'||boundary==='paragraph'?2:3,endIndex:boundary==='adjacent'||boundary==='paragraph'?3:4,textRun:{content:'b',textStyle:{italic:true}}};
  const elements=boundary==='chip'?[first,{startIndex:2,endIndex:3,person:{personProperties:{name:'UNTRUSTED_LABEL'}}},second]:[first,second];
  d.tabs[0].documentTab.body.content=boundary==='paragraph'?[
    {startIndex:1,endIndex:2,paragraph:{elements:[first]}},{startIndex:2,endIndex:3,paragraph:{elements:[second]}}
  ]:[{startIndex:1,endIndex:second.endIndex,paragraph:{elements}}];
  return native(d,async(w,input)=>{
    const r=await w.call('docs_find',{...input,query:{literal:'ab'}});assert.equal(r.count,boundary==='adjacent'?1:0);
    if(boundary==='adjacent'){assert.deepEqual(r.candidates[0].extent,{start:1,end:3});assert.equal(r.candidates[0].runs.length,2);}
  });
});
test('B native bounded context keeps nonBMP scalars intact and match overrun refuses safely',()=>{
  const d=selectorDocument(),text='😀'.repeat(40)+'needle'+'😀'.repeat(40)+' cat'.repeat(501);
  d.tabs[0].documentTab.body.content=[{startIndex:1,endIndex:text.length+1,paragraph:{elements:[{startIndex:1,endIndex:text.length+1,textRun:{content:text}}]}}];
  return native(d,async(w,input)=>{
    const r=await w.call('docs_find',{...input,query:{literal:'needle'}});
    assert.deepEqual(r.candidates[0].extent,{start:81,end:87});assert.equal(r.candidates[0].context,'😀'.repeat(20)+'needle'+'😀'.repeat(20));
    const overrun=await w.call('docs_find',{...input,query:{literal:'cat',limit:1}});assert.equal(overrun.category,'budget');
    const logs=JSON.stringify(w.host.harness.logEntries);assert.doesNotMatch(logs,/PRIVATE_|needle|writer@example/);
  });
});
test('B scalar, normalization and context work bounds are finite before expensive allocation',()=>{
  assert.throws(()=>normalizeMapped('x'.repeat(SEARCH_LIMITS.runUnits+1)),/budget/);
  assert.throws(()=>normalizeMapped('x'.repeat(SEARCH_LIMITS.nfcUnits+1),'nfc'),/budget/);
  assert.throws(()=>normalizeMapped('a'+'\u0300'.repeat(SEARCH_LIMITS.clusterUnits),'nfc'),/budget/);
  assert.equal(normalizeMapped('a'+'\u0300'.repeat(SEARCH_LIMITS.clusterUnits-1),'nfc').text.length,SEARCH_LIMITS.clusterUnits-1);
  assert.throws(()=>normalizeMapped('\ud800'),/scalar/);assert.throws(()=>normalizeMapped('\udfff'),/scalar/);
});
