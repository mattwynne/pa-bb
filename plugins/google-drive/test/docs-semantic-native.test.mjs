import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticWorld,semanticAccount,semanticScope,semanticVector } from '../features/docs/support/semantic-world.mjs';
import { readSemanticJson } from '../adapters/docs-semantic.mjs';
import { normalizeMapped,findLiteral,resolveSelector } from '../core/docs-semantic/selectors.mjs';
import { materialize } from '../core/docs-semantic/model.mjs';
const account=semanticAccount;
async function withWorld(fn,options){const w=new SemanticWorld();try{await w.init(options);await fn(w);}finally{await w.close();}}
const args=(snapshotId,more={})=>({account,snapshotId,scope:semanticScope,format:'structured',styles:true,review:true,...more});
test('native registry is real, strict and excludes future formats/raw mutation flags',()=>withWorld(async w=>{
  const snapshotId=(await w.inspect()).snapshotId;
  for(const extra of [{format:'markdown'},{format:'html'},{rawMask:'body'},{force:true},{startIndex:1}])await assert.rejects(()=>w.call('docs_read',args(snapshotId,extra)),/arguments are invalid/);
  await assert.rejects(()=>w.call('docs_find',{account,snapshotId,scope:semanticScope,query:{regex:'a+'}}),/arguments are invalid/);
  assert.equal(w.calls.length,5);
}));
test('five-minute cursors are single use, scope bound and not broad read authority',()=>withWorld(async w=>{
  const snapshotId=(await w.inspect()).snapshotId,first=await w.call('docs_read',args(snapshotId));
  assert.ok(first.nextCursor);assert.equal(first.complete,false);assert.equal(first.coverage.editReady,false);
  const bad=await w.call('docs_read',{account,snapshotId:'wrong-snapshot',cursor:first.nextCursor});assert.equal(bad.outcome,'unavailable');
  const second=await w.call('docs_read',{account,snapshotId,cursor:first.nextCursor});assert.ok(second.records.length);
  const replay=await w.call('docs_read',{account,snapshotId,cursor:first.nextCursor});assert.equal(replay.outcome,'unavailable');
  const seen=[...first.records,...second.records];let next=second.nextCursor;
  while(next){const p=await w.call('docs_read',{account,snapshotId,cursor:next});seen.push(...p.records);next=p.nextCursor;}
  assert.equal(new Set(seen.map(n=>n.id)).size,seen.length);
  const start=await w.call('docs_read',args(snapshotId));w.clock=300000;
  assert.equal((await w.call('docs_read',{account,snapshotId,cursor:start.nextCursor})).outcome,'unavailable');
},{pageBytes:8000}));
test('view returned by provider must match requested projection',()=>withWorld(async w=>{
  const r=await w.inspect({view:'acceptedPreview'});assert.equal(r.outcome,'unavailable');assert.equal(r.category,'conflict');
}));
test('malformed successful GET never acquires a snapshot, scalar-invalid bytes refused',()=>withWorld(async w=>{
  w.document={documentId:'doc-a',tabs:[]};assert.equal((await w.inspect()).outcome,'unavailable');assert.equal(w.store.semanticSnapshots.stats().snapshots,0);
  await assert.rejects(()=>readSemanticJson(new Response(Buffer.from([0xff]))),/corrupt/);
}));
test('swallowed HTTP contract error fails teardown and still closes SQLite',async()=>{
  const w=new SemanticWorld();await w.init();const db=w.host.bb.storage.database();
  await assert.rejects(()=>w.fetch('https://unexpected.example.test/',{headers:{authorization:'Bearer PRIVATE_TOKEN'}}));
  await assert.rejects(()=>w.close(),/unacknowledged/);assert.equal(db.open,false);
});
test('literal policies carry invertible scalar/grapheme source maps',()=>{
  const cases=[['“A”\u00a0  —','typographic','exact','"A" -'],['Cafe\u0301','nfc','exact','Café'],['ΣςſKßẞıİᎠꭰﬅ','exact','simpleCaseFold','σσskßßıİᎠᎠﬆ'],['אב😀','exact','exact','אב😀']];
  for(const [text,normalization,casePolicy,expected]of cases){const mapped=normalizeMapped(text,normalization,casePolicy);assert.equal(mapped.text,expected);assert.equal(mapped.boundaries.get(expected.length),text.length);}
  assert.equal(normalizeMapped('e\u0301','nfc').boundaries.has(1),true);
  assert.equal(normalizeMapped('😀').boundaries.has(1),false);
  assert.throws(()=>normalizeMapped('\ud800'),/scalar/);
});
test('cardinality never silently chooses first; span has inclusive sibling semantics',()=>{
  const d=structuredClone(semanticVector.document);const e=d.tabs[0].documentTab.body.content[2].paragraph.elements;e[0].textRun.content='Old ';e[1].textRun.content='Old abc\n';
  const m=materialize({document:d,metadata:semanticVector.metadata,binding:{snapshotId:'snap-a',subject:'s',account,threadId:'t',documentId:'doc-a',view:'inline',retrievedAt:0},reviewIncluded:true});
  assert.equal(resolveSelector(m,semanticScope,{text:{literal:'Old'}}).status,'ambiguous');
  assert.equal(resolveSelector(m,semanticScope,{text:{literal:'Old',cardinality:{occurrence:0}}}).candidates[0].extent.start,7);
  assert.equal(resolveSelector(m,semanticScope,{text:{literal:'Old',cardinality:{all:2}}}).status,'resolved');
  assert.equal(resolveSelector(m,semanticScope,{text:{literal:'Old',cardinality:{all:3}}}).status,'ambiguous');
  assert.equal(findLiteral(m,semanticScope,{literal:'Old',limit:1}).truncated,true);
  const paras=Object.values(m.nodes).filter(n=>n.kind==='paragraph'&&n.tabId==='tab-a'&&n.segment.kind==='body'&&m.nodes[n.parent]?.kind==='segment');
  assert.deepEqual(resolveSelector(m,semanticScope,{span:{from:paras[0].id,to:paras[1].id}}).nodes,paras.slice(0,2).map(n=>n.id));
});
