import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
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
    assert.deepEqual(await harness.behavior.callRpc('status', null), { browser: 'bb_subthread' });
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

const parentId = 'thr_parent';
const childId = 'thr_child';
const projectId = 'proj_example';
const environmentId = 'env_example';
const hostId = 'host_example';
const recipient = 'reader@example.com';
const url = 'https://mail.example.com/leave?token=PRIVATE_LINK_TOKEN';
const child = makeThreadResponse({ id: childId, parentThreadId: parentId, projectId, status: 'active' });

function browserFixture(spawnError = false) {
  const { bb, harness } = createFakePluginHost({ pluginId: 'email-unsubscribe', agentSkillIds: ['email-unsubscribe'] });
  let jobId = '';
  let spawnCount = 0;
  let earlyAccess: ReturnType<typeof harness.behavior.callAgentTool> | undefined;
  const mime = Buffer.from(`To: ${recipient}\r\nList-Unsubscribe: <${url}>\r\n\r\nTest message\r\n`).toString('base64');
  harness.sdk.stub('plugins.callRpc', () => ({ status: 'ok', mailbox: recipient, mime }));
  harness.sdk.stub('threads.get', () => makeThreadResponse({ id: parentId, projectId, environmentId, providerId: 'codex', canSpawnChild: true }));
  harness.sdk.stub('environments.get', () => ({ hostId }));
  harness.sdk.stub('threads.spawn', (input: { pluginMetadata: { unsubscribeJob: string }; prompt: string; parentThreadId: string;
    parentNotifications: string; environment: object }) => {
    spawnCount++;
    jobId = input.pluginMetadata.unsubscribeJob;
    assert.equal(input.parentThreadId, parentId);
    assert.equal(input.parentNotifications, 'auto');
    assert.deepEqual(input.environment, { type: 'reuse', environmentId });
    assert.ok(input.prompt.includes(jobId));
    assert.doesNotMatch(input.prompt, /PRIVATE_LINK_TOKEN|reader@example/);
    if (spawnError) throw Error('PRIVATE_LINK_TOKEN');
    earlyAccess = harness.behavior.callAgentTool('email_unsubscribe_browser_job', { jobId }, { threadId: childId, projectId });
    return child;
  });
  plugin(bb, { web: async () => ({ status: 200, html: '<form><script></script></form>' }) });
  const call = async (name: string, input: object, threadId = childId) => {
    const result = await harness.behavior.callAgentTool(name, input, { threadId, projectId });
    assert.equal(typeof result, 'object');
    if (typeof result === 'string') throw new Error('Expected the structured tool result');
    return result;
  };
  return {
    harness, call, jobId: () => jobId, spawnCount: () => spawnCount, earlyAccess: () => earlyAccess,
    use: () => call('email_unsubscribe', { provider: 'gmail', account: recipient, emailId: 'm1' }, parentId),
  };
}

test('interactive mail starts one child and shares the link only with the exact child', async () => {
  const fx = browserFixture();
  try {
    const pending = await fx.use();
    assert.match(JSON.stringify(pending), /in_progress.*thr_child/);
    assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_LINK_TOKEN|reader@example/);
    assert.deepEqual(await fx.use(), pending);
    assert.equal(fx.spawnCount(), 1);
    const jobId = fx.jobId();
    const link = await fx.earlyAccess();
    assert.match(JSON.stringify(link), /PRIVATE_LINK_TOKEN/);
    assert.match(JSON.stringify(link), /host_example/);
    assert.equal((await fx.call('email_unsubscribe_browser_job', { jobId })).isError, true);
    assert.equal((await fx.call('email_unsubscribe_browser_finish', { jobId, status: 'confirmed', reason: 'sender_confirmed' }, parentId)).isError, true);
    assert.equal((await fx.call('email_unsubscribe_browser_finish', { jobId, status: 'confirmed', reason: 'sender_confirmed' }, 'thr_other')).isError, true);
    const result = await fx.call('email_unsubscribe_browser_finish', { jobId, status: 'confirmed', reason: 'sender_confirmed' });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(await fx.use()), /confirmed.*sender_confirmed.*thr_child/);
    assert.equal(fx.spawnCount(), 1);
  } finally { await fx.harness.lifecycle.dispose(); }
});

test('a child ending without a receipt leaves an unverified result and no repeat spawn', async () => {
  const fx = browserFixture();
  try {
    await fx.use();
    await fx.earlyAccess();
    await fx.harness.behavior.emitThreadEvent('thread.idle', { thread: child, lastAssistantText: 'PRIVATE_LINK_TOKEN' });
    assert.equal((await fx.call('email_unsubscribe_browser_finish', {
      jobId: fx.jobId(), status: 'confirmed', reason: 'sender_confirmed',
    })).isError, true);
    assert.match(JSON.stringify(await fx.use()), /unverified.*browser_ended_without_result/);
    assert.doesNotMatch(JSON.stringify(fx.harness.inspection.logEntries), /PRIVATE_LINK_TOKEN/);
    assert.equal(fx.spawnCount(), 1);
  } finally { await fx.harness.lifecycle.dispose(); }
});

test('an uncertain spawn is recorded and further calls cannot start a duplicate child', async () => {
  const fx = browserFixture(true);
  try {
    const result = await fx.use();
    assert.match(JSON.stringify(result), /unverified.*subthread_start_unverified/);
    assert.deepEqual(await fx.use(), result);
    assert.equal(fx.spawnCount(), 1);
    assert.equal((await fx.call('email_unsubscribe_browser_job', { jobId: fx.jobId() })).isError, true);
    assert.doesNotMatch(JSON.stringify(fx.harness.inspection.logEntries), /PRIVATE_LINK_TOKEN/);
  } finally { await fx.harness.lifecycle.dispose(); }
});
