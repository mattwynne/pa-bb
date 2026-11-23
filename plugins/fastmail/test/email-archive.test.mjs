import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';

test('Email reads exact primary Fastmail mail via JMAP with no MCP login', async () => {
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'SECRET_JMAP' } });
  const caller = { experimental_caller: { kind: 'plugin', pluginId: 'email' } };
  const invoke = (method, input) => host.harness.behavior.callRpc(method, input, caller);
  const mime = Buffer.from('Subject: PRIVATE_FASTMAIL_BODY\r\n\r\nA sample message.');
  const mail = 'urn:ietf:params:jmap:mail';
  let first = true;
  let calls = 0;
  await plugin(host.bb, () => assert.fail('No MCP connection is needed'), async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer SECRET_JMAP');
    if (url.endsWith('/session')) return Response.json({
      username: 'primary@example.test', apiUrl: 'https://api.fastmail.com/jmap/api/',
      downloadUrl: 'https://download.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}?type={type}',
      primaryAccounts: { [mail]: 'A1' }, accounts: { A1: { isPersonal: true, accountCapabilities: { [mail]: {} } } },
    });
    if (url.includes('/download/')) {
      assert.equal(new URL(url).pathname, '/jmap/download/A1/B1/message.eml');
      return new Response(mime);
    }
    const [method, args, tag] = JSON.parse(options.body).methodCalls[0];
    assert.equal(args.accountId, 'A1');
    if (method === 'Email/query') {
      if (!first) {
        assert.equal(args.anchor, 'M1');
        assert.equal(args.anchorOffset, 1);
        return Response.json({ methodResponses: [['error', { type: 'anchorNotFound' }, tag]] });
      }
      first = false;
      return Response.json({ methodResponses: [[method, { accountId: 'A1', position: 0, ids: ['M1'] }, tag]] });
    }
    assert.equal(method, 'Email/get');
    assert.deepEqual(args.ids, ['M1']);
    return Response.json({ methodResponses: [[method, { accountId: 'A1', list: [{ id: 'M1', blobId: 'B1', size: mime.length }], notFound: [] }, tag]] });
  });
  try {
    await assert.rejects(host.harness.behavior.callRpc('emailArchiveAccounts', null), { code: 'forbidden' });
    assert.equal(calls, 0);
    assert.deepEqual(await invoke('emailArchiveAccounts', null), [{ id: 'A1', email: 'primary@example.test' }]);
    assert.deepEqual(await invoke('emailArchivePage', { accountId: 'A1', cursor: null }), { ids: ['M1'], next: 'M1' });
    assert.deepEqual(await invoke('emailArchivePage', { accountId: 'A1', cursor: 'M1' }), { ids: [], next: null, restart: true });
    const result = await invoke('emailArchiveMessage', { accountId: 'A1', messageId: 'M1' });
    assert.deepEqual(Buffer.from(result.mime, 'base64'), mime);
    await assert.rejects(invoke('emailArchiveMessage', { accountId: 'A2', messageId: 'M1' }), /Fastmail archive read failed/);
    assert.equal(calls, 9);
    const logs = JSON.stringify(host.harness.inspection.logEntries);
    assert.match(logs, /archive_message account_mismatch/);
    assert.doesNotMatch(logs, /SECRET_JMAP|PRIVATE_FASTMAIL_BODY|primary@example/);
  } finally { await host.harness.lifecycle.dispose(); }
});
