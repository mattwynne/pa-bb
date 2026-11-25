import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test('the scheduled gate stays silent when empty and dispatches only the configured worker for work', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'obsidian-recovery-gate-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const cli = join(dir, 'cli'), calls = join(dir, 'calls');
  await writeFile(cli, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [ "$1" = obsidian ]; then
  if [ "$STATE" = error ]; then exit 2; fi
  printf '%s\\n' "$STATE"
else
  printf '%s\\n' 'worker requested'
fi
`, { mode: 0o700 });
  const script = fileURLToPath(new URL('../scripts/receipt-recovery-gate.sh', import.meta.url));
  const run = (STATE: string) => exec('bash', [script], { env: {
    PATH: process.env.PATH, BB_CLI: cli, OBSIDIAN_RECOVERY_WORKER_ID: 'synthetic-worker',
    BB_PROJECT_ID: 'synthetic-project', BB_AUTOMATION_RUN_ID: 'synthetic-tick', CALLS: calls, STATE,
  } });
  assert.deepEqual(await run('empty'), { stdout: '', stderr: '' });
  assert.equal((await run('work')).stdout, 'worker requested\n');
  await assert.rejects(run('error'), { code: 2 });
  assert.equal(await readFile(calls, 'utf8'), [
    'obsidian recovery-needed', 'obsidian recovery-needed',
    'automation run synthetic-worker --project synthetic-project --idempotency-key synthetic-tick --json',
    'obsidian recovery-needed', '',
  ].join('\n'));
});
