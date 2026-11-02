import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expand} from '../features/docs/coverage/expand.mjs';
import {fixtureFile,digest} from '../features/docs/coverage/audit.mjs';
import {draftCaseIds,draftNeedsSql,executeDraftApplication,compareDraftExecution} from '../features/docs/coverage/draft-execution.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),json=p=>JSON.parse(readFileSync(root+'/'+p)),fixtures=json('features/docs/coverage/draft-fixtures.json'),records=expand(json('features/docs/coverage/obligations.json')).filter(r=>draftCaseIds.includes(r.caseId)&&!draftNeedsSql(r));
for(const record of records)test(`guarded core/application paragraphBold/1 ${record.caseId}`,async()=>{const f=fixtureFile(root,fixtures[record.caseId]),trace=await executeDraftApplication(record,f);assert.ok(compareDraftExecution(record,f,trace));});
test('recomputed digest/hash cannot hide source, footprint, owner, native-label or result corruption',async()=>{
 const record=records.find(r=>r.caseId==='C027.sameRequestRecovery__local.success'),f=fixtureFile(root,fixtures[record.caseId]),trace=await executeDraftApplication(record,f);
 const faults=[t=>{t.events[0].result.proposal.sourceEvidence.paragraph.paragraph.elements[0].textRun.content='Z😀';},t=>{t.events[0].result.proposal.effect.footprint.dependencies=[];},t=>{t.events[0].args.owner.subject='foreign';},t=>{t.boundary.layer='native';},t=>{t.boundary.layer='application+sqlite-integration';t.boundary.ports.snapshots='file-SQLite';t.boundary.ports.journal='file-SQLite';},t=>{t.events[0].result.thisCall.providerMutationCount=1;}];
 for(const fault of faults){const t=structuredClone(trace);fault(t);const p=t.events[0].result.proposal,{integrity,...body}=p;p.integrity=draftHash(body);t.events[0].result.draftHash=draftHash(p);assert.ok(digest(JSON.stringify(t)));assert.throws(()=>compareDraftExecution(record,f,t));}
});
