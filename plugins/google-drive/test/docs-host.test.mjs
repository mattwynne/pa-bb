import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { document, input, account } from './docs-fixtures.mjs';
import { SCOPES } from '../core/service.mjs';
import { DOCS_WRITE_SCOPES } from '../adapters/docs.mjs';
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'google-drive', appUrl: 'https://bb.example', settings: { clientId: 'test-client', clientSecret: 'private-secret', ...options.settings } });
  if (options.settingsFailure) {
    const define = host.bb.settings.define.bind(host.bb.settings);
    host.bb.settings.define = descriptors => {
      const handle = define(descriptors);
      return { ...handle, get: async () => { throw new Error('private-settings-secret-provider-body'); } };
    };
  }
  let doc = document(), writes = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (options.remoteFailure) return Response.json({ message: 'private-provider-body' }, { status: 503 });
    if (path.endsWith('/userinfo')) return Response.json({ sub: 'subject-a', email: account, email_verified: true });
    if (path.includes('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${options.scope || 'drive.file'}` });
    if (path.includes('/drive/v3/files/doc-a')) return Response.json({ id: 'doc-a', trashed: false, mimeType: 'application/vnd.google-apps.document' });
    if (path.endsWith(':batchUpdate')) {
      writes++;
      if (options.uncertain) throw Object.assign(new Error('private-secret-body'), { cause: 'private-refresh' });
      const body = JSON.parse(init.body);
      assert.equal(body.writeControl.requiredRevisionId, 'rev-a');
      doc = document('Hello 😀 new words.\n'); doc.revisionId = 'rev-b';
      return Response.json({ documentId: 'doc-a', writeControl: { requiredRevisionId: 'rev-b' }, replies: [{ replaceAllText: { occurrencesChanged: 1 } }] });
    }
    if (path.includes('/documents/doc-a?')) return Response.json(doc);
    throw new Error('private-unexpected-request');
  };
  await plugin(host.bb);
  const store = createBbStore(host.bb.storage.database(), () => {});
  await store.addAccount({ subject: 'subject-a', email: account, accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 600_000 });
  return { ...host, writes: () => writes, reset: () => { doc = document(); writes = 0; }, close: async () => { globalThis.fetch = original; await host.harness.lifecycle.dispose(); } };
}
async function pending(harness) {
  for (let i = 0; i < 100; i++) {
    if (harness.inspection.pendingInteractions.length) return harness.inspection.pendingInteractions[0];
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Approval form did not open');
}
const text = result => JSON.parse(result.content[0].text);
test('document-free scope diagnostics distinguish missing/present grants from installed consent capability without exposing tokens', async () => {
  for (const [scope, expected] of [['drive.readonly', 'missing'], ['drive.file', 'present']]) {
    const h = await setup({ scope });
    try {
      const result = await h.harness.behavior.runCli(['editing-access', '--account', account]);
      const status = JSON.parse(result.stdout);
      assert.equal(status.writeGrant, expected);
      assert.equal(status.documentAccess, 'not_checked');
      assert.equal(status.settingsCanRequestWrite, SCOPES.some(scope => DOCS_WRITE_SCOPES.includes(scope)));
      assert.equal(h.writes(), 0); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
      assert.doesNotMatch(result.stdout + JSON.stringify(h.harness.inspection.logEntries), /private-access|private-refresh|private-secret|provider-body/);
      const unknown = await h.harness.behavior.runCli(['editing-access', '--account', 'unknown@example.test']);
      assert.equal(JSON.parse(unknown.stdout).writeGrant, 'unknown_account');
    } finally { await h.close(); }
  }
  const h = await setup({ remoteFailure: true });
  try {
    const result = await h.harness.behavior.runCli(['editing-access', '--account', account]);
    assert.equal(JSON.parse(result.stdout).writeGrant, 'unavailable');
    assert.match(JSON.stringify(h.harness.inspection.logEntries), /docs_authorization.*http_status=503/);
    assert.doesNotMatch(result.stdout + JSON.stringify(h.harness.inspection.logEntries), /private-/);
  } finally { await h.close(); }
});
test('tools inspect, preview, then pause for exact owner consent before one verified write', async () => {
  const h = await setup();
  try {
    assert.equal(text(await h.harness.behavior.callAgentTool('gdocs_inspect_for_edit', { account, document: 'doc-a' })).complete, true);
    assert.equal(text(await h.harness.behavior.callAgentTool('gdocs_replace_text', input)).outcome, 'preview');
    assert.equal(h.harness.inspection.pendingInteractions.length, 0);
    const done = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    const form = await pending(h.harness);
    assert.equal(form.rendererId, 'docs-edit-approval');
    assert.equal(form.payload.oldText, input.oldText); assert.equal(form.payload.newText, input.newText);
    assert.equal(form.payload.account, account); assert.equal(h.writes(), 0);
    h.harness.behavior.submitInteraction(form.id, { approved: true });
    assert.equal(text(await done).outcome, 'verified'); assert.equal(h.writes(), 1);
    assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries), /private-|writer@example|old words|new words/);
  } finally { await h.close(); }
});
test('global approval setting defaults on, updates live, persists through reload and never auto-approves an open card', async () => {
  const h = await setup();
  let reloaded;
  try {
    // Omitting the setting preserves approval for existing installations.
    const first = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    let form = await pending(h.harness);
    assert.equal(h.writes(), 0); h.harness.behavior.cancelInteraction(form.id); await first;
    await assert.rejects(() => h.harness.behavior.setSettings({ requireDocsApproval: 'false' }));
    await h.harness.behavior.setSettings({ requireDocsApproval: false });
    const result = text(await h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false }));
    assert.equal(result.outcome, 'verified'); assert.equal(result.approval, 'disabled_in_settings');
    assert.equal(h.writes(), 1); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
    h.reset();
    await h.harness.behavior.setSettings({ requireDocsApproval: true });
    const waiting = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    form = await pending(h.harness);
    await h.harness.behavior.setSettings({ requireDocsApproval: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.harness.inspection.pendingInteractions.length, 1); assert.equal(h.writes(), 0);
    h.harness.behavior.cancelInteraction(form.id);
    assert.equal(text(await waiting).reason, 'user'); assert.equal(h.writes(), 0);
    reloaded = await h.harness.lifecycle.reload(plugin);
    assert.equal(text(await reloaded.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false })).approval, 'disabled_in_settings');
    assert.equal(h.writes(), 1); assert.equal(reloaded.harness.inspection.pendingInteractions.length, 0);
  } finally { await reloaded?.harness.lifecycle.dispose(); await h.close(); }
});
test('tool arguments cannot override global approval policy; read-only grants cannot use no-card mode', async () => {
  const h = await setup({ settings: { requireDocsApproval: false }, scope: 'drive.readonly' });
  try {
    await assert.rejects(() => h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false, requireDocsApproval: false }));
    const result = await h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /lacks an owner-authorized/);
    assert.equal(h.writes(), 0); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
  } finally { await h.close(); }
});

