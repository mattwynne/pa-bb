import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createSheetsEditService, editRequest, editRangeSchema } from '../core/sheets-edit.mjs';
import { createSheetsEditStore, SHEETS_EDIT_MIGRATION } from '../adapters/sheets-edit-store.mjs';
import { createSheetsEditAdapter } from '../adapters/sheets-edit.mjs';
import { hash } from '../core/native-create.mjs';
import { registerSheetsEditTools } from '../sheets-edit-tools.ts';
const account = 'synthetic@example.test', target = { account, spreadsheetId: 'sheet-a', sheetId: 7, startRow: 2, startColumn: 1, rowCount: 2, columnCount: 2 };
const seed = () => ({ spreadsheetId: 'sheet-a', properties: { title: 'Private synthetic workbook' }, sheets: [{ properties: { sheetId: 7, title: "Plan's A1", index: 0, sheetType: 'GRID', gridProperties: { rowCount: 20, columnCount: 10 } } }, { properties: { sheetId: 8, title: 'Other', index: 1, sheetType: 'GRID', gridProperties: { rowCount: 30, columnCount: 12 } } }] });
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'sheets-edit-test', settings: { requireDocsApproval: false } });
  const db = host.bb.storage.database(); db.exec(SHEETS_EDIT_MIGRATION);
  const operations = createSheetsEditStore(db), record = { subject: 'subject-a', email: account };
  const accounts = { byEmail: async email => email === account ? record : email === 'other@example.test' ? { subject: 'other', email } : null };
  let meta = seed(), cells = [[{ userEnteredValue: { stringValue: 'Before' }, userEnteredFormat: { textFormat: { bold: true }, numberFormat: { type: 'TEXT' } }, note: 'Preserved note' }, {}], [{ userEnteredValue: { numberValue: 25 }, userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"CAD "0.00' } } }, {}]];
  options.mutate?.(meta, cells);
  let writes = 0, approvals = 0, reads = 0, access = 0, failRead = false;
  const logs = [], calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ u, init });
    if (u.pathname === '/tokeninfo') return Response.json({ scope: `https://www.googleapis.com/auth/${options.scope || 'drive.file'}` });
    if (u.pathname.endsWith(':batchUpdate')) {
      writes++; options.inRace?.(meta, cells);
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ['requests']);
      const q = body.requests[0].updateCells;
      assert.equal(q.fields, 'userEnteredValue'); assert.deepEqual(q.start, { sheetId: 7, rowIndex: 2, columnIndex: 1 });
      if (options.status) return Response.json({ private: 'SENTINEL-body-token' }, { status: options.status });
      q.rows.forEach((row, y) => row.values.forEach((value, x) => { delete cells[y][x].userEnteredValue; Object.assign(cells[y][x], value); }));
      for (const request of body.requests.slice(1)) { const f = request.updateCells; assert.equal(f.fields, 'userEnteredFormat.numberFormat'); const cell = cells[f.start.rowIndex - 2][f.start.columnIndex - 1]; cell.userEnteredFormat = { ...cell.userEnteredFormat, numberFormat: f.rows[0].values[0].userEnteredFormat.numberFormat }; }
      options.afterWrite?.(meta, cells);
      if (options.lost) throw new Error('SENTINEL-provider-token');
      if (options.verifyFailure) failRead = true;
      if (options.onSubmitted) await options.onSubmitted(init.signal);
      return options.badResponse ? Response.json({ private: 'SENTINEL-body' }) : options.oversize ? new Response('x'.repeat(1048577)) : Response.json({ spreadsheetId: 'sheet-a', replies: options.reply ? [options.reply] : options.nullReply ? [null] : body.requests.map(() => ({})) });
    }
    if (u.pathname === '/v4/spreadsheets/sheet-a') {
      reads++; if (failRead || options.readFailure) throw Object.assign(new Error('SENTINEL-provider-private'), { cause: 'SENTINEL-token' });
      if (!u.searchParams.has('ranges')) return Response.json(meta);
      assert.equal(u.searchParams.get('ranges'), "'Plan''s A1'!B3:C4");
      assert.equal(u.searchParams.get('fields'), 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values)))');
      let rows = structuredClone(cells).map(values => ({ values }));
      if (options.sparse) { rows = rows.map(r => ({ values: r.values[1] && Object.keys(r.values[1]).length ? r.values : r.values.slice(0, 1) })); if (!Object.keys(cells[1][0]).length && !Object.keys(cells[1][1]).length) rows.pop(); }
      return Response.json({ spreadsheetId: 'sheet-a', sheets: [{ properties: { sheetId: 7 }, data: [{ startRow: 2, startColumn: 1, rowData: rows }] }] });
    }
    throw new Error('SENTINEL-unexpected');
  };
  const sheets = createSheetsEditAdapter({ fetchImpl, verifiedAccess: async () => { access++; if (options.revoke && access > 8) throw new Error('SENTINEL-revoked'); return 'SENTINEL-access'; } });
  const drive = { getFile: async () => ({ id: 'sheet-a', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false }) };
  const ports = { accounts, operations, drive, sheets, clock: options.clock,
    diagnose: (stage, error) => logs.push(stage), approve: async p => { approvals++; await options.approval?.(meta, cells, p); return options.decision || { outcome: 'submitted', value: { approved: true } }; } };
  registerSheetsEditTools(host.bb, accounts, operations, drive, sheets);
  const service = createSheetsEditService(ports);
  const args = async () => ({ ...target, rowCount: undefined, columnCount: undefined, operationId: randomUUID(), expectedFingerprint: (await service.inspect(target)).fingerprint, values: [['=literal', true], [75, null]] });
  const input = async () => { const a = await args(); delete a.rowCount; delete a.columnCount; return a; };
  return { ...host, service, ports, operations, accounts, calls, logs, input, get meta() { return meta; }, get cells() { return cells; }, get writes() { return writes; }, get reads() { return reads; }, get approvals() { return approvals; }, recoverReads: () => { failRead = false; }, close: () => host.harness.lifecycle.dispose() };
}
const parse = r => { assert.notEqual(r.isError, true, r.content[0].text); return JSON.parse(r.content[0].text); };
async function pending(h) { for (let i = 0; i < 100; i++) { if (h.harness.inspection.pendingInteractions.length) return h.harness.inspection.pendingInteractions[0]; await new Promise(r => setTimeout(r, 2)); } throw Error('No synthetic form'); }
function safe(h) { assert.doesNotMatch(JSON.stringify(h.harness.inspection.logEntries), /SENTINEL|synthetic@|subject-a|Private synthetic|sheet-a|Before|Preserved note/); }
test('literal rectangle previews then requires exact approval, preserves formatting/notes/tabs and reads back', async () => {
  const h = await setup();
  try {
    const input = await h.input(), meta = structuredClone(h.meta), formats = h.cells.map(r => r.map(c => c.userEnteredFormat));
    await assert.rejects(h.service.update({ ...input, preview: false }), e => e.sheetsEditCode === 'preview_required');
    const preview = await h.service.update(input); assert.equal(preview.outcome, 'preview'); assert.equal(h.writes, 0); assert.equal(h.approvals, 0);
    assert.match(preview.proposal.concurrency, /cannot prevent/); assert.equal(preview.proposal.before[0][0].stringValue, 'Before');
    const result = await h.service.update({ ...input, preview: false }); assert.equal(result.outcome, 'verified'); assert.equal(h.writes, 1); assert.equal(h.approvals, 1);
    assert.equal(h.cells[0][0].userEnteredValue.stringValue, '=literal'); assert.equal(h.cells[0][1].userEnteredValue.boolValue, true);
    assert.equal(h.cells[1][0].userEnteredValue.numberValue, 75); assert.equal(h.cells[1][1].userEnteredValue, undefined);
    assert.deepEqual(h.meta, meta); assert.deepEqual(h.cells.map(r => r.map(c => c.userEnteredFormat)), formats); assert.equal(h.cells[0][0].note, 'Preserved note');
    assert.equal((await h.service.status({ account, operationId: input.operationId })).outcome, 'verified');
    const repeat = await h.service.update({ ...input, preview: false }); assert.equal(repeat.receiptOnly, true); assert.equal(h.writes, 1);
    assert.doesNotMatch(JSON.stringify(await h.operations.get(input.operationId)), /Before|literal|Preserved note|Private synthetic|SENTINEL/);
    safe(h);
  } finally { await h.close(); }
});
test('sparse trailing blank cells/rows normalize without inventing cell content', async () => {
  const h = await setup({ sparse: true, mutate: (_m, cells) => { cells[1] = [{}, {}]; } });
  try { const read = await h.service.inspect(target); assert.deepEqual(read.rows[1], [{}, {}]); const a = await h.input(); await h.service.update(a); assert.equal((await h.service.update({ ...a, preview: false })).outcome, 'verified'); }
  finally { await h.close(); }
});
test('boundaries reject ragged/oversized matrices, formulas/objects, extra requests and control text before writes', async () => {
  const h = await setup();
  try {
    const a = await h.input();
    for (const values of [[], [[]], [[1], [1, 2]], [Array(21).fill(1)], Array.from({ length: 6 }, () => Array(20).fill(1)), [[{ formulaValue: '=1' }]], [[{ date: '2026-02-30' }]], [[{ cad: Infinity }]], [[Infinity]], [['\ud800']], [['\u0000']], [['a'.repeat(2001)]], Array.from({ length: 11 }, () => ['x'.repeat(2000)])]) await assert.rejects(h.service.update({ ...a, values }));
    await assert.rejects(h.service.update({ ...a, requests: [] }));
    for (const patch of [{ sheetId: 8 }, { startRow: 999 }, { rowCount: 101 }, { account: 'missing@example.test' }]) await assert.rejects(h.service.inspect({ ...target, ...patch }));
    for (const patch of [{ requests: [] }, { values: [[{ formulaValue: '=1' }]] }]) assert.throws(() => editRequest({ spreadsheetId: 'sheet-a', sheetId: 7, startRow: 2, startColumn: 1, values: [[1]], ...patch }));
    assert.equal(h.writes, 0);
  } finally { await h.close(); }
});
test('unsupported cell structures/formulas/computed output and tab structures reject without data loss', async () => {
  for (const mutate of [
    (_m,c) => c[0][0].userEnteredValue = { formulaValue: '=SUM(A1:A2)' }, (_m,c) => c[0][1].effectiveValue = { numberValue: 20 },
    ...['textFormatRuns', 'chipRuns', 'dataValidation', 'pivotTable', 'dataSourceTable', 'dataSourceFormula'].map(k => (_m,c) => c[0][0][k] = []),
    ...['merges','protectedRanges','tables'].map(k => (m,_c) => m.sheets[0][k] = [{}]),
  ]) { const h = await setup({ mutate }); try { await assert.rejects(h.service.inspect(target), e => e.sheetsEditCode === 'unsupported'); assert.equal(h.writes, 0); } finally { await h.close(); } }
});
test('declined/cancelled/invalid reviews, stale preflight, read-only scopes, expiry and abort never write', async () => {
  for (const options of [
    { decision: { outcome: 'submitted', value: { approved: false } } }, { decision: { outcome: 'cancelled', reason: 'timeout' } }, { decision: { outcome: 'submitted', value: { approved: 'true' } } },
    { scope: 'drive.readonly' }, { approval: (_m,c) => c[0][0].userEnteredValue.stringValue = 'Concurrent earlier edit' }, { approval: m => m.sheets[0].properties.title = 'Renamed' },
  ]) {
    const h = await setup(options);
    try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.notEqual(r.outcome, 'verified'); assert.equal(r.writeAttempted, false); assert.equal(h.writes, 0); safe(h); }
    finally { await h.close(); }
  }
  let now = 0; const h = await setup({ clock: () => now });
  try { const a = await h.input(); await h.service.update(a); now = 600001; assert.equal((await h.service.update({ ...a, preview: false })).outcome, 'expired'); const b = await h.input(); await h.service.update(b); const c = new AbortController(); c.abort(); assert.equal((await h.service.update({ ...b, preview: false }, c.signal)).outcome, 'cancelled'); assert.equal(h.writes, 0); }
  finally { await h.close(); }
});
test('a race AFTER final comparison is possible: matching readback does not establish no overwrite', async () => {
  const h = await setup({ inRace: (_m,c) => c[0][0].userEnteredValue.stringValue = 'Concurrent edit after comparison' });
  try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); assert.match(r.verification, /Concurrent overwrites cannot be excluded/); }
  finally { await h.close(); }
});
test('lost/malformed/oversized responses and transient HTTP writes never retry and retain spreadsheet lock', async () => {
  for (const options of [{ lost: true }, { badResponse: true }, { oversize: true }, { nullReply: true }, { reply: 'junk' }, { reply: { unexpected: true } }, ...[408,429,503].map(status => ({ status }))]) {
    const h = await setup(options);
    try {
      const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'uncertain'); assert.equal(h.writes, 1);
      const status = await h.service.status({ account, operationId: a.operationId }); assert.equal(status.unresolvedLock, true); assert.equal(status.providerAcknowledged, false);
      assert.equal(status.outcome, options.status ? 'uncertain' : 'observed_matching');
      await h.service.update({ ...a, preview: false }); assert.equal(h.writes, 1);
      const b = await h.input(); b.values[0][0] = 'Another edit'; await h.service.update(b); const busy = await h.service.update({ ...b, preview: false }); assert.equal(busy.outcome, 'busy'); assert.equal(busy.blockingOperationId, a.operationId); assert.equal(h.writes, 1);
      safe(h);
    } finally { await h.close(); }
  }
});
test('definitive rejections and acknowledged-but-unverified results stay distinct, with read-only recovery', async () => {
  for (const options of [...[400,401,403,404].map(status => ({ status })), { verifyFailure: true }, { afterWrite: (_m,c) => c[0][0].note = 'Unexpected note change' }]) {
    const h = await setup(options);
    try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, options.status ? 'rejected' : 'unverified'); assert.equal(h.writes, 1); h.recoverReads(); const s = await h.service.status({ account, operationId: a.operationId }); assert.equal(s.outcome, options.verifyFailure ? 'verified' : options.status ? 'rejected' : 'unverified'); assert.equal(h.writes, 1); safe(h); }
    finally { await h.close(); }
  }
});
test('SQLite claims serialize same and cross-account edits; persisted keys and unresolved locks survive a new service', async () => {
  const h = await setup({ lost: true });
  try {
    const a = await h.input(); await h.service.update(a); const results = await Promise.all([h.service.update({ ...a, preview: false }), h.service.update({ ...a, preview: false })]);
    assert.equal(h.writes, 1); assert.ok(results.some(r => r.outcome === 'uncertain'));
    const reloaded = createSheetsEditService(h.ports); await reloaded.update({ ...a, preview: false }); assert.equal(h.writes, 1);
    await assert.rejects(reloaded.update({ ...a, account: 'other@example.test' }), e => e.sheetsEditCode === 'conflict');
    await assert.rejects(reloaded.status({ account: 'other@example.test', operationId: a.operationId }), e => e.sheetsEditCode === 'unknown');
    const b = await h.input(); b.account = 'other@example.test'; b.values[0][0] = 'Other'; await reloaded.update(b); assert.equal((await reloaded.update({ ...b, preview: false })).outcome, 'busy'); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('durable persistence failures fail closed before write and keep later writes from replay', async () => {
  for (const at of ['reserve','claim','start','save']) {
    const h = await setup();
    try { const a = await h.input(); if (at !== 'reserve') await h.service.update(a); h.operations[at] = async () => { throw Error('SENTINEL-storage'); };
      if (['reserve','claim'].includes(at)) await assert.rejects(h.service.update({ ...a, preview: at === 'reserve' }));
      else assert.notEqual((await h.service.update({ ...a, preview: false })).outcome, 'verified');
      assert.equal(h.writes, at === 'save' ? 1 : 0); safe(h);
    } finally { await h.close(); }
  }
});
test('native fake-host approval ignores Docs optout; tools/schema/diagnostics and caller cancellation', async () => {
  const h = await setup();
  try {
    const b = h.harness.behavior, a = await h.input();
    assert.equal(parse(await b.callAgentTool('gsheets_inspect_for_edit', target)).complete, true);
    assert.equal(parse(await b.callAgentTool('gsheets_update_range', a)).outcome, 'preview');
    await assert.rejects(b.callAgentTool('gsheets_update_range', { ...a, requireApproval: false }));
    const done = b.callAgentTool('gsheets_update_range', { ...a, preview: false }); const form = await pending(h);
    assert.equal(form.rendererId, 'sheets-edit-approval'); assert.equal(h.writes, 0); assert.deepEqual(form.payload.values, a.values);
    b.submitInteraction(form.id, { approved: true }); assert.equal(parse(await done).outcome, 'verified'); assert.equal(h.writes, 1);
    assert.equal(parse(await b.callAgentTool('gsheets_edit_status', { account, operationId: a.operationId })).outcome, 'verified'); safe(h);
  } finally { await h.close(); }
  const h2 = await setup({ readFailure: true });
  try { const r = await h2.harness.behavior.callAgentTool('gsheets_inspect_for_edit', target); assert.equal(r.isError, true); assert.match(JSON.stringify(h2.harness.inspection.logEntries), /agent_tool gsheets_inspect_for_edit/); assert.doesNotMatch(JSON.stringify(r), /SENTINEL/); safe(h2); }
  finally { await h2.close(); }
});

test('Google signed-int32 tab IDs above ten million are accepted without confusing row limits', async () => {
  const h = await setup();
  try { h.meta.sheets[0].properties.sheetId = 1823456789;
    h.ports.sheets.grid = async () => ({ spreadsheetId: 'sheet-a', sheets: [{ properties: { sheetId: 1823456789 }, data: [{ startRow: 2, startColumn: 1, rowData: h.cells.map(values => ({ values })) }] }] });
    const r = await h.service.inspect({ ...target, sheetId: 1823456789 }); assert.equal(r.range.sheetId, 1823456789);
    const q = editRequest({ spreadsheetId: 'sheet-a', sheetId: 1823456789, startRow: 2, startColumn: 1, values: [[1]] }); assert.equal(q.updateCells.start.sheetId, 1823456789);
    for (const sheetId of [-1, 2147483648, 1.5]) assert.throws(() => editRequest({ spreadsheetId: 'sheet-a', sheetId, startRow: 2, startColumn: 1, values: [[1]] }));
  } finally { await h.close(); }
});

test('native read-only grant refusal returns evidence-based Settings guidance and persists only bounded reason', async () => {
  const h = await setup({ scope: 'drive.readonly' });
  try { const a = await h.input(), b = h.harness.behavior;
    parse(await b.callAgentTool('gsheets_update_range', a));
    const r = parse(await b.callAgentTool('gsheets_update_range', { ...a, preview: false }));
    assert.equal(r.outcome, 'not_submitted'); assert.equal(r.failureReason, 'scope_required'); assert.match(r.guidance, /Settings/); assert.equal(h.writes, 0);
    const again = parse(await b.callAgentTool('gsheets_update_range', { ...a, preview: false })); assert.equal(again.failureReason, 'scope_required'); assert.match(again.guidance, /owner-authorized Drive write grant/);
    assert.equal(h.harness.inspection.pendingInteractions.length, 0); safe(h); assert.doesNotMatch(JSON.stringify(r), /SENTINEL/);
  } finally { await h.close(); }
});

test('pending native review cancellation and disposal never submit and preserve durable terminal receipt', async () => {
  for (const mode of ['cancel','dispose','abort']) {
    const h = await setup(); const a = await h.input(), controller = new AbortController();
    try { const b = h.harness.behavior; parse(await b.callAgentTool('gsheets_update_range', a));
      const done = b.callAgentTool('gsheets_update_range', { ...a, preview: false }, { signal: controller.signal });
      const form = await pending(h);
      if (mode === 'dispose') await h.harness.lifecycle.dispose();
      else if (mode === 'cancel') b.cancelInteraction(form.id);
      else { controller.abort(); b.submitInteraction(form.id, { approved: true }); }
      const r = parse(await done); assert.equal(r.writeAttempted, false); assert.equal(h.writes, 0); assert.notEqual(r.outcome, 'verified');
      if (mode !== 'dispose') { await h.service.update({ ...a, preview: false }); assert.equal(h.writes, 0); }
    } finally { if (mode !== 'dispose') await h.close(); }
  }
});
test('post-submission abort is uncertain, never retried, and leaves a durable lock', async () => {
  const controller = new AbortController();
  const h = await setup({ onSubmitted: async signal => { controller.abort(); signal.throwIfAborted(); } });
  try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }, controller.signal);
    assert.equal(r.outcome, 'uncertain'); assert.equal(h.writes, 1);
    const status = await h.service.status({ account, operationId: a.operationId }); assert.equal(status.outcome, 'observed_matching'); assert.equal(status.unresolvedLock, true);
    await h.service.update({ ...a, preview: false }); assert.equal(h.writes, 1);
  } finally { await h.close(); }
});
test('malformed acknowledged responses log the failed boundary without provider content', async () => {
  const h = await setup({ badResponse: true });
  try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'uncertain'); assert.ok(h.logs.includes('sheets_edit_write_response')); safe(h); }
  finally { await h.close(); }
});

