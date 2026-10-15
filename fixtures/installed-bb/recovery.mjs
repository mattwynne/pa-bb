// Optional installed-client conflict proof on a generated alias; run before
// the disposable host shuts down. Never write directly to a native mirror.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const base = process.env.BB_FIXTURE_BASE, alias = process.env.BB_FIXTURE_ALIAS_ROOT;
assert.ok(base?.startsWith('http://127.0.0.1:') && alias?.startsWith('/tmp/'));
const name = 'Conflict-fixture.md', vaultId = 'one';
const rpc = async (method, input) => {
  const response = await fetch(`${base}/api/v1/plugins/obsidian/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000) });
  const body = await response.json(); assert.equal(body.ok, true); return body.result;
};
const invoke = async (tool, input) => { const result = await rpc('fixtureInvoke', { name: tool, input }); assert.equal(result.isError, false, `${tool}: ${result.text}`); return JSON.parse(result.text); };
const initial = await invoke('obsidian_create_note', { vaultId, path: name, text: '# Local candidate\n' });
assert.equal(initial.receipt.kind, 'save');
const receipt = await invoke('obsidian_status', { vaultId, path: name, operationId: initial.operationId });
assert.equal(receipt.receipts[0].operationId, initial.operationId);
await writeFile(join(alias, 'generated', name), '# Incoming candidate\n');
const until = performance.now() + 240000;
let inspection;
while (performance.now() < until) {
  const current = await invoke('obsidian_status', { vaultId, path: name });
  inspection = current.conflict?.inspection;
  if (inspection?.token) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(inspection?.token, 'no native-collision token across following scheduled run');
const incoming = await invoke('obsidian_read_note', { vaultId, path: name, selector: { version: 'incoming', token: inspection.token } });
assert.equal(incoming.text, '# Incoming candidate\n');
const resolved = await invoke('obsidian_edit_note', { vaultId, path: name, resolution: { token: inspection.token, expectedLogicalHash: inspection.logicalHash, expectedIncomingHash: inspection.incomingHash, choice: 'accept_incoming' } });
assert.equal(resolved.receipt.kind, 'resolution');
assert.equal(resolved.receipt.outcome, 'adopted_content');
const read = await invoke('obsidian_read_note', { vaultId, path: name });
assert.equal(read.text, '# Incoming candidate\n');
console.log(JSON.stringify({ client: true, originalReceipt: initial.operationId, resolutionReceipt: resolved.receipt.operationId, incomingHash: inspection.incomingHash, outcome: resolved.receipt.outcome }));
