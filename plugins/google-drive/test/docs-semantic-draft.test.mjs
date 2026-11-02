import test from 'node:test';
import assert from 'node:assert/strict';
import {materialize} from '../core/docs-semantic/model.mjs';
import {planParagraphBold} from '../core/docs-semantic/planner/paragraph-bold.mjs';
import {compileParagraphBold} from '../core/docs-semantic/compiler/paragraph-bold.mjs';
import {compareParagraphBold} from '../core/docs-semantic/verification/paragraph-bold.mjs';
import {createDraftService} from '../core/docs-semantic/drafts.mjs';
import {DRAFT_LIMITS,draftHash}  from '../core/docs-semantic/draft-policy.mjs';
import {createMemoryDraftJournal} from '../features/docs/support/memory-draft-journal.mjs';
import {exerciseDraftJournal} from '../features/docs/support/draft-journal-contract.mjs';
import {createMemorySnapshots} from '../features/docs/support/memory-snapshots.mjs';
import {draftOwner as owner,draftBinding as binding,validDraftDocument,boldAfter,boldRequest,operationKeys} from './docs-semantic-draft-fixtures.mjs';
const model=(document=validDraftDocument())=>materialize({document,metadata:{id:binding.documentId,capabilities:{canEdit:true}},binding,reviewIncluded:true});
const target=s=>Object.values(s.nodes).find(n=>n.kind==='paragraph').id;
const input=s=>({requestId:'bold-1',snapshotId:binding.snapshotId,mode:'direct',command:{op:'paragraphBold',node:target(s),bold:true}});
function setup(options={}){const snapshots=createMemorySnapshots().port,s=model();snapshots.put(s,0);const journal=createMemoryDraftJournal({snapshots,limits:options.limits??DRAFT_LIMITS});let now=1,i=0;const service=createDraftService({snapshots,journal,clock:()=>now,ids:()=>operationKeys[i++],...options});return {s,snapshots,journal,service,setTime:v=>{now=v;}};}
test('real whole-paragraph bold plan, UTF16 compiler and independent complete preservation comparison',()=>{
 const s=model(),plan=planParagraphBold(s,input(s).command);assert.equal(plan.kind,'paragraphBold');assert.deepEqual(plan.effect.changes.map(c=>[c.before,c.after]),[[false,true],[false,true]]);assert.deepEqual(compileParagraphBold(plan),boldRequest);
 assert.deepEqual(compareParagraphBold({plan,before:s,after:boldAfter()}),{matched:true,changesMatched:true,preservationMatched:true,attribution:'notEstablished'});
 for(const change of [d=>{d.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.textStyle.italic=false;},d=>{d.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.content='Lost\n';},d=>{d.tabs[0].documentTab.body.content[0].paragraph.elements[1].textRun.textStyle.bold=false;},d=>{d.futureUnknown={changed:true};}]){const d=boldAfter();change(d);assert.equal(compareParagraphBold({plan,before:s,after:d}).matched,false);}
 const altered=structuredClone(plan);altered.target.range.endIndex=5;assert.throws(()=>compileParagraphBold(altered),/corrupt/);
});
test('actual no-write new draft -> same-request recovery -> cross-thread status -> cancel/tombstone',()=>{
 const {s,service,snapshots,setTime}=setup(),a=service.plan(owner,input(s));assert.equal(a.state,'draft');assert.equal(a.thisCall.providerMutationCount,0);assert.equal(a.claim,'none');assert.ok(a.proposal.effect.changes.length);
 assert.deepEqual(service.plan(owner,input(s)),a);assert.throws(()=>service.plan(owner,{...input(s),command:{...input(s).command,bold:false}}),/request_conflict/);
 assert.deepEqual(service.status({...owner,threadId:'another-thread'},{draftId:a.draftId}),a);assert.deepEqual(service.status(owner,{requestId:'bold-1'}),a);
 assert.throws(()=>service.cancel({...owner,threadId:'another-thread'},{draftId:a.draftId,expectedDraftHash:a.draftHash}),/owner/);
 assert.throws(()=>service.cancel(owner,{draftId:a.draftId,expectedDraftHash:'0'.repeat(64)}),/head/);
 setTime(600001);assert.throws(()=>snapshots.get(binding.snapshotId,owner,600001));assert.ok(snapshots.readPinned(binding.snapshotId,owner,a.operationId,600001));assert.equal(service.status(owner,{draftId:a.draftId}).state,'draft');
 const c=service.cancel(owner,{draftId:a.draftId,expectedDraftHash:a.draftHash});assert.equal(c.state,'cancelled');assert.deepEqual(service.cancel(owner,{draftId:a.draftId,expectedDraftHash:a.draftHash}),c);assert.deepEqual(service.plan(owner,input(s)),c);
 assert.throws(()=>service.status({...owner,subject:'other'},{draftId:a.draftId}),/unknown/);
});
test('planning failure consumes request and key; no caller-resolved plan; expiry does not erase history',()=>{
 const {s,service,setTime}=setup();const bad={...input(s),command:{...input(s).command,node:'missing'}};const rejected=service.plan(owner,bad);assert.equal(rejected.state,'rejected');assert.equal(rejected.submission,'not_sent');assert.deepEqual(service.status(owner,{requestId:'bold-1'}),rejected);assert.deepEqual(service.plan(owner,bad),rejected);assert.throws(()=>service.plan(owner,input(s)),/request_conflict/);
 assert.throws(()=>service.plan(owner,{...input(s),requestId:'other',plan:{verified:true}}),/invalid/);
 setTime(1800001);assert.equal(service.status(owner,{draftId:rejected.draftId}).state,'rejected');
 const late=service.plan(owner,{...input(s),requestId:'expired-source'});assert.equal(late.state,'rejected');
});
test('incomplete/list/review/unknown/newline evidence fails closed with a supported control',()=>{
 const good=model();assert.equal(planParagraphBold(good,input(good).command).effect.witnessSatisfied,true);
 for(const mutate of [d=>{d.commentsViewMode='COMMENTS_VIEW_MODE_UNSPECIFIED';},d=>{d.tabs[0].documentTab.body.content[0].paragraph.bullet={listId:'list-a'};},d=>{d.tabs[0].documentTab.body.content[0].paragraph.elements[0].suggestedInsertionIds=['suggestion-a'];},d=>{d.tabs[0].documentTab.body.content[0].paragraph.futureField='unknown';}]){const d=validDraftDocument();mutate(d);const s=model(d);assert.throws(()=>planParagraphBold(s,input(s).command));}
});
test('shared logical draft journal contract on memory ports',()=>{const snapshots=createMemorySnapshots().port,journal=createMemoryDraftJournal({snapshots});assert.equal(exerciseDraftJournal({snapshots,journal,snapshot:model(),owner,keys:operationKeys}).state,'cancelled');});
test('memory publication pin failure leaves a recoverable no-write rejection, not a fabricated draft',()=>{
 const real=createMemorySnapshots(),s=model();real.port.put(s,0);const snapshots=new Proxy(real.port,{get(t,k){return k==='pin'?()=>{throw Error('PRIVATE_PIN_TOKEN');}:t[k];}}),journal=createMemoryDraftJournal({snapshots}),logs=[],service=createDraftService({snapshots,journal,clock:()=>1,ids:()=>operationKeys[0],diagnose:(...a)=>logs.push(a)});
 const r=service.plan(owner,input(s));assert.equal(r.state,'rejected');assert.equal(r.error,'storage');assert.equal(journal.byId(owner,r.operationId).plan,null);assert.equal(real.observe().pins,0);assert.ok(!JSON.stringify(logs).includes('PRIVATE'));
});
test('opaque disjoint material is preserved; verifier refuses changed unknown material or a forged expectation',()=>{
 const beforeDoc=validDraftDocument(),after=boldAfter();beforeDoc.tabs[0].documentTab.body.content.push({startIndex:11,endIndex:12,futureOpaque:{private:'keep'}});after.tabs[0].documentTab.body.content.push({startIndex:11,endIndex:12,futureOpaque:{private:'keep'}});
 const s=model(beforeDoc),plan=planParagraphBold(s,input(s).command);assert.equal(compareParagraphBold({plan,before:s,after}).matched,true);after.tabs[0].documentTab.body.content[2].futureOpaque.private='changed';assert.equal(compareParagraphBold({plan,before:s,after}).matched,false);
 const forged=structuredClone(plan);forged.verification.bold=false;const {integrity,...body}=forged;forged.integrity=draftHash(body);assert.throws(()=>compareParagraphBold({plan:forged,before:s,after:boldAfter()}),/corrupt/);
});
test('wrong-owner authoring, expired source, canonical input identity and sealed lifetime/budget facts',()=>{
 const {s,service,setTime}=setup();const a=service.plan({...owner,threadId:'foreign'},input(s));assert.equal(a.state,'rejected');
 const b=service.plan(owner,{command:input(s).command,mode:'direct',snapshotId:binding.snapshotId,requestId:'canonical'});assert.equal(b.state,'draft');assert.equal(b.proposal.lifecycle.createdAt,1);assert.equal(b.proposal.lifecycle.expiresAt,b.expiresAt);assert.equal(b.proposal.lifecycle.budgets.version,1);assert.deepEqual(service.plan(owner,{...input(s),requestId:'canonical'}),b);
 setTime(600000);const c=service.plan(owner,{...input(s),requestId:'expired-new'});assert.equal(c.state,'rejected');assert.equal(c.error,'snapshot');
});
test('versioned bounded admission retains keys at capacity and rejects plan excess without GC',()=>{
 const x=setup({limits:{...DRAFT_LIMITS,records:1}}),a=x.service.plan(owner,input(x.s));assert.equal(a.state,'draft');assert.throws(()=>x.service.plan(owner,{...input(x.s),requestId:'second'}),/capacity/);assert.equal(x.service.status(owner,{draftId:a.draftId}).state,'draft');
 const y=setup({limits:{...DRAFT_LIMITS,planBytes:64}}),b=y.service.plan(owner,input(y.s));assert.equal(b.state,'rejected');assert.equal(b.error,'budget');
});
