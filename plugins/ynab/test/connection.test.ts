import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createConnection } from '../connection.ts';

const token = 'synthetic-token-and-private-account-data';
const signal = new AbortController().signal;

function fixture(rejectRead = false) {
  const logs: string[] = [];
  const connection = createConnection({ token, allowWrites: false }, entry => logs.push(entry), () => new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./stdio-fixture.mjs', import.meta.url))],
    env: { SYNTHETIC_YNAB_TOKEN: token, REJECT_PLAN_READ: String(rejectRead) },
    stderr: 'ignore',
  }));
  return { connection, logs };
}

test('the pinned community package discovers read and write tools according to configuration', async () => {
  const connection = createConnection({ token, allowWrites: false }, () => {});
  try {
    const read = JSON.parse(await connection.list()).map((tool: { name: string }) => tool.name);
    assert.ok(read.includes('ynab_list_plans'));
    assert.ok(!read.includes('ynab_create_transaction'));
    await assert.rejects(connection.call('ynab_create_transaction', {}, signal), /unavailable/);
    connection.configure({ token, allowWrites: true });
    const write = JSON.parse(await connection.list()).map((tool: { name: string }) => tool.name);
    assert.ok(write.includes('ynab_create_transaction'));
    assert.ok(!write.includes('ynab_suggest_categories'));
    connection.configure({ allowWrites: false });
    await assert.rejects(connection.check(), /personal access token/);
  } finally {
    await connection.dispose();
  }
});

test('follows catalog pages, admits only current names and verifies a plan read', async () => {
  const { connection, logs } = fixture();
  await connection.check();
  const tools = JSON.parse(await connection.list()).map((tool: { name: string }) => tool.name);
  assert.deepEqual(tools, ['ynab_list_plans', 'ynab_mock_write']);
  await assert.rejects(connection.call('ynab_missing', {}, signal), /unavailable/);
  assert.match(await connection.call('ynab_list_plans', {}, signal), /Synthetic plan/);
  assert.deepEqual(logs, ['YNAB catalog tool_unavailable']);
  await connection.dispose();
});

test('logs fixed categories for failed reads and calls with private content in stderr and results', async () => {
  const { connection, logs } = fixture(true);
  await assert.rejects(connection.check(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /rejected the plan read/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  await assert.rejects(connection.call('ynab_mock_write', {}, signal), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Check your plan/);
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.deepEqual(logs, ['YNAB plan_check provider_error_result', 'YNAB tool_call provider_error_result']);
  await connection.dispose();
});

test('process start failures omit private paths and transport detail', async () => {
  const logs: string[] = [];
  const connection = createConnection({ token, allowWrites: false }, entry => logs.push(entry), () => {
    throw new Error(token);
  });
  await assert.rejects(connection.list(), /could not start the YNAB MCP server/);
  assert.deepEqual(logs, ['YNAB connection_start unknown']);
  await connection.dispose();
});
