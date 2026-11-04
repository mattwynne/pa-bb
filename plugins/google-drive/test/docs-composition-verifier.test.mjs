import test from 'node:test';
import assert from 'node:assert/strict';
import {astralMixedVector} from './docs-composition-vectors.mjs';
import {draftOwner as owner,draftBinding,operationKeys} from './docs-semantic-draft-fixtures.mjs';
import {materialize} from '../core/docs-semantic/model.mjs';
import {familyInput} from '../core/docs-semantic/composition-policy.mjs';
import {planParagraphComposition,commandProvenance,closedParts} from '../core/docs-semantic/planner/paragraph-composition.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
import {compileParagraphComposition} from '../core/docs-semantic/compiler/paragraph-composition.mjs';
import {compareParagraphComposition} from '../core/docs-semantic/verification/paragraph-composition.mjs';
import {weightVector} from './docs-semantic-weight-vectors.mjs';

// Real model + planner, no SDK/database/journal needed to test compiler/verifier.
function model(vector){return materialize({document:vector.before,metadata:{id:'draft-doc',capabilities:{canEdit:true}},binding:draftBinding,reviewIncluded:true});}
function planMixed(snapshot,content,style){
 const id=operationKeys[0],initial={family:'content',request:{account:owner.account,draft:{kind:'new',requestId:'mixed',destination:{snapshotId:draftBinding.snapshotId},mode:'direct'},commands:content}};
 const first=planParagraphComposition(snapshot,familyInput(initial.request,'content'),{origin:{draftId:id,initial},provenance:commandProvenance(id,initial),anchor:1000});
 const extension={family:'style',request:{account:owner.account,draft:{kind:'extend',draftId:id,expectedDraftHash:draftHash(first)},commands:style}};
 return planParagraphComposition(snapshot,[...first.parts.map(p=>p.command),...familyInput(extension.request,'style')],{origin:first.origin,extensions:[extension],provenance:[...first.parts.map(p=>p.provenance),...commandProvenance(id,extension,'extend',draftHash(first))],anchor:1000,existing:closedParts({plan:first})});
}
test('literal astral/shortening + bold in multiple tabs: whole BLOCK order and full raw preservation',()=>{
 const vector=astralMixedVector(),snapshot=model(vector),nodes=Object.values(snapshot.nodes).filter(n=>n.kind==='paragraph'),a=nodes.filter(n=>n.tabId==='tab-a'),b=nodes.find(n=>n.tabId==='tab-b');
 const plan=planMixed(snapshot,[{op:'replace',target:{node:a[0].id},oldText:'😀',newText:'🙂🙂'},{op:'replace',target:{node:a[2].id},oldText:'old',newText:'x'}],[a[1],b].map(n=>({op:'text',target:{node:n.id},set:{bold:true}})));
 assert.deepEqual(compileParagraphComposition(plan),vector.wire);
 assert.deepEqual(plan.parts.map(p=>p.command.node),[a[0].id,a[2].id,a[1].id,b.id]);
 assert.equal(compareParagraphComposition({plan,before:snapshot,after:vector.after}).matched,true);
 const mutations=[d=>{d.opaqueMetadata.startIndex=1001;},d=>{d.tabs[1].documentTab.opaqueTab.endIndex=778;},d=>{d.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle={alignment:'CENTER'};},d=>{d.tabs[0].documentTab.body.content[3].paragraph.elements[0].textRun.textStyle.italic=true;},d=>{d.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content='A\ud83dXX\n';},d=>{d.tabs[0].documentTab.body.content[1].startIndex=6;},d=>{d.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.content='y Z\n';},d=>{d.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.bold=false;},d=>{d.tabs[1].documentTab.body.content[0].paragraph.elements[0].textRun.textStyle.bold=false;},d=>{d.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.extra='UNLISTED';},d=>{d.suggestionResponses=[];},d=>{d.tabs[0].documentTab.body.content.push({startIndex:21,endIndex:22,paragraph:{elements:[{startIndex:21,endIndex:22,textRun:{content:'\n'}}]}});},d=>{d.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content='A🙂🙂 ';}];
 const original=JSON.stringify(snapshot);
 for(const [i,mutate]of mutations.entries()){const after=structuredClone(vector.after);mutate(after);assert.equal(compareParagraphComposition({plan,before:snapshot,after}).matched,false,'independent mutant '+i);}
 assert.equal(JSON.stringify(snapshot),original,'compiler/verifier leave source untouched');
 const corrupt=structuredClone(plan);corrupt.parts[0].target.range.startIndex++;assert.throws(()=>compileParagraphComposition(corrupt),/corrupt/);
});
test('replacement /2 documented-weight400 and active named owners do not normalize opaque/unselected fields',()=>{
 const vector=weightVector('named',true);
 for(const d of [vector.before,vector.after])d.tabs[0].documentTab.namedStyles.styles.push({namedStyleType:'UNUSED',textStyle:{weightedFontFamily:{fontFamily:'Unused'}}});
 vector.after.tabs[0].documentTab.body.content[2].paragraph.elements[0].textRun.textStyle.bold=false;
 const snapshot=model(vector),p=Object.values(snapshot.nodes).filter(n=>n.kind==='paragraph'&&n.tabId==='tab-a');
 const plan=planMixed(snapshot,[{op:'replace',target:{node:p[1].id},oldText:'old',newText:'newer'}],[{op:'text',target:{node:p[2].id},set:{bold:false}}]);
 assert.equal(plan.parts[0].capabilityVersion,'paragraph-replace/2');assert.equal(compareParagraphComposition({plan,before:snapshot,after:vector.after}).matched,true);
 const materialized=structuredClone(vector.after);materialized.tabs[0].documentTab.namedStyles.styles[0].textStyle.weightedFontFamily.weight=400;assert.equal(compareParagraphComposition({plan,before:snapshot,after:materialized}).matched,true);
 for(const change of [d=>{d.opaqueMetadata.weightedFontFamily.weight=400;},d=>{d.tabs[0].documentTab.namedStyles.styles[1].textStyle.weightedFontFamily.weight=400;}]){const after=structuredClone(vector.after);change(after);assert.equal(compareParagraphComposition({plan,before:snapshot,after}).matched,false);}
});
