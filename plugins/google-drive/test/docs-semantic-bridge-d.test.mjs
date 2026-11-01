import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../features/docs/coverage/runner.mjs';

test('D real Cucumber child joins observed production executions without promoting planned keys', {timeout:120000}, () => {
  const run=spawnSync(process.execPath,['features/docs/coverage/runner.mjs'],{cwd:packageRoot,encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const summary=JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(summary.bridgeCandidates,4); // C005 text3, C009 coverage2, C012 literal1 and C015 cardinality2 migrated.
  assert.equal(summary.executedObligations,238); // Raw-mask2 + C00916 + C00530 + C00620 + C00720 + C00825 + C00320 + C01020 + C01115 + C01220 + C01340 + C01510.
  assert.equal(summary.enabledVariants,0);
});
