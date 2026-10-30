import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import plugin from '../dist/server.js';
import { createBbStore } from '../adapters/bb-store.mjs';
import { createGoogleAdapter } from '../adapters/google.mjs';
import { createSheetsService, cellData } from '../core/sheets.mjs';
const account = 'synthetic@example.test';
const input = () => ({ account, operationId: randomUUID(), title: 'Synthetic workbook', folderId: 'root', tabs: [
  { title: "Plan's A1", rows: [['Month', 'Activity', 'Enabled'], [{ date: '2026-11-01' }, '=IMPORTXML("https://example.invalid", "x")', true], [{ date: '2027-10-01' }, '+@literal', null]] },
  { title: 'Budget', rows: [['Month', 'Allowance'], ['November', { cad: 125.5 }], ['December', { cad: 1874.5 }]] },
] });
const parse = result => { assert.notEqual(result.isError, true, result.content[0].text); return JSON.parse(result.content[0].text); };
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'google-drive' });
  const original = globalThis.fetch; const calls = [];
  let created = false, populated = false, request, sheets = [{ properties: { sheetId: 0, title: 'Sheet1', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1000, columnCount: 26 } }, rows: [] }];
  let properties = { title: 'Synthetic workbook', locale: 'en_US', timeZone: 'Etc/UTC' };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ u, init });
    if (u.pathname.endsWith('/userinfo')) return Response.json({ sub: options.wrongIdentity ? 'wrong' : 'subject', email: account, email_verified: true });
    if (u.pathname.endsWith('/tokeninfo')) return Response.json({ scope: `https://www.googleapis.com/auth/${created && options.revoke ? 'drive.readonly' : options.scope || 'drive.file'}` });
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      request = JSON.parse(init.body);
      assert.equal(request.mimeType, 'application/vnd.google-apps.spreadsheet');
      assert.deepEqual(Object.keys(request).sort(), ['appProperties', 'mimeType', 'name', 'parents']);
      assert.deepEqual(Object.keys(request.appProperties), ['paSheetsCreation']);
      if (options.createReject) return Response.json({ private: 'SENTINEL-private-body' }, { status: options.createReject });
      created = true; options.onCreated?.();
      if (options.createFailure) throw Object.assign(new Error('SENTINEL-private-token'), { cause: 'SENTINEL-private-cause', code: 'SENTINEL-private-code' });
      if (options.createBadJson) return new Response('SENTINEL-malformed');
      return Response.json({ id: 'sheet-a' });
    }
    if (u.pathname === '/drive/v3/files') {
      assert.match(u.searchParams.get('q'), /paSheetsCreation/);
      return Response.json({ files: created && !options.missing ? [{ id: 'sheet-a' }, ...(options.ambiguous ? [{ id: 'sheet-b' }] : [])] : [], ...(options.paged ? { nextPageToken: 'SENTINEL-page' } : {}) });
    }
    if (u.pathname.endsWith('/permissions')) return Response.json({ permissions: [{ type: 'user', role: 'owner', emailAddress: account }], ...(options.permissionPaged ? { nextPageToken: 'SENTINEL-page' } : {}) });
    if (u.pathname.includes('/drive/v3/files/')) {
      const id = u.pathname.split('/').at(-1);
      if (id === 'sheet-a') return Response.json({ id, name: options.wrongTitle ? 'Changed' : 'Synthetic workbook', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, parents: [options.wrongParent ? 'other' : request?.parents[0] || 'root-a'] });
      if (u.searchParams.get('fields').includes('owners')) return Response.json({ id, shared: !!options.shared, driveId: options.sharedDrive ? 'drive-a' : undefined, owners: [{ me: !options.notOwned }] });
      return Response.json({ id: id === 'root' ? 'root-a' : id, trashed: false, mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: !options.notWritable } });
    }
    if (u.pathname.endsWith(':batchUpdate')) {
      assert.equal(u.hostname, 'sheets.googleapis.com');
      const { requests } = JSON.parse(init.body);
      assert.equal(requests.filter(r => r.deleteSheet).length, 1);
      if (options.populateReject) return Response.json({ private: 'SENTINEL-private-body' }, { status: options.populateReject });
      for (const r of requests) {
        assert.equal(Object.keys(r).length, 1);
        assert.ok(['updateSpreadsheetProperties', 'updateSheetProperties', 'addSheet', 'updateCells', 'repeatCell', 'updateDimensionProperties', 'deleteSheet'].includes(Object.keys(r)[0]));
        if (r.updateSpreadsheetProperties) assert.deepEqual(r.updateSpreadsheetProperties, { properties: { locale: 'en_CA', timeZone: 'Etc/UTC' }, fields: 'locale,timeZone' });
        if (r.updateSheetProperties) { assert.equal(r.updateSheetProperties.fields, 'title'); assert.equal(r.updateSheetProperties.properties.sheetId, 0); }
        if (r.addSheet) {
          const grid = r.addSheet.properties.gridProperties;
          assert.equal(grid.frozenRowCount, 1); assert.ok(grid.rowCount >= 2 && grid.rowCount <= 200); assert.ok(grid.columnCount >= 1 && grid.columnCount <= 26);
        }
        if (r.updateCells) {
          assert.equal(r.updateCells.fields, 'userEnteredValue,userEnteredFormat.numberFormat');
          assert.deepEqual(r.updateCells.start, { sheetId: r.updateCells.start.sheetId, rowIndex: 0, columnIndex: 0 });
        }
        if (r.repeatCell) {
          const id = r.repeatCell.range.sheetId;
          assert.ok(sheets.some(s => s.properties.sheetId === id));
          if (r.repeatCell.cell.userEnteredFormat.textFormat) assert.deepEqual(r.repeatCell, {
            range: { sheetId: id, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.93, blue: 0.96 } } },
            fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
          });
          else assert.deepEqual(r.repeatCell, { range: { sheetId: id }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' });
        }
        if (r.updateDimensionProperties) assert.deepEqual(r.updateDimensionProperties, {
          range: { sheetId: r.updateDimensionProperties.range.sheetId, dimension: 'COLUMNS' }, properties: { pixelSize: 180 }, fields: 'pixelSize',
        });
        if (r.deleteSheet) assert.deepEqual(r.deleteSheet, { sheetId: 0 });
        if (r.updateSpreadsheetProperties) properties = { ...properties, ...r.updateSpreadsheetProperties.properties };
        if (r.updateSheetProperties) sheets.find(s => s.properties.sheetId === r.updateSheetProperties.properties.sheetId).properties.title = r.updateSheetProperties.properties.title;
        if (r.addSheet) assert.ok(!sheets.some(s => s.properties.title.toLowerCase() === r.addSheet.properties.title.toLowerCase()), 'Google disallows duplicate sheet names');
        if (r.addSheet) sheets.push({ properties: { ...r.addSheet.properties, index: sheets.length }, rows: [] });
        if (r.updateCells) sheets.find(s => s.properties.sheetId === r.updateCells.start.sheetId).rows = r.updateCells.rows.map(r => r.values);
        if (r.deleteSheet) sheets = sheets.filter(s => s.properties.sheetId !== r.deleteSheet.sheetId);
      }
      sheets.forEach((s, i) => { s.properties.index = i; });
      if (options.wrongCell) sheets[0].rows[1][1] = { userEnteredValue: { stringValue: 'Changed' } };
      if (options.formulaInjected) sheets[0].rows[1][1] = { userEnteredValue: { formulaValue: '=1+1' } };
      if (options.extraTab) sheets.push({ properties: { sheetId: 99, title: 'Extra' }, rows: [] });
      if (options.wrongFormat) sheets[1].rows[1][1].userEnteredFormat.numberFormat.pattern = '$0';
      if (options.wrongOrder) sheets.reverse();
      populated = true;
      if (options.populateFailure) throw new Error('SENTINEL-populate');
      return Response.json({ spreadsheetId: 'sheet-a', replies: [] });
    }
    if (u.pathname === '/v4/spreadsheets/sheet-a') {
      if (options.apiDisabled || (populated && options.verifyUnavailable)) return Response.json({ private: 'SENTINEL-private-body' }, { status: 403 });
      const fields = u.searchParams.get('fields');
      assert.equal(fields, fields.includes('locale')
        ? 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))'
        : !u.searchParams.has('ranges') ? 'spreadsheetId,sheets(properties(sheetId),data(rowData(values(userEnteredValue))))'
        : 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat(numberFormat),effectiveValue,formattedValue))))');
      if (fields.includes('locale')) return Response.json({ spreadsheetId: 'sheet-a', properties, sheets: sheets.map(s => ({ properties: s.properties })) });
      if (!u.searchParams.has('ranges')) return Response.json({ spreadsheetId: 'sheet-a', sheets: [{ properties: sheets[0].properties, data: [{ rowData: options.notBlank ? [{ values: [{ userEnteredValue: { stringValue: 'Changed externally' } }] }] : [] }] }] });
      const range = u.searchParams.get('ranges');
      const s = sheets.find(s => range.startsWith(`'${s.properties.title.replaceAll("'", "''")}'!`));
      assert.ok(s, range);
      const match = range.match(/!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      const column = value => [...value].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
      const startRow = Number(match[2]) - 1, startColumn = column(match[1]);
      const rows = structuredClone(s.rows.slice(startRow, Number(match[4])).map(row => ({ values: row.slice(startColumn, column(match[3]) + 1) })));
      if (options.oversizeRead && populated) return new Response('x'.repeat(1048577));
      if (options.readFormula && rows[0]) rows[0].values[0] = { userEnteredValue: { formulaValue: '=SUM(A2:A3)' }, effectiveValue: { numberValue: 2000 } };
      return Response.json({ spreadsheetId: 'sheet-a', sheets: [{ properties: { sheetId: s.properties.sheetId }, data: [{ startRow, startColumn, rowData: rows }] }] });
    }
    throw new Error('SENTINEL-unexpected');
  };
  globalThis.fetch = fetchImpl;
  await plugin(host.bb);
  const store = createBbStore(host.bb.storage.database(), () => {});
  await store.addAccount({ subject: 'subject', email: account, accessToken: 'SENTINEL-access', refreshToken: 'SENTINEL-refresh', expiresAt: Date.now() + 600000 });
  const adapter = createGoogleAdapter({ store, getClient: async () => ({}), fetchImpl });
  const service = createSheetsService({ store, drive: adapter.drive, sheets: adapter.sheets });
  return { ...host, store, service, calls, writes: () => calls.filter(c => c.init.method === 'POST' && !c.u.pathname.endsWith('/tokeninfo')),
    close: async () => { globalThis.fetch = original; await host.harness.lifecycle.dispose(); } };
}
function safe(h) {
  const logs = JSON.stringify(h.harness.inspection.logEntries);
  assert.doesNotMatch(logs, /SENTINEL|synthetic@|Synthetic workbook|sheet-a|Plan's|IMPORTXML|subject/);
  return logs;
}
test('native populated multi-tab workbook: literal strings, civil dates, CAD, formatting, default root and exact readback', async () => {
  const h = await setup();
  try {
    const args = input(); delete args.folderId;
    const result = parse(await h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args));
    assert.equal(result.outcome, 'verified'); assert.equal(result.spreadsheetId, 'sheet-a'); assert.equal(result.url, 'https://docs.google.com/spreadsheets/d/sheet-a/edit');
    assert.equal(result.retrySafe, false); assert.equal(h.writes().length, 2);
    const body = JSON.parse(h.writes()[1].init.body);
    assert.doesNotMatch(JSON.stringify(body), /formulaValue|addProtectedRange|permission|notification/);
    assert.ok(body.requests.some(r => r.repeatCell?.cell.userEnteredFormat.wrapStrategy === 'WRAP'));
    assert.ok(body.requests.some(r => r.repeatCell?.cell.userEnteredFormat.textFormat?.bold === true));
    const cells = body.requests.filter(r => r.updateCells).map(r => r.updateCells.rows);
    assert.equal(cells[0][1].values[0].userEnteredValue.numberValue, 46327); // 2026-11-01
    assert.match(cells[0][1].values[1].userEnteredValue.stringValue, /^=IMPORTXML/);
    assert.equal(cells[1][1].values[1].userEnteredValue.numberValue, 125.5);
    assert.match(cells[1][1].values[1].userEnteredFormat.numberFormat.pattern, /CAD/);
    const read = parse(await h.harness.behavior.callAgentTool('gsheets_read', { account, spreadsheetId: 'sheet-a', sheetId: 2, rowCount: 3, columnCount: 2 }));
    assert.equal(read.complete, true); assert.equal(read.rows[2][1].userEnteredValue.numberValue, 1874.5); assert.equal(read.tabs.length, 2);
    assert.equal(parse(await h.harness.behavior.callAgentTool('gsheets_read', { account, spreadsheetId: 'sheet-a' })).range.sheetId, 1);
    assert.equal(parse(await h.harness.behavior.callAgentTool('gsheets_creation_status', { account, operationId: args.operationId })).outcome, 'verified');
    assert.equal(h.writes().length, 2); assert.equal(h.harness.inspection.pendingInteractions.length, 0);
    const receipt = JSON.stringify(await h.store.getCreation(args.operationId));
    assert.doesNotMatch(receipt, /Synthetic workbook|IMPORTXML|November|Plan's|SENTINEL/); safe(h);
  } finally { await h.close(); }
});
test('valid boundary grids, maximum text, default-name tab and one-row headers populate without name collisions', async () => {
  for (const tabs of [
    [{ title: 'Sheet1', rows: [['Header']] }, { title: '_PA_initial', rows: [['Other']] }],
    [{ title: 'Maximum cells', rows: Array.from({ length: 200 }, () => Array(25).fill(null)) }],
    [{ title: 'Maximum text', rows: Array.from({ length: 20 }, () => ['x'.repeat(2000)]) }],
    Array.from({ length: 4 }, (_, i) => ({ title: `Tab ${i}`, rows: [['Header'], [false]] })),
  ]) {
    const h = await setup();
    try { assert.equal((await h.service.create({ ...input(), tabs })).outcome, 'verified'); assert.equal(h.writes().length, 2); }
    finally { await h.close(); }
  }
});
test('validation rejects malformed/big content and explicit formula objects before provider access', async () => {
  const h = await setup();
  try {
    const cases = [[], Array.from({ length: 5 }, () => input().tabs[0]), [{ title: 'Bad/name', rows: [['a']] }], [{ title: 'X', rows: [[{ formula: '=1' }]] }],
      [{ title: 'X', rows: [[{ date: '2027-02-29' }]] }], [{ title: 'X', rows: [[{ cad: Infinity }]] }], [{ title: 'X', rows: [['x'.repeat(2001)]] }],
      [{ title: 'X', rows: Array.from({ length: 201 }, () => ['x']) }], [{ title: 'X', rows: [Array(27).fill('x')] }],
      [{ title: 'X', rows: Array.from({ length: 200 }, () => Array(26).fill('x')) }],
      [{ title: 'X', rows: Array.from({ length: 30 }, () => ['x'.repeat(2000)]) }], [{ title: 'X', rows: [['\ud800']] }],
      [{ title: 'X', rows: [['a']] }, { title: 'x', rows: [['b']] }]];
    for (const tabs of cases) await assert.rejects(() => h.service.create({ ...input(), tabs }));
    for (const cell of [{ formulaValue: '=SUM(A1:A3)' }, { date: '2026-01-01', cad: 1 }, '\u0000']) assert.throws(() => cellData(cell));
    assert.equal(h.calls.length, 0);
    await assert.rejects(() => h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', { ...input(), share: true }));
  } finally { await h.close(); }
});
test('scopes, identities and explicit supported destinations fail closed; never expand consent', async () => {
  for (const options of [{ scope: 'drive' }, { scope: 'drive.readonly' }, { scope: 'spreadsheets' }, { wrongIdentity: true }, { shared: true }, { sharedDrive: true }, { notOwned: true }, { notWritable: true }, { permissionPaged: true }]) {
    const h = await setup(options); const args = { ...input(), folderId: 'folder-a' };
    try {
      const result = await h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args);
      if (options.scope === 'drive') assert.equal(parse(result).outcome, 'verified');
      else { assert.equal(result.isError, true); assert.equal(h.writes().length, 0); assert.equal(await h.store.getCreation(args.operationId), null); }
      safe(h);
    } finally { await h.close(); }
  }
});
test('single-use receipts survive concurrent calls and reload; mismatching account/request/kind cannot reuse keys', async () => {
  const h = await setup(); const args = input(); let replacement;
  try {
    const result = await Promise.all([h.service.create(args), h.service.create(args)]);
    assert.ok(result.some(r => r.outcome === 'verified')); assert.equal(h.writes().length, 2);
    assert.equal((await h.service.create(args)).receiptOnly, true);
    await assert.rejects(() => h.service.create({ ...args, title: 'Changed' }), e => e.creationCode === 'operation_conflict');
    await h.store.addAccount({ subject: 'other', email: 'other@example.test', refreshToken: 'SENTINEL' });
    await assert.rejects(() => h.service.create({ ...args, account: 'other@example.test' }), e => e.creationCode === 'operation_conflict');
    await assert.rejects(() => h.service.inspect({ account: 'other@example.test', operationId: args.operationId }), e => e.creationCode === 'operation_unknown');
    const docs = await h.harness.behavior.callAgentTool('gdocs_create_document', { account, operationId: args.operationId, title: 'X', folderId: 'root', text: 'X' });
    assert.equal(docs.isError, true); assert.match(docs.content[0].text, /different account or request/);
    replacement = await h.harness.lifecycle.reload(plugin);
    assert.equal(parse(await replacement.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args)).receiptOnly, true);
    assert.equal(h.writes().length, 2); safe(h);
  } finally { await replacement?.harness.lifecycle.dispose(); await h.close(); }
});
test('uncertain creation lookup is read-only; missing, paged and ambiguous results never allow duplicate/population', async () => {
  for (const options of [{ createFailure: true }, { createBadJson: true }, { createFailure: true, missing: true }, { createFailure: true, paged: true }, { createFailure: true, ambiguous: true }]) {
    const h = await setup(options); const args = input();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args));
      assert.equal(result.outcome, 'uncertain'); assert.equal(h.writes().length, 1);
      const status = parse(await h.harness.behavior.callAgentTool('gsheets_creation_status', { account, operationId: args.operationId }));
      assert.equal(status.outcome, options.missing || options.paged || options.ambiguous ? 'uncertain' : 'incomplete');
      await h.service.create(args); assert.equal(h.writes().length, 1); safe(h);
    } finally { await h.close(); }
  }
});
test('population failure/disabled API/revoked consent preserve the known link; applied-but-unacknowledged writes reconcile without replay', async () => {
  for (const options of [{ populateFailure: true }, { populateReject: 403 }, { apiDisabled: true }, { revoke: true }, { notBlank: true }]) {
    const h = await setup(options); const args = input();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args));
      assert.equal(result.outcome, 'incomplete'); assert.equal(result.spreadsheetId, 'sheet-a');
      const count = h.writes().length;
      const status = parse(await h.harness.behavior.callAgentTool('gsheets_creation_status', { account, operationId: args.operationId }));
      assert.equal(status.outcome, options.populateFailure ? 'verified' : options.apiDisabled ? 'verification_unavailable' : 'incomplete');
      await h.service.create(args); assert.equal(h.writes().length, count); assert.match(safe(h), /sheets_creation_populate/);
    } finally { await h.close(); }
  }
});
test('known denials versus uncertain HTTP writes never retry; errors/logs redact private provider content', async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 503]) {
    const h = await setup({ createReject: status }); const args = input();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args));
      assert.equal(result.outcome, status < 405 ? 'not_created' : 'uncertain'); assert.equal(result.writeAttempted, true);
      await h.service.create(args); assert.equal(h.writes().length, 1); assert.match(safe(h), new RegExp(`sheets_creation_create.*http_status=${status}`));
    } finally { await h.close(); }
  }
});
test('changed data/tab order/format/title/destination, formula injection and unavailable readback never claim verified', async () => {
  for (const options of [{ wrongCell: true }, { wrongOrder: true }, { wrongFormat: true }, { extraTab: true }, { wrongTitle: true }, { wrongParent: true }, { formulaInjected: true }, { verifyUnavailable: true }, { oversizeRead: true }]) {
    const h = await setup(options); const args = input();
    try {
      const result = parse(await h.harness.behavior.callAgentTool('gsheets_create_spreadsheet', args));
      assert.equal(result.outcome, 'verification_unavailable'); assert.equal(result.spreadsheetId, 'sheet-a');
      await h.service.create(args); assert.equal(h.writes().length, 2); safe(h);
    } finally { await h.close(); }
  }
});
test('read bounds, nonzero offsets, literal read-only formulas, failed provider reads and no write on read', async () => {
  const h = await setup(); const args = input();
  try {
    await h.service.create(args);
    const result = parse(await h.harness.behavior.callAgentTool('gsheets_read', { account, spreadsheetId: 'sheet-a', sheetId: 2, startRow: 1, startColumn: 1, rowCount: 2 }));
    assert.equal(result.rows[0][0].userEnteredValue.numberValue, 125.5);
    for (const patch of [{ sheetId: 99 }, { rowCount: 1000, columnCount: 2 }, { startRow: 999 }, { account: 'unknown@example.test' }]) {
      assert.equal((await h.harness.behavior.callAgentTool('gsheets_read', { account, spreadsheetId: 'sheet-a', ...patch })).isError, true);
    }
    assert.equal(h.writes().length, 2); safe(h);
  } finally { await h.close(); }
  const f = await setup({ readFormula: true });
  try {
    await f.service.create(input());
    const read = parse(await f.harness.behavior.callAgentTool('gsheets_read', { account, spreadsheetId: 'sheet-a' }));
    assert.equal(read.rows[0][0].userEnteredValue.formulaValue, '=SUM(A2:A3)');
    assert.equal(read.rows[0][0].effectiveValue.numberValue, 2000); assert.equal(f.writes().length, 2); safe(f);
  } finally { await f.close(); }
});
test('durable reservation and known-ID persistence failures never issue unsafe writes; cancellation never resumes', async () => {
  for (const boundary of ['reserve', 'before-create', 'known-id', 'after-create']) {
    const controller = new AbortController(); const h = await setup(boundary === 'after-create' ? { onCreated: () => controller.abort() } : {}); const args = input();
    try {
      if (boundary === 'reserve') h.store.reserveCreation = async () => { throw new Error('SENTINEL-storage'); };
      const update = h.store.updateCreation;
      if (['before-create', 'known-id'].includes(boundary)) h.store.updateCreation = async op => {
        if (boundary === 'before-create' || op.spreadsheetId) throw new Error('SENTINEL-storage');
        return update(op);
      };
      if (boundary === 'reserve') await assert.rejects(() => h.service.create(args));
      else {
        const result = await h.service.create(args, controller.signal);
        assert.equal(result.outcome, boundary === 'before-create' ? 'not_created' : 'incomplete');
        await h.service.create(args);
      }
      assert.equal(h.writes().length, ['known-id', 'after-create'].includes(boundary) ? 1 : 0);
    } finally { await h.close(); }
  }
});
