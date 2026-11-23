import test from 'node:test';
import assert from 'node:assert/strict';
import { RcloneBisyncObservation } from '../adapters/rclone-bisync-observation.ts';

const record = (line: number, msg: string) => ({
  time: '2026-01-01T00:00:00Z', level: 'error', source: `bisync/operations.go:${line}`, msg,
});
const retry = 'Bisync aborted. Error is retryable without --resync due to --resilient mode.';
const resync = 'Bisync aborted. Must run --resync to recover.';
const listing = 'There were errors while building listings. Aborting as it is too dangerous to continue.';

for (const [version, lines] of [['1.75.2', [201, 210, 313]], ['1.76.0', [217, 226, 329]]] as const) {
  test(`stock rclone ${version} classifies only its verified native log sites`, () => {
    const recoverable = new RcloneBisyncObservation();
    recoverable.observe(record(lines[0], retry));
    recoverable.observe(record(lines[2], listing));
    assert.equal(recoverable.decision(), 'retryable_abort');
    assert.equal(recoverable.reason(), 'listing_failure');
    recoverable.observe(record(lines[1], resync));
    assert.equal(recoverable.decision(), 'unknown_fatal');

    const critical = new RcloneBisyncObservation();
    critical.observe(record(lines[1], `\x1b[31m${resync}\x1b[0m`));
    assert.equal(critical.decision(), 'resync_required_abort');
  });

  test(`stock rclone ${version} rejects added fields, changed messages and unverified source lines`, () => {
    for (const invalid of [
      { ...record(lines[0], retry), object: 'PRIVATE_PROVIDER_CONTENT' },
      record(lines[0], 'PRIVATE_PROVIDER_CONTENT'),
      record(lines[0] + 1, retry),
    ]) {
      const observation = new RcloneBisyncObservation();
      observation.observe(invalid);
      assert.equal(observation.decision(), 'unknown_fatal');
    }
    const conflicting = new RcloneBisyncObservation();
    conflicting.observe(record(lines[0], retry));
    conflicting.observe({ ...record(lines[1], resync), object: 'PRIVATE_PROVIDER_CONTENT' });
    assert.equal(conflicting.decision(), 'unknown_fatal');
  });
}
