import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
const MAIL = 'urn:ietf:params:jmap:mail';
const email = { id: 'M1', threadId: 'T1', messageId: ['synthetic@example.test'], receivedAt: '2026-01-02T12:00:00Z' };
async function setup(changes = {}) {
  const h = createFakePluginHost({ pluginId: 'fastmail', agentSkillIds: ['fastmail-jmap'], settings: { jmapApiToken: 'private-token-sentinel' } });
  const db = h.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-mcp-sentinel' } }));
  const calls = [];
  const tools = ['search_email', 'read_email', 'read_thread'].map(name => ({ name, inputSchema: { type: 'object' } }));
  const connect = () => ({ client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools }),
    callTool: async ({ name }) => {
      calls.push(name);
      if (name === 'search_email') return { content: [{ type: 'text', text: JSON.stringify({ results: [email], hasMore: false }) }] };
      if (name === 'read_thread') return { structuredContent: [email], content: [] };
      return { structuredContent: email, content: [] };
    },
  }, transport: { close: async () => {} } });
  const fetcher = async (url, init) => {
    if (changes.throw) throw Object.assign(new Error('private-body-sentinel private-token-sentinel'), { code: 'private-code-sentinel' });
    if (changes.onFetch) await changes.onFetch(h);
    if (url.includes('/session')) {
      const accountId = changes.unsupportedAccount ? 'A1' : 'u1234abcd';
      return Response.json({ apiUrl: 'https://api.fastmail.com/jmap/api/', primaryAccounts: { [MAIL]: accountId }, accounts: { [accountId]: { isPersonal: true, accountCapabilities: { [MAIL]: {} } } } });
    }
    const [method, args, tag] = JSON.parse(init.body).methodCalls[0];
    return Response.json({ methodResponses: [[method, { accountId: args.accountId, list: [{ ...email, ...changes.email }], notFound: [] }, tag]] });
  };
  await plugin(h.bb, connect, fetcher);
  const search = async (direct = false) => {
    if (direct) {
      const list = await h.harness.behavior.callAgentTool('fastmail_list_tools', {});
      const id = JSON.parse(list.content[0].text).find(t => t.name === 'search_email').id;
      return h.harness.behavior.callAgentTool(id, { limit: 1 });
    }
    return h.harness.behavior.callAgentTool('fastmail_call_tool', { name: 'search_email', arguments: { limit: 1 } });
  };
  return { ...h, search, calls };
}
for (const direct of [true, false]) test(`built resolver uses actual ${direct ? 'direct' : 'fallback'} search receipt and same RPC handler`, async () => {
  const h = await setup();
  try {
    const config = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.ok(config.tools.some(t => t.name === 'fastmail_resolve_email_url'));
    assert.match(config.instructions, /never construct folder\/email-ID/);
    await h.search(direct);
    for (const run of [input => h.harness.behavior.callAgentTool('fastmail_resolve_email_url', input), input => h.harness.behavior.callRpc('resolveEmailUrl', input)]) {
      const result = await run({ emailId: 'M1' }); assert.notEqual(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.url, 'https://app.fastmail.com/mail/Archive/T1.M1?u=1234abcd');
      assert.equal(data.verification, 'metadata-verified-not-browser-verified');
    }
    assert.deepEqual(h.calls, ['search_email']); // Resolution reads no MCP bodies or identities.
    assert.deepEqual(h.harness.inspection.logEntries, []);
    await assert.rejects(h.harness.behavior.callRpc('resolveEmailUrl', { emailId: 'M1', userId: 'OTHER' }));
    await h.harness.behavior.callRpc('disconnect', null);
    const config2 = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.ok(!config2.tools.some(t => t.name === 'fastmail_resolve_email_url'));
    assert.equal((await h.harness.behavior.callAgentTool('fastmail_resolve_email_url', { emailId: 'M1' })).isError, true);
  } finally { await h.harness.lifecycle.dispose(); }
});
for (const [name, changes, diagnostic] of [
  ['no source', {}, 'email_url_source source_missing'],
  ['unsupported account', { unsupportedAccount: true }, 'email_url_session unsupported_account_format'],
  ['provider transport', { throw: true }, 'email_url_session transport_or_invalid_response'],
  ['mismatched message', { email: { threadId: 'T_OTHER' } }, 'email_url_metadata source_message_mismatch'],
  ['settings changed', { onFetch: h => h.harness.behavior.setSettings({ jmapApiToken: 'replacement-private-token' }) }, 'email_url'],
]) test(`built resolver safely diagnoses ${name} without private data`, async () => {
  const h = await setup(changes);
  try {
    if (name !== 'no source') await h.search();
    const result = await h.harness.behavior.callAgentTool('fastmail_resolve_email_url', { emailId: 'M1' });
    assert.equal(result.isError, true);
    const logs = JSON.stringify(h.harness.inspection.logEntries);
    assert.match(logs, new RegExp(diagnostic));
    assert.doesNotMatch(logs + JSON.stringify(result), /private-|https:\/\/|M1|T1|WEB_SYNTHETIC|synthetic@/);
  } finally { await h.harness.lifecycle.dispose(); }
});
