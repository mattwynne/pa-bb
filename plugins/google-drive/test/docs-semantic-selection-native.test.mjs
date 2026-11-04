import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureCase} from '../features/docs/support/fixture-cases.mjs';
import { selectionFixture } from '../features/docs/coverage/selection-fixtures.mjs';
import { selectionCompanionCases,executeSelectionNative,compareSelectionNative } from '../features/docs/coverage/selection-native.mjs';
const records=selectionCompanionCases.map(fixtureCase);
for(const caseId of selectionCompanionCases)test('registered selection '+caseId,async()=>{const r=records.find(r=>r.caseId===caseId),f=JSON.parse(JSON.stringify(selectionFixture(r))),t=await executeSelectionNative(r,f);const bad=structuredClone(t);bad.nativeCalls.shift();assert.throws(()=>compareSelectionNative(r,f,bad));
 if(['C016','C017'].includes(r.ledgerId))for(const fault of ['runs','ancestors','paragraphs','cursor']){const b=structuredClone(t);if(fault==='runs'||fault==='ancestors')for(const d of b.persisted.deliveries)d.data.selection[fault]=fault==='runs'?[[0,1]]:[];else if(fault==='cursor'){const c=b.steps.flatMap(s=>s.after.cursors).find(c=>c.state.request.operation!=='inspect');assert.ok(c);c.state.selection.runs=[[0,1]];}else for(const [i,s]of b.steps.entries())if(s.name==='docs_read'&&s.value?.coverage){s.value.records=s.value.records.filter(r=>r.kind!=='paragraph');s.result.content[0].text=JSON.stringify(s.value);b.nativeCalls[i].result=structuredClone(s.result);const a=b.invocations.find(a=>a.name==='docs_read'&&JSON.stringify(a.parsedArgs)===JSON.stringify(s.args));assert.ok(a);a.output=structuredClone(s.result);}assert.throws(()=>compareSelectionNative(r,f,b),undefined,fault);}
});
