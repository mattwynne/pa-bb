// Summarize a generated installed workload without reading its removed root.
// Native sequence/mirror attribution is timestamp-and-phase sampled evidence;
// a missing association is unknown, never inferred as delivered.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const record = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.ok(record.workloadMs >= 300000 && record.latency?.accepted >= 100 && record.logicalFinal === 24);
assert.equal(record.visibility?.length, 24);
const start = Date.parse(record.workloadStartedAt);
const running = (record.native ?? []).filter(sample => sample.active?.length === 1 && sample.nativeChild);
const native = record.nativeRuns.map(run => {
  const phase = running.find(sample => {
    const time = start + sample.atMs;
    return time >= Date.parse(run.startedAt) && time <= Date.parse(run.finishedAt);
  });
  return { ...run, sampledMirror: phase?.active[0] ?? null };
});
const byMirror = {};
for (const run of native) if (run.sampledMirror) (byMirror[run.sampledMirror] ??= []).push(Date.parse(run.startedAt));
const cadence = Object.fromEntries(Object.entries(byMirror).map(([id, starts]) => [id, starts.slice(1).map((time, i) => time - starts[i])]));
const applied = new Map(record.application.map(item => [item.receipt, item]));
const saves = record.saves.map(save => {
  const at = Date.parse(save.savedAt);
  const run = native.find(item => at >= Date.parse(item.startedAt) && at <= Date.parse(item.finishedAt));
  const application = applied.get(save.receipt);
  return { receipt: save.receipt, vault: save.vault, path: save.path, hash: save.hash, bytes: save.bytes,
    atMs: save.atMs, acknowledgementMs: save.ms, nativeChildAtCall: save.nativeChild,
    sampledRunningMirror: save.phase.length === 1 ? save.phase[0] : null,
    nativeSequenceAtAcknowledgement: run?.sequence ?? null,
    applicationObservedAtMs: application?.atMs ?? null,
    applicationDelayMs: application ? application.atMs - save.atMs : null,
    maintenanceAssociation: null };
});
const latest = record.visibility.map(item => {
  assert.equal(item.expectedHash, item.aliasHash); assert.equal(item.expectedHash, item.mirrorHash);
  const save = saves.findLast(sample => sample.vault === item.vault && sample.path === item.path);
  assert.equal(save.hash, item.expectedHash);
  return item;
});
const delays = saves.filter(save => latest.some(item => item.vault === save.vault && item.path === save.path && item.expectedHash === save.hash)).map(save => save.applicationDelayMs).filter(delay => delay !== null);
console.log(JSON.stringify({ source: 'generated installed BB/client fixture', workloadMs: record.workloadMs, latency: record.latency,
  native, sampledPerMirrorStartGapsMs: cadence, applicationObserved: applied.size, latestApplicationDelayMs: delays,
  pendingSamples: record.pendingSamples, saves, exactFinalBytes: latest,
  limits: { ...record.observationLimits, perSaveNative: 'child PID and running phase sampled before call; sequence timestamp match is bounded association, not per-call fsync', retirement: 'aggregate pendingAgeMs=null after following eligible successful native runs; no individual cloud/device proof' } }, null, 2));
