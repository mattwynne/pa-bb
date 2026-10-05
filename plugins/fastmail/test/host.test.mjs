import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

// The built plugin runs against BB's host contract, but never contacts Fastmail.
test('fresh provider resolutions select granted dynamic tools and hide provider metadata', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'synthetic' } }));
  let catalog = [
    { name: 'read', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'send', inputSchema: { type: 'object', properties: { subject: { type: 'string' } } } },
  ];
  const calls = [];
  const fakeConnect = () => ({
    client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: catalog }),
      callTool: async args => { calls.push(args); return { content: [
        { type: 'text', text: 'provider body', _meta: { internal: 'private' } },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', _meta: { internal: 'private' } },
        { type: 'resource_link', uri: 'https://example.test', name: 'link', _meta: { internal: 'private' } },
      ], structuredContent: { count: 1 }, _meta: { internal: 'private' } }; } },
    transport: { close: async () => {} },
  });
  try {
    await plugin(host.bb, fakeConnect);
    const resolve = () => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const selected = await resolve();
    assert.equal(selected.tools.length, 4);
    const send = selected.tools.find(x => x.name.startsWith('fastmail_send_'));
    assert.deepEqual(send.inputSchema.properties, { subject: { type: 'string' } });
    const result = await host.harness.behavior.callAgentTool(send.name, { subject: 'mock' });
    assert.deepEqual(calls, [{ name: 'send', arguments: { subject: 'mock' } }]);
    assert.deepEqual(result.content.slice(0, 2), [
      { type: 'text', text: 'provider body' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    assert.match(result.content[2].text, /resource_link/);
    assert.match(result.content[3].text, /structuredContent/);
    assert.doesNotMatch(JSON.stringify(result), /private|_meta/);
    catalog = [catalog[0]];
    await host.harness.behavior.callRpc('refresh', null);
    assert.equal((await resolve()).tools.length, 3);
    assert.equal((await host.harness.behavior.callAgentTool(send.name, {})).isError, true);
    await host.harness.behavior.callRpc('disconnect', null);
    assert.deepEqual((await resolve()).tools, []);
  } finally { await host.harness.lifecycle.dispose(); }
});
