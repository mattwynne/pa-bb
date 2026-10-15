import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { plugin } from '../server.ts';
import { CatalogFake, FilesFake, MemoryState, hash } from './fakes.ts';

async function setup(count = 2) {
  const host = createFakePluginHost({ pluginId: 'obsidian' });
  const catalog = new CatalogFake(), files = new FilesFake(), repository = new MemoryState();
  const pending = Array.from({ length: count }, (_, i) => ({ operationId: randomUUID(), vaultId: 'one', path: `${'segment/'.repeat(4)}${'a'.repeat(210)}/${'b'.repeat(210)}/${'c'.repeat(210)}/${'d'.repeat(210)}/${i}.md`, at: new Date().toISOString() }));
  repository.value = { revision: 1, vaultIds: ['one'], names: { one: 'Launch' }, pending };
  await plugin(host.bb, { catalog, files, repository });
  const run = async (input: unknown) => {
    const result = await host.harness.behavior.callAgentTool('obsidian_status', input);
    assert.ok(typeof result !== 'string'); assert.equal(result.isError, undefined);
    return JSON.parse((result.content[0] as any).text);
  };
  return { ...host, files, repository, pending, run };
}

test('all nine published tool parameter schemas have an object root for provider function calls', async () => {
  const f = await setup();
  try {
    const config = await f.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.equal(config.tools.length, 9);
    for (const tool of config.tools) assert.equal((tool.inputSchema as { type?: unknown }).type, 'object', tool.name);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('exact-path receipt inspection does not include or settle unrelated pending operations', async () => {
  const f = await setup();
  try {
    for (const pending of f.pending) f.files.saved.push({ kind: 'save', operationId: pending.operationId, mirrorId: pending.vaultId, path: pending.path, at: pending.at, outcome: 'saved_locally_pending_sync', hash: hash('Saved'), previousHash: null });
    const result = await f.run({ vaultId: 'one', path: f.pending[0].path });
    assert.deepEqual(result.receipts.map((receipt: any) => receipt.path), [f.pending[0].path]);
    assert.deepEqual(f.repository.value.pending?.map(p => p.operationId), [f.pending[1].operationId]);
  } finally { await f.harness.lifecycle.dispose(); }
});

test('exact operation and bounded status remain inspectable with 100 long-path uncertain operations', async () => {
  const f = await setup(100);
  try {
    const exact = await f.run({ vaultId: 'one', operationId: f.pending[0].operationId, limit: 1 });
    assert.deepEqual(exact.uncertainOperations.map((p: any) => p.operationId), [f.pending[0].operationId]);
    const bounded = await f.run({ limit: 1 });
    assert.equal(bounded.uncertainOperations.length, 1);
    assert.equal(bounded.uncertainOperationCount, 100);
    assert.equal(bounded.uncertainOperationsIncomplete, true);
    assert.equal(f.repository.value.pending?.length, 100);
  } finally { await f.harness.lifecycle.dispose(); }
});
