import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
const MAIL = 'urn:ietf:params:jmap:mail'; const SUB = 'urn:ietf:params:jmap:submission';
const args = { account: 'login@example.test', emailId: 'M1', blobId: 'B1', expectedName: 'Example.docx', expectedMimeType: 'application/octet-stream', expectedSize: 4 };
const email = { id: 'M1', threadId: 'T1', attachments: [{ blobId: 'B1', name: args.expectedName, type: args.expectedMimeType, size: 4 }] };
async function setup(root, changes = {}) {
  const calls = []; const downloads = [];
  const host = createFakePluginHost({ pluginId: 'fastmail', settings: { jmapApiToken: 'private-token-sentinel' }, sdk: {
    system: { config: async () => ({ primaryHostId: 'server' }) },
    threads: { storageLocation: async value => { calls.push(value); return { hostId: changes.remote ? 'remote' : 'server', storageRootPath: root }; } },
  } });
  const db = host.bb.storage.database();
  db.prepare('CREATE TABLE fastmail_oauth (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
  db.prepare('INSERT INTO fastmail_oauth VALUES (1, ?)').run(JSON.stringify({ tokens: { access_token: 'private-mcp-sentinel' } }));
  const connect = () => ({ client: { connect: async () => {}, close: async () => {}, request: async () => ({ tools: ['list_identities', 'read_email'].map(name => ({ name, inputSchema: { type: 'object' } })) }),
    callTool: async ({ name }) => ({ content: [{ type: 'text', text: JSON.stringify(name === 'list_identities' ? [{ email: 'sender@example.test' }] : email) }] }),
  }, transport: { close: async () => {} } });
  const fetcher = async (url, init) => {
    if (changes.error) throw Object.assign(new Error('private-body-sentinel https://example.test?token=private-token-sentinel'), { code: 'private-code-sentinel' });
    if (url.includes('/session')) return Response.json({ username: args.account, apiUrl: 'https://api.fastmail.com/jmap/api/', downloadUrl: 'https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}', primaryAccounts: { [MAIL]: 'A1' }, accounts: { A1: { isPersonal: true, accountCapabilities: { [MAIL]: {}, [SUB]: {} } } } });
    if (url.includes('/download/')) { downloads.push(url); if (changes.onDownload) await changes.onDownload(host); return new Response(Buffer.from([0, 1, 255, 7]), { headers: { 'Content-Type': args.expectedMimeType } }); }
    const [method, input, id] = JSON.parse(init.body).methodCalls[0];
    assert.ok(['Identity/get', 'Email/get'].includes(method));
    return Response.json({ methodResponses: [[method, { accountId: input.accountId, notFound: [], list: method === 'Identity/get' ? [{ id: 'I1', email: changes.mismatch ? 'other@example.test' : 'sender@example.test' }] : [email] }, id]] });
  };
  await plugin(host.bb, connect, fetcher);
  return { ...host, calls, downloads };
}
async function temp(run) { const root = await mkdtemp(join(tmpdir(), 'attachment-host-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
test('built host selects tools only with both grants, publishes capabilities, saves in current context and drops provider content', () => temp(async root => {
  const h = await setup(root);
  try {
    const resolve = () => h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    const selected = await resolve();
    assert.ok(selected.tools.some(t => t.name === 'fastmail_download_attachment'));
    assert.doesNotMatch(JSON.stringify(selected), /private-/);
    assert.deepEqual(await h.harness.behavior.callRpc('attachmentDownloadCapabilities', null), { contract: 'fastmail-original-v1', configured: true, mcpConnected: true, maxBytes: 4194304, storage: 'linux-bb-server-current-thread' });
    const preflight = await h.harness.behavior.callAgentTool('fastmail_attachment_download_status', {});
    assert.equal(JSON.parse(preflight.content[0].text).account, args.account); assert.equal(h.downloads.length, 0); assert.equal(h.calls.length, 0);
    assert.deepEqual(await h.harness.behavior.callRpc('attachmentDownloadPreflight', null), { status: 'ready', account: args.account });
    const response = await h.harness.behavior.callAgentTool('fastmail_download_attachment', args, { threadId: 'thr_current' });
    assert.notEqual(response.isError, true);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.source.threadId, 'thr_current'); assert.deepEqual(h.calls, [{ threadId: 'thr_current' }]);
    assert.deepEqual(await readFile(join(root, result.source.path)), Buffer.from([0, 1, 255, 7]));
    assert.deepEqual(h.harness.inspection.logEntries, []);
    await h.harness.behavior.callRpc('disconnect', null);
    assert.ok(!(await resolve()).tools.some(t => t.name === 'fastmail_download_attachment'));
    assert.equal((await h.harness.behavior.callAgentTool('fastmail_download_attachment', args)).isError, true);
  } finally { await h.harness.lifecycle.dispose(); }
}));
for (const [name, changes, diagnostic] of [
  ['provider transport', { error: true }, 'attachment_session transport'],
  ['identity mismatch', { mismatch: true }, 'attachment_identity account_mismatch'],
  ['remote storage', { remote: true }, 'attachment_file unsupported_host'],
  ['settings revoke', { onDownload: host => host.harness.behavior.setSettings({ jmapApiToken: 'replacement-private-token' }) }, 'attachment_bytes cancelled'],
  ['MCP disconnect', { onDownload: host => host.harness.behavior.callRpc('disconnect', null) }, 'attachment_mcp connection_changed'],
]) test(`built host safely diagnoses ${name}, with no returned artifact`, () => temp(async root => {
  const h = await setup(root, changes);
  try {
    const response = await h.harness.behavior.callAgentTool('fastmail_download_attachment', args, { threadId: 'thr_current' });
    assert.equal(response.isError, true);
    if (changes.error || changes.mismatch) {
      const status = await h.harness.behavior.callRpc('attachmentDownloadPreflight', null);
      assert.equal(status.status, 'blocked'); assert.equal(typeof status.category, 'string');
    }
    const logs = JSON.stringify(h.harness.inspection.logEntries);
    assert.match(logs, new RegExp(diagnostic));
    assert.doesNotMatch(JSON.stringify(response) + logs, /private-|https:|sender@|login@|Example.docx|B1|M1/);
    assert.deepEqual(await readdir(root), []);
  } finally { await h.harness.lifecycle.dispose(); }
}));
test('built host rejects path-selected or cross-thread arguments before any download', () => temp(async root => {
  const h = await setup(root);
  try {
    for (const extra of [{ threadId: 'thr_other' }, { path: '../../outside' }, { source: { host: 'bb-server', path: 'x' } }]) {
      await assert.rejects(h.harness.behavior.callAgentTool('fastmail_download_attachment', { ...args, ...extra }));
    }
    assert.equal(h.downloads.length, 0); assert.equal(h.calls.length, 0);
  } finally { await h.harness.lifecycle.dispose(); }
}));
