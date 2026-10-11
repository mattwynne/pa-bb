import test from 'node:test';
import assert from 'node:assert/strict';
import { transferStats, RcloneStatsStream } from '../adapters/rclone-stats.ts';
import { progressSnapshot } from '../core/progress.ts';
import { progressPercent, formatBytes } from '../sync-progress.tsx';
import { activity } from '../core/ports.ts';
import type { TransferProgress } from '../core/ports.ts';
test('stats explicitly whitelist bounded counters and omit all provider messages and filenames', () => {
  const safe = transferStats({ msg: 'sentinel-password', object: 'sentinel-file', stats: { bytes: 32, totalBytes: 64, transfers: 1, totalTransfers: 2, lastError: 'sentinel-cookie', checking: ['sentinel-name'], transferring: [{ name: 'sentinel-account' }] } });
  assert.deepEqual(safe, { bytes: 32, totalBytes: 64, files: 1, totalFiles: 2 });
  assert.doesNotMatch(JSON.stringify(safe), /sentinel/);
  for (const bad of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '32']) assert.equal(transferStats({ stats: { bytes: bad, transfers: 1 } }), null);
  assert.deepEqual(transferStats({ stats: { bytes: 32, totalBytes: 12, transfers: 1, totalTransfers: 0 } }), { bytes: 32, totalBytes: null, files: 1, totalFiles: null });
  assert.equal(transferStats({ msg: 'sentinel-error' }), null);
});
test('NDJSON parser handles chunk boundaries, bad output and oversized private records with bounded recovery', () => {
  const seen: TransferProgress[] = []; const stream = new RcloneStatsStream(stats => seen.push(stats));
  const line = JSON.stringify({ msg: 'sentinel-private', stats: { bytes: 1, totalBytes: 2, transfers: 0, totalTransfers: 1 } });
  stream.write(Buffer.from(line.slice(0, 13))); assert.equal(seen.length, 0);
  stream.write(Buffer.from(line.slice(13) + '\nnot-json\n{"stats":null}\n'));
  stream.write(Buffer.from('{"msg":"' + 'x'.repeat(80_000)));
  stream.write(Buffer.from('","stats":{"bytes":99,"transfers":1}}\n' + line)); stream.end();
  assert.equal(seen.length, 2); assert.deepEqual(seen[0], seen[1]); assert.doesNotMatch(JSON.stringify(seen), /sentinel/);
  const throwing = new RcloneStatsStream(() => { throw new Error('sentinel-callback'); });
  assert.doesNotThrow(() => throwing.write(Buffer.from(line + '\n')));
});
test('domain projection and UI never invent a percentage for missing or inconsistent totals', () => {
  const safe = progressSnapshot({ ...activity('transferring'), bytes: 25, totalBytes: 100, files: 1, totalFiles: 4, object: 'sentinel-private' } as any)!;
  assert.equal(progressPercent(safe), 25); assert.doesNotMatch(JSON.stringify(safe), /sentinel/);
  assert.equal(progressPercent(activity('checking')), null);
  assert.equal(progressPercent({ ...activity('transferring'), files: 2, totalFiles: 4 }), 50);
  assert.equal(progressPercent({ ...activity('transferring'), bytes: 100, totalBytes: 200 }), 50);
  assert.equal(progressPercent({ ...activity('transferring'), bytes: 200, totalBytes: 100 }), null);
  assert.equal(progressPercent({ ...activity('transferring'), bytes: 100, totalBytes: 100 }), 100);
  assert.equal(progressSnapshot({ ...activity('checking'), stage: 'sentinel-private' } as any), null);
  assert.equal(formatBytes(1024), '1 KiB');
});
