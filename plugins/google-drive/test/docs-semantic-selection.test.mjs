import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand } from '../features/docs/coverage/expand.mjs';
import { selectionFixture } from '../features/docs/coverage/selection-fixtures.mjs';
import { isSelection,executeSelection,compareSelection } from '../features/docs/coverage/selection-execution.mjs';
const manifest=JSON.parse(readFileSync(new URL('../features/docs/coverage/obligations.json',import.meta.url))),records=expand(manifest).filter(r=>r.earliestSlice==='S02'&&isSelection(r));
assert.equal(records.length,53);
for(const r of records)test(r.key,async()=>{const f=JSON.parse(JSON.stringify(selectionFixture(r))),trace=await executeSelection(r,f);for(const fault of ['omitted','boundary','answer']){const t=structuredClone(trace);if(fault==='omitted')t.events.shift();if(fault==='boundary')t.boundary.layer='native';if(fault==='answer'){const e=t.events.find(e=>e.value?.nodes||e.value?.resolved||e.value?.target);if(e)e.value={status:'resolved'};else t.events.at(-1).outline[0].providerId='counterfeit';}assert.throws(()=>compareSelection(r,f,t),undefined,fault);}if(r.base==='transformedIdentity')for(const fault of ['origin','destination','source','stale']){const t=structuredClone(trace),call=t.localCalls.find(c=>c.operation==='evaluateLogicalIdentity');if(fault==='origin')call.model.binding.subject='counterfeit';if(fault==='destination')call.args.destination.binding.snapshotId='counterfeit';if(fault==='source')call.args.logicalSource='origin:4';if(fault==='stale')t.localCalls.at(-1).model.binding.snapshotId='counterfeit';assert.throws(()=>compareSelection(r,f,t),undefined,fault);}});
