import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expand,allClosures } from '../features/docs/coverage/expand.mjs';
import { assertProductIntake } from '../features/docs/coverage/product-intake.mjs';
import { createMemorySnapshots } from '../features/docs/support/memory-snapshots.mjs';
import { captureSnapshotContract,snapshotContractCases } from '../features/docs/support/snapshot-contract.mjs';
import { productionInventory } from '../features/docs/coverage/execution-adapters.mjs';
import { executeCompanions,compareCompanions } from '../features/docs/coverage/companions.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),json=p=>JSON.parse(readFileSync(new URL('../'+p,import.meta.url))),manifest=json('features/docs/coverage/obligations.json');
test('all 367 S02 declarations without current execution are rejected, not promoted',()=>{const records=expand(manifest).filter(r=>r.earliestSlice==='S02');assert.equal(records.length,367);for(const r of records){const m={...manifest,expansion:{...manifest.expansion,deliveryOverrides:{[r.key]:{status:'delivered'}}}};assert.throws(()=>assertProductIntake({manifest:m,registry:{operations:{},exposed:[]},results:[],fixtures:{},root}),/semantic delivery lacks implemented invocation\/readback adapter/,r.key);}});
test('held accounting preserves exact accepted keys, closures, future modes and zero exposure',()=>{
  const records=expand(manifest),accepted=records.filter(r=>manifest.expansion.deliveryOverrides[r.key]?.status==='delivered'),s02=records.filter(r=>r.earliestSlice==='S02'),keys=new Set(accepted.map(r=>r.key)),closures=allClosures(manifest,records);
  const families=new Set(['C001','C002','C003','C004','C005','C006','C007','C008','C009','C010','C011','C012','C013','C015','C016','C017','C020','C021','C165']),expected=records.filter(r=>r.earliestSlice==='S02'&&families.has(r.ledgerId));assert.equal(expected.length,367);
  const noWriteBases={'draft.composition':['sameRequestRecovery','cancelDraft','noDraftClaims'],'journal.keys':['serverIssued','requestIdRecovery','identicalDuplicate','differentInputConflict','failedPlanningConsumed','cancelledTombstone','crossNamespaceCollision'],'journal.claims':['draftNoClaim'],'verifier.independence':['noCompilerOracle','exactFootprint','unknownFields'],'budgets.lifecycle':['draftTtl']},s03=records.filter(r=>r.earliestSlice==='S03'),newKeys=s03.filter(r=>r.requestedMode==='local'&&noWriteBases[r.operation]?.includes(r.base));assert.equal(s03.length,268);assert.equal(newKeys.length,30);assert.equal(s03.filter(r=>!keys.has(r.key)).length,238);assert.deepEqual(accepted.map(r=>r.key).sort(),[...expected,...newKeys].map(r=>r.key).sort(),'independently selected exact S02 plus reviewed no-write S03 keys');
  assert.equal(Object.keys(manifest.rows).length,211);assert.equal(records.length,11197);assert.equal(accepted.length,397);assert.equal(s02.length,367);assert.equal(s02.filter(r=>!keys.has(r.key)).length,0);assert.deepEqual(manifest.expansion.variantExposure,{});
  const variants=[...new Set(s02.filter(r=>r.profile==='read').map(r=>`${r.operation}/${r.semanticVariant}`))];assert.equal(variants.length,59);assert.equal(variants.filter(v=>closures.get(v).every(r=>keys.has(r.key))).length,59);assert.equal(new Set(variants.flatMap(v=>closures.get(v).map(r=>r.key))).size,311);assert.equal(new Set(variants.flatMap(v=>closures.get(v).filter(r=>!keys.has(r.key)).map(r=>r.key))).size,0);for(const v of variants)assert.equal(closures.get(v).filter(r=>!keys.has(r.key)).length,0);assert.deepEqual(json('features/docs/coverage/bridge-cases.json'),{},'no supplemental cases counted twice');assert.equal(records.filter(r=>r.ledgerId==='C021'&&keys.has(r.key)).length,16);
});
test('fixed actual native/HTTP/SQLite companions reject missing, stale, wrong-route, counterfeit evidence',async()=>{
  const inventory=await productionInventory(),proofs=await executeCompanions(root,inventory,'current-source','current-run');assert.ok(compareCompanions(root,proofs,'current-source','current-run'));
  assert.throws(()=>compareCompanions(root,null,'current-source','current-run'),/missing required/);
  assert.throws(()=>compareCompanions(root,{...proofs,sourceDigest:'old'},'current-source','current-run'),/stale companion source/);
  assert.throws(()=>compareCompanions(root,{...proofs,runId:'old'},'current-source','current-run'),/stale companion run/);
  assert.throws(()=>compareCompanions(root,{...proofs,ids:proofs.ids.slice(1)},'current-source','current-run'),/missing required companion binding/);
  assert.throws(()=>compareCompanions(root,{...proofs,native:proofs.native.slice(1)},'current-source','current-run'),/missing\/wrong-route native companion/);
  const cases=[...proofs.native];cases[0]={...cases[0],fixtureDigest:'old'};assert.throws(()=>compareCompanions(root,{...proofs,native:cases},'current-source','current-run'),/stale companion fixture/);
  cases[0]={...proofs.native[0],trace:{boundary:{layer:'native'},events:[],store:'fake'}};assert.throws(()=>compareCompanions(root,{...proofs,native:cases},'current-source','current-run'),/application\/fake-store evidence cannot prove/);
  cases[0]={...proofs.native[0],trace:{...proofs.native[0].trace,nativeCalls:[]}};assert.throws(()=>compareCompanions(root,{...proofs,native:cases},'current-source','current-run'),/missing actual native call/);
  assert.throws(()=>compareCompanions(root,{...proofs,selection:proofs.selection.slice(1)},'current-source','current-run'),/missing\/wrong-route selection companion/);
  const selection=structuredClone(proofs.selection);selection[0].trace.nativeCalls=[];assert.throws(()=>compareCompanions(root,{...proofs,selection},'current-source','current-run'));
  assert.throws(()=>compareCompanions(root,{...proofs,witness:undefined},'current-source','current-run'),/missing required typed witness/);
  for(const fault of ['route','fixture','service','native','sqlite','tokens']){const witness=structuredClone(proofs.witness);if(fault==='route')witness.id='s02-selection-native';if(fault==='fixture')witness.fixtureDigest='old';if(fault==='service')witness.events=[];if(fault==='native')witness.nativeCalls=[];if(fault==='sqlite')witness.storage=[];if(fault==='tokens')witness.events[2].args.request.deliveryTokens=witness.reads[0].tokens;assert.throws(()=>compareCompanions(root,{...proofs,witness},'current-source','current-run'),undefined,fault);}
  const persistence=[...proofs.persistence];persistence[0]={...persistence[0],events:[]};assert.throws(()=>compareCompanions(root,{...proofs,persistence},'current-source','current-run'),/missing actual snapshot contract invocation/);
  const memoryEvidence=Object.entries(snapshotContractCases()).map(([name,run])=>({name,events:captureSnapshotContract(createMemorySnapshots().port,run)}));assert.throws(()=>compareCompanions(root,{...proofs,persistence:memoryEvidence},'current-source','current-run'),/missing actual SQLite contract observation/);
  persistence[0]={...proofs.persistence[0],events:proofs.persistence[0].events.map(e=>e.method==='get'&&e.result?{...e,resultFrozen:false}:e)};assert.throws(()=>compareCompanions(root,{...proofs,persistence},'current-source','current-run'),/original port result is immutable/);
});