test('approval policy lookup failure is actionable and logged without settings or account content', async () => {
  const h = await setup({ settings: { requireDocsApproval: false }, settingsFailure: true });
  try {
    const result = await h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /approval setting could not be checked/);
    assert.equal(h.writes(), 0); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
    const logs = h.harness.inspection.logEntries;
    assert.match(JSON.stringify(logs), /agent_tool gdocs_replace_text approval_policy_unavailable/);
    assert.doesNotMatch(JSON.stringify([result, logs]), /private-|writer@example|old words|new words/);
  } finally { await h.close(); }
});

test('owner rejection, cancellation and nonboolean approval are distinct and never mutate', async () => {
  for (const [decision, outcome, reason] of [['cancel', 'cancelled', 'user'], [false, 'declined', 'owner_declined'], ['true', 'approval_unavailable', 'invalid_response']]) {
    const h = await setup();
    try {
      const done = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
      const form = await pending(h.harness);
      if (decision === 'cancel') h.harness.behavior.cancelInteraction(form.id);
      else h.harness.behavior.submitInteraction(form.id, { approved: decision });
      const result = text(await done);
      assert.equal(result.outcome, outcome); assert.equal(result.reason, reason); assert.equal(h.writes(), 0);
    } finally { await h.close(); }
  }
});
test('idle is not cancellation; timeout, caller abort, disposal and request setup failure remain distinct', async () => {
  for (const boundary of ['timeout', 'abort', 'dispose', 'setup']) {
    const h = await setup();
    const controller = new AbortController();
    try {
      const requestInput = h.bb.ui.requestInput.bind(h.bb.ui);
      h.bb.ui.requestInput = (request, options) => {
        if (boundary === 'setup') throw new Error('private-account-content-token');
        return requestInput({ ...request, ...(boundary === 'timeout' ? { timeoutMs: 30 } : {}) }, options);
      };
      const done = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false }, { threadId: 'thread-review', signal: controller.signal });
      if (boundary !== 'setup') {
        await pending(h.harness);
        await h.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thread-review', status: 'idle' }), lastAssistantText: 'Waiting for review.' });
        assert.equal(h.harness.inspection.pendingInteractions.length, 1);
        assert.equal(h.writes(), 0);
      }
      if (boundary === 'abort') controller.abort(new Error('private-abort-secret'));
      if (boundary === 'dispose') await h.harness.lifecycle.dispose();
      const result = text(await done);
      assert.equal(result.reason, { timeout: 'timeout', abort: 'request-aborted', dispose: 'plugin-disposed', setup: 'request_failed' }[boundary]);
      assert.equal(result.outcome, boundary === 'setup' ? 'approval_unavailable' : 'cancelled');
      assert.equal(result.writeAttempted, false); assert.equal(h.writes(), 0);
      assert.match(JSON.stringify(h.harness.inspection.logEntries), /docs_approval_/);
      assert.doesNotMatch(JSON.stringify([result, h.harness.inspection.logEntries]), /private-|writer@example|old words|new words/);
    } finally { await h.close(); }
  }
});

