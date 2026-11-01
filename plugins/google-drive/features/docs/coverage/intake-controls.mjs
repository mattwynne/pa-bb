// One bounded current-run product-intake control set, not a new runner or saved
// pass. All positives below come from this invocation's actual Cucumber journal.
import assert from 'node:assert/strict';
import { assertProductIntake } from './product-intake.mjs';
import { expand } from './expand.mjs';
import { digest } from './audit.mjs';
const selected=['C013.exact__read.success','C012.crossRun__read.success','C009.overrun__local.counterexample','C009.empty__local.success','C006.refuseRawMask__capability.refused','C001.nativeDoc__read.success'];
export function assertIntakeFaultControls(input){
  const records=new Map(expand(input.manifest).map(r=>[r.caseId,r])),results=selected.map(id=>{const r=input.results.find(r=>r.caseId===id);assert.ok(r,'current intake control case missing');return r;}),receipts=results.map(r=>input.receipts.find(x=>x.ref===r.ref));
  const operations={};for(const result of results){if(result.pickle.tags.some(t=>t.name==='@bridgeCandidate'))continue;const r=records.get(result.caseId);operations[r.operation]??={variants:{}};operations[r.operation].variants[r.semanticVariant]=input.registry.operations[r.operation].variants[r.semanticVariant];}
  const keys=new Set(results.map(r=>r.key)),manifest={...input.manifest,expansion:{...input.manifest.expansion,deliveryOverrides:Object.fromEntries(Object.entries(input.manifest.expansion.deliveryOverrides).filter(([key])=>keys.has(key)))}};
  const base={...input,manifest,registry:{operations,exposed:[]},results,receipts};assertProductIntake(base);let controls=0;
  function rejects(change,reason){const altered={...base,results:[...results],receipts:[...receipts]};change(altered);assert.throws(()=>assertProductIntake(altered),reason);controls++;}
  function receiptChange(i,change){return altered=>{const r=structuredClone(altered.receipts[i]);change(r);altered.receipts[i]=r;};}
  for(const field of ['caseId','key','driver','schema','requestedMode','observedOutcome','fixtureId','fixtureDigest','runId','sourceDigest'])rejects(receiptChange(0,r=>{r[field]='counterfeit';}),new RegExp(`execution ${field} binding`));
  for(const [field,reason]of [['pickleId','execution pickle'],['uri','execution feature'],['astNodeIds','execution AST/Examples'],['testCaseStartedId','execution instance']])rejects(receiptChange(0,r=>{r[field]=field==='astNodeIds'?[]:'counterfeit';}),new RegExp(reason));
  rejects(receiptChange(0,r=>{r.inventory={...r.inventory,semanticExposure:['counterfeit']};}),/actual inventory drift/);
  rejects(receiptChange(0,r=>{r.fixtureProvenance={};}),/execution fixture provenance/);
  rejects(altered=>{altered.receipts=altered.receipts.slice(1);},/missing actual adapter invocation record/);
  rejects(altered=>{altered.results=[...altered.results,altered.results[0]];},/duplicate execution reuse/);
  rejects(altered=>{altered.receipts=[...altered.receipts,{...altered.receipts[0],ref:'orphan'}];},/orphan\/interrupted\/replayed execution record/);
  for(const [field,reason]of [['runId','stale execution run'],['sourceDigest','stale execution source']])rejects(altered=>{altered.results[0]={...altered.results[0],[field]:'old'};altered.receipts[0]={...altered.receipts[0],[field]:'old'};},new RegExp(reason));
  rejects(receiptChange(0,r=>{r.trace={...r.trace,events:[]};}),/execution observation digest/);
  function traceChange(i,change){return altered=>{const receipt=structuredClone(altered.receipts[i]);change(receipt.trace);altered.receipts[i]=receipt;altered.results[i]={...altered.results[i],executionDigest:digest(JSON.stringify(receipt.trace))};};}
  rejects(traceChange(0,t=>{t.events=[];}),/missing actual application invocation/);
  rejects(traceChange(0,t=>{t.boundary.layer='native';}),/fixed application boundary/);
  rejects(traceChange(1,t=>{t.events[0].id=receipts[0].trace.events[0].id;}),/reused application invocation/);
  rejects(traceChange(2,t=>{t.nativeCalls=[];}),/missing actual native call/);
  rejects(traceChange(2,t=>{t.localCalls=[];}),/missing actual local call/);
  rejects(traceChange(3,t=>{const from=t.localCalls[0].result.connectionId,to=receipts[2].trace.localCalls[0].result.connectionId;Object.assign(t,JSON.parse(JSON.stringify(t).replaceAll(JSON.stringify(from),JSON.stringify(to))));}),/reused actual C009 storage connection/);
  rejects(traceChange(3,t=>{const from=t.nativeCalls[0].id,to=receipts[2].trace.nativeCalls[0].id;Object.assign(t,JSON.parse(JSON.stringify(t).replaceAll(JSON.stringify(from),JSON.stringify(to))));}),/reused actual native schema invocation/);
  rejects(traceChange(4,t=>{t.nativeCalls=[];}),/actual raw-mask host calls/);
  rejects(traceChange(5,t=>{t.calls=[];}),/real registered tool|actual|length|strictly equal/);
  rejects(altered=>{altered.companions=undefined;},/missing required native\/persistence\/adapter companions/);
  rejects(altered=>{altered.companions={...altered.companions,sourceDigest:'old'};},/stale companion source/);
  return controls;
}
