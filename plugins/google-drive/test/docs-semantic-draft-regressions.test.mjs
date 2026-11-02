import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../core/docs-semantic/common.mjs';
import {materialize} from '../core/docs-semantic/model.mjs';
import {planParagraphBold} from '../core/docs-semantic/planner/paragraph-bold.mjs';
import {compileParagraphBold} from '../core/docs-semantic/compiler/paragraph-bold.mjs';
import {compareParagraphBold} from '../core/docs-semantic/verification/paragraph-bold.mjs';
import {draftHash,validateSaved} from '../core/docs-semantic/draft-policy.mjs';
import {createDraftService} from '../core/docs-semantic/drafts.mjs';
import {createMemoryDraftJournal} from '../features/docs/support/memory-draft-journal.mjs';
import {createMemorySnapshots} from '../features/docs/support/memory-snapshots.mjs';
import {draftOwner as owner,draftBinding as binding,validDraftDocument,boldAfter,operationKeys} from './docs-semantic-draft-fixtures.mjs';
const model=d=>materialize({document:d,metadata:{id:binding.documentId,capabilities:{canEdit:true}},binding,reviewIncluded:true});
const paragraphs=s=>Object.values(s.nodes).filter(n=>n.kind==='paragraph');
const input=(s,index=0)=>({requestId:'regression',snapshotId:binding.snapshotId,mode:'direct',command:{op:'paragraphBold',node:paragraphs(s)[index].id,bold:true}});
function rehash(p){const {integrity,...body}=p;p.integrity=draftHash(body);return p;}
const mutations={
 targetNode:(p,s)=>{p.target.node=paragraphs(s)[1].id;},
 targetPath:p=>{p.target.path[5]=1;},
 targetRange:p=>{p.target.range.startIndex=2;p.target.range.endIndex=7;},
 targetText:p=>{p.target.text='Z😀x\n';},
 commandNode:(p,s)=>{p.command.node=paragraphs(s)[1].id;},
 oldValue:p=>{p.effect.changes[0].before=true;},
 newValue:p=>{p.effect.changes[0].after=false;},
 dependency:p=>{p.effect.dependencies.nodes[0].parent='other';},
 oldProperty:p=>{p.effect.dependencies.nodes[0].properties.bold.value=true;},
 selector:(p,s)=>{p.effect.target.selector.node=paragraphs(s)[1].id;},
 footprint:p=>{p.effect.footprint.dependencies=[];},
 revision:p=>{p.effect.target.binding.revision.id='other';},
 registry:p=>{p.effect.dependencies.registryRecords.push({kind:'unknown',id:'missing'});},
 registryKind:p=>{p.effect.dependencies.registryRecords.push({id:'draft-snapshot:registry:999',kind:'unknown',category:'styles',providerId:'unknown',value:{},scopeRelation:'referenced'});},
 verification:p=>{p.verification.normalization=['allFields'];},
 capability:p=>{p.capabilityVersion='paragraph-bold/2';},
 lifetime:p=>{p.lifecycle.expiresAt++;},
 extra:p=>{p.force=true;},
 source:p=>{p.sourceEvidence.paragraph.paragraph.elements[0].textRun.content='B😀';p.sourceEvidence.digest=digest(p.sourceEvidence.paragraph);},
};
for(const [name,mutate]of Object.entries(mutations))test(`R1/R6 compiler and verifier reject rehashed ${name} contradiction`,()=>{
 const s=model(validDraftDocument()),p=structuredClone(planParagraphBold(s,input(s).command));mutate(p,s);rehash(p);
 assert.throws(()=>compileParagraphBold(p),/corrupt/);assert.throws(()=>compareParagraphBold({plan:p,before:s,after:boldAfter()}),/corrupt/);
});
test('R1 independent verifier rejects coherently falsified before facts despite valid plan checksums',()=>{
 const s=model(validDraftDocument()),p=structuredClone(planParagraphBold(s,input(s).command));
 p.sourceEvidence.paragraph.paragraph.elements[0].textRun.textStyle.bold=true;p.sourceEvidence.digest=digest(p.sourceEvidence.paragraph);p.effect.dependencies.nodes[0].storedStyle.bold=true;p.effect.dependencies.nodes[0].properties.bold.value=true;p.effect.changes[0].before=true;rehash(p);
 // Structural compilation is not evidence that these before facts were observed.
 assert.ok(compileParagraphBold(p));assert.throws(()=>compareParagraphBold({plan:p,before:s,after:boldAfter()}),/corrupt/);
});
test('R6 every saved result validates original request, snapshot, lifecycle and inner semantics',()=>{
 const s=model(validDraftDocument()),snapshots=createMemorySnapshots().port;snapshots.put(s,0);const journal=createMemoryDraftJournal({snapshots}),service=createDraftService({snapshots,journal,clock:()=>1,ids:()=>operationKeys[0]});const r=service.plan(owner,input(s)),saved=journal.byId(owner,r.operationId);
 for(const mutate of [x=>{x.record.snapshotId='other';},x=>{x.record.requestHash=draftHash({...input(s),command:{...input(s).command,bold:false}});},x=>{x.record.createdAt++;x.record.expiresAt++;},x=>{x.plan.integrity='0'.repeat(64);x.record.headHash=draftHash(x.plan);},x=>{x.plan.target.path[5]=1;rehash(x.plan);x.record.headHash=draftHash(x.plan);}]){const x=structuredClone(saved);mutate(x);assert.throws(()=>validateSaved(x),/corrupt/);}
});
for(const style of ['omitted','empty'])test(`R2 known inherited before ${style} style verifies without dropping unrelated properties`,()=>{
 const before=validDraftDocument(),tab=before.tabs[0].documentTab,p=tab.body.content[1];p.paragraph.paragraphStyle={namedStyleType:'NORMAL_TEXT'};tab.namedStyles={styles:[{namedStyleType:'NORMAL_TEXT',textStyle:{bold:false}}]};if(style==='omitted')delete p.paragraph.elements[0].textRun.textStyle;else p.paragraph.elements[0].textRun.textStyle={};
 const s=model(before),plan=planParagraphBold(s,input(s,1).command),after=structuredClone(before);after.revisionId='r2';after.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle={bold:true};assert.equal(compareParagraphBold({plan,before:s,after}).matched,true);
 after.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.italic=true;assert.equal(compareParagraphBold({plan,before:s,after}).matched,false);
});
for(const failAt of ['get','pin'])for(const throwingLogger of [false,true])test(`R4/R5 ${failAt} I/O failure and throwingLogger=${throwingLogger} preserves durable storage outcome`,()=>{
 const real=createMemorySnapshots(),s=model(validDraftDocument());real.port.put(s,0);const logs=[],snapshots=new Proxy(real.port,{get(t,k){return k===failAt?()=>{throw Error('PRIVATE_IO_SENTINEL');}:t[k];}}),journal=createMemoryDraftJournal({snapshots}),service=createDraftService({snapshots,journal,clock:()=>1,ids:()=>operationKeys[0],diagnose:(...args)=>{logs.push(args);if(throwingLogger)throw Error('PRIVATE_LOGGER_SENTINEL');}});
 const r=service.plan(owner,input(s));assert.equal(r.state,'rejected');assert.equal(r.error,'storage');assert.equal(service.status(owner,{requestId:'regression'}).operationId,operationKeys[0]);assert.equal(real.observe().pins,0);assert.ok(!JSON.stringify(logs).includes('PRIVATE'));assert.throws(()=>service.status(owner,{draftId:'bad'}),e=>e.draftCode==='invalid'&&!String(e).includes('PRIVATE'));
});
for(const late of [600000,1800001])test(`R4/R5 known publication expiry ${late} with failing logger remains snapshot refusal`,()=>{
 const snapshots=createMemorySnapshots().port,s=model(validDraftDocument());snapshots.put(s,0);let i=0;const journal=createMemoryDraftJournal({snapshots}),service=createDraftService({snapshots,journal,clock:()=>i++===0?(late===600000?599999:1):late,ids:()=>operationKeys[0],diagnose:()=>{throw Error('PRIVATE_LOGGER_SENTINEL');}});const r=service.plan(owner,input(s));assert.equal(r.state,'rejected');assert.equal(r.error,'snapshot');assert.equal(journal.byRequest(owner,'regression').plan,null);
});
