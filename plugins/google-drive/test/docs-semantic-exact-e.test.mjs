import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from '../features/docs/coverage/runner.mjs';
import { readJournal } from '../features/docs/coverage/execution-journal.mjs';
import { expand } from '../features/docs/coverage/expand.mjs';
import { assertProductIntake } from '../features/docs/coverage/product-intake.mjs';

const ids=['C006.refuseRawMask__capability.refused','C006.refuseRawMask__capability.noMutation'];
test('E every S02 key rejects a delivery declaration without its current execution (367 negatives)',()=>{
  const manifest=JSON.parse(readFileSync(join(packageRoot,'features/docs/coverage/obligations.json')));
  const records=expand(manifest).filter(r=>r.earliestSlice==='S02');assert.equal(records.length,367);
  for(const record of records){
    manifest.expansion.deliveryOverrides={[record.key]:{status:'delivered'}};
    assert.throws(()=>assertProductIntake({manifest,registry:{operations:{},exposed:[]},results:[],fixtures:{},root:packageRoot}),
      /semantic delivery lacks implemented invocation\/readback adapter/,record.key);
  }
});
test('E bounded raw-mask pair has normal current executions, not supplemental or serving credit',{timeout:120000},()=>{
  const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:packageRoot,encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(run.status,0,run.stdout+run.stderr);
  const summary=JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(summary.executedObligations,238);
  assert.equal(summary.bridgeCandidates,4);
  assert.equal(summary.enabledVariants,0);
  assert.equal(summary.remainingPlannedKeys,10959);
  assert.deepEqual(summary.s02,{required:367,executed:238,remaining:129,readVariants:59,completeReadClosures:42});
  const dir=run.stdout.match(/Docs current-run evidence: (.+)/)[1];
  const receipts=readJournal(join(dir,'executions.ndjson'));
  assert.deepEqual(receipts.filter(r=>ids.includes(r.caseId)).map(r=>r.caseId).sort(),[...ids].sort());
  assert.equal(JSON.parse(readFileSync(join(dir,'child.json'))).status,0);
  const accounting=JSON.parse(readFileSync(join(dir,'s02-accounting.json')));
  assert.equal(accounting.requiredKeys.length,367);assert.equal(accounting.remainingKeys.length,129);
  assert.equal(new Set([...accounting.executedKeys,...accounting.remainingKeys]).size,367);
  assert.deepEqual(accounting.executedKeys.filter(k=>!k.startsWith('C009/')&&!k.startsWith('C005/')&&!k.startsWith('C006/docs_read.structure/')&&!k.startsWith('C007/docs_read.richCell/')&&!k.startsWith('C008/docs_read.opaque/')&&!k.startsWith('C003/docs_read.segment/')&&!k.startsWith('C010/docs_read.view/')&&!k.startsWith('C011/docs_read.reviewView/')&&!k.startsWith('C012/docs_find.literal/')&&!k.startsWith('C013/docs_find.normalization/')&&!k.startsWith('C015/selector.cardinality/')).sort(),ids.map(id=>'C006/policy.publicRawMask/refuseRawMask__capability/'+id.split('.').at(-1)).sort());
  assert.equal(accounting.executedKeys.filter(k=>k.startsWith('C009/')).length,16);
  const semantic=Object.entries(accounting.readClosures).filter(([key])=>key.startsWith('docs_'));
  assert.equal(semantic.length,58);
  assert.equal(accounting.executedKeys.filter(k=>k.startsWith('C005/')).length,30);
  assert.ok(semantic.every(([key,c])=>c.required.length===21&&c.missing.length===(/^(docs_read\.(projection|structure|richCell|opaque|segment|view|reviewView)|docs_find\.(literal|normalization))\//.test(key)?0:5)));
  assert.equal(new Set(semantic.flatMap(([,c])=>c.required)).size,306);
  assert.equal(new Set(Object.values(accounting.readClosures).flatMap(c=>c.required)).size,311);
});
