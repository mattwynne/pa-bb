import test from 'node:test';
import assert from 'node:assert/strict';
import { DocsWorld, barrier, key, account, formatArgs } from '../features/docs/support/world.mjs';
import { createDocsFormatService } from '../core/docs-format.mjs';
import { createDocsEditService } from '../core/docs-edit.mjs';

async function fixture(t, fault = 'none') {
  const w = new DocsWorld(); await w.init(fault); t.after(() => w.close()); return w;
}
function service(w, kind, patch) {
  const ports = { ...w.ports, ...patch };
  if (kind === 'format') w.format = createDocsFormatService(ports);
  else w.edit = createDocsEditService(ports);
}
for (const kind of ['format', 'replace']) {
  for (const change of ['policy', 'cancel', ...(kind === 'format' ? ['expiry'] : [])]) {
    test(`${kind}: ${change} during final claim read is checked after that await`, { timeout: 5000 }, async t => {
      const w = await fixture(t), gate = barrier();
      const target = kind === 'format' ? w.store : w.store.images;
      const name = kind === 'format' ? 'getFormatting' : 'active';
      const original = target[name].bind(target);
      target[name] = async (...args) => {
        const value = await original(...args);
        if (w.authCount === 2) await gate.wait();
        return value;
      };
      const pending = w.apply(kind).catch(error => { w.failure = error; });
      await gate.reached; await w.change(change); gate.release(); await pending;
      assert.equal(w.mutations.length, 0);
      if (kind === 'format') { assert.equal(w.result.outcome, 'not_submitted'); assert.equal(w.result.historicalWriteAttempted, false); }
      else assert.equal(w.failure.docsWriteAttempted, false);
    });
  }
  for (const change of ['cancel', ...(kind === 'format' ? ['expiry'] : [])]) {
    test(`${kind}: ${change} inside final policy await prevents dispatch`, { timeout: 5000 }, async t => {
      const w = await fixture(t), gate = barrier();
      service(w, kind, { approvalRequired: async () => { if (w.authCount === 2) await gate.wait(); return false; } });
      const pending = w.apply(kind).catch(error => { w.failure = error; });
      await gate.reached; await w.change(change); gate.release(); await pending;
      assert.equal(w.mutations.length, 0);
      if (kind === 'format') assert.equal(w.result.outcome, 'not_submitted');
      else assert.equal(w.failure.docsWriteAttempted, false);
    });
  }
  test(`${kind}: final policy read failure is a zero-mutation refusal`, async t => {
    const w = await fixture(t);
    service(w, kind, { approvalRequired: async () => { if (w.authCount === 2) throw new Error('PRIVATE_POLICY'); return false; } });
    await w.apply(kind).catch(error => { w.failure = error; });
    assert.equal(w.mutations.length, 0);
    if (kind === 'format') { assert.equal(w.result.outcome, 'not_submitted'); assert.doesNotMatch(JSON.stringify(w.result), /PRIVATE_/); }
    else { assert.equal(w.failure.docsWriteAttempted, false); assert.equal(w.failure.docsCode, 'approval_policy_unavailable'); }
  });
  test(`${kind}: bounded guarantee does NOT serialize policy snapshots inside the callback`, { timeout: 5000 }, async t => {
    const w = await fixture(t), gate = barrier();
    service(w, kind, { approvalRequired: async () => {
      const captured = w.policy;
      if (w.authCount === 2) await gate.wait();
      return captured;
    } });
    const pending = w.apply(kind);
    await gate.reached; w.policy = true; gate.release(); await pending;
    // Deliberate limitation witness, NOT a zero-write safety claim. An async
    // policy port can return an old snapshot; S00 has no serialized epoch port.
    assert.equal(w.mutations.length, 1); assert.equal(w.result.outcome, 'verified'); assert.equal(w.approvals, 0);
  });
}

test('format: changes after durable intent persistence but before its await returns are rechecked', { timeout: 5000 }, async t => {
  const w = await fixture(t), gate = barrier(), start = w.store.startFormattingWrite.bind(w.store);
  w.store.startFormattingWrite = async op => { const saved = await start(op); await gate.wait(); return saved; };
  const pending = w.apply(); await gate.reached;
  assert.equal((await w.store.getFormatting(key)).state, 'writing'); assert.equal(w.mutations.length, 0);
  w.policy = true; gate.release(); await pending;
  assert.equal(w.mutations.length, 0); assert.equal(w.result.outcome, 'not_submitted');
  assert.equal(await w.store.activeFormatting('doc-a'), null);
});

