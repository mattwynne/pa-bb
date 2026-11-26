import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../server.ts';

test('agent tool routes by provider and keeps a durable receipt for an uncertain send', async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'email-unsubscribe', agentSkillIds: ['email-unsubscribe'] });
  const inbox = 'reader@example.com';
  const mime = Buffer.from(
    `To: ${inbox}\r\nList-Unsubscribe: <mailto:remove@example.com>\r\n\r\nPRIVATE_MAIL_BODY\r\n`,
  ).toString('base64');
  let sends = 0;
  harness.sdk.stub('plugins.callRpc', ({ method, pluginId }: { method: string; pluginId: string }) => {
    assert.equal(pluginId, 'google-workspace');
    if (method === 'unsubscribeMessage') return { status: 'ok', mailbox: inbox, mime };
    assert.equal(method, 'sendUnsubscribeMail');
    sends++;
    throw new Error('PRIVATE_MAIL_BODY:SECRET_CREDENTIAL');
  });
  plugin(bb);
  try {
    assert.deepEqual(await harness.behavior.callRpc('status', null), { browser: 'not_configured' });
    const use = (account: string) => harness.behavior.callAgentTool('email_unsubscribe', { provider: 'gmail', account, emailId: 'msg1' });
    const first = await use(inbox);
    assert.match(JSON.stringify(first), /send_unverified/);
    assert.deepEqual(await use(inbox.toUpperCase()), first);
    assert.equal(sends, 1);
    const logs = JSON.stringify(harness.inspection.logEntries);
    assert.match(logs, /mailto send_unverified/);
    assert.doesNotMatch(logs, /PRIVATE_MAIL_BODY|SECRET_CREDENTIAL|reader@example/);
  } finally { await harness.lifecycle.dispose(); }
});
