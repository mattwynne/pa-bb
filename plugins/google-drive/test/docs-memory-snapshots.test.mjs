import test from 'node:test';
import assert from 'node:assert/strict';
import {materialize} from '../core/docs-semantic/model.mjs';
import {createMemorySnapshots} from '../features/docs/support/memory-snapshots.mjs';
import {validDraftDocument,draftOwner,draftBinding} from './docs-semantic-draft-fixtures.mjs';
test('memory snapshot ingestion owns data; repeated reads share only the recursively immutable owned model',()=>{
 const original=structuredClone(materialize({document:validDraftDocument(),metadata:{id:draftBinding.documentId},binding:draftBinding,reviewIncluded:true})),memory=createMemorySnapshots().port;
 memory.put(original,0);const a=memory.get(draftBinding.snapshotId,draftOwner,1),b=memory.get(draftBinding.snapshotId,draftOwner,2);assert.equal(a,b);
 original.evidence.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content='forged';assert.equal(a.evidence.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content,'A😀');
 assert.throws(()=>{a.evidence.title='changed';},TypeError);
 assert.throws(()=>memory.get(draftBinding.snapshotId,{...draftOwner,subject:'other'},2),e=>e.semanticCode==='snapshot');
 assert.throws(()=>memory.get(draftBinding.snapshotId,draftOwner,600000),e=>e.semanticCode==='snapshot');
});
