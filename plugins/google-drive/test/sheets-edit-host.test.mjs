// Full plugin wiring, old database upgrade and reload, with synthetic Google only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
const account = 'synthetic@example.test', subject = 'subject-sheet', sheetId = 1823456789;
const target = { account, spreadsheetId: 'sheet-a', sheetId, startRow: 2, startColumn: 1, rowCount: 1, columnCount: 2 };
const parse = r => { assert.notEqual(r.isError, true, r.content[0].text); return JSON.parse(r.content[0].text); };
async function pending(h) {
  for (let i = 0; i < 100; i++) {
    if (h.inspection.pendingInteractions.length) return h.inspection.pendingInteractions[0];
    await new Promise(r => setTimeout(r, 2));
  }
  throw Error('No synthetic spreadsheet approval');
}
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'google-drive', settings: { requireDocsApproval: false }, agentSkillIds: ['google-docs-editing', 'google-drive-sharing', 'google-sheets', 'google-sheets-editing'] });
  const calls = [], originalFetch = globalThis.fetch;
  const state = { scope: 'drive.file', identity: subject, writes: 0,
    cells: [{ userEnteredValue: { stringValue: 'Before' }, userEnteredFormat: { numberFormat: { type: 'TEXT' }, textFormat: { bold: true } }, note: 'Keep note' }, { userEnteredValue: { boolValue: false } }] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); calls.push({ path: u.pathname, init });
    if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: state.identity, email: account, email_verified: true });
    if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${state.scope}` });
    if (u.pathname === '/drive/v3/files/sheet-a') return Response.json({ id: 'sheet-a', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false });
    if (u.pathname === '/v4/spreadsheets/sheet-a') {
      if (options.failRead) throw Object.assign(new Error('SENTINEL-private-sheet-content'), { cause: 'SENTINEL-access-token' });
      if (u.searchParams.has('ranges')) {
        assert.equal(u.searchParams.get('ranges'), "'Plan''s A1'!B3:C3");
        assert.equal(u.searchParams.get('fields'), 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values)))');
        return Response.json({ spreadsheetId: 'sheet-a', sheets: [{ properties: { sheetId }, data: [{ startRow: 2, startColumn: 1, rowData: [{ values: state.cells }] }] }] });
      }
      return Response.json({ spreadsheetId: 'sheet-a', properties: { title: 'Private workbook' }, sheets: [
        { properties: { sheetId, title: "Plan's A1", index: 0, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 26 } } },
        { properties: { sheetId: 3, title: 'Unrelated tab', index: 1, sheetType: 'GRID', gridProperties: { rowCount: 50, columnCount: 10 } } },
      ] });
    }
    if (u.pathname === '/v4/spreadsheets/sheet-a:batchUpdate') {
      state.writes++;
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { requests: [{ updateCells: { start: { sheetId, rowIndex: 2, columnIndex: 1 }, rows: [{ values: [{ userEnteredValue: { stringValue: '=literal' } }, {}] }], fields: 'userEnteredValue' } }] });
      assert.doesNotMatch(JSON.stringify(body), /formulaValue|userEnteredFormat|delete|permission|notification/);
      delete state.cells[1].userEnteredValue;
      state.cells[0].userEnteredValue = { stringValue: '=literal' };
      if (options.lost) throw new Error('SENTINEL-private-provider-token');
      return Response.json({ spreadsheetId: 'sheet-a', replies: [{}] });
    }
    throw new Error('SENTINEL-unexpected-boundary');
  };
  let current = host;
  // Seed the real previous migration history (all current entries except the
  // new trailing Sheets edit schema), then install the real updated factory.
  const old = createBbStore(host.bb.storage.database(), (db, statements) => host.bb.storage.migrate(db, statements.slice(0, -1)));
  const accountRecord = { subject, email: account, refreshToken: 'SENTINEL-refresh', accessToken: 'SENTINEL-access', expiresAt: Date.now() + 600000 };
  await old.addAccount(accountRecord);
  const legacy = {
    docs: { operationId: randomUUID(), subject, kind: 'document', outcome: 'verified', writeAttempted: true, documentId: 'legacy-doc', contentHash: 'hash' },
    sheets: { operationId: randomUUID(), subject, kind: 'spreadsheet', outcome: 'verified', writeAttempted: true, spreadsheetId: 'legacy-sheet', contentHash: 'hash' },
    sharing: { operationId: randomUUID(), subject, fileId: 'legacy-file', state: 'verified', requestHash: 'hash' },
    formatting: { operationId: randomUUID(), subject, documentId: 'legacy-format', state: 'verified', requestHash: 'hash' },
  };
  await old.reserveCreation(legacy.docs); await old.reserveCreation(legacy.sheets); await old.reserveSharing(legacy.sharing); await old.reserveFormatting(legacy.formatting);
  assert.equal(host.bb.storage.database().prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='drive_sheets_edits'").get().n, 0);
  await plugin(host.bb);
  function store() { return createBbStore(current.bb.storage.database(), () => {}); }
  async function assertLegacy() {
    const s = store();
    assert.deepEqual(await s.getCreation(legacy.docs.operationId), legacy.docs); assert.deepEqual(await s.getCreation(legacy.sheets.operationId), legacy.sheets);
    assert.deepEqual(await s.getSharing(legacy.sharing.operationId), legacy.sharing); assert.deepEqual(await s.getFormatting(legacy.formatting.operationId), legacy.formatting);
    assert.deepEqual(await s.byEmail(account), accountRecord);
  }
  return { state, calls, store, assertLegacy, get harness() { return current.harness; },
    async input() {
      const inspected = parse(await current.harness.behavior.callAgentTool('gsheets_inspect_for_edit', target));
      return { account, spreadsheetId: 'sheet-a', sheetId, startRow: 2, startColumn: 1, expectedFingerprint: inspected.fingerprint, operationId: randomUUID(), values: [['=literal', null]] };
    },
    async reload() { current = await current.harness.lifecycle.reload(plugin); },
    async close() { globalThis.fetch = originalFetch; await current.harness.lifecycle.dispose(); },
  };
}
function safe(h, result) {
  assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries) + (result ? JSON.stringify(result) : ''), /SENTINEL|Private workbook|Keep note|synthetic@example|subject-sheet/);
}
test('updated plugin registers editing tools/skill, upgrades previous schema and preserves all existing receipts/accounts', async () => {
  const h = await setup();
  try {
    await h.assertLegacy();
    const configured = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext());
    for (const name of ['gsheets_inspect_for_edit','gsheets_update_range','gsheets_edit_status','gsheets_create_spreadsheet','gsheets_creation_status','gdocs_replace_text','gdocs_format_document']) assert.ok(configured.tools.some(t => t.name === name), name);
    assert.ok(configured.skills.includes('google-sheets-editing'));
    await h.reload(); await h.assertLegacy(); assert.equal(h.state.writes, 0); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
test('real registered tool path still asks for Sheets review when Docs approval is disabled, then verifies exact value-only batch', async () => {
  const h = await setup();
  try {
    const a = await h.input(), b = h.harness.behavior;
    parse(await b.callAgentTool('gsheets_update_range', a));
    const done = b.callAgentTool('gsheets_update_range', { ...a, preview: false });
    const card = await pending(h.harness);
    assert.equal(card.rendererId, 'sheets-edit-approval'); assert.deepEqual(card.payload.values, a.values); assert.equal(card.payload.account, account); assert.equal(h.state.writes, 0);
    b.submitInteraction(card.id, { approved: true }); const result = parse(await done);
    assert.equal(result.outcome, 'verified'); assert.equal(h.state.writes, 1); assert.match(result.verification, /Concurrent overwrites cannot be excluded/);
    assert.equal(h.state.cells[0].note, 'Keep note'); assert.equal(h.state.cells[0].userEnteredFormat.textFormat.bold, true);
    assert.equal(h.calls.filter(c => c.path.endsWith('/tokeninfo')).length, 2);
    assert.equal(parse(await b.callAgentTool('gsheets_edit_status', { account, operationId: a.operationId })).outcome, 'verified');
    await h.reload(); await h.assertLegacy();
    assert.equal(parse(await h.harness.behavior.callAgentTool('gsheets_update_range', { ...a, preview: false })).receiptOnly, true); assert.equal(h.state.writes, 1); safe(h);
  } finally { await h.close(); }
});
test('existing identity and scope checks fail closed before mutation even after the owner approved', async () => {
  for (const mode of ['scope','identity']) {
    const h = await setup();
    try {
      const a = await h.input(), b = h.harness.behavior; parse(await b.callAgentTool('gsheets_update_range', a));
      const done = b.callAgentTool('gsheets_update_range', { ...a, preview: false }); const card = await pending(h.harness);
      if (mode === 'scope') h.state.scope = 'drive.readonly'; else h.state.identity = 'SENTINEL-wrong-subject';
      b.submitInteraction(card.id, { approved: true }); const result = parse(await done);
      assert.equal(result.outcome, 'not_submitted'); assert.equal(result.writeAttempted, false); assert.equal(h.state.writes, 0);
      if (mode === 'scope') { assert.equal(result.failureReason, 'scope_required'); assert.match(result.guidance, /Settings/); }
      safe(h, result);
    } finally { await h.close(); }
  }
});
test('actual transport lost response retains a durable lock and stays observation-only across full plugin reload', async () => {
  const h = await setup({ lost: true });
  try {
    const a = await h.input(), b = h.harness.behavior; parse(await b.callAgentTool('gsheets_update_range', a));
    const done = b.callAgentTool('gsheets_update_range', { ...a, preview: false }); const card = await pending(h.harness); b.submitInteraction(card.id, { approved: true });
    assert.equal(parse(await done).outcome, 'uncertain'); assert.equal(h.state.writes, 1);
    await h.reload(); await h.assertLegacy();
    const status = parse(await h.harness.behavior.callAgentTool('gsheets_edit_status', { account, operationId: a.operationId }));
    assert.equal(status.outcome, 'observed_matching'); assert.equal(status.unresolvedLock, true); assert.equal(status.providerAcknowledged, false);
    const saved = await h.store().sheetsEdits.get(a.operationId); assert.equal(saved.state, 'uncertain');
    assert.doesNotMatch(JSON.stringify(saved), /literal|Keep note|Private workbook|SENTINEL/);
    const callsBefore = h.calls.length;
    assert.equal(parse(await h.harness.behavior.callAgentTool('gsheets_update_range', { ...a, preview: false })).receiptOnly, true); assert.equal(h.calls.length, callsBefore); assert.equal(h.state.writes, 1); safe(h, status);
  } finally { await h.close(); }
});
test('full plugin failed reads have bounded Sheets attribution without provider/account content', async () => {
  const h = await setup({ failRead: true });
  try {
    const result = await h.harness.behavior.callAgentTool('gsheets_inspect_for_edit', target);
    assert.equal(result.isError, true); assert.match(JSON.stringify(h.harness.inspection.logEntries), /agent_tool gsheets_inspect_for_edit/); assert.equal(h.state.writes, 0); safe(h, result);
  } finally { await h.close(); }
});