test('format: final claim no longer writing refuses dispatch', async t => {
  const w = await fixture(t);
  w.finalAuth = async () => { const op = await w.store.getFormatting(key); await w.store.updateFormatting({ ...op, state: 'cancelled' }); };
  await w.apply(); assert.equal(w.result.outcome, 'not_submitted'); assert.equal(w.mutations.length, 0);
});

test('format: acknowledgement receipt failure preserves durable intent across reopen, never manufactures history', async t => {
  const w = await fixture(t, 'storage'); await w.apply();
  assert.equal(w.result.providerAcknowledged, true); assert.equal(w.result.historicalWriteAttempted, true);
  assert.equal((await w.store.getFormatting(key)).state, 'writing');
  await w.reopen(); w.fault = 'none'; await w.recover();
  assert.equal(w.status.outcome, 'observed_matching'); assert.equal(w.status.providerAcknowledged, false);
  assert.equal(w.status.historicalWriteAttempted, null); assert.equal(w.status.writeAttempted, false);
  assert.equal(await w.store.activeFormatting('doc-a'), key); assert.equal(w.mutations.length, 1);
  assert.doesNotMatch(JSON.stringify([w.logs, w.result, w.status]), /PRIVATE_/);
});

test('format: a one-off acknowledgement storage failure can save known facts, without replay', async t => {
  const w = await fixture(t), update = w.store.updateFormatting.bind(w.store);
  let failed = false;
  w.store.updateFormatting = async op => {
    if (op.appliedRevision && !failed) { failed = true; throw new Error('PRIVATE_STORAGE'); }
    return update(op);
  };
  await w.apply(); assert.equal(w.result.outcome, 'uncertain'); assert.equal(w.result.providerAcknowledged, true);
  await w.reopen(); await w.recover();
  assert.equal(w.status.outcome, 'verified'); assert.equal(w.status.historicalWriteAttempted, true); assert.equal(w.mutations.length, 1);
});

test('format: failure saving verified state keeps the acknowledgement and unresolved claim', async t => {
  const w = await fixture(t), update = w.store.updateFormatting.bind(w.store);
  w.store.updateFormatting = async op => { if (op.state === 'verified') throw new Error('PRIVATE_STORAGE'); return update(op); };
  await w.apply(); assert.equal(w.result.outcome, 'uncertain'); assert.equal(w.result.providerAcknowledged, true);
  assert.equal(await w.store.activeFormatting('doc-a'), key);
  await w.reopen(); assert.equal((await w.store.getFormatting(key)).appliedRevision, 'rev-b');
  await w.recover(); assert.equal(w.status.outcome, 'verified'); assert.equal(w.mutations.length, 1);
});

test('format: legacy receipt fields and missing attempt evidence survive unavailable status unchanged', async t => {
  const w = await fixture(t, 'docs403'); await w.apply();
  const legacy = await w.store.getFormatting(key); delete legacy.writeAttempted;
  legacy.legacyPrivateEvidence = { retained: 'PRIVATE_LEGACY' };
  await w.store.updateFormatting(legacy); await w.reopen(); await w.recover();
  assert.equal(w.status.providerAcknowledged, true); assert.equal(w.status.historicalWriteAttempted, null);
  assert.equal(w.status.writeAttempted, false); assert.deepEqual(await w.store.getFormatting(key), legacy);
  assert.doesNotMatch(JSON.stringify([w.logs, w.status]), /PRIVATE_/);
});

test('format: same-key repeated apply after failed readback does not mutate or discard evidence', async t => {
  const w = await fixture(t, 'docs403'); await w.apply(); await w.reopen();
  const repeated = await w.format.format(formatArgs);
  assert.equal(repeated.writeAttempted, false); assert.equal(repeated.historicalWriteAttempted, true);
  assert.equal(repeated.providerAcknowledged, true); assert.equal(w.mutations.length, 1);
  assert.equal(await w.store.activeFormatting('doc-a'), key);
});

test('format: in-progress status is zero-mutation and durable intent is not proof of submission', { timeout: 5000 }, async t => {
  const w = await fixture(t), gate = barrier(); w.finalAuth = gate.wait;
  const pending = w.apply(); await gate.reached;
  const status = await w.format.status({ account, operationId: key });
  assert.equal(status.inProgress, true); assert.equal(status.writeAttempted, false); assert.equal(status.historicalWriteAttempted, null);
  assert.equal(w.mutations.length, 0); gate.release(); await pending;
});
