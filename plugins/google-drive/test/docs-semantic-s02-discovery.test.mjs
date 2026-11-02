import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { executeDiscovery,compareDiscovery } from '../features/docs/coverage/discovery-execution.mjs';
const directory=new URL('../features/docs/coverage/fixtures/s02-discovery/',import.meta.url),copy=x=>JSON.parse(JSON.stringify(x));
for(const name of readdirSync(directory).filter(n=>n.endsWith('.json')&&!n.startsWith('C165.fileMetadata'))){
 const f=JSON.parse(readFileSync(new URL(name,directory))),ledgerId=f.caseId.split('.')[0],record={caseId:f.caseId,ledgerId,base:f.variant,outcomeVariant:f.outcome,requestedMode:'read',operation:ledgerId==='C001'?'docs_inspect.kind':ledgerId==='C002'?'docs_inspect.tabs':'docs_inspect.provenance'};
 test(`actual discovery and independent oracle ${f.caseId}`,async()=>{
  const trace=copy(await executeDiscovery(record,f));assert.ok(compareDiscovery(record,f,trace));
  function rejects(change,reason){const t=copy(trace);change(t);assert.throws(()=>compareDiscovery(record,f,t),reason);}
  rejects(t=>{t.boundary.layer='native';},/fixed S02 discovery application boundary/);
  rejects(t=>{t.events=t.events.slice(1);});
  rejects(t=>{const e=t.events[0];e.calls=e.calls.some(c=>c.operation==='metadata')?e.calls.filter(c=>c.operation!=='metadata'):[];});
  rejects(t=>{const e=t.events[0];if(e.initial.result?.coverage)e.initial.result.coverage.readProof=true;else if(e.initial.result)e.initial.result.kind='wrong';else e.initial.error='wrong';});
  if(trace.events[0].initial.failure)rejects(t=>{t.events[0].initial.failure.guidance='PRIVATE_FAILURE';},/independently authored bounded failure/);
  if(trace.events[0].model)rejects(t=>{t.events[0].model.tabs.splice(1,1);});
  if(trace.events[0].pages){
   rejects(t=>{t.events[0].initial.result.coverage.readProof=true;},/actual first diagnostic output binding/);
   rejects(t=>{const e=t.events[0];e.initial.result.view='acceptedPreview';for(const p of e.pages)p.view='acceptedPreview';},/independent complete diagnostic envelope/);
   rejects(t=>{const e=t.events[0];e.initial.result.revision={kind:'docs',id:'foreign',subject:'other'};for(const p of e.pages)p.revision={kind:'docs',id:'foreign',subject:'other'};},/independent complete diagnostic envelope/);
   rejects(t=>{t.events[0].pages.at(-1).records.pop();},/independent complete diagnostic tab inventory/);
   rejects(t=>{t.events[0].state.work[0][1]--;},/exact diagnostic traversal work/);
   const counterfeit=copy(f);counterfeit.primary={...counterfeit.control};assert.throws(()=>compareDiscovery(record,counterfeit,trace),/exact discovery outcome branch/);
  }
 });
}
