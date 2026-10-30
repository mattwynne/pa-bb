import test from 'node:test';
import assert from 'node:assert/strict';
import { createCopyService } from '../core/copy.mjs';
import { createMemoryStore } from '../core/memory-store.mjs';
const key = '12345678-1234-4123-8123-123456789abc';
const folder = 'application/vnd.google-apps.folder';
const args = { account: 'a@example.org', operationId: key, sourceId: 'source', folderId: 'root' };
async function setup(overrides = {}) {
  const store = createMemoryStore();
  await store.addAccount({ subject: 'sub', email: args.account });
  let count = 0;
  const drive = {
    async getFile(_r, id) {
      if (id === 'source') return { id, name: 'Template', mimeType: 'application/pdf', trashed: false, capabilities: { canCopy: true } };
      if (id === 'root') return { id: 'destination', mimeType: folder, trashed: false, capabilities: { canAddChildren: true } };
      return { id, name: 'Template', mimeType: 'application/pdf', trashed: false, parents: ['destination'], appProperties: { paCopyCreation: key } };
    },
    async prepareCopy() { return async () => { count++; return { id: 'new' }; }; },
    async findCopy() { return { files: [{ id: 'new' }] }; }, ...overrides,
  };
  const service = () => createCopyService({ store, drive, fileInfo: f => ({ ...f, url: `https://drive.google.com/file/d/${f.id}/view` }) });
  return { store, drive, service, count: () => count };
}
test('acknowledged copy verifies exact metadata and same key survives restart without replay', async () => {
  const f = await setup(); const a = await f.service().copy(args);
  assert.equal(a.outcome, 'verified'); assert.equal(a.file.id, 'new'); assert.match(a.file.url, /^https:/);
  const b = await f.service().copy(args); assert.equal(b.receiptOnly, true); assert.equal(f.count(), 1);
  assert.equal((await f.service().status(args)).outcome, 'verified');
  await assert.rejects(f.service().copy({ ...args, title: 'different' }), { copyCode: 'conflict' });
});
test('unknown write yields observation only and never replays after restart', async () => {
  let count = 0; const f = await setup({ prepareCopy: async () => async () => { count++; return {}; } });
  assert.equal((await f.service().copy(args)).outcome, 'uncertain');
  const result = await f.service().status(args);
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.acknowledged, false); assert.equal(result.observation, 'matching_metadata');
  await f.service().copy(args); assert.equal(count, 1);
});
test('missing keys, collisions, and unknown account cannot copy', async () => {
  const f = await setup();
  await assert.rejects(f.service().copy({ ...args, operationId: undefined }), { copyCode: 'invalid' });
  await f.store.reserveCreation({ operationId: key, kind: 'document', subject: 'sub' });
  await assert.rejects(f.service().copy(args), { copyCode: 'conflict' });
  await assert.rejects(f.service().status(args), { copyCode: 'unknown' });
  assert.equal(f.count(), 0);
});
test('incomplete search and mismatched metadata never prove completion', async () => {
  const f = await setup({ prepareCopy: async () => async () => ({}), findCopy: async () => ({ files: [{ id: 'new' }], nextPageToken: 'more' }) });
  await f.service().copy(args); assert.equal((await f.service().status(args)).outcome, 'uncertain');
  f.drive.findCopy = async () => ({ files: [{ id: 'new' }] });
  const get = f.drive.getFile; f.drive.getFile = async (r, id) => id === 'new' ? { ...(await get(r,id)), parents: ['other'] } : get(r,id);
  assert.equal((await f.service().status(args)).observation, 'mismatch');
});
test('verification failure retains acknowledged id without exposing private errors', async () => {
  const f = await setup(); const get = f.drive.getFile;
  f.drive.getFile = async (r,id) => { if (id === 'new') throw Error('private sentinel'); return get(r,id); };
  const result = await f.service().copy(args);
  assert.equal(result.outcome, 'verification_unavailable'); assert.equal(result.file.id, 'new');
  assert.ok(!JSON.stringify(result).includes('sentinel'));
});
test('concurrent calls reserve one key and submit once', async () => {
  const f = await setup(); const results = await Promise.all([f.service().copy(args), f.service().copy(args)]);
  assert.equal(f.count(), 1); assert.equal(results.length, 2);
});
test('durable SQLite receipt survives recreation and cross-account key collision', async () => {
  const { createFakePluginHost } = await import('@get-bb/plugin-sdk/testing');
  const { createBbStore } = await import('../adapters/bb-store.mjs');
  const host = createFakePluginHost({ pluginId: 'google-drive' });
  const db = host.bb.storage.database();
  const store = createBbStore(db, (db, migrations) => host.bb.storage.migrate(db, migrations));
  await store.addAccount({ subject: 'sub', email: args.account, refreshToken: 'synthetic' });
  await store.addAccount({ subject: 'other', email: 'b@example.org', refreshToken: 'synthetic' });
  const f = await setup(); let writes = 0;
  f.drive.prepareCopy = async () => async () => { writes++; return {}; };
  const create = s => createCopyService({ store: s, drive: f.drive, fileInfo: f => ({ id: f.id }) });
  assert.equal((await create(store).copy(args)).outcome, 'uncertain');
  const reopened = createBbStore(db, () => {});
  assert.equal((await create(reopened).status(args)).outcome, 'uncertain');
  await create(reopened).copy(args);
  await assert.rejects(create(reopened).copy({ ...args, account: 'b@example.org' }), { copyCode: 'conflict' });
  assert.equal(writes, 1);
  await host.harness.lifecycle.dispose();
});
test('receipt failures before submission and after acknowledgement cannot replay', async () => {
  for (const afterWrite of [false, true]) {
    const f = await setup(); let updates = 0;
    const update = f.store.updateCreation;
    f.store.updateCreation = async op => { updates++; if (updates === (afterWrite ? 2 : 1)) throw Error('private sentinel'); return update(op); };
    const result = await f.service().copy(args);
    assert.equal(result.outcome, afterWrite ? 'verification_unavailable' : 'uncertain');
    assert.equal(f.count(), afterWrite ? 1 : 0);
    f.store.updateCreation = update;
    await f.service().copy(args); assert.equal(f.count(), afterWrite ? 1 : 0);
    const recovered = await f.service().status(args);
    assert.equal(recovered.outcome, 'uncertain'); assert.equal(recovered.acknowledged, false);
    assert.doesNotMatch(JSON.stringify(result), /sentinel/);
  }
});
test('acknowledged verification refuses every metadata mismatch', async () => {
  for (const patch of [{ id: 'other' }, { name: 'wrong' }, { mimeType: 'image/png' }, { parents: ['destination', 'other'] }, { trashed: true }, { appProperties: {} }]) {
    const f = await setup(); const get = f.drive.getFile;
    f.drive.getFile = async (r, id) => id === 'new' ? { ...(await get(r, id)), ...patch } : get(r, id);
    const result = await f.service().copy(args);
    assert.equal(result.outcome, 'mismatch'); assert.equal(result.file.id, 'new'); assert.equal(f.count(), 1);
  }
});
test('diagnostic callback receives fixed stages and no provider text reaches receipt', async () => {
  const f = await setup(); const events = [];
  f.drive.prepareCopy = async () => async () => { throw Object.assign(Error('private sentinel'), { code: 'private code' }); };
  const service = createCopyService({ store: f.store, drive: f.drive, fileInfo: f => ({ id: f.id }), diagnose: stage => events.push(stage) });
  const result = await service.copy(args);
  assert.deepEqual(events, ['copy_write_or_verification']); assert.equal(result.outcome, 'uncertain');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
test('preflight requires exact source and destination identities and definite untrashed metadata', async () => {
  for (const [id, patch] of [['source', { id: 'other' }], ['source', { trashed: undefined }], ['source', { mimeType: undefined }],
    ['root', { trashed: undefined }], ['root', { mimeType: undefined }]]) {
    const f = await setup(); const get = f.drive.getFile;
    f.drive.getFile = async (r, target) => target === id ? { ...(await get(r, target)), ...patch } : get(r, target);
    await assert.rejects(f.service().copy(args), { copyCode: id === 'source' ? 'source' : 'destination' });
    assert.equal(f.count(), 0);
  }
  const f = await setup(); const get = f.drive.getFile;
  f.drive.getFile = async (r, id) => id === 'dest' ? { ...(await get(r, 'root')), id: 'other' } : get(r, id);
  await assert.rejects(f.service().copy({ ...args, folderId: 'dest' }), { copyCode: 'destination' });
  assert.equal(f.count(), 0);
});
test('ambiguous lookup and recovery mismatch have fixed safe diagnostic stages', async () => {
  const f = await setup({ prepareCopy: async () => async () => ({}) }); const logs = [];
  const service = createCopyService({ store: f.store, drive: f.drive, fileInfo: file => ({ id: file.id }), diagnose: stage => logs.push(stage) });
  await service.copy(args); logs.length = 0;
  f.drive.findCopy = async () => ({ files: [{ id: 'new' }], nextPageToken: 'SENTINEL' });
  await service.status(args); assert.deepEqual(logs, ['copy_status_lookup_uncertain']);
  logs.length = 0; f.drive.findCopy = async () => ({ files: [{ id: 'new' }] });
  const get = f.drive.getFile; f.drive.getFile = async (r,id) => id === 'new' ? { ...(await get(r,id)), name: 'SENTINEL' } : get(r,id);
  const result = await service.status(args); assert.deepEqual(logs, ['copy_status_mismatch']);
  assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(logs), /SENTINEL/);
});
