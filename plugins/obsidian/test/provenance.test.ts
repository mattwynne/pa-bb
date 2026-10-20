import test from 'node:test';
import assert from 'node:assert/strict';
import { provenance } from '../core/provenance.js';
import type { Source } from '../core/ports.js';

const source: Source = { id: 'one', name: 'Vault', initialized: true, enabled: true, cloudConnected: true, phase: 'ready', lastSuccess: '2026-10-20T22:44:25.109Z', failure: null, local: { available: true, reason: null, pendingAgeMs: null, applicationBlocker: null } };
for (const at of ['2026-10-20T22:50:48.000Z', '2026-11-20T22:50:48.000Z']) {
  test(`elapsed age does not assess local content at ${at}`, () => {
    const result = provenance(source, at);
    assert.equal(result.lastSuccessfulSync, source.lastSuccess);
    assert.equal(result.localObservedAt, at);
    assert.equal('stale' in result, false);
    assert.deepEqual(result.sync, { connected: true, enabled: true, phase: 'ready', failure: null });
    assert.match(result.delivery, /not proof/);
  });
}
test('unknown history, paused sync and actual failure remain facts', () => {
  const result = provenance({ ...source, lastSuccess: null, cloudConnected: false, enabled: false, phase: 'failed', failure: 'authentication' }, '2026-10-20T22:50:48Z');
  assert.equal(result.lastSuccessfulSync, null);
  assert.match(result.syncTimestampMeaning, /never synced or history unknown/);
  assert.deepEqual(result.sync, { connected: false, enabled: false, phase: 'failed', failure: 'authentication' });
  assert.equal('stale' in result, false);
});
