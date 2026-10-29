import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createDocsCreationService } from '../core/docs-create.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { account, document, tab } from './docs-fixtures.mjs';
const args = () => ({ account, operationId: randomUUID(), folderId: 'root', title: 'Synthetic interview', text: 'Introduction 😀\n\nQuestion one?\nKallee:\n\nSharon:\n\nLily:\n\nQuestion two?' });
const parse = result => { assert.notEqual(result.isError, true, result.content[0].text); return JSON.parse(result.content[0].text); };
function doc(text = '\n') {
  const parts = text.match(/[^\n]*\n/g) || [];
  let index = 1;
  const result = document(); result.title = 'Synthetic interview'; result.tabs = [tab('\n')];
  result.tabs[0].documentTab.body.content = [{ endIndex: 1, sectionBreak: {} }, ...parts.map(content => {
    const startIndex = index; index += content.length;
    return { startIndex, endIndex: index, paragraph: { elements: [{ startIndex, endIndex: index, textRun: { content } }] } };
  })];
  return result;
}
async function setup(options = {}) {
  const h = createFakePluginHost({ pluginId: 'google-drive', settings: { requireDocsApproval: true } });
  const calls = []; let created = false, populated = false, requested;
  const original = globalThis.fetch;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ url: String(url), init });
    if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: options.wrongIdentity ? 'other' : 'subject-a', email: account, email_verified: true });
    if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${created && options.revokeAfterCreate ? 'drive.readonly' : options.scope || 'drive'}` });
    if (init.method === 'POST' && u.pathname === '/drive/v3/files') {
      requested = JSON.parse(init.body);
      assert.deepEqual(Object.keys(requested).sort(), ['appProperties', 'mimeType', 'name', 'parents']);
      if (options.createReject) return Response.json({ private: 'private-provider-body' }, { status: options.createReject });
      created = true;
      options.onCreated?.();
      if (options.createFailure) throw Object.assign(new Error('private-token-and-content'), { cause: 'private-cause', code: 'private-code' });
      if (options.createBadJson) return new Response('private-malformed-response');
      return Response.json({ id: 'doc-a' });
    }
    if (init.method === 'POST' && u.pathname.endsWith(':batchUpdate')) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { writeControl: { requiredRevisionId: 'rev-a' }, requests: [{ insertText: { location: { index: 1, tabId: 'tab-a' }, text: options.inputText || args().text } }] });
      if (options.populateReject) return Response.json({ private: 'private-body' }, { status: options.populateReject });
      populated = true;
      if (options.populateFailure) throw new Error('private-populate-content');
      return Response.json({ documentId: 'doc-a', replies: [{}] });
    }
    if (u.pathname === '/drive/v3/files') return Response.json({ files: created && !options.noSearchResult ? [{ id: 'doc-a' }, ...(options.duplicateMatch ? [{ id: 'doc-b' }] : [])] : [], ...(options.pagedSearch ? { nextPageToken: 'private-page-token' } : {}) });
    if (u.pathname.endsWith('/permissions')) return Response.json({ permissions: [{ type: 'user', role: 'owner', emailAddress: account }], ...(options.pagedPermissions ? { nextPageToken: 'private-token' } : {}) });
    if (u.pathname.includes('/drive/v3/files/')) {
      const fileId = u.pathname.split('/').at(-1);
      if (fileId !== 'doc-a') {
        if (u.searchParams.get('fields')?.includes('owners')) return Response.json({ id: fileId, shared: options.shared === true, driveId: options.sharedDrive ? 'drive-a' : undefined, owners: [{ me: !options.notOwned }] });
        return Response.json({ id: fileId === 'root' ? 'root-a' : fileId, trashed: false, mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: !options.notWritable } });
      }
      if (options.verifyFailure) return Response.json({ private: 'private-body' }, { status: 503 });
      return Response.json({ id: 'doc-a', name: 'Synthetic interview', mimeType: 'application/vnd.google-apps.document', trashed: false, parents: [options.wrongParent ? 'other' : requested?.parents[0] || 'root-a'] });
    }
    if (u.pathname === '/v1/documents/doc-a') {
      if (options.blankFailure && !populated) throw new Error('private-doc-body');
      const result = doc(populated ? (options.changedText ? 'Other text\n' : (options.inputText || args().text) + '\n') : '\n');
      if (populated && options.extraTab) result.tabs.push(tab('Other text\n', 'tab-b'));
      if (populated && options.changedTitle) result.title = 'Unexpected title';
      return Response.json(result);
    }
    throw new Error('private-unexpected-url');
  };
  globalThis.fetch = fetchImpl;
  await plugin(h.bb);
  const store = createBbStore(h.bb.storage.database(), () => {});
  await store.addAccount({ subject: 'subject-a', email: account, accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 600_000 });
  const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl });
  return { ...h, store, calls, service: createDocsCreationService({ store, drive: adapter.drive, docs: adapter.docs, creation: adapter.creation }),
    writes: () => calls.filter(c => c.init.method === 'POST' && !c.url.includes('/tokeninfo')),
    close: async () => { globalThis.fetch = original; await h.harness.lifecycle.dispose(); } };
}
const safeLogs = h => {
  const logs = JSON.stringify(h.harness.inspection.logEntries);
  assert.doesNotMatch(logs, /private-|writer@example|Synthetic interview|Question one|Kallee|Sharon|Lily|subject-a|doc-a/);
  return logs;
};
test('native create/populate verifies every paragraph, explicit destination and title, with no sharing or approval changes', async () => {
  const h = await setup(); const input = args();
  try {
    const result = parse(await h.harness.behavior.callAgentTool('gdocs_create_document', input));
    assert.equal(result.outcome, 'verified'); assert.equal(result.documentId, 'doc-a');
    assert.equal(result.url, 'https://docs.google.com/document/d/doc-a/edit');
    assert.equal(result.writeAttempted, true); assert.equal(result.retrySafe, false);
    assert.equal(h.writes().length, 2); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
    assert.equal(h.writes()[0].init.body.includes(input.operationId), true);
    assert.equal(parse(await h.harness.behavior.callAgentTool('gdocs_creation_status', { account, operationId: input.operationId })).outcome, 'verified');
    assert.equal(h.writes().length, 2);
    const receipt = await h.store.getCreation(input.operationId);
    assert.doesNotMatch(JSON.stringify(receipt), /Introduction|Question|Kallee|Sharon|Lily|Synthetic interview|private-/);
    safeLogs(h);
  } finally { await h.close(); }
});
test('old read-only and Docs-only grants, wrong identity and unknown account cannot write or reserve', async () => {
  for (const options of [{ scope: 'drive.readonly' }, { scope: 'documents' }, { wrongIdentity: true }, { unknownAccount: true }]) {
    const h = await setup(options); const input = args();
    if (options.unknownAccount) input.account = 'unknown@example.test';
    try {
      const result = await h.harness.behavior.callAgentTool('gdocs_create_document', input);
      assert.equal(result.isError, true); assert.equal(h.writes().length, 0); assert.equal(await h.store.getCreation(input.operationId), null);
      assert.equal(h.harness.inspection.pendingInteractions.length, 0);
      assert.doesNotMatch(JSON.stringify(result), /private-/); safeLogs(h);
    } finally { await h.close(); }
  }
});
test('drive.file write consent works without scope expansion; supported folder checked, shared/unverified folders rejected', async () => {
  for (const options of [{ scope: 'drive.file' }, { shared: true }, { sharedDrive: true }, { notOwned: true }, { pagedPermissions: true }, { notWritable: true }]) {
    const h = await setup(options); const input = { ...args(), folderId: 'folder-a' };
    try {
      const result = await h.harness.behavior.callAgentTool('gdocs_create_document', input);
      if (options.scope) { assert.equal(parse(result).outcome, 'verified'); assert.equal(h.writes().length, 2); }
      else { assert.equal(result.isError, true); assert.equal(h.writes().length, 0); assert.match(result.content[0].text, /owned, unshared/); }
      safeLogs(h);
    } finally { await h.close(); }
  }
});
test('literal Unicode, trailing blank paragraphs and maximum bounded text are preserved', async () => {
  for (const text of ['First 😀\n\nLast\n\n', 'x'.repeat(40_000)]) {
    const h = await setup({ inputText: text });
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gdocs_create_document', { ...args(), text }));
      assert.equal(result.outcome, 'verified'); assert.equal(h.writes().length, 2); safeLogs(h);
    } finally { await h.close(); }
  }
});
test('changed grants or cancellation after creation never populates or recreates the blank document', async () => {
  for (const revoke of [false, true]) {
    const controller = new AbortController();
    const h = await setup(revoke ? { revokeAfterCreate: true } : { onCreated: () => controller.abort() });
    const input = args();
    try {
      const result = await h.service.create(input, controller.signal);
      assert.equal(result.outcome, 'incomplete'); assert.equal(result.documentId, 'doc-a');
      assert.equal(h.writes().length, 1);
      await h.service.create(input); assert.equal(h.writes().length, 1);
    } finally { await h.close(); }
  }
});
test('validate content, destinations, keys and bounds before any Google request', async () => {
  const h = await setup();
  try {
    for (const patch of [{ title: ' ' }, { title: 'x'.repeat(256) }, { title: 'bad\nname' }, { text: '' }, { text: 'x'.repeat(40001) }, { text: 'bad\r\ntext' }, { text: '\uE000' }, { text: '\ud800' }, { text: '\u0000' }, { operationId: randomUUID().toUpperCase() }, { operationId: 'not-a-key' }, { folderId: 'https://drive.google.com/' }]) {
      await assert.rejects(() => h.service.create({ ...args(), ...patch }));
    }
    assert.equal(h.calls.length, 0);
    await assert.rejects(() => h.harness.behavior.callAgentTool('gdocs_create_document', { ...args(), permissions: ['anyone'], requireDocsApproval: false }));
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
test('same key never replays including concurrent calls, reload, account/request conflict and durable reservation interruption', async () => {
  const h = await setup(); const input = args(); let replacement;
  try {
    const results = await Promise.all([h.service.create(input), h.service.create(input)]);
    assert.ok(results.some(r => r.outcome === 'verified')); assert.equal(h.writes().length, 2);
    const repeated = await h.service.create(input);
    assert.equal(repeated.outcome, 'verified'); assert.equal(repeated.receiptOnly, true); assert.equal(h.writes().length, 2);
    await assert.rejects(() => h.service.create({ ...input, text: 'different' }), e => e.creationCode === 'operation_conflict');
    await h.store.addAccount({ subject: 'other', email: 'other@example.test', refreshToken: 'private-other' });
    await assert.rejects(() => h.service.create({ ...input, account: 'other@example.test' }), e => e.creationCode === 'operation_conflict');
    await assert.rejects(() => h.service.inspect({ account: 'other@example.test', operationId: input.operationId }), e => e.creationCode === 'operation_unknown');
    replacement = await h.harness.lifecycle.reload(plugin);
    assert.equal(parse(await replacement.harness.behavior.callAgentTool('gdocs_create_document', input)).outcome, 'verified'); assert.equal(h.writes().length, 2);
    const reloadedStore = createBbStore(replacement.bb.storage.database(), () => {});
    const op = { ...await reloadedStore.getCreation(input.operationId), operationId: randomUUID(), outcome: 'reserved', documentId: undefined, writeAttempted: false };
    await reloadedStore.reserveCreation(op);
    const before = h.calls.length;
    const interrupted = parse(await replacement.harness.behavior.callAgentTool('gdocs_create_document', { ...input, operationId: op.operationId }));
    assert.equal(interrupted.outcome, 'reserved'); assert.equal(interrupted.writeAttempted, 'unknown'); assert.equal(h.calls.length, before);
    safeLogs(h);
  } finally { await replacement?.harness.lifecycle.dispose(); await h.close(); }
});
test('create timeout or malformed response retains key; read-only recovery locates blank document and link without population', async () => {
  for (const options of [{ createFailure: true }, { createBadJson: true }]) {
    const h = await setup(options); const input = args();
    try {
      let result = parse(await h.harness.behavior.callAgentTool('gdocs_create_document', input));
      assert.equal(result.outcome, 'uncertain'); assert.equal(result.retrySafe, false); assert.equal(h.writes().length, 1);
      result = parse(await h.harness.behavior.callAgentTool('gdocs_creation_status', { account, operationId: input.operationId }));
      assert.equal(result.outcome, 'incomplete'); assert.equal(result.documentId, 'doc-a'); assert.match(result.url, /docs.google.com/);
      await h.service.create(input); assert.equal(h.writes().length, 1);
      assert.match(safeLogs(h), /docs_creation_create/);
    } finally { await h.close(); }
  }
});
test('definite creation denial is not_created; 429/5xx are uncertain, never retried', async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 503]) {
    const h = await setup({ createReject: status }); const input = args();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gdocs_create_document', input));
      assert.equal(result.outcome, status < 405 ? 'not_created' : 'uncertain');
      assert.equal(result.writeAttempted, true); // Even definitive denial was a submitted POST.
      assert.equal(h.writes().length, 1); await h.service.create(input); assert.equal(h.writes().length, 1);
      assert.match(safeLogs(h), new RegExp(`docs_creation_create.*http_status=${status}`));
    } finally { await h.close(); }
  }
});
test('population failures keep usable ID; status verifies an applied but unacknowledged population without retry', async () => {
  for (const options of [{ populateFailure: true }, { populateReject: 403 }, { blankFailure: true }]) {
    const h = await setup(options); const input = args();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gdocs_create_document', input));
      assert.equal(result.outcome, 'incomplete'); assert.equal(result.documentId, 'doc-a'); assert.equal(result.retrySafe, false);
      const writes = h.writes().length;
      const status = parse(await h.harness.behavior.callAgentTool('gdocs_creation_status', { account, operationId: input.operationId }));
      assert.equal(status.outcome, options.populateFailure ? 'verified' : options.blankFailure ? 'verification_unavailable' : 'incomplete');
      await h.service.create(input); assert.equal(h.writes().length, writes); safeLogs(h);
    } finally { await h.close(); }
  }
});
test('verification failure, changed content or wrong destination never claims completion or duplicates', async () => {
  for (const options of [{ verifyFailure: true }, { changedText: true }, { wrongParent: true }, { extraTab: true }, { changedTitle: true }]) {
    const h = await setup(options); const input = args();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gdocs_create_document', input));
      assert.equal(result.outcome, 'verification_unavailable'); assert.equal(result.documentId, 'doc-a');
      assert.equal(h.writes().length, 2); await h.service.create(input); assert.equal(h.writes().length, 2);
      assert.match(safeLogs(h), /docs_creation_verify/);
    } finally { await h.close(); }
  }
});
test('missing, ambiguous and paged recovery searches remain uncertain; absence is not permission to recreate', async () => {
  for (const patch of [{ noSearchResult: true }, { duplicateMatch: true }, { pagedSearch: true }]) {
    const h = await setup({ createFailure: true, ...patch }); const input = args();
    try {
      await h.service.create(input);
      const result = await h.service.inspect({ account, operationId: input.operationId });
      assert.equal(result.outcome, 'uncertain'); assert.equal(result.documentId, undefined); assert.equal(result.retrySafe, false);
      await h.service.create(input); assert.equal(h.writes().length, 1); safeLogs(h);
    } finally { await h.close(); }
  }
});
test('abort and receipt persistence failures fail closed before mutation or population', async () => {
  for (const boundary of ['abort', 'reserve', 'before-create', 'known-id']) {
    const h = await setup(); const input = args();
    try {
      const controller = new AbortController();
      if (boundary === 'abort') controller.abort(new Error('private-cancel'));
      if (boundary === 'reserve') h.store.reserveCreation = async () => { throw new Error('private-storage'); };
      const update = h.store.updateCreation;
      if (['before-create', 'known-id'].includes(boundary)) h.store.updateCreation = async op => {
        if (boundary === 'before-create' || op.documentId) throw new Error('private-storage');
        return update(op);
      };
      if (['abort', 'reserve'].includes(boundary)) await assert.rejects(() => h.service.create(input, controller.signal));
      else {
        const result = await h.service.create(input);
        assert.equal(result.outcome, boundary === 'known-id' ? 'incomplete' : 'not_created');
        if (boundary === 'known-id') assert.equal(result.documentId, 'doc-a');
      }
      assert.equal(h.writes().length, boundary === 'known-id' ? 1 : 0);
    } finally { await h.close(); }
  }
});
