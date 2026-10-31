import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { validateFormula, formulaCalculation } from '../core/sheets-formula.mjs';
import { createSheetsEditService, editRangeSchema } from '../core/sheets-edit.mjs';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createSheetsEditAdapter } from '../adapters/sheets-edit.mjs';
import { registerSheetsEditTools } from '../sheets-edit-tools.ts';
const tabs = [{ sheetId: 1, title: 'Budget', gridProperties: { rowCount: 1000, columnCount: 100 } }, { sheetId: 2, title: "Forecast's year", gridProperties: { rowCount: 1000, columnCount: 100 } }];
const context = { tabs, sheetId: 1 };
for (const text of ['=1+2*3', '=SUM($A$1:B20)', '=IF(A1>0,ROUND(A1*10%,2),0)', "='Forecast''s year'!$B2+A1", '=NPV(0.1,A1:A10)', '=PMT(0.05/12,60,-10000)', '=SUMIFS(A1:A10,B1:B10,">0")', '=COUNTIFS(A1:A10,">=10",B1:B10,"yes")', '=XIRR(A1:A10,B1:B10,0.1)', '=IFERROR(1/0,"Check figures")', '=TRUE()', '=NA()', '=AND(TRUE,A1<>0)', '=DATE(2027,1,1)', '="=IMPORTDATA(""https://example.invalid"")"', '=INDEX(A1:B2,1,2)', '=VLOOKUP(A1,A2:B10,2,FALSE)', '=SUMPRODUCT(A1:A10,B1:B10)']) test(`parser accepts explicit financial grammar: ${text}`, () => { assert.ok(validateFormula(text, context)); });
for (const text of ['=IMPORTDATA("https://example.invalid")', '=IMPORTRANGE("id","A1")', '=IMAGE("https://example.invalid")', '=HYPERLINK("https://example.invalid")', '=WEBSERVICE(A1)', '=INDIRECT(A1)', '=OFFSET(A1,1,1)', '=CUSTOM(A1)', '=LAMBDA(x,x)(1)', '=LET(x,1,x)', '=NamedRange+1', '=SUM(A:A)', '=SUM(1:10)', '=SUM(A1:A1001)', '=ZZZ1', '=SUM(B2:A1)', '=SUM(A1:Sheet2!A10)', '=Sheet3!A1', '=[external.xlsx]Sheet1!A1', '=SUM({1,2})', '=SUM(A1#)', '=@SUM(A1)', '=A1:A2', '=INDEX(A1:B2,0,1)', '=INDEX(A1:B2,1)', '=INDEX(A1:B2,A3,1)', '=IF(A1:A2,1,0)', '=A1:A2+1', '=SUMPRODUCT(A1:A10*B1:B10)', '=VLOOKUP(A1,A2:B10,A3)', '=SUM(1;2)', '=SUM(,A1)', '=SUM(A1,)', '=SUM()', '=IF(1)', '=constructor(1)', '=__proto__(1)', '=SUM(A1)GARBAGE', '=A1:A2:A3', '=SUM(A1)\n=IMAGE(A1)', "='SUM'(A1)", '=ROUND(1,2,3)', '=COUNTIFS(A1:A2,1,A3)', '=SUMIFS(A1:A2,A3:A4)', '=\u00a0SUM(1)', '=SUM(\u0000)', '=1e999', '=' + '('.repeat(33) + '1' + ')'.repeat(33), '=SUM(' + Array(60).fill('1').join(',') + ')', '=1'.padEnd(2001, ' ')]) test(`parser fails closed: ${JSON.stringify(text).slice(0, 100)}`, () => { assert.throws(() => validateFormula(text, context), e => e.sheetsEditCode === 'formula_unsupported'); });
test('grammar bounds tokens, range area, sheet scope and malformed Unicode without evaluating anything', () => {
  assert.throws(() => validateFormula('=' + Array(260).fill('1').join('+'), context));
  assert.ok(validateFormula('=SUM(A1:CV1000)', context));
  assert.throws(() => validateFormula('=SUM(A1:CV1001)', { ...context, tabs: [{ ...tabs[0], gridProperties: { rowCount: 2000, columnCount: 100 } }] }));
  assert.throws(() => validateFormula('=SUM(A1)', { tabs, sheetId: 999 }));
  assert.throws(() => validateFormula('="\ud800"', context));
  const r = validateFormula("=SUM('Forecast''s year'!A1:B2)", context); assert.equal(r.references[0].sheetId, 2);
});
test('review regression: control-text JSON expansion stays bounded independently of raw text units', () => {
  const rowData = [{ values: Array.from({length: 20}, () => ({userEnteredValue: {formulaValue: '=A1'}, effectiveValue: {stringValue: '\u0001'.repeat(200)}})) }];
  const result = formulaCalculation({sheets: [{data: [{rowData}]}]}, {rowCount: 1, columnCount: 20, startRow: 0, startColumn: 0});
  assert.equal(result.length, 20); assert.ok(JSON.stringify(result).length <= 12000); assert.ok(result.some(c => c.calculation.truncated));
});
const account = 'owner@example.invalid', target = { account, spreadsheetId: 'book', sheetId: 1, startRow: 2, startColumn: 2, rowCount: 1, columnCount: 3 };
async function setup(options = {}) {
  const h = createFakePluginHost({ pluginId: 'google-drive' });
  const store = createBbStore(h.bb.storage.database(), (db, statements) => h.bb.storage.migrate(db, statements));
  await store.addAccount({ subject: 'owner', email: account, refreshToken: 'PRIVATE_TOKEN' });
  const meta = { spreadsheetId: 'book', properties: { title: 'PRIVATE_TITLE' }, sheets: tabs.map(properties => ({ properties: structuredClone(properties) })) };
  const cells = [[{ userEnteredValue: { formulaValue: '=IMPORTDATA("PRIVATE_OLD")' }, effectiveValue: { numberValue: 5 }, note: 'PRIVATE_NOTE', userEnteredFormat: { numberFormat: { type: 'CURRENCY' }, textFormat: { bold: true } } }, {}, {}]];
  let writes = 0, reads = 0, approvals = 0, blockedRead = false; const diagnostics = [], requests = [];
  const sheets = createSheetsEditAdapter({ verifiedAccess: async () => 'PRIVATE_TOKEN', fetchImpl: async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: 'https://www.googleapis.com/auth/' + (options.scope || 'drive.file') });
    if (u.pathname.endsWith(':batchUpdate')) {
      writes++; const body = JSON.parse(init.body); requests.push(body);
      const q = body.requests[0].updateCells; assert.equal(q.fields, 'userEnteredValue');
      q.rows.forEach((row, y) => row.values.forEach((value, x) => { delete cells[y][x].userEnteredValue; delete cells[y][x].effectiveValue; Object.assign(cells[y][x], value); if (value.userEnteredValue?.formulaValue) cells[y][x].effectiveValue = options.pending ? {} : options.error ? { errorValue: { type: 'DIVIDE_BY_ZERO', message: 'PRIVATE_PROVIDER' } } : { numberValue: 99 }; }));
      for (const { updateCells: f } of body.requests.slice(1)) { assert.equal(f.fields, 'userEnteredFormat.numberFormat'); const cell = cells[f.start.rowIndex - 2][f.start.columnIndex - 2]; cell.userEnteredFormat = { ...cell.userEnteredFormat, numberFormat: f.rows[0].values[0].userEnteredFormat.numberFormat }; }
      if (options.lost) throw new Error('PRIVATE_REPLY');
      if (options.badFormula) cells[0][0].userEnteredValue.formulaValue = '=Different';
      if (options.failedReadback) blockedRead = true;
      return Response.json({ spreadsheetId: 'book', replies: body.requests.map(() => ({})) });
    }
    reads++; if (blockedRead) throw new Error('PRIVATE_READ');
    return Response.json(u.searchParams.has('ranges') ? { spreadsheetId: 'book', sheets: [{ properties: { sheetId: 1 }, data: [{ startRow: 2, startColumn: 2, rowData: cells.map(values => ({ values })) }] }] } : meta);
  } });
  const drive = { async getFile() { return { id: 'book', trashed: false, mimeType: 'application/vnd.google-apps.spreadsheet' }; } };
  const ports = { accounts: store, operations: store.sheetsEdits, drive, sheets, diagnose: stage => diagnostics.push(stage), approve: async proposal => { approvals++; options.onApproval?.(meta, cells, proposal); return { outcome: 'submitted', value: { approved: options.decline !== true } }; } };
  const service = createSheetsEditService(ports);
  registerSheetsEditTools(h.bb, store, store.sheetsEdits, drive, sheets);
  return { ...h, store, service, ports, meta, cells, diagnostics, requests, get writes() { return writes; }, get reads() { return reads; }, get approvals() { return approvals; }, recover: () => { blockedRead = false; }, async input(values = [[{ formula: '=SUM(A1:A2)' }, '=SUM(A1:A2)', { cad: 25 }]]) { const inspect = await service.inspect({ ...target, mode: 'formulas' }); return { account, spreadsheetId: 'book', sheetId: 1, startRow: 2, startColumn: 2, mode: 'formulas', operationId: randomUUID(), expectedFingerprint: inspect.fingerprint, values }; }, close: () => h.harness.lifecycle.dispose() };
}
test('opt-in formula inspection reads existing formulas as data; default literal inspection remains closed', async () => {
  const h = await setup(); try {
    await assert.rejects(h.service.inspect(target), e => e.sheetsEditCode === 'unsupported');
    const r = await h.service.inspect({ ...target, mode: 'formulas' }); assert.equal(r.rows[0][0].userEnteredValue.formulaValue, '=IMPORTDATA("PRIVATE_OLD")'); assert.equal(r.calculation[0].calculation.number, 5); assert.equal(h.writes, 0);
  } finally { await h.close(); }
});
for (const options of [{}, { error: true }, { pending: true }]) test(`typed formula write preserves literals/notes/formats and separates calculation ${JSON.stringify(options)}`, async () => {
  const h = await setup(options); try {
    const a = await h.input(), formats = structuredClone(h.cells[0][0].userEnteredFormat);
    const p = await h.service.update(a); assert.equal(p.outcome, 'preview'); assert.equal(p.proposal.mode, 'formulas'); assert.equal(h.writes, 0);
    const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); assert.equal(r.formulaReadbackMatches, true); assert.equal(h.writes, 1);
    assert.deepEqual(h.cells[0][0].userEnteredFormat, formats); assert.equal(h.cells[0][0].note, 'PRIVATE_NOTE'); assert.equal(h.cells[0][0].userEnteredValue.formulaValue, '=SUM(A1:A2)'); assert.equal(h.cells[0][1].userEnteredValue.stringValue, '=SUM(A1:A2)'); assert.equal(h.cells[0][2].userEnteredValue.numberValue, 25);
    if (options.error) assert.equal(r.calculation[0].calculation.errorType, 'DIVIDE_BY_ZERO'); else if (options.pending) assert.equal(r.calculation[0].calculation.pending, true); else assert.equal(r.calculation[0].calculation.number, 99);
    const readCount = h.reads; await h.service.update({ ...a, preview: false }); assert.equal(h.writes, 1); assert.equal(h.reads, readCount);
    assert.doesNotMatch(JSON.stringify(await h.store.sheetsEdits.get(a.operationId)), /PRIVATE|SUM|formulaValue/);
    assert.equal((await h.service.status({ account, operationId: a.operationId })).outcome, 'verified');
  } finally { await h.close(); }
});
test('default mode forbids formula objects; invalid grammar and wrong fingerprints cannot reserve or write', async () => {
  const h = await setup(); try {
    const a = await h.input(); assert.equal(editRangeSchema.safeParse({ ...a, mode: 'literal' }).success, false);
    for (const patch of [{ values: [[{ formula: '=IMPORTDATA("PRIVATE_URL")' }, null, null]] }, { values: [[{ formula: '=Custom(A1)' }, null, null]] }, { expectedFingerprint: '0'.repeat(64) }]) {
      await assert.rejects(h.service.update({ ...a, ...patch })); assert.equal(await h.store.sheetsEdits.get(a.operationId), null);
    }
    assert.equal(h.writes, 0); assert.equal(h.approvals, 0);
  } finally { await h.close(); }
});
test('mixed formula/date/CAD only formats explicitly requested typed cells', async () => {
  const h = await setup(); try {
    const a = { ...await h.input([[{ formula: '=1' }, { date: '2027-01-01' }, { cad: 20 }]]), formatTypedValues: true };
    await h.service.update(a); assert.equal((await h.service.update({ ...a, preview: false })).outcome, 'verified');
    assert.equal(h.requests[0].requests.length, 3); assert.equal(h.cells[0][0].userEnteredFormat.numberFormat.type, 'CURRENCY'); assert.equal(h.cells[0][1].userEnteredFormat.numberFormat.type, 'DATE');
  } finally { await h.close(); }
});
for (const options of [{ lost: true }, { badFormula: true }, { failedReadback: true }, { decline: true }, { scope: 'drive.readonly' }, { onApproval: meta => { meta.sheets[1].properties.title = 'Renamed'; } }]) test(`formula failure/recovery never replays ${JSON.stringify(options)}`, async () => {
  const h = await setup(options); try {
    const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.notEqual(r.outcome, 'verified');
    const writes = h.writes; h.recover(); const reopened = createSheetsEditService(h.ports); const s = await reopened.status({ account, operationId: a.operationId });
    if (options.lost) { assert.equal(s.outcome, 'observed_matching'); assert.equal(s.unresolvedLock, true); }
    if (options.failedReadback) assert.equal(s.outcome, 'verified');
    await reopened.update({ ...a, preview: false }); assert.equal(h.writes, writes); assert.doesNotMatch(JSON.stringify(h.diagnostics), /PRIVATE/);
  } finally { await h.close(); }
});
test('native approval shows explicit formula mode even with Docs optout; host capabilities and safe refusal diagnostics', async () => {
  const h = await setup(); try {
    const a = await h.input(); await h.harness.behavior.callAgentTool('gsheets_update_range', a);
    const done = h.harness.behavior.callAgentTool('gsheets_update_range', { ...a, preview: false });
    for (let i = 0; i < 100 && !h.harness.inspection.pendingInteractions.length; i++) await new Promise(r => setTimeout(r, 2));
    const f = h.harness.inspection.pendingInteractions[0]; assert.equal(f.rendererId, 'sheets-edit-approval'); assert.equal(f.payload.mode, 'formulas'); assert.equal(h.writes, 0);
    h.harness.behavior.submitInteraction(f.id, { approved: true }); assert.equal(JSON.parse((await done).content[0].text).outcome, 'verified');
    assert.equal((await h.harness.behavior.callRpc('sheetsFormulaCapabilities', null)).contract, 'sheets-financial-formulas-v1');
    const b = await h.input([[{ formula: '=PRIVATE_CUSTOM("PRIVATE_URL")' }, null, null]]), rejected = await h.harness.behavior.callAgentTool('gsheets_update_range', b);
    assert.equal(rejected.isError, true); const logs = JSON.stringify(h.harness.inspection.logEntries); assert.match(logs, /agent_tool gsheets_update_range/); assert.doesNotMatch(logs + JSON.stringify(rejected), /PRIVATE|owner@example|"book"/);
  } finally { await h.close(); }
});
