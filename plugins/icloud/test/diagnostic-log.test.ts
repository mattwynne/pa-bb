import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticMessage } from '../adapters/diagnostic-log.ts';
import { CloudError, category, evidence } from '../core/ports.ts';
test('v2 ownership, startup, application, maintenance and conflict failures name their fixed boundaries', () => {
  for (const stage of ['startup', 'note_owner', 'note_start', 'note_apply', 'note_maintenance', 'note_inspect_conflict', 'note_resolve_conflict']) {
    assert.equal(diagnosticMessage(stage, 'unavailable'), `iCloud ${stage} unavailable`);
  }
});
test('diagnostic log fields whitelist stages, categories, sequences and exit evidence', () => {
  assert.equal(diagnosticMessage('sync/backing_up_cloud', 'sync_failed', { run: 12, evidence: { kind: 'command_exit', exitCode: 4 } }), 'iCloud sync/backing_up_cloud sync_failed run=12 evidence=command_exit exit=4');
  assert.equal(diagnosticMessage('sync/checking', 'interrupted', { run: 13, evidence: { kind: 'command_timeout' } }), 'iCloud sync/checking interrupted run=13 evidence=command_timeout');
  assert.equal(diagnosticMessage('history_retention', 'capacity'), 'iCloud history_retention capacity');
  assert.equal(diagnosticMessage('sync/checking', 'sync_failed', { run: 14, evidence: { kind: 'command_exit', exitCode: 7, native: 'retryable_abort', reason: 'listing_failure' } }), 'iCloud sync/checking sync_failed run=14 evidence=command_exit exit=7 native=retryable_abort reason=listing_failure');
  assert.equal(diagnosticMessage('sync/checking', 'recovery_required', { run: 15, evidence: { kind: 'command_exit', exitCode: 7, native: 'resync_required_abort' } }), 'iCloud sync/checking recovery_required run=15 evidence=command_exit exit=7 native=resync_required_abort');
  assert.equal(diagnosticMessage('sync/checking', 'recovery_required', { evidence: { kind: 'command_exit', exitCode: 7, native: 'unknown_fatal' } }), 'iCloud sync/checking recovery_required evidence=command_exit exit=7 native=unknown_fatal');
  const spoof = diagnosticMessage('sync/checking', 'sync_failed', { evidence: { kind: 'command_exit', exitCode: 7, native: 'sentinel-provider', reason: 'sentinel-private' } } as any);
  assert.equal(spoof, 'iCloud sync/checking sync_failed evidence=command_exit exit=7');
  const unsafe = diagnosticMessage('sentinel-private-stage', 'sentinel-category', { run: 'sentinel-account', evidence: { kind: 'command_exit', exitCode: 'sentinel-password', message: 'sentinel-file' } } as any);
  assert.equal(unsafe, 'iCloud unknown unknown evidence=command_exit exit=unknown'); assert.doesNotMatch(unsafe, /sentinel/);
  for (const code of [-1, 0, 11, Infinity, NaN, 3.5]) assert.match(diagnosticMessage('schedule', 'unknown', { evidence: { kind: 'command_exit', exitCode: code } }), /exit=unknown$/);
  const error = new CloudError('sentinel-category' as any, { kind: 'sentinel-evidence' } as any);
  assert.equal(category(error), 'unknown'); assert.equal(evidence(error), null);
});
