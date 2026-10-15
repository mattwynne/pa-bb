// Fixture-only Pi extension. Load in a private generated cwd with built-ins,
// global extensions, skills and context files disabled. Never load for a real BB.
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const names = ['obsidian_status', 'obsidian_search_notes', 'obsidian_read_note', 'obsidian_get_note_metadata', 'obsidian_resolve_link', 'obsidian_list_tasks', 'obsidian_create_note', 'obsidian_edit_note', 'obsidian_update_properties'];
const base = process.env.BB_FIXTURE_BASE;
const ledger = process.env.BB_FIXTURE_PROVIDER_LEDGER;
assert.ok(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && ledger?.startsWith('/tmp/'));
async function rpc(method: string, input: unknown) {
  const response = await fetch(`${base}/api/v1/plugins/obsidian/rpc/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `fixture HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.ok, true, 'fixture RPC failed');
  return body.result;
}
export default async function bridge(pi: ExtensionAPI) {
  // These are the installed wrapper's captured ORIGINAL registration schemas,
  // not handwritten Pi versions. Its invoke route parses original Zod again.
  const catalog = JSON.parse(await rpc('fixtureCatalog', null));
  assert.deepEqual(catalog.map((tool: { name: string }) => tool.name), names);
  await appendFile(ledger!, JSON.stringify({ catalog: names.length, schemaSha256: createHash('sha256').update(JSON.stringify(catalog.map((tool: { inputSchema: unknown }) => tool.inputSchema))).digest('hex') }) + '\n', { mode: 0o600 });
  for (const tool of catalog) {
    assert.equal(tool.inputSchema.type, 'object');
    pi.registerTool({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_callId, params) {
        const result = await rpc('fixtureInvoke', { name: tool.name, input: params });
        await appendFile(ledger!, JSON.stringify({ name: tool.name, handlerResult: result.isError ? 'error' : 'ok' }) + '\n', { mode: 0o600 });
        // Returning the original handler text preserves complete-read hashes
        // and receipts for the model; a handler error must not become success.
        if (result.isError) throw new Error(result.text.slice(0, 1000));
        return { content: [{ type: 'text', text: result.text }], details: { originalHandler: true } };
      },
    });
  }
}
