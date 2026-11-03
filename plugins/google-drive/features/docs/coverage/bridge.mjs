// Only this module writes the runner-owned descriptor. Steps receive a reference,
// never a receipt constructor or mutable execution record. This is a trusted test
// harness boundary, NOT protection against malicious repository code/FD writes.
import assert from 'node:assert/strict';
import { readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixtureFile, digest } from './audit.mjs';
import { expand } from './expand.mjs';
import { executeAdapter, productionInventory } from './execution-adapters.mjs';
import { publicationGuard } from './execution-journal.mjs';
import { createInventoryContext,referenceReceipt } from './inventory-envelope.mjs';
const checkPublication=publicationGuard();
const completed=new Set();
let inventory,context;
export async function executeBridgeCase(root,pickle,testCaseStartedId,caseId) {
  assert.equal(pickle.name.match(/\[(C\d{3}\.[^\]]+)\]$/)?.[1],caseId,'execution case identity');
  assert.ok(!completed.has(caseId),'execution replay');completed.add(caseId);
  const manifest=JSON.parse(readFileSync(join(root,'features/docs/coverage/obligations.json')));
  const record=expand(manifest).find(r=>r.caseId===caseId);assert.ok(record,'unknown case');
  const candidate=pickle.tags.some(t=>t.name==='@bridgeCandidate');
  const index=JSON.parse(readFileSync(join(root,candidate?'features/docs/coverage/bridge-cases.json':'features/docs/coverage/fixtures/index.json')));
  const entry=index[caseId];assert.ok(entry,'missing bridge fixture');
  const fixture=fixtureFile(root,entry);assert.ok(!fixture.auditControlOnly,'synthetic auditControlOnly fixture forbidden on product intake');
  assert.equal(fixture.caseId,caseId,'fixture case');
  const runId=process.env.DOCS_ACCEPTANCE_RUN_ID,sourceDigest=process.env.DOCS_ACCEPTANCE_SOURCE_DIGEST;
  assert.ok(runId&&sourceDigest&&process.env.DOCS_EXECUTION_FD==='3','runner-owned execution channel required');
  inventory??=await productionInventory();
  if(!context){context=createInventoryContext({inventory,runId,sourceDigest});checkPublication(context);writeSync(3,JSON.stringify(context)+'\n');}
  const trace=await executeAdapter({...record,bridgeCandidate:candidate},fixture,inventory,{runId,sourceDigest,fixtureDigest:entry.sha256,role:'primary',pickleId:pickle.id,astNodeIds:pickle.astNodeIds,uri:pickle.uri,testCaseStartedId});
  // Publish only after independent comparison AND actual transport/SQLite
  // teardown. Interrupted execution has no completed record and earns nothing.
  const ref=randomUUID(),receipt={ref,runId,sourceDigest,caseId,key:record.key,driver:record.driver,schema:record.schema,requestedMode:record.requestedMode,
    observedOutcome:record.outcomeVariant,fixtureId:caseId,fixtureDigest:entry.sha256,fixtureProvenance:entry.provenance,
    pickleId:pickle.id,astNodeIds:pickle.astNodeIds,uri:pickle.uri,testCaseStartedId,inventory,trace};
  const reference=referenceReceipt(receipt,context);
  checkPublication(reference);
  writeSync(3,JSON.stringify(reference)+'\n');
  return {ref,runId,sourceDigest,caseId,key:record.key,driver:record.driver,schema:record.schema,requestedMode:record.requestedMode,
    kind:record.kind,observedOutcome:record.outcomeVariant,fixtureId:caseId,fixtureDigest:entry.sha256,executionDigest:digest(JSON.stringify(trace))};
}
