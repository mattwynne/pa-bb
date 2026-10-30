import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { createBbStore } from '../adapters/bb-store.mjs';
import { registerFilingTools, FILING_TOOLS } from '../filing-tools.ts';
const account = 'owner@example.invalid';
const input = () => ({ account, operationId: randomUUID(), fileId: 'doc-id', expectedParentId: 'root-id', folderId: 'dest-id', preview: false });
const parse = r => { assert.notEqual(r.isError, true, r.content[0].text); return JSON.parse(r.content[0].text); };
async function setup(options = {}) {
  const h = createFakePluginHost({ pluginId: 'google-drive' }); let writes = 0, calls = 0, mismatch = false;
  const store = createBbStore(h.bb.storage.database(), (db, statements) => h.bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'subject', email: account, refreshToken: 'private-refresh' });
  const filing = {
    async propose(_record, kind) {
      calls++;
      if (options.fail) throw Object.assign(new Error('private-token-account-content'), { code: 'private-provider-code', cause: 'private-cause', status: 503 });
      return { resource: 'file:doc-id', fingerprint: mismatch ? 'different' : 'same', destinationId: 'dest-id', sourceParentId: 'root-id', fileId: 'doc-id', requiresApproval: options.shared !== false,
        preview: { kind, account, title: 'Synthetic Doc', from: 'My Drive', to: 'My Drive / Synthetic team', destinationId: 'dest-id', fileId: 'doc-id', sourceAudience: 'Owner only', destinationAudience: 'group: team@example.invalid — writer', audience: 'group: team@example.invalid — writer', impact: 'Inherited access changes; no permission edits.' } };
    },
    async prepare() { return async () => { writes++; if (options.lost) throw new Error('private-response-lost'); return { id: 'doc-id' }; }; },
    async verify() { return { matches: true, visibleAccess: [] }; },
    async findFolder() { return null; },
  };
  async function plugin(bb) { registerFilingTools(bb, createBbStore(bb.storage.database(), (db, statements) => bb.storage.migrate(db, statements)), { filing }); bb.agents.configure(() => ({ tools: FILING_TOOLS, skills: [] })); }
  await plugin(h.bb);
  return { ...h, store, writes: () => writes, calls: () => calls, stale: () => { mismatch = true; }, plugin };
}
async function pending(h) {
  for (let i = 0; i < 200; i++) { if (h.inspection.pendingInteractions.length) return h.inspection.pendingInteractions[0]; await new Promise(r => setTimeout(r, 1)); }
  throw new Error('No synthetic filing approval');
}
test('filing native registrations and exact shared-audience approval lifecycle', async () => {
  const h = await setup();
  try {
    const config = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    assert.deepEqual(config.tools.map(t => t.name).sort(), [...FILING_TOOLS].sort(), JSON.stringify(h.harness.inspection.logEntries));
    const a = input(), done = h.harness.behavior.callAgentTool('gdrive_move_file', a);
    const form = await pending(h.harness); assert.equal(form.rendererId, 'drive-filing-approval'); assert.equal(form.payload.operationId, a.operationId); assert.equal(h.writes(), 0);
    h.harness.behavior.submitInteraction(form.id, { approved: true });
    assert.equal(parse(await done).outcome, 'verified'); assert.equal(h.writes(), 1);
    assert.equal(parse(await h.harness.behavior.callAgentTool('gdrive_filing_status', { account, operationId: a.operationId })).outcome, 'verified'); assert.equal(h.writes(), 1);
  } finally { await h.harness.lifecycle.dispose(); }
});
test('owner-only exact request does not introduce a redundant card; preview never writes', async () => {
  const h = await setup({ shared: false });
  try { const a = input(); assert.equal(parse(await h.harness.behavior.callAgentTool('gdrive_move_file', { ...a, preview: true })).outcome, 'proposed'); assert.equal(h.writes(), 0); assert.equal(parse(await h.harness.behavior.callAgentTool('gdrive_move_file', a)).outcome, 'verified'); assert.equal(h.harness.inspection.pendingInteractions.length, 0); }
  finally { await h.harness.lifecycle.dispose(); }
});
test('decline, invalid input, abort and stale approved proposals cannot write', async () => {
  for (const mode of ['decline', 'invalid', 'abort', 'stale']) {
    const h = await setup(), controller = new AbortController();
    try {
      const done = h.harness.behavior.callAgentTool('gdrive_move_file', input(), { signal: controller.signal }); const form = await pending(h.harness);
      if (mode === 'abort') controller.abort();
      else { if (mode === 'stale') h.stale(); h.harness.behavior.submitInteraction(form.id, { approved: mode === 'invalid' ? 'yes' : mode !== 'decline' }); }
      assert.notEqual(parse(await done).outcome, 'verified'); assert.equal(h.writes(), 0);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});
test('unknown-account/provider boundary errors are safe and attributable, without account/provider content', async () => {
  for (const fail of [false, true]) {
    const h = await setup({ fail });
    try {
      const a = input(); if (!fail) a.account = 'unknown@example.invalid';
      const r = await h.harness.behavior.callAgentTool('gdrive_move_file', a); assert.equal(r.isError, true); assert.equal(h.writes(), 0);
      const logs = JSON.stringify(h.harness.inspection.logEntries); assert.match(logs, /filing_agent_tool/);
      assert.doesNotMatch(logs + JSON.stringify(r), /private-|owner@example|unknown@example|Synthetic Doc|doc-id|dest-id|team@example/);
    } finally { await h.harness.lifecycle.dispose(); }
  }
});
test('uncertain native move survives reload; status observes but does not replay or unlock', async () => {
  const h = await setup({ lost: true }); let next;
  try {
    const a = input(), done = h.harness.behavior.callAgentTool('gdrive_move_file', a), form = await pending(h.harness);
    h.harness.behavior.submitInteraction(form.id, { approved: true }); assert.equal(parse(await done).outcome, 'uncertain'); assert.equal(h.writes(), 1);
    next = await h.harness.lifecycle.reload(h.plugin);
    const observed = parse(await next.harness.behavior.callAgentTool('gdrive_filing_status', { account, operationId: a.operationId }));
    assert.equal(observed.outcome, 'observed_matching'); assert.equal(observed.unresolved, true); assert.equal(h.writes(), 1);
    assert.equal(parse(await next.harness.behavior.callAgentTool('gdrive_move_file', a)).outcome, 'uncertain'); assert.equal(h.writes(), 1);
    assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries), /private-response-lost/);
  } finally { await next?.harness.lifecycle.dispose(); await h.harness.lifecycle.dispose(); }
});
