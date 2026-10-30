import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { document, account } from './docs-fixtures.mjs';
const operationId = '11111111-1111-4111-8111-111111111111';
const input = { account, document: 'doc-a', operationId, expectedRevisionId: 'rev-a', ranges: [{ tabId: 'tab-a', startIndex: 1, endIndex: 7, textStyle: { sizePt: 30 } }] };
const parse = r => JSON.parse(r.content[0].text);
async function pending(h) {
  for (let i = 0; i < 100; i++) { if (h.inspection.pendingInteractions.length) return h.inspection.pendingInteractions[0]; await new Promise(r => setTimeout(r, 2)); }
  throw new Error('No synthetic approval');
}
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'google-drive', settings: { requireDocsApproval: options.approvalRequired ?? true } });
  let doc = document('Title\n'), writes = 0, calls = 0;
  if (options.background) doc.tabs[0].documentTab.documentStyle = { documentFormat: { documentMode: 'PAGES' }, marginLeft: { magnitude: 54, unit: 'PT' } };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (options.fail) throw Object.assign(new Error('private-token-body'), { cause: 'private-account-content' });
    const path = String(url);
    if (path.endsWith('/userinfo')) return Response.json({ sub: 'subject-a', email: account, email_verified: true });
    if (path.includes('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${options.readonly ? 'drive.readonly' : 'drive.file'}` });
    if (path.includes('/drive/v3/files/doc-a')) return Response.json({ id: 'doc-a', trashed: false, mimeType: 'application/vnd.google-apps.document' });
    if (path.endsWith(':batchUpdate')) {
      writes++;
      const body = JSON.parse(init.body);
      assert.deepEqual(body, options.background
        ? { writeControl: { requiredRevisionId: 'rev-a' }, requests: [{ updateDocumentStyle: { tabId: 'tab-a', documentStyle: { background: { color: { color: { rgbColor: { red: 244 / 255, green: 241 / 255, blue: 232 / 255 } } } } }, fields: 'background' } }] }
        : { writeControl: { requiredRevisionId: 'rev-a' }, requests: [{ updateTextStyle: { range: { tabId: 'tab-a', startIndex: 1, endIndex: 7 }, textStyle: { fontSize: { magnitude: 30, unit: 'PT' } }, fields: 'fontSize' } }] });
      if (options.lost) throw new Error('private-provider-token');
      if (options.background) doc.tabs[0].documentTab.documentStyle.background = { color: { color: { rgbColor: { red: Math.fround(244 / 255), green: Math.fround(241 / 255), blue: Math.fround(232 / 255) } } } };
      else doc.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle.fontSize = { magnitude: 30, unit: 'PT' };
      doc.revisionId = 'rev-b';
      return Response.json({ documentId: 'doc-a', replies: [{}], writeControl: { requiredRevisionId: 'rev-b' } });
    }
    if (path.includes('/documents/doc-a?')) return Response.json(doc);
    throw new Error('private-unexpected-request');
  };
  await plugin(host.bb);
  const store = createBbStore(host.bb.storage.database(), () => {});
  await store.addAccount({ subject: 'subject-a', email: account, refreshToken: 'private-refresh', accessToken: 'private-access', expiresAt: Date.now() + 600_000 });
  return { ...host, writes: () => writes, calls: () => calls, resetDoc: () => { doc = document('Title\n'); }, close: async () => { globalThis.fetch = original; await host.harness.lifecycle.dispose(); } };
}
test('format tools default to exact owner approval; actual adapter wire and durable status work', async () => {
  const h = await setup();
  try {
    const b = h.harness.behavior;
    assert.equal(parse(await b.callAgentTool('gdocs_inspect_formatting', { account, document: 'doc-a' })).complete, true);
    assert.equal(parse(await b.callAgentTool('gdocs_format_document', input)).outcome, 'proposed');
    const done = b.callAgentTool('gdocs_format_document', { ...input, preview: false });
    const form = await pending(h.harness); assert.equal(form.rendererId, 'docs-format-approval'); assert.equal(h.writes(), 0);
    assert.equal(form.payload.account, account); assert.equal(form.payload.selections[0].paragraphs[0].text, 'Title\n');
    assert.equal(form.payload.selections[0].textStyle.sizePt, 30);
    b.submitInteraction(form.id, { approved: true });
    assert.equal(parse(await done).outcome, 'verified'); assert.equal(h.writes(), 1);
    assert.equal(parse(await b.callAgentTool('gdocs_formatting_status', { account, operationId })).outcome, 'verified');
    await assert.rejects(b.callAgentTool('gdocs_format_document', { ...input, requireApproval: false }));
    assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries), /private-|Title|writer@example/);
  } finally { await h.close(); }
});
test('owner setting disables formatting cards live and survives reload without weakening validation', async () => {
  const h = await setup(); let replacement;
  try {
    await h.harness.behavior.setSettings({ requireDocsApproval: false });
    const r = parse(await h.harness.behavior.callAgentTool('gdocs_format_document', { ...input, preview: false }));
    assert.equal(r.outcome, 'verified'); assert.equal(r.approval, 'disabled_in_settings'); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
    h.resetDoc(); replacement = await h.harness.lifecycle.reload(plugin);
    const again = parse(await replacement.harness.behavior.callAgentTool('gdocs_format_document', { ...input, operationId: '22222222-2222-4222-8222-222222222222', preview: false }));
    assert.equal(again.outcome, 'verified'); assert.equal(again.approval, 'disabled_in_settings'); assert.equal(h.writes(), 2);
    await assert.rejects(replacement.harness.behavior.callAgentTool('gdocs_format_document', { ...input, approvalRequired: false }));
    assert.doesNotMatch(JSON.stringify(replacement.harness.inspection.logEntries), /private-|writer@example|Title/);
  } finally { await replacement?.harness.lifecycle.dispose(); await h.close(); }
});
test('native colour-only schema and adapter preserve omitted layout with the same revision/recovery guard', async () => {
  const h = await setup({ background: true, approvalRequired: false });
  try {
    const request = { ...input, ranges: [], page: { tabId: 'tab-a', backgroundColor: '#F4F1E8' } };
    const b = h.harness.behavior;
    const preview = parse(await b.callAgentTool('gdocs_format_document', request)); assert.equal(h.writes(), 0);
    assert.deepEqual(preview.proposal.page.after, request.page);
    const r = parse(await b.callAgentTool('gdocs_format_document', { ...request, preview: false }));
    assert.equal(r.outcome, 'verified'); assert.equal(r.approval, 'disabled_in_settings'); assert.equal(h.writes(), 1);
    const inspected = parse(await b.callAgentTool('gdocs_inspect_formatting', { account, document: 'doc-a' }));
    assert.deepEqual(inspected.tabStyles[0].documentStyle.marginLeft, { magnitude: 54, unit: 'PT' });
    assert.equal(parse(await b.callAgentTool('gdocs_formatting_status', { account, operationId })).outcome, 'verified');
  } finally { await h.close(); }
});
test('fixed synthetic review tool cannot reach Google, even when approved', async () => {
  const h = await setup({ fail: true });
  try {
    for (const state of ['formatting', 'background']) {
      const done = h.harness.behavior.callAgentTool('gdocs_review_format_example', { state });
      const form = await pending(h.harness); assert.equal(form.payload.exampleOnly, true);
      if (state === 'background') { assert.deepEqual(form.payload.selections, []); assert.deepEqual(form.payload.page.after, { tabId: 'main', backgroundColor: '#F4F1E8' }); }
      h.harness.behavior.submitInteraction(form.id, { approved: true });
      assert.deepEqual(parse(await done), { outcome: 'approved', exampleOnly: true, writeAttempted: false });
    }
    assert.equal(h.calls(), 0); assert.equal(h.writes(), 0);
  } finally { await h.close(); }
});
test('read-only scope and controlled inspection failure produce bounded safe diagnostics', async () => {
  for (const options of [{ readonly: true }, { fail: true }]) {
    const h = await setup(options);
    try {
      const result = await h.harness.behavior.callAgentTool('gdocs_format_document', { ...input, preview: false });
      assert.equal(h.writes(), 0); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
      const logs = JSON.stringify(h.harness.inspection.logEntries);
      assert.match(logs, options.fail ? /agent_tool gdocs_format_document/ : /docs_format_preflight.*scope_required/);
      assert.doesNotMatch(JSON.stringify(result) + logs, /private-|Title|writer@example/);
    } finally { await h.close(); }
  }
});
test('native abort/disposal/timeout/invalid submission never writes or auto-replays after reload', async () => {
  for (const mode of ['abort', 'dispose', 'timeout', 'invalid']) {
    const h = await setup(), controller = new AbortController(); let replacement;
    try {
      const request = h.bb.ui.requestInput.bind(h.bb.ui);
      if (mode === 'timeout') h.bb.ui.requestInput = (p, options) => request({ ...p, timeoutMs: 20 }, options);
      const done = h.harness.behavior.callAgentTool('gdocs_format_document', { ...input, preview: false }, { signal: controller.signal });
      const form = await pending(h.harness);
      if (mode === 'abort') controller.abort();
      if (mode === 'dispose') await h.harness.lifecycle.dispose();
      if (mode === 'invalid') h.harness.behavior.submitInteraction(form.id, { approved: 'true' });
      const r = parse(await done); assert.equal(r.writeAttempted, false); assert.equal(h.writes(), 0);
      if (mode !== 'dispose') {
        replacement = await h.harness.lifecycle.reload(plugin);
        const again = parse(await replacement.harness.behavior.callAgentTool('gdocs_format_document', { ...input, preview: false }));
        assert.equal(again.writeAttempted, false); assert.equal(h.writes(), 0); assert.equal(replacement.harness.inspection.pendingInteractions.length, 0);
      }
    } finally { await replacement?.harness.lifecycle.dispose(); await h.close(); }
  }
});
test('uncertain mutation survives native reload and read-only recovery cannot retry it', async () => {
  const h = await setup({ lost: true }); let replacement;
  try {
    const done = h.harness.behavior.callAgentTool('gdocs_format_document', { ...input, preview: false });
    const form = await pending(h.harness); h.harness.behavior.submitInteraction(form.id, { approved: true });
    assert.equal(parse(await done).outcome, 'uncertain'); assert.equal(h.writes(), 1);
    replacement = await h.harness.lifecycle.reload(plugin);
    const status = parse(await replacement.harness.behavior.callAgentTool('gdocs_formatting_status', { account, operationId }));
    assert.equal(status.outcome, 'uncertain'); assert.equal(h.writes(), 1);
    assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries), /private-|writer@example|Title/);
  } finally { await replacement?.harness.lifecycle.dispose(); await h.close(); }
});
