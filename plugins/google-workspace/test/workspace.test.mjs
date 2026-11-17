import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspace } from '../core/workspace.mjs';
import { MemoryMcp } from '../testing/memory-mcp.mjs';
import { tools, richResult } from './support/mcp-fixture.mjs';

function world() {
  const tokens = [], records = [{ email: 'alice@example.test' }, { email: 'bob@example.test' }];
  const accounts = { list: async () => records, access: async email => { tokens.push(email); if (!records.some(r => r.email === email)) throw new Error('Unknown account'); return `token-${email}`; } };
  const mcp = new MemoryMcp({ tools, handler: () => richResult });
  const workspace = createWorkspace({ accounts, mcp });
  return { workspace, mcp, tokens, records };
}

test('no account means no backend startup or catalogue', async () => {
  const w = world(); w.records.length = 0;
  await w.workspace.refresh();
  assert.deepEqual(w.workspace.tools(), []);
  assert.deepEqual(w.mcp.calls, []);
});
test('discovers runtime schemas, adds explicit account, and includes Gmail', async () => {
  const w = world(); await w.workspace.refresh();
  const list = w.workspace.tools();
  assert.equal(list.length, 3);
  const send = list.find(t => t.upstream === 'send_gmail_message');
  assert.match(send.name, /^gworkspace_send_gmail_message_/);
  assert.deepEqual(send.inputSchema.required, ['to', 'body', 'account']);
  assert.deepEqual(send.inputSchema.properties.to, { type: 'string' });
  assert.deepEqual(w.mcp.tools, tools, 'provider schema was not mutated');
});
test('write runs once under the selected account without planning or approval', async () => {
  const w = world(); await w.workspace.refresh(); w.mcp.calls.length = 0;
  const send = w.workspace.tools().find(t => t.upstream === 'send_gmail_message');
  assert.deepEqual(await w.workspace.call(send.name, { account: 'bob@example.test', to: 'recipient@example.test', body: 'Hello' }), richResult);
  assert.deepEqual(w.mcp.calls, [{ method: 'callTool', token: 'token-bob@example.test', call: { name: 'send_gmail_message', arguments: { to: 'recipient@example.test', body: 'Hello' } } }]);
});
test('unknown or removed account stops before an upstream call', async () => {
  const w = world(); await w.workspace.refresh(); w.mcp.calls.length = 0;
  await assert.rejects(w.workspace.call('send_gmail_message', { account: 'unknown@example.test' }), /account/i);
  assert.deepEqual(w.mcp.calls, []);
});
test('provider failure is returned once, not replayed', async () => {
  const w = world(); await w.workspace.refresh(); w.mcp.calls.length = 0;
  w.mcp.handler = () => { throw new Error('PROVIDER_FAILURE'); };
  await assert.rejects(w.workspace.call('modify_doc_text', { account: 'alice@example.test', document_id: 'doc', text: 'Change' }), /PROVIDER_FAILURE/);
  assert.equal(w.mcp.calls.length, 1);
});
test('schema ordering is stable, changed schemas invalidate old tool names', async () => {
  const w = world(); await w.workspace.refresh();
  const before = w.workspace.tools().find(t => t.upstream === 'modify_doc_text').name;
  w.mcp.tools[1].inputSchema.properties = { text: { type: 'string' }, document_id: { type: 'string' } };
  await w.workspace.refresh();
  assert.equal(w.workspace.tools().find(t => t.upstream === 'modify_doc_text').name, before);
  w.mcp.tools[1].inputSchema.properties.text.maxLength = 100;
  await w.workspace.refresh();
  await assert.rejects(w.workspace.call(before, { account: 'alice@example.test' }), /tool/i);
});
test('failed discovery revokes stale catalogue; does not report an empty success', async () => {
  const w = world(); await w.workspace.refresh();
  w.mcp.listTools = async () => { throw new Error('TRANSPORT_FAILURE'); };
  await assert.rejects(w.workspace.refresh(), /TRANSPORT_FAILURE/);
  assert.deepEqual(w.workspace.tools(), []);
});
test('legacy email arguments come from selected account, not caller override', async () => {
  const w = world();
  w.mcp.tools[0].inputSchema.properties.user_google_email = { type: 'string' };
  w.mcp.tools[0].inputSchema.required.push('user_google_email');
  await w.workspace.refresh(); w.mcp.calls.length = 0;
  assert.deepEqual(w.workspace.tools()[0].inputSchema.required, ['document_id', 'account']);
  await w.workspace.call('get_doc_content', { account: 'alice@example.test', user_google_email: 'bob@example.test', document_id: 'doc' });
  assert.equal(w.mcp.calls[0].call.arguments.user_google_email, 'alice@example.test');
});
