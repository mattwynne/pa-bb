import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materialize } from '../core/docs-semantic/model.mjs';
import { resolveScope, findLiteral, resolveSelector, parseDocument } from '../core/docs-semantic/selectors.mjs';
import { project } from '../core/docs-semantic/reader.mjs';
const fixture = JSON.parse(readFileSync(new URL('../features/docs/coverage/fixtures/snapshot-vector.json', import.meta.url)));
const binding = { snapshotId:'snap-a', subject:'subject-a', account:'writer@example.test', threadId:'thread-a', documentId:'doc-a', view:'inline', retrievedAt:0 };
const model = (document = fixture.document) => materialize({ document, metadata:fixture.metadata, binding, reviewIncluded:true });
const scope = { tabs:{ids:['tab-a']}, segments:[{kind:'body'}] };
test('loss-aware graph retains ordered tabs, segments, exact evidence and immutable identity', () => {
  const m = model();
  assert.deepEqual(m.tabs.map(t=>t.providerId), fixture.expected.tabIds);
  assert.deepEqual(m.tabs[0].segments.map(id=>m.nodes[id].segment.kind), fixture.expected.segmentKinds);
  assert.deepEqual(m.evidence, fixture.document); assert.notEqual(m.evidence, fixture.document);
  assert.ok(Object.isFrozen(m.evidence.tabs[0].documentTab.body.content));
  assert.throws(()=>{m.binding.subject='other';});
  const unknown = Object.values(m.nodes).find(n=>n.kind==='opaque');
  assert.deepEqual(unknown.extent,{start:45,end:46}); assert.equal(unknown.opaqueType,'futureBlock');
  assert.match(unknown.evidence.digest,/^[a-f0-9]{64}$/);
  assert.ok(m.unknownFields.some(x=>x.field==='futureDocumentField'));
  assert.equal(m.revision.kind,'docs'); assert.equal(m.revision.subject,'subject-a');
});
test('text concatenates adjacent runs and rich nested cells without object placeholders',()=>{
  const m=model(), p=project(m, resolveScope(m,scope), {format:'text',styles:true,review:true});
  assert.equal(p.records.filter(r=>r.kind==='text').map(r=>r.text).join(''),fixture.expected.bodyText);
  assert.doesNotMatch(JSON.stringify(p.records),/\[TABLE\]|\[IMAGE\]|CHIP_LABEL/);
  assert.ok(p.losses.some(l=>l.kind==='nonText'));
  const tables=Object.values(m.nodes).filter(n=>n.kind==='table'); assert.equal(tables.length,2);
  assert.equal(tables[0].grid[0][0],tables[0].children.map(id=>m.nodes[id])[0].children[0]);
});
test('omit-images does not silently discard unknown inline objects',()=>{
  const m=model();const p=project(m,resolveScope(m,scope),{format:'structured',omitImages:true});
  assert.ok(p.losses.some(l=>l.kind==='omittedImage'));assert.ok(!p.records.some(r=>r.kind==='inlineObjectElement'));
  const d=structuredClone(fixture.document);d.tabs[0].documentTab.inlineObjects['image-a'].inlineObjectProperties.embeddedObject={futureDrawing:{keep:true}};
  const unknown=model(d),q=project(unknown,resolveScope(unknown,scope),{format:'structured',omitImages:true});
  assert.ok(q.records.some(r=>r.kind==='inlineObjectElement'));assert.ok(!q.losses.some(l=>l.kind==='omittedImage'));
});
test('comments mode omission never masquerades as complete review coverage',()=>{
  const d=structuredClone(fixture.document);delete d.commentsViewMode;assert.equal(model(d).missingReviewCoverage,true);
  const m=model(),run=Object.values(m.nodes).find(n=>n.text==='Old ');assert.equal(run.review.comments[0].commentId,'comment-a');
  assert.deepEqual(m.registries.comments,fixture.document.comments);
});
test('named style inheritance and unknown defaults stay distinct',()=>{
  const m=model(), text=Object.values(m.nodes).find(n=>n.text==='Old ');
  assert.deepEqual(text.style.properties.bold,{value:true,provenance:'direct'});
  assert.deepEqual(text.style.properties.fontSize,{value:{magnitude:11,unit:'PT'},provenance:'named',source:'NORMAL_TEXT'});
  assert.equal(text.style.absent,'unknown'); assert.equal(text.style.properties.underline,undefined);
});
test('outline has peer section extents, paths and canonical deep links',()=>{
  const m=model(), h=m.outline.find(h=>h.providerId==='h-a');
  assert.deepEqual({id:h.providerId,level:h.level,title:h.title,start:h.extent.start,end:h.extent.end},fixture.expected.heading);
  assert.deepEqual(h.path,['Terms']); assert.match(h.link,/tab=tab-a.*heading=h-a/);
  const selection=resolveSelector(m,scope,{section:{headingId:'h-a',includeHeading:false}});
  assert.equal(selection.status,'resolved'); assert.ok(!selection.nodes.includes(h.node));
  assert.ok(!selection.nodes.includes(m.outline.find(h=>h.providerId==='h-b').node));
});
test('literal selection crosses styles but never chips, paragraphs or sibling scopes',()=>{
  const m=model(), match=findLiteral(m,scope,{literal:'Old terms'});
  assert.equal(match.count,1); assert.deepEqual(match.candidates[0].extent,{start:7,end:16});
  for(const literal of ['ABC','😀\nAB','Sibling']) assert.equal(findLiteral(m,scope,{literal}).count,0);
  assert.equal(findLiteral(m,scope,{literal:'terms'}).readProof,false);
});
test('explicit scope and snapshot handles cannot be silently rebound',()=>{
  const m=model(); assert.throws(()=>resolveScope(m,{}),/scope/);
  assert.equal(resolveScope(m,{tabs:{path:['Terms']},segments:[{kind:'body'}]}).status,'ambiguous');
  assert.throws(()=>resolveScope(m,{tabs:{ordinal:0,snapshotId:'old'},segments:[{kind:'body'}]}),/snapshot/);
  const old=Object.values(m.nodes).find(n=>n.kind==='paragraph').id;
  const next=materialize({document:fixture.document,metadata:fixture.metadata,binding:{...binding,snapshotId:'snap-b'},reviewIncluded:true});
  assert.equal(resolveSelector(next,scope,{node:old}).status,'missing');
  assert.deepEqual(parseDocument('https://docs.google.com/document/d/doc-a/edit?tab=tab-a'),{documentId:'doc-a',urlTab:'tab-a'});
  assert.throws(()=>resolveScope(m,scope,'tab-b'),/conflict/);
});
test('no revision and preview views never acquire CAS authority',()=>{
  const d=structuredClone(fixture.document);delete d.revisionId;
  assert.deepEqual(model(d).revision,{kind:'unavailable',reason:'notProvided'});
  const m=materialize({document:{...fixture.document,suggestionsViewMode:'PREVIEW_SUGGESTIONS_ACCEPTED'},metadata:fixture.metadata,binding:{...binding,view:'acceptedPreview'},reviewIncluded:false});
  assert.equal(m.currentEditEvidence,false);assert.equal(m.missingReviewCoverage,true);
});
test('bounded parser refuses scalar corruption, index mismatch, excessive depth and nodes',()=>{
  const bad=structuredClone(fixture.document);bad.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content='\ud800';
  assert.throws(()=>model(bad),/scalar/);
  const mismatch=structuredClone(fixture.document);mismatch.tabs[0].documentTab.body.content[1].paragraph.elements[0].endIndex=99;
  assert.throws(()=>model(mismatch),/extent/);
  for(const budgets of [{nodes:5},{depth:2},{providerBytes:100}]) assert.throws(()=>materialize({document:fixture.document,metadata:fixture.metadata,binding,reviewIncluded:true,budgets}),/budget/);
});
