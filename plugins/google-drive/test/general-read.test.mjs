import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { createDriveService } from '../core/service.mjs';
import { createMemoryStore } from '../core/memory-store.mjs';
import { createBbStore } from '../adapters/bb-store.mjs';
import { failureCategory } from '../diagnostic.mjs';

const MiB = 1_048_576;
const record = { subject: 'synthetic-subject', email: 'reader@example.test', accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 600_000 };
const paragraph = text => ({ paragraph: { elements: [{ textRun: { content: text } }] } });
const tab = content => ({ documentTab: { body: { content } } });
function document(text = 'main\n') {
  return { title: 'private-title', tabs: [{ ...tab([
    paragraph(text),
    { table: { tableRows: [{ tableCells: [{ content: [paragraph('cell\n')] }] }] } },
    { tableOfContents: { content: [paragraph('contents\n')] } },
  ]), childTabs: [tab([paragraph('child\n')])] }], stylePadding: 'private-provider-content-' + 'x'.repeat(4 * MiB) };
}
async function fixture(response) {
  const calls = [], store = createMemoryStore();
  await store.addAccount(record);
  const adapter = createGoogleAdapter({ store, getClient: async () => { throw Error('No refresh expected'); }, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: record.subject, email: record.email, email_verified: true });
    if (String(url).includes('docs.googleapis.com')) return response();
    return Response.json({ id: 'doc-a', name: 'private-title', mimeType: 'application/vnd.google-apps.document' });
  } });
  return { adapter, calls, service: createDriveService({ store, ...adapter }) };
}

test('general reader accepts style-heavy Docs above 1 MiB, with URL/ID, tables, contents and child tabs', async () => {
  for (const input of ['doc-a', 'https://docs.google.com/document/d/doc-a/edit']) {
    const h = await fixture(() => Response.json(document()));
    const result = await h.service.execute('gdocs_read', { account: record.email, document: input });
    assert.equal(result.text, 'main\ncell\n\tcontents\nchild\n');
    assert.equal(result.truncated, false);
    assert.equal(result.documentId, 'doc-a');
    const request = h.calls.find(c => c.url.includes('docs.googleapis.com'));
    assert.equal(new URL(request.url).searchParams.get('includeTabsContent'), 'true');
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.ok(h.calls.every(c => c.init.method === undefined && c.init.body === undefined));
  }
});

test('general reader retains legacy body support and the 100,000 UTF-16-unit text cap', async () => {
  const h = await fixture(() => Response.json({ body: { content: [paragraph('x'.repeat(100_001))] }, stylePadding: 'x'.repeat(2 * MiB) }));
  const result = await h.service.execute('gdocs_read', { account: record.email, document: 'doc-a' });
  assert.equal(result.text, 'x'.repeat(100_000));
  assert.equal(result.truncated, true);
});

test('general reader accepts exactly 8 MiB but rejects streaming overrun and advertised excess without retry', async () => {
  const prefix = '{"padding":"', suffix = '"}';
  const atLimit = prefix + 'x'.repeat(8 * MiB - prefix.length - suffix.length) + suffix;
  const accepted = await fixture(() => new Response(atLimit));
  await accepted.adapter.drive.readDoc(record, 'doc-a');
  for (const advertised of [false, true]) {
    let cancelled = false, reads = 0, response;
    const h = await fixture(() => {
      response = new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(MiB)); },
        cancel() { cancelled = true; },
      }), { headers: advertised ? { 'content-length': String(8 * MiB + 1) } : {} });
      return response;
    });
    await assert.rejects(() => h.adapter.drive.readDoc(record, 'doc-a'), error => {
      assert.equal(error.code, 'response_too_large');
      assert.equal(failureCategory(error), 'response_too_large');
      assert.doesNotMatch(error.message, /private-|reader@example/);
      return true;
    });
    assert.equal(h.calls.filter(c => c.url.includes('docs.googleapis.com')).length, 1);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
    assert.ok(reads <= (advertised ? 1 : 10));
  }
});

test('larger general-read allowance does not relax the editing inspection limit', async () => {
  const h = await fixture(() => Response.json(document()));
  await assert.rejects(() => h.adapter.docs.inspect(record, 'doc-a'), error => error.docsCode === 'unsupported_document');
});

test('host tool reads large Docs and reports oversized responses distinctly without leaking account/provider data', async () => {
  const original = globalThis.fetch;
  let oversized = false, long = false;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: record.subject, email: record.email, email_verified: true });
    if (String(url).includes('docs.googleapis.com')) return oversized
      ? new Response('private-provider-content', { headers: { 'content-length': String(8 * MiB + 1) } })
      : Response.json(document(long ? 'x'.repeat(100_001) : 'main\n'));
    return Response.json({ id: 'private-doc-id', name: 'private-title', mimeType: 'application/vnd.google-apps.document' });
  };
  const host = createFakePluginHost({ pluginId: 'google-drive', agentSkillIds: ['google-docs-editing', 'google-drive-sharing'] });
  try {
    await plugin(host.bb);
    const store = createBbStore(host.bb.storage.database(), () => {});
    await store.addAccount(record);
    const args = { account: record.email, document: 'private-doc-id' };
    const result = await host.harness.behavior.callAgentTool('gdocs_read', args);
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).text, 'main\ncell\n\tcontents\nchild\n');
    long = true;
    const first = JSON.parse((await host.harness.behavior.callAgentTool('gdocs_read', args)).content[0].text);
    const second = await host.harness.behavior.callAgentTool('gdocs_read', { ...args, cursor: first.nextCursor });
    assert.equal(JSON.parse(second.content[0].text).complete, true);
    const replay = await host.harness.behavior.callAgentTool('gdocs_read', { ...args, cursor: first.nextCursor });
    assert.equal(replay.isError, true);
    assert.match(replay.content[0].text, /Start a fresh read/);
    oversized = true;
    const failed = await host.harness.behavior.callAgentTool('gdocs_read', args);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /size limit.*plain text/i);
    assert.doesNotMatch(failed.content[0].text, /connected account|copy|reconnect/i);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /agent_tool gdocs_read response_too_large/);
    assert.match(logs, /agent_tool gdocs_read docs_cursor_expired/);
    assert.doesNotMatch(logs + JSON.stringify(replay), new RegExp(first.nextCursor));
    assert.doesNotMatch(logs + JSON.stringify(failed), /private-|reader@example|synthetic-subject/);
    assert.equal(failureCategory({ code: 'private-untrusted-code' }), 'unknown');
  } finally { await host.harness.lifecycle.dispose(); globalThis.fetch = original; }
});
