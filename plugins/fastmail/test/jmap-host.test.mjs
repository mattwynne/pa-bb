import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

const resolve = host => host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
test('JMAP token is secret, independent of MCP, dynamically selected, and read at invocation', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail' });
  const seen = [];
  try {
    await plugin(host.bb, undefined, async (url, init) => { seen.push(init.headers.Authorization); return new Response('private provider response', { status: 401 }); });
    assert.equal(host.harness.inspection.registrations.settingsDescriptors.jmapApiToken.secret, true);
    assert.deepEqual((await resolve(host)).tools, []);
    await host.harness.behavior.setSettings({ jmapApiToken: 'private-token-one' });
    assert.deepEqual((await resolve(host)).tools.map(t => t.name), ['fastmail_update_email_labels']);
    const args = { emailIds: ['M1'], addLabels: ['Inbox'] };
    const result = await host.harness.behavior.callAgentTool('fastmail_update_email_labels', args);
    assert.equal(result.isError, true);
    await host.harness.behavior.setSettings({ jmapApiToken: 'private-token-two' });
    await host.harness.behavior.callAgentTool('fastmail_update_email_labels', args);
    assert.deepEqual(seen, ['Bearer private-token-one', 'Bearer private-token-two']);
    await host.harness.behavior.callRpc('disconnect', null);
    assert.equal((await resolve(host)).tools.length, 1); // Disconnect is MCP only.
    await host.harness.behavior.setSettings({ jmapApiToken: null });
    assert.deepEqual((await resolve(host)).tools, []);
    const missing = await host.harness.behavior.callAgentTool('fastmail_update_email_labels', args);
    assert.equal(missing.isError, true); assert.equal(seen.length, 2);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /jmap_session http_status=401/);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(missing) + JSON.stringify(host.harness.inspection.logEntries), /private|Bearer|M1|Inbox/);
    await assert.rejects(host.harness.behavior.setSettings({ jmapApiToken: 'private\r\ntoken' }));
  } finally { await host.harness.lifecycle.dispose(); }
});
test('seeded JMAP token is selected on load and never reaches agent instructions or schema', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'private-jmap-token' } });
  try {
    await plugin(host.bb);
    const selected = await resolve(host);
    assert.equal(selected.tools[0].name, 'fastmail_update_email_labels');
    assert.doesNotMatch(JSON.stringify(selected), /private-jmap-token/);
    assert.equal((await host.harness.behavior.callRpc('status', null)).connected, false);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('built BB tool previews, applies, and surfaces partial verification honestly', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'private-jmap-token' } });
  let memberships = { screen: true }; let writes = 0; let reject = false;
  const MAIL = 'urn:ietf:params:jmap:mail';
  const fetcher = async (url, init) => {
    if (url.endsWith('/session')) return Response.json({ apiUrl: 'https://api.fastmail.com/jmap/api/', primaryAccounts: { [MAIL]: 'A1' }, accounts: { A1: { accountCapabilities: { [MAIL]: {} } } } });
    const [method, args, callId] = JSON.parse(init.body).methodCalls[0]; let data;
    if (method === 'Mailbox/get') data = { list: [{ id: 'in', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true, mayRemoveItems: true } }, { id: 'screen', name: 'Screener', role: null, parentId: null, myRights: { mayAddItems: true, mayRemoveItems: true } }] };
    else if (method === 'Email/get') data = { state: 's1', list: [{ id: 'M1', blobId: 'B1', threadId: 'T1', mailboxIds: memberships, keywords: {} }], notFound: [] };
    else {
      writes++;
      if (!reject) memberships = { in: true };
      data = reject ? { notUpdated: { M1: { type: 'forbidden', description: 'private response body' } } } : { updated: { M1: null } };
    }
    return Response.json({ methodResponses: [[method, { accountId: args.accountId, ...data }, callId]] });
  };
  try {
    await plugin(host.bb, undefined, fetcher);
    const args = { emailIds: ['M1'], addLabels: ['Inbox'], removeLabels: ['Screener'] };
    let result = await host.harness.behavior.callAgentTool('fastmail_update_email_labels', args);
    assert.equal(JSON.parse(result.content[0].text).status, 'preview'); assert.equal(writes, 0);
    result = await host.harness.behavior.callAgentTool('fastmail_update_email_labels', { ...args, apply: true });
    assert.equal(JSON.parse(result.content[0].text).status, 'applied'); assert.notEqual(result.isError, true); assert.equal(writes, 1);
    memberships = { screen: true }; reject = true;
    result = await host.harness.behavior.callAgentTool('fastmail_update_email_labels', { ...args, apply: true });
    assert.equal(JSON.parse(result.content[0].text).status, 'partial'); assert.equal(result.isError, true);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /jmap_update partial_result/);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(host.harness.inspection.logEntries), /private/);
  } finally { await host.harness.lifecycle.dispose(); }
});
test('unexpected settings/transport failures never expose raw diagnostics', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'private-jmap-token' } });
  try {
    await plugin(host.bb, undefined, async () => { throw Object.assign(new Error('private provider body private-jmap-token'), { code: 'private-untrusted-code' }); });
    const result = await host.harness.behavior.callAgentTool('fastmail_update_email_labels', { emailIds: ['M1'], addLabels: ['Inbox'] });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(host.harness.inspection.logEntries), /jmap_session transport/);
    assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(host.harness.inspection.logEntries), /private/);
  } finally { await host.harness.lifecycle.dispose(); }
});
