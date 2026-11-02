// Fixed integration executions, shared by application outcomes. No fixture can
// choose a layer/driver or declare a boolean that establishes these guarantees.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../../../adapters/bb-store.mjs';
import { snapshotContractCases,captureSnapshotContract,compareSnapshotContract } from '../support/snapshot-contract.mjs';
import { sqliteContractObservation,compareSqliteContractObservation } from '../support/sqlite-contract-observations.mjs';
import { fixtureFile,digest } from './audit.mjs';
import { expand } from './expand.mjs';
import { executeNativeAdapter,compareNativeExecution } from './execution-adapters.mjs';
import { selectionCompanionCases,executeSelectionNative,compareSelectionNative } from './selection-native.mjs';
import { discoveryCompanionCases,executeDiscoveryNative,compareDiscoveryNative } from './discovery-native.mjs';
export const nativeCompanionCases=Object.freeze([
  'C003.footnote__read.success','C005.continuation__read.success','C006.styles__read.success','C007.nestedTable__read.success','C008.unknown__read.success',
  'C010.inline__read.success','C010.acceptedPreview__read.success','C010.rejectedPreview__read.success','C010.projectionNotEditProof__read.success',
  'C011.deniedComments__read.success','C011.missingReviewCoverage__read.success','C011.tabsAndInline__read.success',
  'C012.crossRun__read.success','C013.inverseMap__read.success','C015.explicitOccurrenceZero__local.success',
]);
const read=root=>{const json=p=>JSON.parse(readFileSync(join(root,p)));return {records:new Map(expand(json('features/docs/coverage/obligations.json')).map(r=>[r.caseId,r])),fixtures:json('features/docs/coverage/fixtures/index.json')};};
export async function executeCompanions(root,inventory,sourceDigest,runId){
  const {records,fixtures}=read(root),native=[];
  for(const caseId of nativeCompanionCases){const record=records.get(caseId),entry=fixtures[caseId],fixture=fixtureFile(root,entry),trace=await executeNativeAdapter(record,fixture,inventory);compareNativeExecution(record,fixture,trace);native.push({caseId,fixtureDigest:entry.sha256,trace});}
  const discovery=[];for(const caseId of discoveryCompanionCases){const record=records.get(caseId),entry=fixtures[caseId],trace=await executeDiscoveryNative(record,fixtureFile(root,entry));discovery.push({caseId,fixtureDigest:entry.sha256,trace});}
  const metadata=[];for(const outcome of ['success','invalid','preservation','bounds','wrongSubject']){const caseId=`C165.fileMetadata__read.${outcome}`,record=records.get(caseId),entry=fixtures[caseId],trace=await executeNativeAdapter(record,fixtureFile(root,entry),inventory);metadata.push({caseId,fixtureDigest:entry.sha256,trace});}
  const selection=[];for(const caseId of selectionCompanionCases){const record=records.get(caseId),entry=fixtures[caseId],trace=await executeSelectionNative(record,fixtureFile(root,entry));selection.push({caseId,fixtureDigest:entry.sha256,trace});}
  const persistence=[];
  for(const [name,run]of Object.entries(snapshotContractCases())){const h=createFakePluginHost({pluginId:'semantic-companion'});try{assert.notEqual(h.bb.storage.database().name,':memory:');const port=createBbStore(h.bb.storage.database(),h.bb.storage.migrate).semanticSnapshots,observation=sqliteContractObservation(h.bb.storage.database());observation.capture();const events=captureSnapshotContract(port,run);observation.capture();persistence.push({name,events,sqlite:observation.result()});}finally{await h.harness.lifecycle.dispose();}}
  return {sourceDigest,runId,native,discovery,metadata,selection,persistence,ids:['semantic-native-read','semantic-sqlite-contract','semantic-http-contract','s02-discovery-native','s02-selection-native'],scope:'offline native/SQLite and real-adapter stubbed HTTP; no live Google'};
}
export function compareCompanions(root,proofs,sourceDigest,runId){
  assert.ok(proofs,'missing required native/persistence/adapter companions');assert.equal(proofs.sourceDigest,sourceDigest,'stale companion source');assert.equal(proofs.runId,runId,'stale companion run');
  assert.deepEqual(proofs.ids,['semantic-native-read','semantic-sqlite-contract','semantic-http-contract','s02-discovery-native','s02-selection-native'],'missing required companion binding');assert.deepEqual(proofs.native.map(c=>c.caseId),nativeCompanionCases,'missing/wrong-route native companion');
  const {records,fixtures}=read(root);
  const calls=new Set(),connections=new Set(),files=new Set();
  for(const c of proofs.native){const entry=fixtures[c.caseId];assert.equal(c.fixtureDigest,entry.sha256,'stale companion fixture');assert.ok(Array.isArray(c.trace?.nativeCalls)&&Array.isArray(c.trace?.localCalls),'application/fake-store evidence cannot prove native/SQLite companion');compareNativeExecution(records.get(c.caseId),fixtureFile(root,entry),c.trace);
    const storage=c.trace.localCalls[0].result;assert.ok(!connections.has(storage.connectionId)&&!files.has(storage.fileDigest),'reused actual companion SQLite connection');connections.add(storage.connectionId);files.add(storage.fileDigest);
    for(const call of [...c.trace.nativeCalls,...c.trace.localCalls,...(c.trace.selectorCalls??[])]){assert.ok(!calls.has(call.id),'reused actual companion invocation');calls.add(call.id);}
  }
  assert.deepEqual(proofs.discovery?.map(c=>c.caseId),discoveryCompanionCases,'missing/wrong-route discovery companion');assert.deepEqual(proofs.metadata?.map(c=>c.caseId),['success','invalid','preservation','bounds','wrongSubject'].map(o=>`C165.fileMetadata__read.${o}`),'missing native metadata companion');
  for(const c of [...proofs.discovery,...proofs.metadata]){const entry=fixtures[c.caseId];assert.equal(c.fixtureDigest,entry.sha256,'stale discovery companion fixture');if(c.caseId.startsWith('C165.fileMetadata'))compareNativeExecution(records.get(c.caseId),fixtureFile(root,entry),c.trace);else compareDiscoveryNative(records.get(c.caseId),fixtureFile(root,entry),c.trace);
    for(const event of c.trace.events??[c.trace]){for(const call of event.nativeCalls??[]){assert.ok(!calls.has(call.id),'reused discovery companion invocation');calls.add(call.id);}if(event.storage){const a=event.storage[0],file=a.databases.find(d=>d.name==='main').fileDigest;assert.ok(!connections.has(a.connectionId)&&!files.has(file),'reused discovery companion SQLite connection');connections.add(a.connectionId);files.add(file);}}
  }
  assert.deepEqual(proofs.selection?.map(c=>c.caseId),selectionCompanionCases,'missing/wrong-route selection companion');
  for(const c of proofs.selection){const entry=fixtures[c.caseId];assert.equal(c.fixtureDigest,entry.sha256);compareSelectionNative(records.get(c.caseId),fixtureFile(root,entry),c.trace);const a=c.trace.storage[0],file=a.databases.find(d=>d.name==='main').fileDigest;assert.ok(!connections.has(a.connectionId)&&!files.has(file),'reused selection SQLite connection');connections.add(a.connectionId);files.add(file);for(const call of c.trace.nativeCalls){assert.ok(!calls.has(call.id),'reused selection native invocation');calls.add(call.id);}}
  // Replay independently expected contracts against recorded actual port calls,
  // never a passing flag. Physical capacity/tamper/reopen remain package tests.
  assert.deepEqual(proofs.persistence.map(c=>c.name),Object.keys(snapshotContractCases()),'missing SQLite logical-contract execution');
  for(const contract of proofs.persistence){const connection=compareSqliteContractObservation(contract.name,contract.sqlite);assert.ok(!connections.has(connection),'reused actual SQLite contract connection');connections.add(connection);compareSnapshotContract(contract.events,snapshotContractCases()[contract.name]);}
  assert.equal(proofs.scope,'offline native/SQLite and real-adapter stubbed HTTP; no live Google');
  return digest(JSON.stringify(proofs));
}
