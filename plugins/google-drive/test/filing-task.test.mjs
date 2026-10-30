import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createFilingService, filingHash } from '../core/filing.mjs';
const account = 'owner@example.invalid';
const item = (fileId, changed = true) => ({ kind: 'move', operationId: randomUUID(), fileId, expectedParentId: 'source', folderId: 'destination', changed });
async function setup() {
  const h = createFakePluginHost({ pluginId: 'google-drive' });
  const store = createBbStore(h.bb.storage.database(), (db, statements) => h.bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'subject', email: account, refreshToken: 'synthetic' });
  const changes = new Map(), writes = [], logs = [], effects = new Set();
  let policy = true, time = 0, lost = false, mismatch = false, policyReads = 0, failureAt = null, previewCount = 0, huge = false, afterProposal = () => {}, beforePrepare = () => {};
  const filing = {
    async propose(r, kind, request) {
      previewCount++; if (previewCount === failureAt) throw new Error('private-preview-sentinel');
      const id = request.fileId || request.name;
      afterProposal(previewCount);
      const changed = changes.get(id) !== false;
      const preview = { kind, account: r.email, title: huge ? 'x'.repeat(40_000) : id, from: 'Old folder', to: 'Destination', fileId: request.fileId || '', destinationId: request.folderId || request.parentId,
        sourceAudience: 'Owner', destinationAudience: 'Owner and partner', accessChanges: changed ? 'Partner may gain editing access.' : 'No access change found.', impact: 'Direct shares preserved.' };
      return { fingerprint: filingHash([request, changed]), resource: `file:${id}`, contextIds: ['source', 'destination', id], requiresApproval: changed, preview,
        fileId: request.fileId, destinationId: request.folderId || request.parentId, sourceParentId: 'source', mimeType: 'application/pdf' };
    },
    async prepare() { beforePrepare(); return async (kind, request) => { writes.push(request); effects.add(request.fileId); if (lost) throw new Error('private-provider-sentinel'); return { id: request.fileId || 'created-folder' }; }; },
    async verify(r, op) { return { matches: !mismatch, visibleAccess: ['Owner', 'Partner'] }; },
  };
  const create = () => createFilingService({ store, operations: store.filing, filing, clock: () => time, requireApproval: async () => { policyReads++; return typeof policy === 'function' ? policy(policyReads) : policy; },
    diagnose: (stage) => logs.push(stage) });
  const s = create();
  const args = input => ({ account, operationId: randomUUID(), items: input.map(({ changed, ...i }) => { changes.set(i.fileId || i.name, changed); return i; }) });
  return { h, store, s, create, args, changes, writes, logs, effects, setPolicy: v => { policy = v; }, failAt: n => { failureAt = n; }, makeHuge: () => { huge = true; }, onPropose: fn => { afterProposal = fn; }, onPrepare: fn => { beforePrepare = fn; }, tick: v => { time += v; }, lose: () => { lost = true; }, mismatch: () => { mismatch = true; }, close: () => h.harness.lifecycle.dispose() };
}
const yes = async () => ({ outcome: 'submitted', value: { approved: true } });
test('business-style five moves: two unchanged, three gains, one exact task card and five durable verified receipts', async () => {
  const h = await setup(), a = h.args([item('plan', false), item('marketing', false), item('resume'), item('market'), item('finance')]);
  try {
    const preview = await h.s.task(a); assert.equal(preview.items.filter(i => i.requiresApproval).length, 3);
    let cards = 0;
    const result = await h.s.task({ ...a, preview: false }, undefined, async p => { cards++; assert.equal(p.items.length, 5); assert.equal(p.items.filter(i => i.requiresApproval).length, 3); assert.equal(h.writes.length, 0); return yes(); });
    assert.equal(cards, 1); assert.equal(result.outcome, 'verified'); assert.equal(h.writes.length, 5);
    assert.ok(result.items.every(i => i.outcome === 'verified' && i.accessChanges));
    await h.create().task({ ...a, preview: false }, undefined, () => { throw new Error('replay'); });
    assert.equal(h.writes.length, 5);
    await assert.rejects(h.s.task({ ...a, items: a.items.slice(1) }), e => e.filingCode === 'conflict');
  } finally { await h.close(); }
});
test('requested folder creation participates in the same exact task review', async () => {
  const h = await setup(), a = h.args([item('file'), { kind: 'folder', operationId: randomUUID(), parentId: 'destination', name: 'Requested folder', changed: true }]);
  try {
    let cards = 0;
    const r = await h.s.task({ ...a, preview: false }, undefined, async p => { cards++; assert.equal(p.items[1].kind, 'folder'); return yes(); });
    assert.equal(cards, 1); assert.equal(r.outcome, 'verified'); assert.equal(h.writes.length, 2);
  } finally { await h.close(); }
});
test('task decline, invalid approval, stale access, expiry and abort never grant later consent', async () => {
  for (const mode of ['decline', 'invalid', 'stale', 'expiry', 'abort']) {
    const h = await setup(), a = h.args([item('file')]), abort = new AbortController();
    try {
      await h.s.task(a);
      const r = await h.s.task({ ...a, preview: false }, abort.signal, async () => {
        if (mode === 'stale') h.changes.set('file', false);
        if (mode === 'expiry') h.tick(600_001);
        if (mode === 'abort') abort.abort();
        return { outcome: 'submitted', value: mode === 'invalid' ? { approved: true, bypass: true } : { approved: mode !== 'decline' } };
      });
      assert.notEqual(r.outcome, 'verified'); assert.equal(h.writes.length, 0);
      await h.create().task({ ...a, preview: false }); assert.equal(h.writes.length, 0);
    } finally { await h.close(); }
  }
});
test('uncertain first write stops batch, preserves individual unresolved receipt, never replays', async () => {
  const h = await setup(), a = h.args([item('first'), item('second')]);
  try {
    h.lose(); const r = await h.s.task({ ...a, preview: false }, undefined, yes);
    assert.equal(r.outcome, 'partial'); assert.equal(r.items[0].outcome, 'observed_matching'); assert.equal(r.items[0].unresolved, true);
    assert.equal(r.items[1].outcome, 'proposed'); assert.equal(h.writes.length, 1);
    await h.create().task({ ...a, preview: false }); assert.equal(h.writes.length, 1);
    assert.ok(h.logs.includes('filing_task_partial')); assert.ok(!h.logs.join().includes('private-provider-sentinel'));
  } finally { await h.close(); }
});
test('Never policy suppresses filing cards, not revalidation, verification or impact reporting', async () => {
  const h = await setup(), a = h.args([item('file')]);
  try {
    h.setPolicy(false); h.mismatch();
    const r = await h.s.task({ ...a, preview: false }, undefined, () => { throw new Error('card'); });
    assert.equal(r.outcome, 'partial'); assert.equal(r.items[0].outcome, 'uncertain'); assert.match(r.items[0].accessChanges, /gain/); assert.equal(h.writes.length, 1);
  } finally { await h.close(); }
});
test('tightening Never policy inside child claim cannot synthesize owner consent', async () => {
  const h = await setup(), a = h.args([item('file')]);
  try {
    h.setPolicy(n => n >= 3);
    const r = await h.s.task({ ...a, preview: false }, undefined, () => { throw new Error('Unexpected owner card'); });
    assert.equal(r.outcome, 'partial'); assert.equal(h.writes.length, 0); assert.equal(r.items[0].outcome, 'cancelled');
  } finally { await h.close(); }
});
test('Never tightening during revalidation or writer preparation stops both individual and task submission', async () => {
  for (const task of [false, true]) for (const boundary of ['revalidate', 'prepare']) {
    const h = await setup(), a = h.args([item('file')]);
    try {
      h.setPolicy(false);
      if (boundary === 'revalidate') h.onPropose(n => { if (n === 2) h.setPolicy(true); });
      else h.onPrepare(() => h.setPolicy(true));
      const { kind, ...child } = a.items[0];
      const r = task ? await h.s.task({ ...a, preview: false }) : await h.s.move({ ...child, account, preview: false });
      assert.equal(h.writes.length, 0); assert.equal(r.outcome, task ? 'partial' : 'not_submitted');
      if (!task) assert.equal(r.writeAttempted, false);
    } finally { await h.close(); }
  }
});
test('final reservation/policy failure cannot submit an unreviewed write', async () => {
  for (const mode of ['tighten_start', 'policy_failure']) {
    const h = await setup(), a = h.args([item('file')]);
    try {
      h.setPolicy(false);
      if (mode === 'tighten_start') {
        const start = h.store.filing.start;
        h.store.filing.start = async op => { const r = await start(op); h.setPolicy(true); return r; };
      } else h.setPolicy(n => { if (n > 1) throw new Error('private-policy-sentinel'); return false; });
      const { kind, ...child } = a.items[0];
      const r = await h.s.move({ ...child, account, preview: false });
      assert.equal(r.outcome, 'not_submitted'); assert.equal(h.writes.length, 0); assert.equal(r.writeAttempted, false);
      assert.doesNotMatch(JSON.stringify(r) + h.logs.join(), /private-policy-sentinel/);
    } finally { await h.close(); }
  }
});
test('failed, aborted and oversized previews retain inspectable task receipt with every prepared/unprepared child', async () => {
  for (const mode of ['failure', 'abort', 'oversize']) {
    const h = await setup(), a = h.args([item('first'), item('second')]), abort = new AbortController();
    try {
      if (mode === 'failure') h.failAt(2);
      if (mode === 'abort') h.onPropose(n => { if (n === 1) abort.abort(); });
      if (mode === 'oversize') h.makeHuge();
      const r = await h.s.task(a, abort.signal);
      assert.equal(r.outcome, 'not_submitted'); assert.equal(r.inProgress, false); assert.equal(r.items.length, 2); assert.equal(h.writes.length, 0);
      assert.equal(r.items[1].outcome, mode === 'oversize' ? 'proposed' : 'unprepared');
      const recovered = await h.create().status({ account, operationId: a.operationId });
      assert.equal(recovered.outcome, 'not_submitted'); assert.equal(recovered.items.length, 2);
      await h.create().task({ ...a, preview: false }); assert.equal(h.writes.length, 0);
    } finally { await h.close(); }
  }
});
test('task reservation failure prepares no child; persisted abandoned preparation/review is interrupted without replay', async () => {
  const h = await setup(), a = h.args([item('file')]);
  try {
    const reserve = h.store.filing.reserve; h.store.filing.reserve = async () => { throw new Error('private-storage-sentinel'); };
    await assert.rejects(h.s.task(a)); assert.equal(await h.store.filing.get(a.items[0].operationId), null);
    h.store.filing.reserve = reserve;
    await h.s.task(a); const op = await h.store.filing.get(a.operationId);
    await h.store.filing.claim(op);
    const recovered = await h.create().status({ account, operationId: a.operationId });
    assert.equal(recovered.outcome, 'interrupted'); assert.equal(recovered.inProgress, false);
    await h.create().task({ ...a, preview: false }); assert.equal(h.writes.length, 0);
  } finally { await h.close(); }
});
test('task keys cannot adopt prior children, duplicate items, alternate account or settings arguments', async () => {
  const h = await setup(), a = h.args([item('file')]);
  try {
    await assert.rejects(h.s.task({ ...a, requireApproval: false }), e => e.filingCode === 'invalid');
    await assert.rejects(h.s.task({ ...a, items: [...a.items, { ...a.items[0], operationId: randomUUID() }] }), e => e.filingCode === 'invalid');
    await h.s.task(a);
    await assert.rejects(h.s.task({ ...a, account: 'other@example.invalid' }), e => e.filingCode === 'account');
    const b = { ...a, operationId: randomUUID() };
    await assert.rejects(h.s.task(b), e => e.filingCode === 'conflict');
    assert.equal(h.writes.length, 0);
  } finally { await h.close(); }
});
