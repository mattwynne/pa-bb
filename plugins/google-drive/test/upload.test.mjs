import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createUploadService, uploadParameters, uploadMessage } from '../core/upload.mjs';
const sha = createHash('sha256').update('fixture').digest('hex');
const input = () => ({ account: 'owner@example.invalid', operationId: randomUUID(), source: { host: 'bb-server', threadId: 'thr_test', path: 'model.xlsx' }, expectedSha256: sha, folderId: 'dest', name: 'Model.xlsx', mimeType: 'application/test' });
const yes = async () => ({ outcome: 'submitted', value: { approved: true } });
async function setup(options = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: 'google-drive' });
  const store = createBbStore(bb.storage.database(), (db, statements) => bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'subject', email: 'owner@example.invalid', refreshToken: 'PRIVATE_TOKEN' });
  let writes = 0, drift = false, changed = false, duplicate = false, now = 0, unavailable = false, file, granted = true;
  const diagnostics = [];
  const assessment = { async assessDestination() { if (options.incomplete) throw new Error('PRIVATE_PROVIDER'); return { destinationId: 'dest', fingerprint: drift ? 'drift' : 'original', contextIds: ['dest', 'root'], path: 'My Drive / Foreign parent / Team', owners: 'foreign@example.invalid', audience: 'team@example.invalid — Can edit', allowedAccess: [] }; }, async verifyCreated() { return !options.unexpectedAccess; } };
  const source = { async capture() { if (changed) throw Object.assign(new Error('PRIVATE_SOURCE'), { uploadCode: 'changed' }); return { bytes: Buffer.from('fixture'), sizeBytes: 7, sha256: sha, md5: 'md5', name: 'model.xlsx', location: '/synthetic/thread/model.xlsx', version: 'version', conversion: { tabs: ['Budget'], sourceFormulaCount: 1 } }; } };
  const upload = { async prepare() { if (!granted) throw Object.assign(new Error('PRIVATE_TOKEN'), { uploadCode: 'scope' }); return async r => { writes++; file = { id: 'new', name: r.name, mimeType: r.resultMime, parents: ['dest'], appProperties: { paLocalUpload: r.operationId }, trashed: false, size: '7', md5Checksum: options.checksumMismatch ? 'wrong' : 'md5', sha256Checksum: sha }; if (options.lost) throw new Error('PRIVATE_REPLY'); if (options.rejected) throw Object.assign(new Error('PRIVATE_REJECTION'), { uploadRejected: true }); return { id: 'new' }; }; }, async duplicates() { if (duplicate) throw Object.assign(new Error('PRIVATE_DUPLICATE'), { uploadCode: 'duplicate' }); }, async get() { if (unavailable) throw new Error('PRIVATE_PROVIDER'); return file; }, async find() { return options.empty ? null : 'new'; }, async inspectSheet() { if (options.importReadFailure) throw new Error('PRIVATE_IMPORT'); return { structureMatches: !options.tabMismatch, fidelityVerified: false, observedCalculationErrorCount: 1 }; } };
  const service = createUploadService({ store, source, upload, assessment, clock: () => now, diagnose: (stage, error) => diagnostics.push([stage, uploadMessage(error)]) });
  return { store, service, diagnostics, setDrift() { drift = true; }, change() { changed = true; }, duplicate() { duplicate = true; }, revoke() { granted = false; }, expire() { now = 600001; }, unavailable() { unavailable = true; }, writes: () => writes, close: () => harness.lifecycle.dispose(), reload: () => createUploadService({ store, source, upload, assessment }) };
}
test('preview captures exact metadata without write; mandatory review and repeated/reloaded request never replay', async () => {
  const h = await setup(), a = input(); try {
    const p = await h.service.submit(a); assert.equal(h.writes(), 0); assert.equal(p.preview.sha256, sha); assert.equal(p.preview.sourcePath, '/synthetic/thread/model.xlsx');
    await assert.rejects(h.service.submit({ ...a, preview: false }), e => e.uploadCode === 'review');
    const r = await h.service.submit({ ...a, preview: false }, undefined, yes); assert.equal(r.outcome, 'verified'); assert.equal(r.evidence.checksumMatches, true);
    assert.equal((await h.reload().submit({ ...a, preview: false }, undefined, yes)).receiptOnly, true); assert.equal(h.writes(), 1);
    assert.equal((await h.service.status({ account: a.account, operationId: a.operationId })).outcome, 'verified');
    assert.doesNotMatch(JSON.stringify(await h.store.getCreation(a.operationId)), /PRIVATE|model.xlsx|Model.xlsx|fixture/);
    for (const delta of [{ name: 'other' }, { mode: 'xlsx_to_sheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { expectedSha256: '0'.repeat(64) }, { source: { ...a.source, path: 'other.xlsx' } }]) await assert.rejects(h.service.submit({ ...a, ...delta }), e => e.uploadCode === 'conflict');
  } finally { await h.close(); }
});
for (const kind of ['change', 'setDrift', 'duplicate', 'revoke', 'expire', 'cancel', 'decline', 'extraApproval', 'abort']) test(`${kind} after review prevents submission`, async () => {
  const h = await setup(), a = input(), controller = new AbortController(); try {
    await h.service.submit(a);
    const r = await h.service.submit({ ...a, preview: false }, controller.signal, async () => {
      if (kind === 'cancel') return { outcome: 'cancelled' };
      if (kind === 'decline') return { outcome: 'submitted', value: { approved: false } };
      if (kind === 'extraApproval') return { outcome: 'submitted', value: { approved: true, bypass: true } };
      if (kind === 'abort') controller.abort(); else h[kind](); return yes();
    });
    assert.notEqual(r.outcome, 'verified'); assert.equal(h.writes(), 0);
    await h.service.submit({ ...a, preview: false }, undefined, yes); assert.equal(h.writes(), 0);
    assert.doesNotMatch(JSON.stringify(h.diagnostics), /PRIVATE/);
  } finally { await h.close(); }
});
for (const mode of ['binary', 'xlsx_to_sheet']) test(`${mode}: lost reply observes but never acknowledges, replays or unlocks`, async () => {
  const h = await setup({ lost: true }), a = { ...input(), mode, mimeType: mode === 'binary' ? 'application/test' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }; try {
    assert.equal((await h.service.submit({ ...a, preview: false }, undefined, yes)).outcome, 'uncertain');
    const r = await h.reload().status({ account: a.account, operationId: a.operationId }); assert.equal(r.outcome, 'observed_matching'); assert.equal(r.acknowledged, false); assert.equal(r.unresolved, true);
    await h.service.submit({ ...a, preview: false }, undefined, yes); assert.equal(h.writes(), 1);
    const op = { operationId: randomUUID(), subject: 'subject', fileId: 'new', state: 'proposed' }; await h.store.reserveSharing(op); assert.equal(await h.store.claimSharing(op.operationId, 'new'), false);
    const b = { ...a, operationId: randomUUID(), preview: false }; await assert.rejects(h.service.submit(b, undefined, yes), e => e.uploadCode === 'busy');
  } finally { await h.close(); }
});
for (const options of [{ checksumMismatch: true }, { unexpectedAccess: true }, { lost: true, empty: true }, { importReadFailure: true }, { tabMismatch: true }]) test(`verification failure ${JSON.stringify(options)} stays honest`, async () => {
  const h = await setup(options), a = { ...input(), ...(options.importReadFailure || options.tabMismatch ? { mode: 'xlsx_to_sheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } : {}) }; try {
    const r = await h.service.submit({ ...a, preview: false }, undefined, yes); assert.equal(r.outcome, 'uncertain');
    assert.notEqual((await h.service.status({ account: a.account, operationId: a.operationId })).outcome, 'verified'); assert.equal(h.writes(), 1);
  } finally { await h.close(); }
});
test('explicit conversion acknowledges only provider import, never checksum equality or Excel fidelity', async () => {
  const h = await setup(), a = { ...input(), mode: 'xlsx_to_sheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', preview: false }; try {
    const r = await h.service.submit(a, undefined, yes); assert.equal(r.outcome, 'verified'); assert.equal(r.evidence.fidelityVerified, false); assert.equal(r.evidence.checksumMatches, undefined); assert.equal(r.evidence.observedCalculationErrorCount, 1);
  } finally { await h.close(); }
});
test('interrupted review status cancels without writes; acknowledged readback failure can recover read-only', async () => {
  const h = await setup(), a = input(); try {
    await h.service.submit(a); const op = await h.store.getCreation(a.operationId); op.claimState = 'reviewing'; op.outcome = 'reviewing'; await h.store.updateCreation(op);
    assert.equal((await h.reload().status({ account: a.account, operationId: a.operationId })).outcome, 'cancelled'); assert.equal(h.writes(), 0);
    const b = input(); await h.service.submit({ ...b, preview: false }, undefined, yes); h.unavailable();
    assert.equal((await h.service.status({ account: b.account, operationId: b.operationId })).outcome, 'verification_unavailable'); assert.equal(h.writes(), 1);
  } finally { await h.close(); }
});
test('failed durable acknowledgement does not cause replay; cross-kind receipt cannot be reused', async () => {
  const h = await setup(), a = input(); try {
    h.store.attachSharedCreation = async () => { throw new Error('PRIVATE_STORAGE'); };
    assert.equal((await h.service.submit({ ...a, preview: false }, undefined, yes)).outcome, 'uncertain');
    await h.service.submit({ ...a, preview: false }, undefined, yes); assert.equal(h.writes(), 1);
    const b = input(); await h.store.reserveCreation({ operationId: b.operationId, subject: 'subject', kind: 'copy' });
    await assert.rejects(h.service.submit(b), e => e.uploadCode === 'conflict');
  } finally { await h.close(); }
});
test('review regression: same destination/name excludes concurrent uploads across different connected accounts', async () => {
  const h = await setup(), a = { ...input(), preview: false }; let release;
  const decision = new Promise(resolve => { release = resolve; });
  try {
    await h.store.addAccount({ subject: 'other', email: 'other@example.invalid', refreshToken: 'PRIVATE_TOKEN' });
    const first = h.service.submit(a, undefined, async () => decision);
    for (let i = 0; i < 100; i++) { if ((await h.store.getCreation(a.operationId))?.claimState === 'reviewing') break; await new Promise(r => setTimeout(r, 1)); }
    await assert.rejects(h.service.submit({ ...a, account: 'other@example.invalid', operationId: randomUUID() }, undefined, yes), e => e.uploadCode === 'busy');
    release({ outcome: 'submitted', value: { approved: false } }); await first; assert.equal(h.writes(), 0);
  } finally { release?.({ outcome: 'cancelled' }); await h.close(); }
});
test('schema refuses remote paths/unknown switches/native source MIME and conversion cannot be inferred', async () => {
  assert.equal(uploadParameters.parse(input()).mode, 'binary');
  assert.equal(uploadParameters.safeParse({ ...input(), source: { host: 'remote', threadId: 'thr_test', path: 'file' } }).success, false);
  const h = await setup(); try { await assert.rejects(h.service.submit({ ...input(), mimeType: 'application/vnd.google-apps.spreadsheet' }), e => e.uploadCode === 'invalid'); } finally { await h.close(); }
});
