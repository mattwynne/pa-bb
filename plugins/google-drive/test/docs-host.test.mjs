import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { document, input, account } from './docs-fixtures.mjs';
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'google-drive', appUrl: 'https://bb.example', settings: { clientId: 'test-client', clientSecret: 'private-secret' } });
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
  return { ...host, writes: () => writes, close: async () => { globalThis.fetch = original; await host.harness.lifecycle.dispose(); } };
}
async function pending(harness) {
  for (let i = 0; i < 100; i++) {
    if (harness.inspection.pendingInteractions.length) return harness.inspection.pendingInteractions[0];
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Approval form did not open');
}
const text = result => JSON.parse(result.content[0].text);
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
test('owner rejection, cancellation and nonboolean approval never mutate', async () => {
  for (const decision of ['cancel', false, 'true']) {
    const h = await setup();
    try {
      const done = h.harness.behavior.callAgentTool('gdocs_replace_text', { ...input, preview: false });
      const form = await pending(h.harness);
      if (decision === 'cancel') h.harness.behavior.cancelInteraction(form.id);
      else h.harness.behavior.submitInteraction(form.id, { approved: decision });
      assert.equal(text(await done).outcome, 'cancelled'); assert.equal(h.writes(), 0);
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
