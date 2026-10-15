// Generated-data, client-observed fixture driver; no direct mirror writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const digest = text => createHash('sha256').update(text).digest('hex');
const percentile = (sorted, fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
export async function workload({ root, env, record, save, rpc, invoke, wait, delay, serverPid }) {
  const start = performance.now(), files = new Map(), transitions = new Map();
  record.workloadStartedAt = new Date().toISOString();
  record.application = []; record.pendingSamples = [];
  const alias = id => join(env.BB_GENERATED_ALIAS_ROOT, id === 'one' ? 'generated' : 'other', 'transfer.bin');
  const mirrorFile = (id, path) => join(root, 'data/plugins/icloud/sync/mirrors', id, path);
  const observeApplication = async () => {
    // Read-only observation of generated mirror bytes: a superseded save may
    // coalesce without ever being applied. This is not native delivery proof.
    for (const [keyPath, latest] of files) {
      const [id, path] = keyPath.split('/');
      const receipt = record.saves.findLast(s => s.vault === id && s.path === path)?.receipt;
      if (!receipt || record.application.some(a => a.receipt === receipt)) continue;
      let bytes;
      try { bytes = await readFile(mirrorFile(id, path)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (digest(bytes) === digest(latest)) record.application.push({ receipt, atMs: Math.round(performance.now() - start), mirror: id, path, hash: digest(bytes) });
    }
  };
  // Generated alias-side source bytes; no mirror changes outside the native owner.
  await writeFile(alias('two'), Buffer.alloc(24 * 1024 * 1024, 66));
  let lastTransfer = 0, priorPid = null, nativeStart = 0;
  const child = async () => {
    const ids = (await readFile(`/proc/${serverPid}/task/${serverPid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    for (const id of ids) { try { if ((await readFile(`/proc/${id}/cmdline`, 'utf8')).split('\0').includes('bisync')) return Number(id); } catch {} }
    return null;
  };
  const observations = [];
  let round = 0;
  // A real cron minute drives turns, never a hand-invoked fake scheduler.
  while (performance.now() - start < 305000 || record.saves.length < 105) {
    const elapsed = performance.now() - start;
    if (elapsed > 380000) break;
    const status = await rpc('icloud', 'status');
    const nativePid = await child();
    if (nativePid !== priorPid) {
      if (priorPid) observations.push({ atMs: Math.round(elapsed), nativeMs: Math.round(elapsed - nativeStart), nativePid: priorPid });
      if (nativePid) nativeStart = elapsed;
      priorPid = nativePid;
    }
    const active = status.mirrors.filter(m => m.phase === 'running');
    if (record.saves.length % 10 === 0) record.pendingSamples.push({ atMs: Math.round(elapsed), mirrors: status.mirrors.map(m => ({ id: m.id, phase: m.phase, pendingAgeMs: m.local.pendingAgeMs, blocker: m.local.applicationBlocker })) });
    await observeApplication();
    const key = active.map(m => m.id).join(',') + ':' + Boolean(nativePid);
    if (!transitions.has(key + ':' + round)) { transitions.set(key + ':' + round, true); observations.push({ atMs: Math.round(elapsed), active: active.map(m => m.id), nativeChild: Boolean(nativePid), pendingAgeMs: status.mirrors.map(m => [m.id, m.local.pendingAgeMs]) }); }
    if (!nativePid && !active.length && elapsed > lastTransfer + 75000 && round < 2) {
      round++; lastTransfer = elapsed;
      for (const id of ['one', 'two']) await writeFile(alias(id), Buffer.alloc(24 * 1024 * 1024, 66 + round * 2 + (id === 'one' ? 1 : 0)));
      observations.push({ atMs: Math.round(elapsed), aliasChanged: round });
    }
    const id = record.saves.length % 2 ? 'two' : 'one';
    const path = `Work-${Math.floor(record.saves.length / 2) % 12}.md`;
    const keyPath = id + '/' + path;
    const previous = files.get(keyPath);
    // Alternates 1 KiB and ~64 KiB UTF-8 exact-byte changes; the large
    // character count remains below the existing 64k tool-input/output caps.
    const large = record.saves.length % 4 === 0;
    const text = `# Generated ${record.saves.length}\n` + (large ? 'é'.repeat(32000) : 'x'.repeat(1024)) + '\n';
    let name, input;
    if (previous === undefined) { name = 'obsidian_create_note'; input = { vaultId: id, path, text }; }
    else {
      const read = await invoke('obsidian_read_note', { vaultId: id, path });
      assert.equal(read.isError, false, read.text); assert.equal(read.value.complete, true);
      assert.equal(digest(read.value.text), read.value.hash);
      name = 'obsidian_edit_note'; input = { vaultId: id, path, expectedHash: read.value.hash, replacements: [{ oldText: read.value.text, newText: text }] };
    }
    const result = await invoke(name, input);
    assert.equal(result.isError, false, `${name}: ${result.text.slice(0, 400)}`);
    assert.equal(result.value.receipt.outcome, 'saved_locally_pending_sync');
    files.set(keyPath, text);
    record.saves.push({ atMs: Math.round(performance.now() - start), savedAt: new Date().toISOString(), ms: Math.round(result.ms * 100) / 100, vault: id, path, bytes: Buffer.byteLength(text), hash: digest(text), nativeChild: Boolean(nativePid), phase: active.map(m => m.id), receipt: result.value.receipt.operationId });
    if (record.saves.length % 10 === 0) await save();
    await delay(2700);
  }
  if (priorPid) observations.push({ atMs: Math.round(performance.now() - start), nativeMs: Math.round(performance.now() - start - nativeStart), nativePid: priorPid, stillRunning: true });
  record.native = observations;
  record.workloadMs = Math.round(performance.now() - start);
  const numbers = record.saves.map(s => s.ms).sort((a, b) => a - b);
  record.latency = { p50: percentile(numbers, .5), p95: percentile(numbers, .95), max: numbers.at(-1), accepted: numbers.length, duringNative: record.saves.filter(s => s.nativeChild).length };
  await save();
  assert.ok(record.workloadMs >= 300000 && numbers.length >= 100);
  assert.ok(record.latency.duringNative >= 30);
  assert.ok(record.latency.p95 < 1000 && record.latency.max < 2000);
  // A completed, eligible following native run must retire every ordinary
  // path. Continue observing application while waiting, not just latency.
  await wait(async () => {
    const status = await rpc('icloud', 'status'); await observeApplication();
    record.pendingSamples.push({ atMs: Math.round(performance.now() - start), mirrors: status.mirrors.map(m => ({ id: m.id, phase: m.phase, pendingAgeMs: m.local.pendingAgeMs, blocker: m.local.applicationBlocker })) });
    return status.mirrors.every(m => m.phase === 'ready' && m.local.pendingAgeMs === null);
  }, 240000, 'following native retirement');
  record.observations.push({ name: 'following-idle', mirrors: (await rpc('icloud', 'status')).mirrors.map(m => ({ id: m.id, lastSuccess: m.lastSuccess, pendingAgeMs: m.local.pendingAgeMs })) });
  record.nativeRuns = (await rpc('icloud', 'diagnostics', {})).runs.filter(r => r.kind === 'sync').map(r => ({ sequence: r.sequence, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, outcome: r.outcome }));
  record.visibility = [];
  for (const [keyPath, text] of files) {
    const [id, path] = keyPath.split('/');
    const result = await invoke('obsidian_read_note', { vaultId: id, path });
    assert.equal(result.isError, false); assert.equal(result.value.text, text);
    const remote = await readFile(join(env.BB_GENERATED_ALIAS_ROOT, id === 'one' ? 'generated' : 'other', path));
    const mirror = await readFile(mirrorFile(id, path));
    const expectedHash = digest(text);
    assert.equal(digest(remote), expectedHash, `alias mismatch: ${keyPath}`);
    assert.equal(digest(mirror), expectedHash, `mirror mismatch: ${keyPath}`);
    record.visibility.push({ vault: id, path, expectedHash, aliasHash: digest(remote), mirrorHash: digest(mirror), bytes: Buffer.byteLength(text) });
  }
  record.logicalFinal = files.size;
  record.observationLimits = { application: 'sampled local mirror publication; coalesced intermediate saves have no application event', followingRun: 'successful local alias bisync and retired overlay, not cloud/device verification', maintenance: 'not separately instrumented', commitFsync: 'not separately instrumented' };
}