test('false conditional claims report durable terminal/in-flight state rather than inventing a blocker', async () => {
  for (const mode of ['completed-before-claim','start-refused','claim-refused']) {
    const h = await setup();
    try { const a = await h.input(); await h.service.update(a);
      if (mode === 'completed-before-claim') h.operations.claim = async id => { const op = await h.operations.get(id); await h.operations.save({ ...op, state: 'verified', writeAttempted: true, acknowledged: true }); return false; };
      else if (mode === 'start-refused') h.operations.start = async () => false;
      else h.operations.claim = async () => false;
      const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, mode === 'completed-before-claim' ? 'verified' : mode === 'start-refused' ? 'reviewing' : 'not_claimed'); assert.equal(h.writes, 0); assert.equal(r.blockingOperationId, undefined); if (mode === 'claim-refused') assert.match(r.guidance, /No durable claim was obtained/);
    } finally { await h.close(); }
  }
});

test('typed values preserve formats by default and apply only explicitly requested formats', async () => {
  for (const formatted of [false, true]) {
    let proposal; const h = await setup({ approval: (_m,_c,p) => { proposal = p; } });
    try { const a = await h.input(); a.values = [[{date:'2024-02-29'}, 'literal'], [{cad:-12.5}, null]];
      const before = structuredClone(h.cells); const preview = await h.service.update({ ...a, formatTypedValues: formatted });
      assert.equal(preview.proposal.formatTypedValues, formatted);
      await assert.rejects(h.service.update({ ...a, formatTypedValues: !formatted, preview: false }), e => e.sheetsEditCode === 'conflict');
      const result = await h.service.update({ ...a, formatTypedValues: formatted, preview: false }); assert.equal(result.outcome, 'verified');
      assert.equal(h.cells[0][0].userEnteredValue.numberValue, 45351); assert.equal(h.cells[1][0].userEnteredValue.numberValue, -12.5);
      assert.deepEqual(h.cells[0][0].userEnteredFormat.textFormat, before[0][0].userEnteredFormat.textFormat); assert.equal(h.cells[0][0].note, before[0][0].note);
      assert.deepEqual(h.cells[0][1].userEnteredFormat, before[0][1].userEnteredFormat);
      assert.equal(h.cells[0][0].userEnteredFormat.numberFormat.type, formatted ? 'DATE' : 'TEXT');
      assert.equal(h.cells[1][0].userEnteredFormat.numberFormat.pattern, formatted ? '\"CAD \"#,##0.00;[Red]-\"CAD \"#,##0.00' : before[1][0].userEnteredFormat.numberFormat.pattern);
      assert.equal(proposal.formatTypedValues, formatted); assert.equal(h.writes, 1);
    } finally { await h.close(); }
  }
});
test('typed format mismatch is unverified and lost response stays locked', async () => {
  for (const options of [{ afterWrite: (_m,c) => c[0][0].userEnteredFormat.numberFormat = {type:'TEXT'} }, {lost:true}]) {
    const h = await setup(options); try { const a = await h.input(); a.values[0][0] = {date:'1900-01-01'}; a.formatTypedValues = true;
      await h.service.update(a); const r = await h.service.update({...a,preview:false}); assert.equal(r.outcome, options.lost ? 'uncertain' : 'unverified');
      const status = await h.service.status({account,operationId:a.operationId}); if (options.lost) { assert.equal(status.outcome,'observed_matching'); assert.equal(status.unresolvedLock,true); }
      await h.service.update({...a,preview:false}); assert.equal(h.writes,1); safe(h);
    } finally { await h.close(); }
  }
});

