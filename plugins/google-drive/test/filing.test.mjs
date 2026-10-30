import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { createFilingService, filingCategory } from '../core/filing.mjs';
import { failureCategory } from '../diagnostic.mjs';
const account = 'owner@example.invalid', FOLDER = 'application/vnd.google-apps.folder', DOC = 'application/vnd.google-apps.document';
const owner = { id: 'owner', type: 'user', role: 'owner', emailAddress: account, permissionDetails: [{ inherited: false, role: 'owner', permissionType: 'file' }] };
const group = { id: 'group', type: 'group', role: 'writer', emailAddress: 'team@example.invalid', permissionDetails: [{ inherited: true, inheritedFrom: 'root-id', role: 'writer', permissionType: 'file' }] };
const folderArgs = () => ({ account, operationId: randomUUID(), parentId: 'root', name: 'Synthetic filing folder' });
const statusArgs = ({ account, operationId }) => ({ account, operationId });
const moveArgs = () => ({ account, operationId: randomUUID(), fileId: 'doc-id', expectedParentId: 'root', folderId: 'dest-id' });
async function setup(options = {}) {
  const h = createFakePluginHost({ pluginId: 'google-drive' });
  const store = createBbStore(h.bb.storage.database(), (db, statements) => h.bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'subject', email: account, accessToken: 'private-access-token', refreshToken: 'private-refresh', expiresAt: Date.now() + 600_000 });
  const calls = [], logs = [], files = new Map(), extra = options.shared ? [group] : [];
  function meta(id, name, mimeType, parents) { return { id, name, mimeType, parents, trashed: false, owners: [{ me: true, emailAddress: account }], capabilities: { canAddChildren: true, canMoveItemWithinDrive: true } }; }
  files.set('root-id', meta('root-id', 'My Drive', FOLDER));
  files.set('dest-id', meta('dest-id', 'Synthetic destination', FOLDER, ['root-id']));
  files.set('doc-id', meta('doc-id', 'Synthetic existing Doc', DOC, ['root-id']));
  const content = 'private-original-content'; let storedContent = content, marker, writes = 0, clock = 1000;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ url: u, init });
    if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: options.wrongIdentity ? 'other' : 'subject', email: account, email_verified: true });
    if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${options.scope || 'drive'}` });
    if (init.method === 'POST' && u.pathname === '/drive/v3/files') {
      writes++;
      if (options.reject) return Response.json({ secret: 'private-body' }, { status: options.reject });
      const body = JSON.parse(init.body); assert.deepEqual(Object.keys(body).sort(), ['appProperties', 'mimeType', 'name', 'parents']);
      assert.equal(body.mimeType, FOLDER); marker = body.appProperties.paFilingCreation;
      files.set('new-folder', meta('new-folder', body.name, FOLDER, body.parents));
      if (options.lost) throw Object.assign(new Error('private-error'), { cause: 'private-cause', code: 'private-code' });
      return options.badJson ? new Response('private-unreadable') : Response.json({ id: 'new-folder' });
    }
    if (init.method === 'PATCH') {
      writes++;
      assert.equal(u.pathname, '/drive/v3/files/doc-id'); assert.equal(u.searchParams.get('addParents'), 'dest-id'); assert.equal(u.searchParams.get('removeParents'), 'root-id');
      assert.deepEqual(JSON.parse(init.body), {});
      if (options.reject) return Response.json({ secret: 'private-body' }, { status: options.reject });
      files.get('doc-id').parents = ['dest-id'];
      if (options.lost) throw Object.assign(new Error('private-error'), { cause: 'private-cause', code: 'private-code' });
      return options.badJson ? new Response('private-unreadable') : Response.json({ id: 'doc-id' });
    }
    if (u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q');
      if (q.includes('appProperties')) return Response.json({ files: marker && !options.emptyRecovery ? [{ id: 'new-folder' }, ...(options.ambiguousRecovery ? [{ id: 'other' }] : [])] : [], ...(options.incompleteRecovery ? { incompleteSearch: true } : {}) });
      return Response.json({ files: options.duplicate || files.has('new-folder') ? [{ id: 'new-folder' }] : [], ...(options.pagedDuplicates ? { nextPageToken: 'private-page' } : {}) });
    }
    const id = u.pathname.split('/')[4] === 'root' ? 'root-id' : u.pathname.split('/')[4];
    if (u.pathname.endsWith('/permissions')) {
      if (options.permissionError) return Response.json({ private: 'private-response' }, { status: 503 });
      const inherited = id === 'dest-id' || (id === 'doc-id' && files.get('doc-id').parents[0] === 'dest-id') ? extra : [];
      const list = [owner, ...inherited, ...(options.unexpectedAccess && writes && id === 'doc-id' ? [{ ...group, id: 'unexpected', emailAddress: 'other@example.invalid' }] : []), ...(options.directSource && id === 'doc-id' ? [{ ...group, id: 'direct', permissionDetails: [{ inherited: false }] }] : [])];
      return Response.json({ permissions: list, ...(options.pagedPermissions ? { nextPageToken: 'private-page' } : {}) });
    }
    if (files.has(id)) {
      if (options.verifyError && writes && id === 'doc-id') return Response.json({ private: 'private-response' }, { status: 503 });
      const file = structuredClone(files.get(id));
      if (options.sharedDrive && id === 'dest-id') file.driveId = 'shared-drive';
      if (options.notOwned && id === 'dest-id') file.owners[0].me = false;
      if (options.limited && id === 'dest-id') file.inheritedPermissionsDisabled = true;
      if (options.notWritable && id === 'dest-id') file.capabilities.canAddChildren = false;
      if (options.notMovable && id === 'doc-id') file.capabilities.canMoveItemWithinDrive = false;
      if (options.shortcut && id === 'doc-id') file.mimeType = 'application/vnd.google-apps.shortcut';
      if (options.wrongParentAfterWrite && writes && id === 'doc-id') file.parents = ['root-id'];
      return Response.json(file);
    }
    throw new Error('private-unexpected-request');
  };
  const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl });
  const diagnose = (stage, error) => logs.push(`Google Drive ${stage} ${filingCategory(error)} ${failureCategory(error)}`);
  const service = () => createFilingService({ store, operations: store.filing, filing: adapter.filing, diagnose, clock: () => clock });
  const s = service();
  return { ...h, store, s, service, files, calls, options, logs, writes: () => writes, content: () => storedContent,
    tick: ms => { clock += ms; }, close: () => h.harness.lifecycle.dispose() };
}
function safe(h) { assert.doesNotMatch(h.logs.join('\n'), /private-|owner@example|Synthetic|doc-id|dest-id|subject|team@example/); }
test('folder preview then one create, exact readback, repeat/status never write again', async () => {
  const h = await setup(), a = folderArgs();
  try {
    const p = await h.s.createFolder(a); assert.equal(p.outcome, 'proposed'); assert.equal(p.requiresApproval, false); assert.equal(h.writes(), 0);
    const r = await h.s.createFolder({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); assert.equal(r.fileId, 'new-folder'); assert.equal(h.writes(), 1);
    assert.equal((await h.s.createFolder({ ...a, preview: false })).receiptOnly, true);
    assert.equal((await h.s.status(statusArgs(a))).outcome, 'verified'); assert.equal(h.writes(), 1); safe(h);
  } finally { await h.close(); }
});
test('move preserves ID, URL and content; one metadata-only PATCH, never copy/permission/content requests', async () => {
  const h = await setup(), a = moveArgs();
  try {
    const r = await h.s.move({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); assert.equal(r.fileId, a.fileId);
    assert.equal(r.url, 'https://docs.google.com/document/d/doc-id/edit'); assert.deepEqual(h.files.get('doc-id').parents, ['dest-id']); assert.equal(h.content(), 'private-original-content');
    assert.equal(h.writes(), 1); await h.s.move({ ...a, preview: false }); await h.s.status(statusArgs(a)); assert.equal(h.writes(), 1);
    assert.ok(h.calls.every(c => !c.url.pathname.includes('/copy') && (!c.init.method || c.init.method === 'PATCH' || c.url.pathname.endsWith('/tokeninfo')))); safe(h);
  } finally { await h.close(); }
});
test('shared destination requires exact approval; no inherited-access categorical rejection', async () => {
  const h = await setup({ shared: true }), a = moveArgs();
  try {
    const p = await h.s.move(a); assert.equal(p.requiresApproval, true); assert.match(p.preview.audience, /team@example.invalid/);
    let card;
    const r = await h.s.move({ ...a, preview: false }, undefined, async payload => { card = payload; assert.equal(h.writes(), 0); return { outcome: 'submitted', value: { approved: true } }; });
    assert.equal(r.outcome, 'verified'); assert.equal(card.operationId, a.operationId); assert.equal(card.to, 'My Drive / Synthetic destination'); assert.equal(h.writes(), 1); safe(h);
  } finally { await h.close(); }
});
test('shared parent folder creation also requires review and makes no ACL write', async () => {
  const h = await setup({ shared: true }), a = { ...folderArgs(), parentId: 'dest-id', preview: false };
  try { const r = await h.s.createFolder(a, undefined, async () => ({ outcome: 'submitted', value: { approved: true } })); assert.equal(r.outcome, 'verified'); assert.equal(h.writes(), 1); }
  finally { await h.close(); }
});
test('decline, timeout, invalid approval and cancellation never submit', async () => {
  for (const decision of [{ outcome: 'submitted', value: { approved: false } }, { outcome: 'cancelled', reason: 'timeout' }, { outcome: 'submitted', value: { approved: true, extra: true } }]) {
    const h = await setup({ shared: true });
    try { const r = await h.s.move({ ...moveArgs(), preview: false }, undefined, async () => decision); assert.ok(['declined', 'cancelled'].includes(r.outcome)); assert.equal(h.writes(), 0); safe(h); }
    finally { await h.close(); }
  }
  const h = await setup(); const controller = new AbortController(); controller.abort();
  try { assert.equal((await h.s.move({ ...moveArgs(), preview: false }, controller.signal)).outcome, 'not_submitted'); assert.equal(h.writes(), 0); } finally { await h.close(); }
});
test('stale names/access, expired proposals, changed parents and duplicate names do not write', async () => {
  const h = await setup(), a = moveArgs();
  try { await h.s.move(a); h.files.get('dest-id').name = 'Changed'; assert.equal((await h.s.move({ ...a, preview: false })).outcome, 'stale'); assert.equal(h.writes(), 0); } finally { await h.close(); }
  const e = await setup(), b = moveArgs();
  try { await e.s.move(b); e.tick(600_000); assert.equal((await e.s.move({ ...b, preview: false })).outcome, 'expired'); assert.equal(e.writes(), 0); } finally { await e.close(); }
  for (const options of [{ duplicate: true }, { pagedDuplicates: true }]) {
    const d = await setup(options); try { await assert.rejects(d.s.createFolder({ ...folderArgs(), preview: false })); assert.equal(d.writes(), 0); } finally { await d.close(); }
  }
});
test('scope, identity, authority, unsupported structures and incomplete permissions fail before write', async () => {
  for (const options of [{ scope: 'drive.readonly' }, { scope: 'documents' }, { wrongIdentity: true }, { sharedDrive: true }, { notOwned: true }, { limited: true }, { notWritable: true }, { notMovable: true }, { shortcut: true }, { pagedPermissions: true }, { permissionError: true }]) {
    const h = await setup(options);
    try { await assert.rejects(h.s.move({ ...moveArgs(), preview: false })); assert.equal(h.writes(), 0); safe(h); } finally { await h.close(); }
  }
  const h = await setup({ scope: 'drive.file' }); try { assert.equal((await h.s.move({ ...moveArgs(), preview: false })).outcome, 'verified'); } finally { await h.close(); }
});
test('input validation, unknown account and key/account/request conflicts never bypass a receipt', async () => {
  const h = await setup(), a = folderArgs();
  try {
    for (const patch of [{ name: ' ' }, { name: 'bad\nname' }, { name: '\ud800' }, { name: 'x'.repeat(256) }, { parentId: 'https://drive.google.com' }, { operationId: randomUUID().toUpperCase() }, { permissions: [] }]) await assert.rejects(h.s.createFolder({ ...a, ...patch }));
    assert.equal(h.calls.length, 0);
    await assert.rejects(h.s.createFolder({ ...a, account: 'unknown@example.invalid' }));
    await h.s.createFolder(a);
    await assert.rejects(h.s.createFolder({ ...a, name: 'different' }), e => e.filingCode === 'conflict');
    await h.store.addAccount({ subject: 'other', email: 'other@example.invalid', refreshToken: 'private-other' });
    await assert.rejects(h.s.createFolder({ ...a, account: 'other@example.invalid' }), e => e.filingCode === 'conflict');
    await assert.rejects(h.s.status({ ...statusArgs(a), account: 'other@example.invalid' }), e => e.filingCode === 'unknown'); assert.equal(h.writes(), 0);
  } finally { await h.close(); }
});
test('same-key concurrency/restart and different-key same-document review exclusion', async () => {
  const h = await setup(), a = folderArgs();
  try {
    const results = await Promise.all([h.s.createFolder({ ...a, preview: false }), h.s.createFolder({ ...a, preview: false })]);
    assert.ok(results.some(r => r.outcome === 'verified')); assert.equal(h.writes(), 1);
    assert.equal((await h.service().createFolder({ ...a, preview: false })).receiptOnly, true); assert.equal(h.writes(), 1);
  } finally { await h.close(); }
  const b = await setup({ shared: true }); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }); const decision = new Promise(resolve => { release = resolve; });
  const first = b.s.move({ ...moveArgs(), preview: false }, undefined, async () => { entered(); return decision; });
  try {
    await ready; await assert.rejects(b.s.move({ ...moveArgs(), preview: false }), e => e.filingCode === 'busy');
    release({ outcome: 'submitted', value: { approved: true } }); assert.equal((await first).outcome, 'verified'); assert.equal(b.writes(), 1);
  } finally { release({ outcome: 'cancelled' }); await first; await b.close(); }
});
test('folder lost-response recovery is marker-based, never blind recreation; absent/ambiguous results remain uncertain', async () => {
  for (const options of [{ lost: true }, { badJson: true }, { lost: true, emptyRecovery: true }, { lost: true, ambiguousRecovery: true }, { lost: true, incompleteRecovery: true }]) {
    const h = await setup(options), a = folderArgs();
    try {
      assert.equal((await h.s.createFolder({ ...a, preview: false })).outcome, 'uncertain'); assert.equal(h.writes(), 1);
      const r = await h.service().status(statusArgs(a)); assert.equal(r.outcome, options.emptyRecovery || options.ambiguousRecovery || options.incompleteRecovery ? 'uncertain' : 'verified');
      await h.s.createFolder({ ...a, preview: false }); assert.equal(h.writes(), 1); safe(h);
    } finally { await h.close(); }
  }
});
test('lost move response matching is observed only: same-key inspection never replays or releases unresolved lock', async () => {
  const h = await setup({ lost: true }), a = moveArgs();
  try {
    assert.equal((await h.s.move({ ...a, preview: false })).outcome, 'uncertain');
    const r = await h.service().status(statusArgs(a)); assert.equal(r.outcome, 'observed_matching'); assert.equal(r.unresolved, true); assert.equal(r.readbackMatches, true);
    assert.equal((await h.store.filing.get(a.operationId)).state, 'uncertain');
    await h.s.move({ ...a, preview: false }); assert.equal(h.writes(), 1);
    await assert.rejects(h.s.move({ ...moveArgs(), expectedParentId: 'dest-id', folderId: 'root', preview: false }), e => e.filingCode === 'busy');
    assert.equal(h.writes(), 1); safe(h);
  } finally { await h.close(); }
});
test('definite refusal vs uncertain HTTP failures; never retries a mutation', async () => {
  for (const status of [400, 401, 403, 404, 409, 412, 422, 408, 429, 503]) {
    const h = await setup({ reject: status }), a = moveArgs();
    try {
      assert.equal((await h.s.move({ ...a, preview: false })).outcome, [408, 429, 503].includes(status) ? 'uncertain' : 'rejected');
      await h.s.move({ ...a, preview: false }); await h.s.status(statusArgs(a)); assert.equal(h.writes(), 1); safe(h);
    } finally { await h.close(); }
  }
});
test('scope revocation after review and direct grants are handled without ACL edits', async () => {
  const h = await setup({ shared: true }), a = moveArgs();
  try {
    const r = await h.s.move({ ...a, preview: false }, undefined, async () => { h.options.scope = 'drive.readonly'; return { outcome: 'submitted', value: { approved: true } }; });
    assert.equal(r.outcome, 'not_submitted'); assert.equal(h.writes(), 0); safe(h);
  } finally { await h.close(); }
  const d = await setup({ directSource: true });
  try { const r = await d.s.move({ ...moveArgs(), preview: false }, undefined, async () => ({ outcome: 'submitted', value: { approved: true } })); assert.equal(r.outcome, 'verified'); assert.equal(d.writes(), 1); } finally { await d.close(); }
});
test('unresolved permission work on source/destination/ancestry prevents filing without replay', async () => {
  for (const fileId of ['doc-id', 'dest-id', 'root-id']) {
    const h = await setup();
    try {
      await h.store.reserveSharing({ operationId: randomUUID(), subject: 'subject', fileId, state: 'uncertain' });
      await assert.rejects(h.s.move({ ...moveArgs(), preview: false }), e => e.filingCode === 'sharing_busy'); assert.equal(h.writes(), 0);
    } finally { await h.close(); }
  }
});
test('reservation/persistence failure cannot authorize replay; marker recovers a lost durable folder ID', async () => {
  const h = await setup(), a = folderArgs(), originalReserve = h.store.filing.reserve;
  try {
    h.store.filing.reserve = async () => { throw new Error('private-reservation'); };
    await assert.rejects(h.s.createFolder({ ...a, preview: false })); assert.equal(h.writes(), 0);
    h.store.filing.reserve = originalReserve;
    const originalSave = h.store.filing.save; h.store.filing.save = async () => { throw new Error('private-receipt'); };
    const r = await h.s.createFolder({ ...a, preview: false }); assert.equal(r.outcome, 'uncertain'); assert.equal(h.writes(), 1);
    h.store.filing.save = originalSave;
    assert.equal((await h.service().status(statusArgs(a))).outcome, 'verified');
    await h.s.createFolder({ ...a, preview: false }); assert.equal(h.writes(), 1); safe(h);
  } finally { await h.close(); }
});
test('verification failure or wrong parent never reports completion; later change does not replay historical success', async () => {
  for (const options of [{ verifyError: true }, { wrongParentAfterWrite: true }, { unexpectedAccess: true }]) {
    const h = await setup(options), a = moveArgs();
    try { assert.equal((await h.s.move({ ...a, preview: false })).outcome, 'uncertain'); await h.s.status(statusArgs(a)); assert.equal(h.writes(), 1); safe(h); } finally { await h.close(); }
  }
  const h = await setup(), a = moveArgs();
  try { await h.s.move({ ...a, preview: false }); h.files.get('doc-id').name = 'Later human rename'; assert.equal((await h.s.status(statusArgs(a))).outcome, 'changed_since_verification'); assert.equal(h.writes(), 1); } finally { await h.close(); }
});
