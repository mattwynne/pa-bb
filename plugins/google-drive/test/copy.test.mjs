import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveService } from '../core/service.mjs';
const folder = 'application/vnd.google-apps.folder';
function setup(overrides = {}) {
  const calls = [];
  const drive = {
    getFile: async (_, id) => id === 'dest' ? { id, mimeType: folder, capabilities: { canAddChildren: true } }
      : id === 'new' ? { id, parents: ['dest'] } : { id, name: 'Template', capabilities: { canCopy: true } },
    copyFile: async (...args) => { calls.push(args); return { id: 'new' }; }, ...overrides,
  };
  return { calls, service: createDriveService({ store: { byEmail: async () => ({ email: 'test@example.org' }) }, drive }) };
}
const args = { account: 'test@example.org', sourceId: 'source', folderId: 'dest' };
test('copy verifies destination and returns ID and clickable URL', async () => {
  const { service, calls } = setup();
  const result = await service.execute('gdrive_copy_file', args);
  assert.equal(result.outcome, 'verified');
  assert.equal(result.file.id, 'new');
  assert.match(result.file.url, /^https:\/\//);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), ['source', 'dest', 'Template']);
});
test('uncertain copy is not retried', async () => {
  let count = 0;
  const { service } = setup({ copyFile: async () => { count++; return { outcome: 'uncertain' }; } });
  assert.equal((await service.execute('gdrive_copy_file', args)).retrySafe, false);
  assert.equal(count, 1);
});
test('unwritable destination prevents mutation', async () => {
  const { service, calls } = setup({ getFile: async () => ({ capabilities: { canCopy: true } }) });
  await assert.rejects(service.execute('gdrive_copy_file', args), /writable folder/);
  assert.equal(calls.length, 0);
});
test('verification failure retains new ID and forbids retry', async () => {
  const { service } = setup({ getFile: async (_, id) => {
    if (id === 'new') throw new Error('private sentinel');
    return id === 'dest' ? { mimeType: folder, capabilities: { canAddChildren: true } } : { capabilities: { canCopy: true } };
  } });
  const result = await service.execute('gdrive_copy_file', args);
  assert.equal(result.file.id, 'new');
  assert.equal(result.retrySafe, false);
  assert.ok(!JSON.stringify(result).includes('sentinel'));
});
