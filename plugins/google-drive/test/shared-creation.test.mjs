import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createNativeCreationService } from '../core/native-create.mjs';
async function setup(options = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-drive' });
  const store = createBbStore(bb.storage.database(), (db, statements) => bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'subject', email: 'owner@example.invalid', refreshToken: 'secret', accessToken: 'secret' });
  let creates = 0, populations = 0, content = false, drift = false, now = 0, unavailable = false;
  const diagnostics = [];
  const drive = { async getFile(_r, id) { return id === 'new' ? { id, name: 'Title', trashed: false, mimeType: 'application/test', parents: ['dest'] } : { id: 'dest', trashed: false, mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } }; }, async getSharingMetadata() { return { id: 'dest', shared: true, owners: [{ me: true }] }; }, async listPermissions() { return { permissions: [{ type: 'user', role: 'owner', emailAddress: 'owner@example.invalid' }] }; } };
  const assessment = { async assessDestination() { if (options.incomplete) throw new Error('secret-provider'); return { destinationId: 'dest', fingerprint: drift ? 'changed' : 'original', contextIds: ['dest', 'root'], path: 'My Drive / Team', owners: 'owner', audience: 'team', allowedAccess: [] }; }, async verifyCreated() { return true; } };
  const creation = { async prepare() { return { async create() { creates++; if (options.lostCreate) throw new Error('secret-create'); return { id: 'new' }; }, async populate() { populations++; content = true; if (options.lostPopulation) throw new Error('secret-populate'); } }; }, async find() { return { files: creates && !options.emptyLookup ? [{ id: 'new' }] : [] }; } };
  const spec = { kind: options.kind || 'document', idField: 'documentId', mimeType: 'application/test', stage: 'test_creation', statusTool: 'status', url: id => `https://example.invalid/${id}`, verifiedGuidance: 'verified', request: a => [a.folderId, a.title, a.text], reviewContent: a => a.text, validate() {}, expected() { return {}; }, async populate(writer) { if (options.drift) drift = true; await writer.populate({}); }, async verify() { if (unavailable) throw new Error('secret-provider-content'); return content; } };
  const service = createNativeCreationService({ store, drive, creation, assessment, spec, clock: () => now, diagnose: stage => diagnostics.push(stage) });
  const input = { account: 'owner@example.invalid', operationId: randomUUID(), folderId: 'dest', title: 'Title', text: 'Exact private content' };
  return { store, service, input, diagnostics, counts: () => [creates, populations], setDrift: () => { drift = true; }, setUnavailable: () => { unavailable = true; }, expire: () => { now = 600_001; }, close: () => harness.lifecycle.dispose() };
}
const yes = async p => { assert.equal(p.content, 'Exact private content'); return { outcome: 'submitted', value: { approved: true } }; };
for (const kind of ['document', 'spreadsheet']) test(`${kind} shared creation reviews and verifies once`, async () => {
  const h = await setup({ kind }); try {
    assert.equal((await h.service.create(h.input, undefined, yes)).outcome, 'verified');
    assert.equal((await h.service.create(h.input, undefined, yes)).receiptOnly, true);
    assert.equal((await h.service.inspect(h.input)).outcome, 'verified'); assert.deepEqual(h.counts(), [1, 1]);
    assert.doesNotMatch(JSON.stringify(await h.store.getCreation(h.input.operationId)), /Exact private content|Title/);
  } finally { await h.close(); }
});

for (const mode of ['expiry', 'access_change']) test(`${mode} after approval prevents both writes`, async () => {
  const h = await setup(); try {
    const r = await h.service.create(h.input, undefined, async () => { if (mode === 'expiry') h.expire(); else h.setDrift(); return { outcome: 'submitted', value: { approved: true } }; });
    assert.equal(r.outcome, 'not_created'); assert.deepEqual(h.counts(), [0, 0]);
  } finally { await h.close(); }
});

test('failed durable ID claim prevents population and remains unresolved', async () => {
  const h = await setup(); try {
    h.store.attachSharedCreation = async () => { throw new Error('secret-storage'); };
    const r = await h.service.create(h.input, undefined, yes);
    assert.equal(r.outcome, 'uncertain'); assert.deepEqual(h.counts(), [1, 0]);
    assert.equal((await h.store.getCreation(h.input.operationId)).claimState, 'uncertain');
    await h.service.create(h.input, undefined, yes); assert.deepEqual(h.counts(), [1, 0]);
  } finally { await h.close(); }
});
for (const mode of ['decline', 'cancel', 'drift', 'incomplete', 'lostCreate', 'lostPopulation']) test(`shared creation ${mode} does not replay`, async () => {
  const h = await setup({ [mode]: true }); try {
    const approve = mode === 'decline' ? async () => ({ outcome: 'submitted', value: { approved: false } }) : mode === 'cancel' ? async () => ({ outcome: 'cancelled' }) : yes;
    if (mode === 'incomplete') await assert.rejects(h.service.create(h.input, undefined, approve));
    else { const r = await h.service.create(h.input, undefined, approve); assert.notEqual(r.outcome, 'verified');
      if (mode.startsWith('lost')) { const observed = await h.service.inspect(h.input); assert.notEqual(observed.outcome, 'verified'); assert.equal(observed.unresolved, true); }
      await h.service.create(h.input, undefined, approve); }
    assert.deepEqual(h.counts(), [['drift', 'lostCreate', 'lostPopulation'].includes(mode) ? 1 : 0, mode === 'lostPopulation' ? 1 : 0]);
  } finally { await h.close(); }
});

test('unresolved creation blocks sharing and same-key requests cannot change content', async () => {
  const h = await setup({ lostPopulation: true }); try {
    await h.service.create(h.input, undefined, yes);
    const share = { operationId: randomUUID(), subject: 'subject', fileId: 'dest', state: 'proposed' };
    await h.store.reserveSharing(share);
    assert.equal(await h.store.claimSharing(share.operationId, 'dest'), false);
    assert.deepEqual(h.counts(), [1, 1]);
    await assert.rejects(h.service.create({ ...h.input, text: 'Different' }, undefined, yes), e => e.creationCode === 'operation_conflict');
  } finally { await h.close(); }
});

test('oversized exact review is rejected before reservation or provider write', async () => {
  const h = await setup(); try {
    await assert.rejects(h.service.create({ ...h.input, text: 'x'.repeat(49000) }, undefined, yes), e => e.creationCode === 'review_unavailable');
    assert.equal(await h.store.getCreation(h.input.operationId), null); assert.deepEqual(h.counts(), [0, 0]);
  } finally { await h.close(); }
});

test('shared status diagnoses incomplete lookup and mismatched observation using fixed stages', async () => {
  for (const emptyLookup of [true, false]) {
    const h = await setup({ lostCreate: true, emptyLookup });
    try {
      await h.service.create(h.input, undefined, yes);
      await h.service.inspect(h.input);
      assert.ok(h.diagnostics.includes(emptyLookup ? 'test_creation_lookup_uncertain' : 'test_creation_status_mismatch'));
      assert.doesNotMatch(JSON.stringify(h.diagnostics), /secret|private/);
    } finally { await h.close(); }
  }
});

test('unavailable read of historical verified shared creation does not claim an unresolved lock', async () => {
  const h = await setup(); try {
    assert.equal((await h.service.create(h.input, undefined, yes)).outcome, 'verified');
    h.setUnavailable();
    const status = await h.service.inspect(h.input);
    assert.equal(status.outcome, 'verification_unavailable'); assert.equal(status.unresolved, undefined);
    assert.ok(h.diagnostics.includes('test_creation_status'));
  } finally { await h.close(); }
});
