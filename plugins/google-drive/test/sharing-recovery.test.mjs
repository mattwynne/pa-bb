import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, account, owner, other, named, link } from './sharing-fixtures.mjs';
import { createSharingService } from '../core/sharing.mjs';
for (const folder of [false, true]) for (const target of [named, link]) for (const action of ['change', 'revoke']) {
  test(`lost ${action} reply recovers exact ${target.type} permission on ${folder ? 'folder' : 'file'} without replay`, async () => {
    const h = await fixture({ folder, lostReply: true, permissions: [owner, other, target] });
    const input = { account, operationId: request().operationId, fileId: 'item', action, permissionId: target.id, ...(action === 'change' ? { role: 'writer' } : {}), preview: false };
    try {
      assert.equal((await h.service.change(input)).outcome, 'uncertain');
      const restarted = createSharingService(h.ports);
      assert.equal((await restarted.status({ account, operationId: input.operationId })).outcome, 'verified');
      assert.equal(h.writes().length, 1); assert.equal((await restarted.change(input)).receiptOnly, true); assert.equal(h.writes().length, 1);
    } finally { await h.close(); }
  });
}
test('scope removed during approval never submits; expiry during approval is consumed', async () => {
  let h;
  h = await fixture({ approve: async () => { h.state.scope = 'drive.readonly'; return { outcome: 'submitted', value: { approved: true } }; } });
  try { assert.equal((await h.service.change({ ...request(), preview: false })).outcome, 'not_submitted'); assert.equal(h.writes().length, 0); }
  finally { await h.close(); }
});
test('expiry during slow revalidation is checked again before writing', async () => {
  const h = await fixture(); const input = request();
  try {
    await h.service.change(input);
    const propose = h.ports.sharing.propose;
    h.ports.sharing.propose = async (...args) => { const result = await propose(...args); h.state.now += 600_000; return result; };
    assert.equal((await h.service.change({ ...input, preview: false })).outcome, 'expired');
    assert.equal(h.writes().length, 0);
  } finally { await h.close(); }
});
test('storage failure after application leaves durable writing reservation; status can resolve it after restart', async () => {
  const h = await fixture(); const input = { ...request(), preview: false };
  const update = h.store.updateSharing; let fail = true;
  h.store.updateSharing = async op => { if (fail && op.state === 'uncertain') throw Error('PRIVATE-STORAGE'); return update(op); };
  try {
    assert.equal((await h.service.change(input)).outcome, 'uncertain'); assert.equal(h.writes().length, 1);
    // Both the returned ID receipt and catch-path receipt were unavailable.
    assert.equal((await h.store.getSharing(input.operationId)).state, 'writing');
    fail = false;
    assert.equal((await createSharingService(h.ports).status({ account, operationId: input.operationId })).outcome, 'verified');
    assert.equal(h.writes().length, 1);
  } finally { await h.close(); }
});
test('cannot submit without a durable writing transition; aborted signal never authorizes a write', async () => {
  for (const storageFailure of [true, false]) {
    const h = await fixture(); const controller = new AbortController();
    if (storageFailure) h.store.startSharingWrite = async () => { throw Error('PRIVATE-STORAGE'); };
    else controller.abort();
    try {
      assert.notEqual((await h.service.change({ ...request(), preview: false }, controller.signal)).outcome, 'verified');
      assert.equal(h.writes().length, 0);
    } finally { await h.close(); }
  }
});
test('new operation after verification does not make historical status seize a lock', async () => {
  const h = await fixture(); const first = { ...request(), preview: false };
  try {
    assert.equal((await h.service.change(first)).outcome, 'verified');
    h.state.permissions.find(p => p.id === other.id).role = 'writer';
    assert.equal((await h.service.status({ account, operationId: first.operationId })).outcome, 'changed_since_verification');
    const next = request({ audience: { type: 'user', emailAddress: 'next@example.test' }, preview: false });
    assert.equal((await h.service.change(next)).outcome, 'verified');
    assert.equal(h.writes().length, 2);
  } finally { await h.close(); }
});
for (const code of [400, 401, 403, 404, 409, 412, 422, 408, 429, 500]) {
  test(`HTTP ${code} is never retried; only definite request refusals release the item lock`, async () => {
    const h = await fixture({ reject: code }); const input = { ...request(), preview: false };
    try {
      const result = await h.service.change(input);
      assert.equal(result.outcome, [408, 429, 500].includes(code) ? 'uncertain' : 'rejected');
      assert.equal(h.writes().length, 1);
      assert.equal((await h.service.change(input)).receiptOnly, true); assert.equal(h.writes().length, 1);
      assert.equal(Boolean(await h.store.activeSharing('item')), result.outcome === 'uncertain');
    } finally { await h.close(); }
  });
}
test('unknown account/status and mismatched account never disclose another account receipt', async () => {
  const h = await fixture(); const input = request();
  try {
    await h.service.change(input);
    await assert.rejects(h.service.status({ account: 'unknown@example.test', operationId: input.operationId }), /explicit connected/);
    await h.store.addAccount({ subject: 'other-subject', email: 'second@example.test', refreshToken: 'PRIVATE' });
    await assert.rejects(h.service.status({ account: 'second@example.test', operationId: input.operationId }), /No sharing receipt/);
    await assert.rejects(h.service.change({ ...input, account: 'second@example.test' }), /different request/);
    assert.equal(h.writes().length, 0);
  } finally { await h.close(); }
});