test('read-only access returns actionable scope error before owner form; diagnostics are bounded', async () => {
  const h = await setup({ scope: 'drive.readonly' });
  try {
    const result = await h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /lacks an owner-authorized Docs write grant/);
    assert.equal(h.harness.inspection.pendingInteractions.length, 0); assert.equal(h.writes(), 0);
    const logs = JSON.stringify(h.harness.inspection.logEntries);
    assert.match(logs, /agent_tool gdocs_replace_text scope_required/);
    assert.doesNotMatch(logs, /private-|writer@example|old words|new words/);
  } finally { await h.close(); }
});
test('remote inspection failure and uncertain write report honest outcomes without content/secrets', async () => {
  let h = await setup({ remoteFailure: true });
  try {
    const result = await h.harness.behavior.callAgentTool('gdocs_inspect_for_edit', { account, document: 'doc-a' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(h.harness.inspection.logEntries), /http_status=503/);
    assert.doesNotMatch(JSON.stringify([result, h.harness.inspection.logEntries]), /private-|writer@example/);
  } finally { await h.close(); }
  h = await setup({ uncertain: true });
  try {
    const done = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
    const form = await pending(h.harness); h.harness.behavior.submitInteraction(form.id, { approved: true });
    const result = await done;
    assert.equal(text(result).outcome, 'uncertain'); assert.equal(h.writes(), 1);
    assert.match(JSON.stringify(h.harness.inspection.logEntries), /docs_write_uncertain unknown/);
    assert.doesNotMatch(JSON.stringify([result, h.harness.inspection.logEntries]), /private-|writer@example|old words|new words/);
  } finally { await h.close(); }
});
