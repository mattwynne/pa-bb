import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expand} from '../features/docs/coverage/expand.mjs';
import {fixtureFile,digest} from '../features/docs/coverage/audit.mjs';
import {draftCaseIds,draftNeedsSql,executeDraftApplication,compareDraftExecution} from '../features/docs/coverage/draft-execution.mjs';
import {executeDraftSqlite,compareDraftSqlite,executeDraftCompanions,compareDraftCompanions} from '../features/docs/coverage/draft-persistence.mjs';
import {draftHash} from '../core/docs-semantic/draft-policy.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),json=p=>JSON.parse(readFileSync(root+'/'+p)),fixtures=json('features/docs/coverage/draft-fixtures.json'),records=expand(json('features/docs/coverage/obligations.json')).filter(r=>draftCaseIds.includes(r.caseId));
assert.equal(records.length,30);assert.deepEqual(Object.keys(fixtures).sort(),[...draftCaseIds].sort());
for(const record of records)test(`unscored real ${record.caseId}`,async()=>{
 const f=fixtureFile(root,fixtures[record.caseId]),trace=await (draftNeedsSql(record)?executeDraftSqlite(record,f):executeDraftApplication(record,f));assert.ok(compareDraftExecution(record,f,trace));
 const missing=structuredClone(trace);missing.events.pop();assert.throws(()=>compareDraftExecution(record,f,missing),/missing\/orphan actual draft invocation/);
 const layer=structuredClone(trace);layer.boundary.nativeRegistration='registered';assert.throws(()=>compareDraftExecution(record,f,layer));
 const corrupted=structuredClone(trace);corrupted.providerAfter.documentId='wrong';const recomputed=digest(JSON.stringify(corrupted));assert.ok(recomputed);assert.throws(()=>compareDraftExecution(record,f,corrupted));
 if(trace.storage){const sql=structuredClone(trace);sql.storage.kind='memory';assert.throws(()=>compareDraftSqlite(record,f,sql),/memory\/fake evidence/);}
});
test('E1-E8 durable fresh argument, lineage, closed-plan, verifier and SQL counterfeit regressions',async()=>{
 const byId=id=>records.find(r=>r.caseId===id),app=byId('C027.sameRequestRecovery__local.success'),af=fixtureFile(root,fixtures[app.caseId]),trace=await executeDraftApplication(app,af);
 const rejects=(record,f,original,change,sql=false)=>{const t=structuredClone(original);change(t);assert.ok(digest(JSON.stringify(t)));assert.throws(()=>sql?compareDraftSqlite(record,f,t):compareDraftExecution(record,f,t));};
 rejects(app,af,trace,t=>{t.events[0].args={};});
 const issued=byId('C190.serverIssued__local.success'),sf=fixtureFile(root,fixtures[issued.caseId]),st=await executeDraftApplication(issued,sf);rejects(issued,sf,st,t=>{t.journalCalls=[];t.snapshotCalls=[];});rejects(issued,sf,st,t=>{t.journalCalls[1].sequence=t.snapshotCalls[0].sequence;});rejects(issued,sf,st,t=>{t.journalCalls[0].ownerEventId='orphan';});
 rejects(app,af,trace,t=>{const p=t.events[0].result.proposal;p.unreviewedField={force:true};const {integrity,...body}=p;p.integrity=draftHash(body);t.events[0].result.draftHash=draftHash(p);});
 const verify=byId('C194.exactFootprint__local.counterexample'),vf=fixtureFile(root,fixtures[verify.caseId]),vt=await executeDraftApplication(verify,vf);rejects(verify,vf,vt,t=>{t.events.find(e=>e.label==='italic').args.after=vf.after;});rejects(verify,vf,vt,t=>{t.events[0].args={};});
 const sql=byId('C191.draftNoClaim__local.success'),f=fixtureFile(root,fixtures[sql.caseId]),actual=await executeDraftSqlite(sql,f);
 rejects(sql,f,actual,t=>{t.storage.legacyCalls[1].args.operationId='b0000000-0000-4000-8000-000000000099';},true);
 for(const table of ['docs_semantic_draft_revisions','docs_semantic_pins'])rejects(sql,f,actual,t=>{t.storage.after[table].push(structuredClone(t.storage.after[table][0]));},true);
 for(const table of ['docs_semantic_draft_revisions','docs_semantic_pins'])rejects(sql,f,actual,t=>{const row=structuredClone(t.storage.after[table][0]);if(table==='docs_semantic_pins')row.owner='orphan';else row.operation_id='orphan';t.storage.after[table].push(row);},true);
 const selected=[sql],load=e=>fixtureFile(root,e),proof={sourceDigest:'regression-source',runId:'regression-run',producerPid:process.pid,cases:await executeDraftCompanions(selected,fixtures,load)};proof.cases[0].trace.storage.after.docs_semantic_draft_revisions.push(structuredClone(proof.cases[0].trace.storage.after.docs_semantic_draft_revisions[0]));assert.throws(()=>compareDraftCompanions(proof,selected,fixtures,load,'regression-source','regression-run'));
});
test('UNSEALED actual SQL evidence explicitly rejects either native stage table, not an unknown schema',async()=>{
 const record=records.find(r=>r.caseId==='C191.draftNoClaim__local.success'),f=fixtureFile(root,fixtures[record.caseId]),trace=await executeDraftSqlite(record,f);assert.ok(compareDraftSqlite(record,f,trace));
 for(const table of ['docs_semantic_stage_events','docs_semantic_stage_evidence']){assert.deepEqual(trace.storage.before[table],[]);assert.deepEqual(trace.storage.after[table],[]);const fake=structuredClone(trace);fake.storage.after[table].push(table==='docs_semantic_stage_events'?{operation_id:draftKeyForStage(),sequence:1,event:'{}',digest:'0'.repeat(64)}:{operation_id:draftKeyForStage(),kind:'reply',bytes:2,data:{codec:'sqlite-blob-hex/1',bytes:2,hex:'7b7d'},digest:'0'.repeat(64)});assert.throws(()=>compareDraftSqlite(record,f,fake),/UNSEALED draft controls never persist/);}
 function draftKeyForStage(){return trace.storage.after.docs_semantic_drafts[0].operation_id;}
});
test('E9-E10 fixed-program chronology and distinct SQL observations reject replay',async()=>{
 const app=records.find(r=>r.caseId==='C027.sameRequestRecovery__local.success'),af=fixtureFile(root,fixtures[app.caseId]),trace=await executeDraftApplication(app,af);assert.ok(compareDraftExecution(app,af,trace));
 const swapped=structuredClone(trace),first=swapped.events[0],second=swapped.events[1],a=first.completedSequence,b=second.completedSequence-a,map=n=>n<=a?n+b:n<=a+b?n-a:n;
 for(const o of [...swapped.events,...swapped.journalCalls,...swapped.snapshotCalls]){o.sequence=map(o.sequence);o.completedSequence=map(o.completedSequence);}assert.throws(()=>compareDraftExecution(app,af,swapped),/service chronology/);
 const record=records.find(r=>r.caseId==='C191.draftNoClaim__local.success'),f=fixtureFile(root,fixtures[record.caseId]),sql=await executeDraftSqlite(record,f);assert.ok(compareDraftSqlite(record,f,sql));
 const replay=structuredClone(sql);replay.storage.connections[0][1]=structuredClone(replay.storage.connections[0][0]);assert.throws(()=>compareDraftSqlite(record,f,replay),/observation sequence/);
 for(const change of [o=>{o.extra=true;},o=>{o.state.temp.metadata.extra=1;},o=>{o.state.main.metadata.page_count='x'.repeat(65);}]){const t=structuredClone(sql);change(t.storage.connections[0][1]);assert.throws(()=>compareDraftSqlite(record,f,t));}
 // Real reopened duplicate/status calls form a read-only observation interval.
 const rr=records.find(r=>r.caseId==='C190.identicalDuplicate__local.success'),rf=fixtureFile(root,fixtures[rr.caseId]),readonly=await executeDraftSqlite(rr,rf),pair=readonly.storage.connections.at(-1);assert.equal(pair[0].totalChanges,pair[1].totalChanges);assert.ok(compareDraftSqlite(rr,rf,readonly));
});
test('fixed companion joins reject omitted/stale/wrong-route/memory/replayed actual SQL evidence',async()=>{
 const selected=records.filter(r=>['C027.cancelDraft__local.success','C190.serverIssued__local.success'].includes(r.caseId)),load=e=>fixtureFile(root,e),proof={sourceDigest:'synthetic-unit-source',runId:'synthetic-unit-run',producerPid:process.pid,cases:await executeDraftCompanions(selected,fixtures,load)};
 const compare=p=>compareDraftCompanions(p,selected,fixtures,load,'synthetic-unit-source','synthetic-unit-run');assert.ok(compare(proof));
 assert.throws(()=>compare(null),/missing required/);assert.throws(()=>compare({...proof,producerPid:process.pid+1}),/actual parent producer PID/);assert.throws(()=>compare({...proof,sourceDigest:'old'}),/stale draft companion source/);assert.throws(()=>compare({...proof,runId:'old'}),/stale draft companion run/);assert.throws(()=>compare({...proof,cases:proof.cases.slice(1)}),/missing\/wrong draft outcome/);
 for(const change of [p=>{p.cases[0].fixtureDigest='old';},p=>{p.cases[0].trace.storage.kind='memory';},p=>{p.cases[0].trace.storage.after.docs_semantic_drafts=[];},p=>{p.cases[0].trace.boundary.layer='native';}]){const p=structuredClone(proof);change(p);assert.ok(digest(JSON.stringify(p)));assert.throws(()=>compare(p));}
 assert.throws(()=>compareDraftCompanions(proof,selected,fixtures,load,'synthetic-unit-source','synthetic-unit-run',[proof.cases[0].trace]),/reused draft (SQLite file|companion\/primary invocation)/);
});
test('fixed actual file SQLite companion executes every non-verifier outcome, not a passing suite flag',async()=>{
 for(const record of records.filter(r=>r.ledgerId!=='C194')){const f=fixtureFile(root,fixtures[record.caseId]),trace=await executeDraftSqlite(record,f);assert.ok(compareDraftSqlite(record,f,trace));const fake=structuredClone(trace);fake.storage.after.docs_semantic_drafts=[];if(trace.storage.after.docs_semantic_drafts.length)assert.throws(()=>compareDraftSqlite(record,f,fake),/SQL retained reservation count/);}
});
