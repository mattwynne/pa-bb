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
  const calls = [], logs = [], files = new Map(), permissionRows = new Map(), extra = options.shared ? [group] : [];
  function meta(id, name, mimeType, parents) { return { id, name, mimeType, parents, trashed: false, owners: [{ me: true, emailAddress: account }], capabilities: { canAddChildren: true, canMoveItemWithinDrive: true } }; }
  files.set('root-id', meta('root-id', 'My Drive', FOLDER));
  files.set('dest-id', meta('dest-id', 'Synthetic destination', FOLDER, ['root-id']));
  files.set('doc-id', meta('doc-id', 'Synthetic existing Doc', DOC, ['root-id']));
  const content = 'private-original-content'; let storedContent = content, marker, writes = 0, clock = 1000;
  if (options.mimeType) files.get('doc-id').mimeType = options.mimeType;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ url: u, init });
    if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: options.wrongIdentity ? 'other' : 'subject', email: account, email_verified: true });
    if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${options.scope || 'drive'}` });
    if (init.method === 'POST' && u.pathname === '/drive/v3/files') {
      writes++;
      if (options.reject) return Response.json({ secret: 'private-body' }, { status: options.reject });
      const body = JSON.parse(init.body); assert.deepEqual(Object.keys(body).sort(), ['appProperties', 'mimeType', 'name', 'parents']);
      assert.equal(body.mimeType, FOLDER); marker = body.appProperties.paFilingCreation;
      files.set('new-folder', { ...meta('new-folder', body.name, FOLDER, body.parents), ...options.newFolderMetadata });
      if (options.newFolderPermissions) permissionRows.set('new-folder', options.newFolderPermissions);
      if (options.lost) throw Object.assign(new Error('private-error'), { cause: 'private-cause', code: 'private-code' });
      return options.badJson ? new Response('private-unreadable') : Response.json({ id: 'new-folder' });
    }
    if (init.method === 'PATCH') {
      writes++;
      assert.equal(u.pathname, '/drive/v3/files/doc-id'); assert.equal(u.searchParams.get('addParents'), 'dest-id'); assert.equal(u.searchParams.get('removeParents'), files.get('doc-id').parents[0]);
      assert.deepEqual(JSON.parse(init.body), {});
      if (options.reject) return Response.json({ secret: 'private-body' }, { status: options.reject });
      files.get('doc-id').parents = ['dest-id'];
      if (options.docPermissionsAfterWrite) permissionRows.set('doc-id', options.docPermissionsAfterWrite);
      if (options.typeAfterWrite) files.get('doc-id').mimeType = options.typeAfterWrite;
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
      const list = permissionRows.get(id) || (id === 'doc-id' && files.get(id).parents[0] === 'dest-id' ? permissionRows.get('dest-id') : null) || [owner, ...inherited, ...(options.unexpectedAccess && writes && id === 'doc-id' ? [{ ...group, id: 'unexpected', emailAddress: 'other@example.invalid' }] : []), ...(options.directSource && !(options.dropDirectAfterWrite && writes) && id === 'doc-id' ? [{ ...group, id: 'direct', permissionDetails: [{ inherited: false }] }] : [])];
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
  return { ...h, store, s, service, files, permissionRows, calls, options, logs, writes: () => writes, content: () => storedContent,
    tick: ms => { clock += ms; }, close: () => h.harness.lifecycle.dispose() };
}
function safe(h) { assert.doesNotMatch(h.logs.join('\n'), /private-|example\.invalid|Synthetic|doc-id|dest-id|subject|foreign-ancestor|owned-middle/); }
// Owned destination -> owned parent -> another person's folder -> owned root.
// No real account, file, credential or provider is involved.
function alternatingPath(h, { visibleWriter = true, sourcePath = false } = {}) {
  const ancestor = structuredClone(h.files.get('dest-id'));
  ancestor.id = 'foreign-ancestor'; ancestor.name = 'Synthetic shared administration';
  ancestor.owners = [{ me: false, emailAddress: 'partner@example.invalid' }];
  const middle = structuredClone(h.files.get('dest-id'));
  middle.id = 'owned-middle'; middle.name = 'Synthetic work'; middle.parents = [ancestor.id];
  h.files.set(ancestor.id, ancestor); h.files.set(middle.id, middle);
  h.files.get('dest-id').parents = [middle.id];
  if (sourcePath) h.files.get('doc-id').parents = [middle.id];
  const foreignOwner = { ...owner, id: 'foreign-owner', emailAddress: 'partner@example.invalid' };
  const selectedWriter = { ...owner, role: 'writer', permissionDetails: [{ inherited: false, role: 'writer' }] };
  h.permissionRows.set(ancestor.id, [foreignOwner, selectedWriter]);
  const otherWriter = { ...group, id: 'foreign-owner', type: 'user', emailAddress: 'partner@example.invalid', permissionDetails: [{ inherited: true, inheritedFrom: ancestor.id, role: 'writer' }] };
  for (const id of [middle.id, 'dest-id']) h.permissionRows.set(id, [owner, ...(visibleWriter ? [otherWriter] : [])]);
  return { ancestor, middle, otherWriter, foreignOwner, selectedWriter };
}
test('alternating-owned ancestry permits owned Sheet move only after exact review, with owners, paths and access impact', async () => {
  const h = await setup({ mimeType: 'application/vnd.google-apps.spreadsheet' }), a = moveArgs();
  alternatingPath(h);
  try {
    const p = await h.s.move(a); assert.equal(p.requiresApproval, true); assert.equal(h.writes(), 0);
    assert.equal(p.preview.to, 'My Drive / Synthetic shared administration / Synthetic work / Synthetic destination');
    assert.match(p.preview.destinationOwners, /Synthetic shared administration — owner: partner@example.invalid/);
    assert.match(p.preview.audience, /partner@example.invalid — Owner/);
    assert.match(p.preview.accessChanges, /partner@example.invalid — may gain editing access/);
    assert.match(p.preview.sharedAncestorSummary, /“Synthetic shared administration” belongs to partner@example.invalid/);
    assert.match(p.preview.reviewReason, /parent folder belongs to another person/);
    const r = await h.s.move({ ...a, preview: false }, undefined, async card => {
      assert.deepEqual(card, { ...p.preview, operationId: a.operationId }); assert.equal(h.writes(), 0);
      return { outcome: 'submitted', value: { approved: true } };
    });
    assert.equal(r.outcome, 'verified'); assert.equal(h.writes(), 1);
    assert.equal((await h.service().status(statusArgs(a))).outcome, 'verified');
    await h.s.move({ ...a, preview: false }); assert.equal(h.writes(), 1);
    const writes = h.calls.filter(c => c.url.pathname.startsWith('/drive/') && c.init.method && c.init.method !== 'GET');
    assert.equal(writes.length, 1); assert.equal(writes[0].init.method, 'PATCH'); assert.deepEqual(JSON.parse(writes[0].init.body), {});
    assert.equal(h.content(), 'private-original-content'); safe(h);
  } finally { await h.close(); }
});
test('non-owned ancestor independently mandates review even with equivalent visible item audiences; decline and invalid approval never write', async () => {
  for (const decision of [{ outcome: 'submitted', value: { approved: false } }, { outcome: 'cancelled' }, { outcome: 'submitted', value: { approved: true, bypass: true } }]) {
    const h = await setup(); alternatingPath(h, { visibleWriter: false });
    try {
      const p = await h.s.move(moveArgs()); assert.equal(p.requiresApproval, true);
      assert.match(p.preview.accessChanges, /No access change was found/);
      const r = await h.s.move({ ...moveArgs(), preview: false }, undefined, async () => decision);
      assert.ok(['declined', 'cancelled'].includes(r.outcome)); assert.equal(h.writes(), 0);
    } finally { await h.close(); }
  }
});
test('shared source ancestry and source-only inherited loss are summarized without removing direct grants', async () => {
  const h = await setup(), a = moveArgs();
  const { otherWriter } = alternatingPath(h, { sourcePath: true });
  h.files.get('dest-id').parents = ['root-id']; h.permissionRows.set('dest-id', [owner]);
  h.permissionRows.set('doc-id', [owner, otherWriter]); a.expectedParentId = 'owned-middle';
  try {
    const p = await h.s.move(a); assert.equal(p.requiresApproval, true);
    assert.match(p.preview.sourceOwners, /partner@example.invalid/);
    assert.match(p.preview.accessChanges, /partner@example.invalid — may lose some or all editing access from folders/);
    assert.equal(h.writes(), 0);
  } finally { await h.close(); }
});
test('ancestor authority remains complete and consistent; move endpoint ownership is not widened', async () => {
  const mutations = [
    h => { h.files.get('foreign-ancestor').owners = []; },
    h => { delete h.files.get('foreign-ancestor').owners[0].me; },
    h => { h.files.get('foreign-ancestor').owners[0].me = true; },
    h => { h.files.get('foreign-ancestor').owners[0].emailAddress = account; },
    h => { h.permissionRows.set('foreign-ancestor', [owner]); },
    h => { h.permissionRows.set('foreign-ancestor', []); },
    h => { h.permissionRows.get('foreign-ancestor').push(owner); },
    h => { h.permissionRows.get('foreign-ancestor')[0].type = 'group'; },
    h => { h.files.get('foreign-ancestor').driveId = 'shared-drive'; },
    h => { h.files.get('foreign-ancestor').inheritedPermissionsDisabled = true; },
    h => { h.files.get('foreign-ancestor').parents = []; },
    h => { h.files.get('foreign-ancestor').parents = ['owned-middle']; },
    h => { h.options.pagedPermissions = true; },
    h => { h.options.permissionError = true; },
    h => { h.files.get('dest-id').capabilities.canAddChildren = false; },
    h => { delete h.files.get('doc-id').capabilities.canMoveItemWithinDrive; },
    h => { h.files.get('dest-id').owners = [{ me: false, emailAddress: 'partner@example.invalid' }]; },
    h => { h.files.get('doc-id').owners = [{ me: false, emailAddress: 'partner@example.invalid' }]; },
  ];
  for (const mutate of mutations) {
    const h = await setup(); alternatingPath(h); mutate(h);
    try { await assert.rejects(h.s.move({ ...moveArgs(), preview: false })); assert.equal(h.writes(), 0); safe(h); }
    finally { await h.close(); }
  }
});
test('all shared-ancestor authority is rechecked after preview and after owner approval; changed state never writes', async () => {
  for (const when of ['preview', 'approval']) for (const change of ['owner', 'permission', 'parent', 'capability', 'partial', 'account']) {
    const h = await setup(), a = moveArgs(); alternatingPath(h);
    const mutate = () => {
      if (change === 'owner') {
        h.files.get('foreign-ancestor').owners[0].emailAddress = 'new-owner@example.invalid';
        h.permissionRows.get('foreign-ancestor')[0].emailAddress = 'new-owner@example.invalid';
      }
      if (change === 'permission') h.permissionRows.get('foreign-ancestor')[1].role = 'reader';
      if (change === 'parent') h.files.get('owned-middle').parents = ['root-id'];
      if (change === 'capability') h.files.get('dest-id').capabilities.canAddChildren = false;
      if (change === 'partial') h.options.pagedPermissions = true;
      if (change === 'account') h.options.wrongIdentity = true;
    };
    try {
      await h.s.move(a); if (when === 'preview') mutate();
      const r = await h.s.move({ ...a, preview: false }, undefined, async () => { if (when === 'approval') mutate(); return { outcome: 'submitted', value: { approved: true } }; });
      assert.ok(['stale', 'not_submitted'].includes(r.outcome), `${when} ${change}: ${r.outcome}`); assert.equal(h.writes(), 0); safe(h);
    } finally { await h.close(); }
  }
});
test('same-owner inherited writer rows remain inspectable without confusing the unique other-owner permission row', async () => {
  const h = await setup(); alternatingPath(h);
  h.permissionRows.get('owned-middle').push({ ...owner, id: 'selected-inherited-writer', role: 'writer', permissionDetails: [{ inherited: true, inheritedFrom: 'foreign-ancestor', role: 'writer' }] });
  try { assert.equal((await h.s.move(moveArgs())).requiresApproval, true); assert.equal(h.writes(), 0); }
  finally { await h.close(); }
});
test('shared-ancestor lost-response recovery survives restart and never unlocks/replays the parent PATCH', async () => {
  const h = await setup({ lost: true }), a = moveArgs(); alternatingPath(h);
  try {
    assert.equal((await h.s.move({ ...a, preview: false }, undefined, async () => ({ outcome: 'submitted', value: { approved: true } }))).outcome, 'uncertain');
    const observed = await h.service().status(statusArgs(a)); assert.equal(observed.outcome, 'observed_matching'); assert.equal(observed.unresolved, true);
    await h.s.move({ ...a, preview: false }); assert.equal(h.writes(), 1);
    await assert.rejects(h.s.move({ ...moveArgs(), expectedParentId: 'dest-id', folderId: 'root', preview: false }), e => e.filingCode === 'busy');
    h.files.get('foreign-ancestor').name = 'Changed since review';
    assert.equal((await h.service().status(statusArgs(a))).outcome, 'uncertain'); assert.equal(h.writes(), 1); safe(h);
  } finally { await h.close(); }
});
test('overlapping direct/ancestor principals preserve explicit direct role and detect its loss after moving', async () => {
  for (const mode of ['kept', 'removed', 'inherited-only', 'mixed-kept', 'mixed-lost']) {
    const h = await setup(), a = moveArgs();
    const { otherWriter } = alternatingPath(h, { sourcePath: true });
    a.expectedParentId = 'owned-middle';
    const mixed = mode.startsWith('mixed');
    const directRow = { ...otherWriter, permissionDetails: [{ inherited: false, role: mixed ? 'reader' : 'writer' }, ...(mixed ? otherWriter.permissionDetails : [])] };
    h.permissionRows.set('doc-id', [owner, directRow]);
    // Destination still provides the overlapping inherited writer. A retained
    // inherited row alone must not certify preservation of the direct grant.
    h.options.docPermissionsAfterWrite = [owner, ...(['kept', 'mixed-kept'].includes(mode) ? [directRow] : mode === 'removed' ? [] : [otherWriter])];
    try {
      const p = await h.s.move(a); assert.doesNotMatch(p.preview.accessChanges, /may lose/);
      const op = await h.store.filing.get(a.operationId);
      assert.equal(op.directBefore.find(p => p.id === otherWriter.id).role, mixed ? 'reader' : 'writer');
      const r = await h.s.move({ ...a, preview: false }, undefined, async () => ({ outcome: 'submitted', value: { approved: true } }));
      assert.equal(r.outcome, ['kept', 'mixed-kept'].includes(mode) ? 'verified' : 'uncertain', mode); assert.equal(h.writes(), 1); safe(h);
    } finally { await h.close(); }
  }
});
// Parent ownership is independent of the selected creator's writable authority.
function folderPath(h, mode = 'foreign-parent') {
  const a = { ...folderArgs(), parentId: 'dest-id', name: 'Synthetic - exact folder' };
  if (mode === 'owned') return a;
  if (mode === 'owned-shared') { h.permissionRows.set('dest-id', [owner, group]); return a; }
  const { foreignOwner, selectedWriter } = alternatingPath(h);
  if (mode === 'foreign-parent') {
    h.files.get('dest-id').owners = [{ me: false, emailAddress: foreignOwner.emailAddress }];
    h.permissionRows.set('dest-id', [foreignOwner, selectedWriter]);
  }
  return a;
}
const yes = async () => ({ outcome: 'submitted', value: { approved: true } });
test('owned/shared/foreign parent and ancestors create exactly once; creator owns new folder, parent ownership unchanged', async () => {
  for (const mode of ['owned', 'owned-shared', 'foreign-ancestor', 'foreign-parent']) {
    const h = await setup(), a = folderPath(h, mode), before = structuredClone(h.files.get('dest-id'));
    try {
      const p = await h.s.createFolder(a); assert.equal(p.requiresApproval, mode !== 'owned'); assert.equal(h.writes(), 0);
      assert.equal(p.preview.title, 'Synthetic - exact folder'); assert.ok(p.preview.to.endsWith(' / Synthetic - exact folder'));
      if (mode === 'foreign-parent') {
        h.options.newFolderPermissions = [owner, { ...group, id: 'foreign-owner', type: 'user', emailAddress: 'partner@example.invalid' }];
        assert.match(p.preview.destinationOwners, /Synthetic destination — owner: partner@example.invalid/);
        assert.match(p.preview.accessChanges, /partner@example.invalid — may get access.*parent access: Owner/);
        assert.match(p.preview.sharedAncestorSummary, /Synthetic destination.*belongs to partner@example.invalid/);
      }
      let reviewed = 0;
      const r = await h.s.createFolder({ ...a, preview: false }, undefined, async card => {
        reviewed++; assert.deepEqual(card, { ...p.preview, operationId: a.operationId }); assert.equal(h.writes(), 0); return yes();
      });
      assert.equal(reviewed, mode === 'owned' ? 0 : 1); assert.equal(r.outcome, 'verified'); assert.equal(h.writes(), 1);
      assert.deepEqual(h.files.get('dest-id'), before); assert.deepEqual(h.files.get('new-folder').owners, [{ me: true, emailAddress: account }]);
      await h.s.createFolder({ ...a, preview: false }); assert.equal((await h.service().status(statusArgs(a))).outcome, 'verified'); assert.equal(h.writes(), 1);
      const writes = h.calls.filter(c => c.url.pathname.startsWith('/drive/') && c.init.method && c.init.method !== 'GET'); assert.equal(writes.length, 1); assert.equal(writes[0].init.method, 'POST');
      assert.deepEqual(JSON.parse(writes[0].init.body), { name: a.name, mimeType: FOLDER, parents: ['dest-id'], appProperties: { paFilingCreation: a.operationId } });
      assert.ok(h.calls.some(c => c.url.searchParams.get('q')?.includes("name = 'Synthetic - exact folder'"))); safe(h);
    } finally { await h.close(); }
  }
});
test('folder authority refuses missing/false capability, reader/unknown permissions, incomplete or inconsistent ancestry before review', async () => {
  const mutations = [
    h => { h.files.get('dest-id').capabilities.canAddChildren = false; },
    h => { delete h.files.get('dest-id').capabilities.canAddChildren; },
    h => { h.files.get('dest-id').capabilities.canAddChildren = 'true'; },
    h => { h.permissionRows.get('dest-id')[1].role = 'reader'; },
    h => { h.permissionRows.get('dest-id')[1].role = 'commenter'; },
    h => { h.permissionRows.get('dest-id').pop(); },
    h => { h.files.get('dest-id').owners[0].me = true; },
    h => { h.files.get('dest-id').owners = []; },
    h => { h.permissionRows.get('dest-id')[0].emailAddress = 'different@example.invalid'; },
    h => { h.permissionRows.get('dest-id').push(owner); },
    h => { h.files.get('foreign-ancestor').owners[0].me = true; },
    h => { h.permissionRows.set('foreign-ancestor', [owner]); },
    h => { h.files.get('root-id').owners = [{ me: false, emailAddress: 'partner@example.invalid' }]; },
    h => { h.options.pagedPermissions = true; }, h => { h.options.permissionError = true; },
    h => { h.files.get('dest-id').driveId = 'shared-drive'; },
    h => { h.files.get('foreign-ancestor').inheritedPermissionsDisabled = true; },
    h => { h.files.get('dest-id').mimeType = 'application/vnd.google-apps.shortcut'; },
    h => { h.files.get('foreign-ancestor').parents = ['owned-middle']; },
    h => { h.options.scope = 'drive.readonly'; }, h => { h.options.wrongIdentity = true; },
  ];
  for (const mutate of mutations) {
    const h = await setup(), a = folderPath(h); mutate(h);
    try { await assert.rejects(h.s.createFolder({ ...a, preview: false }, undefined, () => { throw Error('Must not review'); })); assert.equal(h.writes(), 0); safe(h); }
    finally { await h.close(); }
  }
});
test('folder post-preview/post-card owner, access, path, capability, identity and exact-name duplicate changes refuse before POST', async () => {
  for (const when of ['preview', 'card']) for (const change of ['owner', 'access', 'path', 'capability', 'missing-capability', 'reader', 'incomplete', 'duplicate', 'duplicate-page', 'identity']) {
    const h = await setup(), a = folderPath(h);
    const mutate = () => {
      if (change === 'owner') { h.files.get('dest-id').owners[0].emailAddress = 'new@example.invalid'; h.permissionRows.get('dest-id')[0].emailAddress = 'new@example.invalid'; }
      if (change === 'access') h.permissionRows.get('dest-id').push(group);
      if (change === 'path') h.files.get('dest-id').parents = ['root-id'];
      if (change === 'capability') h.files.get('dest-id').capabilities.canAddChildren = false;
      if (change === 'missing-capability') delete h.files.get('dest-id').capabilities.canAddChildren;
      if (change === 'reader') h.permissionRows.get('dest-id')[1].role = 'reader';
      if (change === 'incomplete') h.options.pagedPermissions = true;
      if (change === 'duplicate') h.options.duplicate = true;
      if (change === 'duplicate-page') h.options.pagedDuplicates = true;
      if (change === 'identity') h.options.wrongIdentity = true;
    };
    try {
      await h.s.createFolder(a); if (when === 'preview') mutate();
      const r = await h.s.createFolder({ ...a, preview: false }, undefined, async () => { if (when === 'card') mutate(); return yes(); });
      assert.ok(['stale', 'not_submitted'].includes(r.outcome), `${when}/${change}: ${r.outcome}`); assert.equal(h.writes(), 0); safe(h);
    } finally { await h.close(); }
  }
});
test('foreign folder approvals decline/cancel/expire/abort/restart safely; no alternate-key cleanup or replay', async () => {
  for (const decision of [{ outcome: 'submitted', value: { approved: false } }, { outcome: 'cancelled' }, { outcome: 'submitted', value: { approved: true, extra: true } }]) {
    const h = await setup(), a = folderPath(h);
    try { const r = await h.s.createFolder({ ...a, preview: false }, undefined, async () => decision); assert.ok(['declined', 'cancelled'].includes(r.outcome)); await h.s.createFolder({ ...a, preview: false }, undefined, yes); assert.equal(h.writes(), 0); }
    finally { await h.close(); }
  }
  for (const mode of ['expired', 'aborted', 'restart']) {
    const h = await setup(), a = folderPath(h), controller = new AbortController();
    try {
      const r = await h.s.createFolder({ ...a, preview: false }, controller.signal, async () => {
        if (mode === 'expired') h.tick(600_000);
        if (mode === 'aborted') controller.abort();
        if (mode === 'restart') assert.equal((await h.service().status(statusArgs(a))).outcome, 'cancelled');
        return yes();
      });
      assert.ok(['expired', 'not_submitted'].includes(r.outcome), `${mode}: ${r.outcome}`); assert.equal(h.writes(), 0); safe(h);
    } finally { await h.close(); }
  }
});
test('foreign folder lost-response recovery requires exact owned creation readback; unknown writes never recreate/delete', async () => {
  for (const mode of ['matching', 'empty', 'ambiguous', 'incomplete', 'foreign-owner', 'inconsistent-owner', 'wrong-name', 'wrong-parent', 'wrong-type']) {
    const h = await setup({ lost: true, emptyRecovery: mode === 'empty', ambiguousRecovery: mode === 'ambiguous', incompleteRecovery: mode === 'incomplete' }), a = folderPath(h);
    try {
      assert.equal((await h.s.createFolder({ ...a, preview: false }, undefined, yes)).outcome, 'uncertain');
      const f = h.files.get('new-folder');
      if (mode === 'foreign-owner') { f.owners = [{ me: false, emailAddress: 'partner@example.invalid' }]; h.permissionRows.set(f.id, [{ ...owner, emailAddress: 'partner@example.invalid' }]); }
      if (mode === 'inconsistent-owner') h.permissionRows.set(f.id, [{ ...owner, emailAddress: 'different@example.invalid' }]);
      if (mode === 'wrong-name') f.name = 'Different name';
      if (mode === 'wrong-parent') f.parents = ['root-id'];
      if (mode === 'wrong-type') f.mimeType = DOC;
      const r = await h.service().status(statusArgs(a)); assert.equal(r.outcome, mode === 'matching' ? 'verified' : ['foreign-owner', 'inconsistent-owner'].includes(mode) ? 'verification_unavailable' : 'uncertain', mode);
      await h.s.createFolder({ ...a, preview: false }, undefined, yes); assert.equal(h.writes(), 1);
      if (mode !== 'matching') {
        // Even an empty name lookup cannot bypass the original unresolved resource.
        h.files.delete('new-folder'); await assert.rejects(h.s.createFolder({ ...a, operationId: randomUUID(), preview: false }, undefined, yes), e => e.filingCode === 'busy');
      }
      assert.equal(h.writes(), 1); assert.ok(h.calls.every(c => !['DELETE', 'PATCH'].includes(c.init.method))); safe(h);
    } finally { await h.close(); }
  }
});
test('acknowledged folder POST with foreign/mismatched creator owner or unexpected access stays uncertain, locked and never replays/cleans up', async () => {
  for (const mode of ['foreign-owner', 'inconsistent-owner', 'unexpected-access']) {
    const h = await setup(), a = folderPath(h);
    if (mode === 'foreign-owner') {
      h.options.newFolderMetadata = { owners: [{ me: false, emailAddress: 'partner@example.invalid' }] };
      h.options.newFolderPermissions = [{ ...owner, emailAddress: 'partner@example.invalid' }];
    }
    if (mode === 'inconsistent-owner') h.options.newFolderPermissions = [{ ...owner, emailAddress: 'different@example.invalid' }];
    if (mode === 'unexpected-access') h.options.newFolderPermissions = [owner, { ...group, emailAddress: 'unexpected@example.invalid' }];
    try {
      const r = await h.s.createFolder({ ...a, preview: false }, undefined, yes);
      assert.equal(r.outcome, 'uncertain', mode); assert.equal(r.fileId, 'new-folder'); assert.equal(h.writes(), 1);
      assert.equal((await h.store.filing.get(a.operationId)).state, 'uncertain');
      await h.service().status(statusArgs(a)); await h.s.createFolder({ ...a, preview: false }, undefined, yes);
      assert.equal(h.writes(), 1); assert.ok(h.files.has('new-folder')); // never delete a partial result
      // Provider absence later is not authority to bypass the retained resource lock.
      h.files.delete('new-folder'); await assert.rejects(h.s.createFolder({ ...a, operationId: randomUUID(), preview: false }, undefined, yes), e => e.filingCode === 'busy');
      assert.equal(h.writes(), 1); assert.ok(h.calls.every(c => !['DELETE', 'PATCH'].includes(c.init.method))); safe(h);
    } finally { await h.close(); }
  }
});
test('folder preview then one create, exact readback, repeat/status never write again', async () => {
  const h = await setup(), a = folderArgs();
  try {
    const p = await h.s.createFolder(a); assert.equal(p.outcome, 'proposed'); assert.equal(p.requiresApproval, false); assert.equal(h.writes(), 0);
    assert.match(p.preview.impact, /new folder.*no existing source file/);
    assert.doesNotMatch(p.preview.impact, /Moving|old folder/);
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
const moveTypes = [
  [DOC, 'https://docs.google.com/document/d/doc-id/edit'],
  ['application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/doc-id/edit'],
  ['application/vnd.google-apps.presentation', 'https://docs.google.com/presentation/d/doc-id/edit'],
  ...['application/pdf', 'image/png', 'text/plain', 'video/mp4', 'application/zip', 'application/x-next-file-type', 'application/vnd.google-apps.form']
    .map(type => [type, 'https://drive.google.com/file/d/doc-id/view']),
];
for (const [mimeType, url] of moveTypes) test(`capability-driven move preserves identity and metadata without body reads or content/ACL edits: ${mimeType}`, async () => {
  const h = await setup({ mimeType }), a = moveArgs();
  const before = structuredClone(h.files.get('doc-id'));
  try {
    const p = await h.s.move(a); assert.equal(p.mimeType, mimeType); assert.equal(p.preview.mimeType, mimeType); assert.equal(p.url, url); assert.equal(h.writes(), 0);
    const r = await h.s.move({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); assert.equal(r.fileId, a.fileId); assert.equal(r.url, url); assert.equal(r.mimeType, mimeType);
    assert.deepEqual(h.files.get('doc-id'), { ...before, parents: ['dest-id'] }); assert.equal(h.content(), 'private-original-content');
    await h.s.move({ ...a, preview: false }); assert.equal((await h.service().status(statusArgs(a))).outcome, 'verified'); assert.equal(h.writes(), 1);
    assert.ok(h.calls.every(c => !c.url.searchParams.has('alt') && !/\/export|\/copy|\/download/.test(c.url.pathname)));
    assert.deepEqual(h.calls.filter(c => c.init.method === 'PATCH').map(c => JSON.parse(c.init.body)), [{}]); safe(h);
  } finally { await h.close(); }
});
test('unsupported source metadata and missing/false capability reject before any write, regardless of MIME', async () => {
  const mutations = [
    f => { f.mimeType = FOLDER; }, f => { f.mimeType = 'application/vnd.google-apps.shortcut'; },
    ...[undefined, '', 'not-a-type', 'application/pdf\n', 'x/'.padEnd(256, 'a')].map(mime => f => { f.mimeType = mime; }),
    f => { delete f.capabilities.canMoveItemWithinDrive; }, f => { f.capabilities.canMoveItemWithinDrive = false; },
    f => { f.capabilities.canMoveItemWithinDrive = 'true'; }, f => { f.driveId = 'shared'; }, f => { f.owners[0].me = false; },
    f => { f.trashed = true; }, f => { f.parents = []; }, f => { f.parents = ['root-id', 'dest-id']; }, f => { f.parents = ['unknown']; },
    f => { f.inheritedPermissionsDisabled = true; },
  ];
  for (const mutate of mutations) {
    const h = await setup({ mimeType: 'application/pdf' });
    try {
      mutate(h.files.get('doc-id'));
      await assert.rejects(h.s.move({ ...moveArgs(), preview: false }), error => {
        if (h.files.get('doc-id').mimeType === FOLDER) assert.match(error.message, /folder creation.*Folder-tree moves.*not supported/);
        return true;
      });
      assert.equal(h.writes(), 0); safe(h);
    }
    finally { await h.close(); }
  }
});
test('shared native and binary moves revalidate exact audiences, parents, MIME and capability after review', async () => {
  for (const mimeType of ['application/vnd.google-apps.spreadsheet', 'application/pdf', 'application/x-next-file-type']) {
    for (const change of ['none', 'parent', 'permissions', 'mime', 'capability', 'destination']) {
      const h = await setup({ mimeType, shared: true, directSource: true }), a = moveArgs();
      try {
        const p = await h.s.move(a); assert.equal(p.requiresApproval, true); let reviewed = false;
        const r = await h.s.move({ ...a, preview: false }, undefined, async card => {
          reviewed = true; assert.equal(h.writes(), 0); assert.equal(card.mimeType, mimeType); assert.equal(card.fileId, a.fileId); assert.equal(card.destinationId, a.folderId);
          assert.match(card.destinationAudience, /team@example.invalid/);
          if (change === 'parent') h.files.get('doc-id').parents = ['dest-id'];
          if (change === 'permissions') h.options.directSource = false;
          if (change === 'mime') h.files.get('doc-id').mimeType = 'image/jpeg';
          if (change === 'capability') h.files.get('doc-id').capabilities.canMoveItemWithinDrive = false;
          if (change === 'destination') h.files.get('dest-id').parents = ['doc-id'];
          return { outcome: 'submitted', value: { approved: true } };
        });
        assert.equal(reviewed, true); assert.equal(r.outcome, change === 'none' ? 'verified' : ['permissions', 'mime'].includes(change) ? 'stale' : 'not_submitted');
        assert.equal(h.writes(), change === 'none' ? 1 : 0); safe(h);
      } finally { await h.close(); }
    }
  }
});
test('non-Doc lost responses retain read-only unresolved locks; type/direct-grant readback changes never verify', async () => {
  for (const mimeType of ['application/vnd.google-apps.spreadsheet', 'application/pdf']) {
    for (const options of [{ lost: true }, { typeAfterWrite: 'image/jpeg' }, { directSource: true, dropDirectAfterWrite: true }]) {
      const h = await setup({ mimeType, ...options }), a = moveArgs();
      try {
        const r = await h.s.move({ ...a, preview: false }, undefined, async () => ({ outcome: 'submitted', value: { approved: true } }));
        assert.equal(r.outcome, 'uncertain');
        const status = await h.service().status(statusArgs(a)); assert.equal(status.outcome, options.lost ? 'observed_matching' : 'uncertain'); assert.equal(status.unresolved, true);
        await h.s.move({ ...a, preview: false }); assert.equal(h.writes(), 1);
        await assert.rejects(h.s.move({ ...moveArgs(), expectedParentId: 'dest-id', folderId: 'root', preview: false }), e => e.filingCode === 'busy'); safe(h);
      } finally { await h.close(); }
    }
  }
});
test('legacy Docs-only verified/proposed receipts and folder receipts remain readable without migration or replay', async () => {
  for (const kind of ['move', 'folder']) {
    const h = await setup(), a = kind === 'move' ? moveArgs() : folderArgs();
    try {
      const change = kind === 'move' ? h.s.move : h.s.createFolder;
      await change(a);
      let op = await h.store.filing.get(a.operationId); delete op.mimeType; delete op.preview.mimeType; delete op.directEvidenceVersion; await h.store.filing.save(op);
      assert.equal((await change({ ...a, preview: false })).outcome, 'verified'); assert.equal(h.writes(), 1);
      op = await h.store.filing.get(a.operationId); delete op.mimeType; delete op.directEvidenceVersion; await h.store.filing.save(op);
      const r = await h.service().status(statusArgs(a)); assert.equal(r.outcome, 'verified');
      assert.equal(r.url, kind === 'move' ? 'https://docs.google.com/document/d/doc-id/edit' : 'https://drive.google.com/drive/folders/new-folder');
      await change({ ...a, preview: false }); assert.equal(h.writes(), 1);
    } finally { await h.close(); }
  }
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
test('sharing claimed after the initial check prevents the filing claim and every provider write', async () => {
  const h = await setup(), claim = h.store.filing.claim;
  h.store.filing.claim = async op => {
    const share = { operationId: randomUUID(), subject: 'subject', fileId: 'dest-id', state: 'proposed' };
    await h.store.reserveSharing(share);
    assert.equal(await h.store.claimSharing(share.operationId, share.fileId), true);
    return claim(op);
  };
  try {
    await assert.rejects(h.s.move({ ...moveArgs(), preview: false }), e => e.filingCode === 'busy');
    assert.equal(h.writes(), 0); safe(h);
  } finally { await h.close(); }
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
