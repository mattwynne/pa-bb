import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

test('one active download bounds concurrency; refusal cannot release another call’s reservation', { timeout: 3000 }, async () => {
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'private-token' } });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-mcp' } }));
  const connect = () => ({ client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: [] }) }, transport: { close: async () => {} } });
  let fetches = 0;
  try {
    await plugin(host.bb, connect, async () => { fetches++; started(); await blocked; return new Response('private-provider-body', { status: 403 }); });
    const args = { account: 'user@example.test', emailId: 'M1', blobId: 'B1', expectedName: 'file.docx', expectedMimeType: 'application/octet-stream', expectedSize: 1 };
    const invoke = () => host.harness.behavior.callAgentTool('fastmail_download_attachment', args, { threadId: 'thr_current' });
    const pending = invoke();
    await entered;
    for (let i = 0; i < 2; i++) {
      const refused = await invoke();
      assert.equal(refused.isError, true);
    }
    assert.equal(fetches, 1); release(); assert.equal((await pending).isError, true);
    assert.equal((await invoke()).isError, true);
    assert.equal(fetches, 2);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /attachment_admission busy/); assert.match(logs, /attachment_session http_status=403/);
    assert.doesNotMatch(logs, /private-|user@|file.docx|M1|B1/);
  } finally { release(); await host.harness.lifecycle.dispose(); }
});
