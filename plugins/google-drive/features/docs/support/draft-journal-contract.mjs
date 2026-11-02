// Independently expected logical promises shared by memory and actual SQLite.
// This never claims physical durability, process death or provider dispatch.
import assert from 'node:assert/strict';
import {createDraftService} from '../../../core/docs-semantic/drafts.mjs';
export function exerciseDraftJournal({snapshots,journal,snapshot,owner,keys}){
 snapshots.put(snapshot,0);let now=1,index=0;
 const service=createDraftService({snapshots,journal,clock:()=>now,ids:()=>keys[index++]});
 const node=Object.values(snapshot.nodes).find(n=>n.kind==='paragraph').id;
 const input={requestId:'shared-contract',snapshotId:snapshot.binding.snapshotId,mode:'direct',command:{op:'paragraphBold',node,bold:true}};
 const result=service.plan(owner,input);
 assert.equal(result.state,'draft');assert.equal(result.operationId,keys[0]);assert.equal(result.submission,'not_sent');assert.equal(result.claim,'none');assert.equal(result.thisCall.providerMutationCount,0);
 assert.ok(Object.isFrozen(journal.byId(owner,keys[0]).plan));
 assert.deepEqual(service.plan(owner,input),result);
 assert.throws(()=>service.plan(owner,{...input,command:{...input.command,bold:false}}),/request_conflict/);
 assert.equal(service.status({...owner,threadId:'recovery-thread'},{draftId:result.draftId}).draftHash,result.draftHash);
 assert.throws(()=>service.cancel({...owner,threadId:'foreign-thread'},{draftId:result.draftId,expectedDraftHash:result.draftHash}),/owner/);
 now=600001;assert.throws(()=>snapshots.get(snapshot.binding.snapshotId,owner,now));assert.equal(snapshots.readPinned(snapshot.binding.snapshotId,owner,result.operationId,now).evidenceDigest,snapshot.evidenceDigest);
 const cancelled=service.cancel(owner,{draftId:result.draftId,expectedDraftHash:result.draftHash});assert.equal(cancelled.state,'cancelled');assert.deepEqual(service.cancel(owner,{draftId:result.draftId,expectedDraftHash:result.draftHash}),cancelled);
 assert.deepEqual(service.plan(owner,input),cancelled);
 now=1800001;assert.equal(service.status(owner,{draftId:result.draftId}).state,'cancelled');assert.equal(service.status(owner,{draftId:result.draftId}).expired,true);
 assert.throws(()=>service.status({...owner,subject:'unrelated-subject'},{draftId:result.draftId}),/unknown/);
 return {key:result.operationId,hash:result.draftHash,state:'cancelled',providerMutations:0};
}