test('pre-existing primitive proposal hash remains applicable with omitted or false option', async () => {
  const h = await setup(); try { const a = await h.input(); await h.service.update(a);
    const op = await h.operations.get(a.operationId);
    const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
    const rows = [[{userEnteredValue:{stringValue:'=literal'}},{userEnteredValue:{boolValue:true}}],[{userEnteredValue:{numberValue:75}},{}]];
    const legacy = hash(JSON.stringify(stable({subject:'subject-a',spreadsheetId:a.spreadsheetId,range:op.range,expectedFingerprint:a.expectedFingerprint,rows})));
    assert.equal(op.requestHash,legacy); assert.equal((await h.service.update({...a,formatTypedValues:false,preview:false})).outcome,'verified');
  } finally { await h.close(); }
});

test('oversized typed dates fail schema before account, provider, or approval work', async () => {
  const h = await setup();
  try {
    const a = await h.input();
    const calls = h.calls.length; let accountReads = 0;
    h.accounts.byEmail = async () => { accountReads++; throw Error('unexpected account lookup'); };
    const invalid = { ...a, values: [[{ date: '2026-01-01' + 'x'.repeat(50000) }]] };
    assert.equal(editRangeSchema.safeParse(invalid).success, false);
    await assert.rejects(h.service.update(invalid), e => e.sheetsEditCode === 'invalid');
    assert.equal(accountReads, 0); assert.equal(h.calls.length, calls);
    assert.equal(h.approvals, 0); assert.equal(h.writes, 0);
  } finally { await h.close(); }
});
