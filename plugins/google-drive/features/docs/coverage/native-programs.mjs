// Exact trusted local invariant programs; fixtures cannot choose a driver/layer/program.
const groups=[['C179','authority.subjectPin','authority-dispatch','K5.local-epochs',['perOperationPin']],['C185','transport.oneAttempt','transport-boundary','transport.single-attempt',['networkLoss','noRepair','noRollback']],['C187','executor.authorityDispatch','durable-executor','K4.stage-facts',['tokeninfoBarrier','policyAwait','intentPersistence','preDispatchEpoch','cancellation','expiry']],['C188','authority.identityScope','authority-dispatch','K5.local-epochs',['noScopeExpansion','refreshRace']],['C189','executor.revisionRoutes','durable-executor','K4.stage-facts',['contentRequiredRevision','noRebuild','ownSubjectRevision']],['C191','journal.claims','sqlite-operation-journal','K4-K6.receipt-claims',['accessConflict','crossAccountDocument','oldNewFamily','sealAcquire','reopenHeld']],['C192','executor.stageFacts','durable-executor','K4.stage-facts',['notSent','intentCrashUnknown','dispatchRejected','acknowledged','read403AfterAck','ackSaveFailure','currentCallMutationCount']],['C194','verifier.independence','independent-verifier','verification.obligations',['documentedNormalizationOnly']],['C200','approval.policy','approval-application','K1.effects-policy',['cancel','decline','disabledStanding','enabledCard','expiry','malformed','noSyntheticOwnerApproval','policyChange']]];
export const nativeBindings=()=>Object.fromEntries(groups.flatMap(([,op,driver,schema,bases])=>bases.map(base=>[`${op}/${base}__local`,{driver,schema,mode:'local',action:'nativeExecution',outcomes:['success','counterexample']}])));
export const nativeRecords=()=>groups.flatMap(([id,op,driver,schema,bases])=>bases.flatMap(base=>['success','counterexample'].map(outcome=>({ledgerId:id,operation:op,base,driver,schema,requestedMode:'local',outcomeVariant:outcome,caseId:`${id}.${base}__local.${outcome}`,key:`${id}/${op}/${base}__local/${outcome}`}))));
// Measured first normal tranche: whole pairs, preserving the original72 proposal.
export const normalNativeRecords=()=>nativeRecords().filter(r=>r.ledgerId==='C187'||r.ledgerId==='C192'||r.ledgerId==='C194'||r.ledgerId==='C200'&&['cancel','enabledCard'].includes(r.base));
export function isNativeOutcome(r){return normalNativeRecords().some(x=>x.key===r?.key);}
export const normalNativeBindings=()=>Object.fromEntries(Object.entries(nativeBindings()).filter(([key])=>normalNativeRecords().some(r=>`${r.operation}/${r.base}__local`===key)));
// Labels select only fixed technical actions. They never contain service answers.
export function nativeProgram(r){const found=nativeRecords().find(x=>x.key===r.key);if(!found||found.driver!==r.driver||found.schema!==r.schema||r.requestedMode!=='local')throw Error('No exact native invariant program');const n=r.outcomeVariant==='counterexample',b=r.base;
 switch(b){
 case 'perOperationPin':return n?['sourceSubjectDrift','sourceAccountDrift']:['pinned'];
 case 'networkLoss':return n?['physicalLost']:['physicalComplete'];
 case 'noRepair':return n?['afterMismatch','afterDenied']:['noRepairExact'];
 case 'noRollback':return n?['physicalLost']:['definiteRejection'];
 case 'tokeninfoBarrier':return n?['tokenAccountEpoch','tokenPolicyEpoch']:['stableToken'];
 case 'policyAwait':return n?['finalPolicyEpoch']:['stablePolicy'];
 case 'intentPersistence':return n?['physicalIntentKill']:['physicalCommittedIntent'];
 case 'preDispatchEpoch':return n?['synchronousVeto']:['intentFetchMicrotask'];
 case 'cancellation':return n?['signalAbort']:['signalApproved'];
 case 'expiry':return r.ledgerId==='C187'?(n?['prepareExpired']:['prepareJustBefore']):(n?['ownerExpired']:['ownerJustBefore']);
 case 'noScopeExpansion':return n?['readOnlyScope']:['editScope'];
 case 'refreshRace':return n?['tokenIdentityEpoch']:['mechanicalRotation'];
 case 'contentRequiredRevision':return n?['currentRevisionDrift']:['requiredRevision'];
 case 'noRebuild':return n?['currentRevisionDrift','physicalR3']:['physicalNoRebuild'];
 case 'ownSubjectRevision':return n?['identityAfterRead']:['ownRevision'];
 case 'accessConflict':return n?['sharingBothOrders','filingBothOrders']:['commonAncestry'];
 case 'crossAccountDocument':return n?['otherSubjectSameDocument']:['otherDocument'];
 case 'oldNewFamily':return n?['legacyBothOrders']:['copySource'];
 case 'sealAcquire':return n?['producedHeaderCorrupt','producedRefCorrupt','producedRightsCorrupt']:['atomicSeal'];
 case 'reopenHeld':return n?['physicalIntentKill','physicalLost']:['physicalVerifiedReopen'];
 case 'notSent':return n?['lateVetoForbidden']:['synchronousVeto'];
 case 'intentCrashUnknown':return n?['physicalIntentKill','physicalPreAckKill']:['physicalComplete'];
 case 'dispatchRejected':return n?['appliedLost','malformedReply']:['definiteRejection'];
 case 'acknowledged':return n?['afterR3','afterMismatch']:['ownAck'];
 case 'read403AfterAck':return n?['physicalDenied']:['physicalComplete'];
 case 'ackSaveFailure':return n?['eventInsertFault','blobInsertFault']:['atomicAck'];
 case 'currentCallMutationCount':return n?['physicalLost']:['physicalCount'];
 case 'documentedNormalizationOnly':return n?['weightUnusedRoot','weightExplicitOverride','weightScalar','weightV1Strict']:['weightNamed'];
 case 'cancel':return n?['nativeCancelled']:['nativeApproved'];
 case 'decline':return n?['nativeDeclined']:['nativeApproved'];
 case 'disabledStanding':return n?['standingPolicyEpoch']:['standing'];
 case 'enabledCard':return n?['pendingDuplicate']:['visibleCard'];
 case 'malformed':return n?['nativeExtra','nativeBadType']:['nativeApproved'];
 case 'noSyntheticOwnerApproval':return n?['standing','nativeCancelled']:['nativeApproved'];
 case 'policyChange':return n?['nativePolicyEpoch','finalPolicyEpoch']:['stablePolicy'];
 default:throw Error('Unimplemented native variant');}
}
