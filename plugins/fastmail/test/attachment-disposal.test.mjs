import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

test('dispose cancels and drains an active original-download read without publishing or retrying', { timeout: 3000 }, async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'private-token' } });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-mcp' } }));
  const connect = () => ({ client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: [] }) }, transport: { close: async () => {} } });
  let start; const entered = new Promise(resolve => { start = resolve; }); let fetches = 0; let signal;
  try {
    await plugin(host.bb, connect, async (_url, init) => { fetches++; signal = init.signal; start(); return new Promise(() => {}); });
    const pending = host.harness.behavior.callAgentTool('fastmail_download_attachment', {
      account: 'user@example.test', emailId: 'M1', blobId: 'B1', expectedName: 'Example.docx', expectedMimeType: 'application/octet-stream', expectedSize: 1,
    }, { threadId: 'thr_current' });
    await entered;
    await host.harness.lifecycle.dispose();
    const result = await pending;
    assert.equal(result.isError, true); assert.equal(signal.aborted, true); assert.equal(fetches, 1);
    assert.equal(host.harness.inspection.sdk.callsTo('threads.storageLocation').length, 0);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /attachment_session cancelled/); assert.doesNotMatch(logs, /private-|user@|Example.docx/);
  } finally { await host.harness.lifecycle.dispose(); }
});
