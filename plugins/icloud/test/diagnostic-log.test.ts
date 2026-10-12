import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticMessage } from '../adapters/diagnostic-log.ts';
import { CloudError, category, evidence } from '../core/ports.ts';
test('diagnostic log fields whitelist stages, categories, sequences and exit evidence', () => {
  assert.equal(diagnosticMessage('sync/backing_up_cloud', 'sync_failed', { run: 12, evidence: { kind: 'command_exit', exitCode: 4 } }), 'iCloud sync/backing_up_cloud sync_failed run=12 evidence=command_exit exit=4');
  assert.equal(diagnosticMessage('sync/checking', 'interrupted', { run: 13, evidence: { kind: 'command_timeout' } }), 'iCloud sync/checking interrupted run=13 evidence=command_timeout');
  assert.equal(diagnosticMessage('history_retention', 'capacity'), 'iCloud history_retention capacity');
  const unsafe = diagnosticMessage('sentinel-private-stage', 'sentinel-category', { run: 'sentinel-account', evidence: { kind: 'command_exit', exitCode: 'sentinel-password', message: 'sentinel-file' } } as any);
  assert.equal(unsafe, 'iCloud unknown unknown evidence=command_exit exit=unknown'); assert.doesNotMatch(unsafe, /sentinel/);
  for (const code of [-1, 0, 11, Infinity, NaN, 3.5]) assert.match(diagnosticMessage('schedule', 'unknown', { evidence: { kind: 'command_exit', exitCode: code } }), /exit=unknown$/);
  const error = new CloudError('sentinel-category' as any, { kind: 'sentinel-evidence' } as any);
  assert.equal(category(error), 'unknown'); assert.equal(evidence(error), null);
});
