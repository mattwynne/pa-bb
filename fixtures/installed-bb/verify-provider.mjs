// Bounded verifier for ONE private generated Pi JSON session and installed
// fixture bridge ledger. Never prints tool arguments, note bytes or auth data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [eventsPath, ledgerPath, installedPath] = process.argv.slice(2);
assert.ok(eventsPath && ledgerPath && installedPath);
const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const ledger = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const installed = JSON.parse(await readFile(installedPath, 'utf8'));
const names = ['obsidian_status', 'obsidian_search_notes', 'obsidian_read_note', 'obsidian_get_note_metadata', 'obsidian_resolve_link', 'obsidian_list_tasks', 'obsidian_create_note', 'obsidian_edit_note', 'obsidian_update_properties'];
assert.deepEqual(installed.tools.map(tool => tool.name), names);
const schemaSha256 = createHash('sha256').update(JSON.stringify(installed.tools.map(tool => tool.inputSchema))).digest('hex');
assert.deepEqual(ledger[0], { catalog: 9, schemaSha256 });
const calls = [], started = new Map(), counts = {};
let model = null, provider = null;
for (const event of lines) {
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    model ??= event.message.model; provider ??= event.message.provider;
  }
  if (event.type === 'tool_execution_start') {
    assert.ok(names.includes(event.toolName), 'non-fixture tool called');
    started.set(event.toolCallId, event);
  }
  if (event.type === 'tool_execution_end') {
    const start = started.get(event.toolCallId); assert.ok(start, 'missing tool start');
    assert.equal(event.isError, false, `tool error: ${event.toolName}`);
    const text = event.result?.content?.find(item => item.type === 'text')?.text;
    const value = JSON.parse(text);
    calls.push({ name: event.toolName, input: start.args, value });
    counts[event.toolName] = (counts[event.toolName] ?? 0) + 1;
    started.delete(event.toolCallId);
  }
}
assert.equal(started.size, 0); assert.ok(model && provider);
assert.ok(names.every(name => counts[name] > 0), 'all nine original handlers must be model-selected');
assert.equal(ledger.length - 1, calls.length, 'every model-selected call must reach the original handler');
const forwarded = {};
for (const item of ledger.slice(1)) {
  assert.equal(item.handlerResult, 'ok'); assert.ok(names.includes(item.name));
  forwarded[item.name] = (forwarded[item.name] ?? 0) + 1;
}
assert.deepEqual(forwarded, counts);
const path = 'Provider-Probe.md', vaultId = 'one';
const relevant = calls.filter(call => call.input?.vaultId === vaultId && call.input?.path === path);
const create = relevant.find(call => call.name === 'obsidian_create_note');
assert.equal(create?.value?.receipt?.outcome, 'saved_locally_pending_sync');
for (const name of ['obsidian_edit_note', 'obsidian_update_properties']) {
  const index = relevant.findIndex(call => call.name === name);
  assert.ok(index >= 0);
  const mutation = relevant[index], prior = relevant.slice(0, index).filter(call => call.name === 'obsidian_read_note').at(-1);
  assert.equal(prior?.value?.complete, true, `${name} requires a complete earlier read`);
  assert.equal(mutation.input.expectedHash, prior.value.hash, `${name} must use read hash`);
  assert.equal(mutation.value.receipt?.outcome, 'saved_locally_pending_sync');
  const following = relevant.slice(index + 1).find(call => call.name === 'obsidian_read_note');
  assert.equal(following?.value?.complete, true, `${name} needs local read-after-save`);
  assert.equal(following.value.hash, mutation.value.receipt.hash);
}
assert.ok(relevant.filter(call => call.name === 'obsidian_read_note').at(-1).value.text.includes('Provider edit verified.'));
assert.ok(lines.some(event => event.type === 'agent_end'), 'provider conversation must finish');
console.log(JSON.stringify({ provider, model, originalToolCounts: counts, originalSchemaSha256: schemaSha256, completeReadCas: true, localReadAfterSave: true, bridge: 'Pi model-selected -> client-only fixtureInvoke -> original BB-registered handlers', nativeOrDeviceDelivery: false }, null, 2));
