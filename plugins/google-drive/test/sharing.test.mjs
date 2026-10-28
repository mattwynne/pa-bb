import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveService } from '../core/service.mjs';
function fixture(listPermissions) {
  const diagnostics = [];
  const service = createDriveService({ store: { byEmail: async email => email === 'test@example.org' ? { email } : null }, drive: {
    getSharingMetadata: async () => ({ id: 'folder', name: 'Folder', driveId: 'team', owners: [], shared: true }), listPermissions,
  }, diagnose: (stage) => diagnostics.push(stage) });
  return { diagnostics, run: () => service.execute('gdrive_inspect_sharing', { account: 'test@example.org', fileId: 'folder' }) };
}
test('sharing drains pages and distinguishes public, link, group and inherited visibility', async () => {
  const tokens = [];
  const f = fixture(async (_, id, token) => {
    assert.equal(id, 'folder'); tokens.push(token);
    return token ? { permissions: [
      { id: 'link', type: 'anyone', role: 'reader', allowFileDiscovery: false },
      { id: 'group', type: 'group', emailAddress: 'group@example.org', role: 'writer', permissionDetails: [{ inherited: true, inheritedFrom: 'parent', role: 'writer' }] },
    ] } : { permissions: [{ id: 'public', type: 'anyone', role: 'reader', allowFileDiscovery: true }], nextPageToken: 'next' };
  });
  const r = await f.run();
  assert.deepEqual(tokens, [undefined, 'next']);
  assert.equal(r.listingComplete, true);
  assert.deepEqual(r.anyoneAccess.map(p => p.discovery), ['discoverable', 'link']);
  assert.equal(r.permissions[2].permissionDetails[0].inheritedFrom, 'parent');
  assert.match(r.visibility, /not an exhaustive/);
});
test('partial failure is not empty success and provider content does not leak', async () => {
  const f = fixture(async (_, id, token) => {
    if (token) throw Object.assign(Error('private sentinel'), { status: 403 });
    return { permissions: [{ type: 'user', role: 'reader' }], nextPageToken: 'next' };
  });
  const r = await f.run();
  assert.equal(r.listingComplete, false);
  assert.equal(r.permissions.length, 1);
  assert.equal(r.listingError, 'drive_unavailable');
  assert.deepEqual(f.diagnostics, ['inspect_sharing_permissions']);
  assert.ok(!JSON.stringify(r).includes('sentinel'));
});
test('empty and repeated pages cannot imply privacy or loop indefinitely', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { permissions: [], nextPageToken: 'same' }; });
  const r = await f.run();
  assert.equal(calls, 2);
  assert.equal(r.listingComplete, false);
  assert.match(r.visibility, /does not establish privacy/);
});
test('complete empty list still has visibility caveat', async () => {
  const r = await fixture(async () => ({ permissions: [] })).run();
  assert.equal(r.listingComplete, true);
  assert.deepEqual(r.anyoneAccess, []);
  assert.match(r.visibility, /Group membership/);
});
