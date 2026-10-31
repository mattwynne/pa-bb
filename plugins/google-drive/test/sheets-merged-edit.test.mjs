import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createSheetsEditService, sheetsEditMessage } from '../core/sheets-edit.mjs';
import { editableLayout, MAX_EDIT_MERGES } from '../core/sheets-edit-layout.mjs';
import { createSheetsEditAdapter } from '../adapters/sheets-edit.mjs';
import { createSheetsEditStore, SHEETS_EDIT_MIGRATION } from '../adapters/sheets-edit-store.mjs';
const account = 'owner@example.test', sheetId = 7;
const target = { account, spreadsheetId: 'merged-sheet', sheetId, startRow: 25, startColumn: 0, rowCount: 1, columnCount: 1 };
const merge = (r = 25, c = 0, rows = 1, cols = 15) => ({ sheetId, startRowIndex: r, endRowIndex: r + rows, startColumnIndex: c, endColumnIndex: c + cols });
const metadata = merges => ({ spreadsheetId: target.spreadsheetId, properties: { title: 'SENTINEL private title' }, sheets: [{ properties: { sheetId, title: "Review's summary", sheetType: 'GRID', gridProperties: { rowCount: 300, columnCount: 50 } }, merges }] });
const letters = s => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const key = (r, c) => `${r}:${c}`;
async function setup(options = {}) {
  const host = createFakePluginHost({ pluginId: 'merged-edit-fixture', settings: { requireDocsApproval: false } });
  const db = host.bb.storage.database(); db.exec(SHEETS_EDIT_MIGRATION);
  const state = { meta: metadata(options.merges ?? [merge(), merge(0, 0, 1, 3)]), grid: new Map(), writes: 0, approvals: 0, reads: [], requests: [], logs: [] };
  const selected = { ...target, ...options.target, ...(options.mode ? { mode: options.mode } : {}) };
  for (const m of state.meta.sheets[0].merges) for (let r = m.startRowIndex; r < m.endRowIndex; r++) for (let c = m.startColumnIndex; c < m.endColumnIndex; c++) {
    state.grid.set(key(r, c), { userEnteredFormat: { textFormat: { italic: c % 2 === 1 }, horizontalAlignment: 'LEFT' }, note: `SENTINEL retained note ${r}:${c}` });
  }
  const anchor = state.grid.get(key(selected.startRow, selected.startColumn)) || {};
  anchor.userEnteredValue = options.formula ? { formulaValue: '=1/0' } : { stringValue: 'Before merged text' };
  if (options.formula) anchor.effectiveValue = { errorValue: { type: 'DIVIDE_BY_ZERO', message: 'SENTINEL calculation detail' } };
  state.grid.set(key(selected.startRow, selected.startColumn), anchor);
  state.grid.set(key(299, 49), { userEnteredValue: { formulaValue: '=SUM(A1:A2)' } });
  options.mutate?.(state);
  const operations = createSheetsEditStore(db), record = { subject: 'synthetic-subject', email: account };
  const accounts = { byEmail: async email => email === account ? record : null };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/tokeninfo') return Response.json({ scope: `https://www.googleapis.com/auth/${options.scope || 'drive.file'}` });
    if (u.pathname.endsWith(':batchUpdate')) {
      state.writes++;
      const body = JSON.parse(init.body); state.requests.push(body);
      assert.equal(body.requests.length, 1); const q = body.requests[0].updateCells;
      assert.equal(q.fields, 'userEnteredValue'); assert.deepEqual(q.start, { sheetId, rowIndex: selected.startRow, columnIndex: selected.startColumn });
      assert.equal(q.rows.length, 1); assert.equal(q.rows[0].values.length, 1);
      assert.doesNotMatch(JSON.stringify(body), /unmerge|mergeCells|userEnteredFormat|note|permission/);
      const cell = state.grid.get(key(selected.startRow, selected.startColumn));
      delete cell.userEnteredValue; delete cell.effectiveValue; Object.assign(cell, q.rows[0].values[0]);
      options.afterWrite?.(state);
      if (options.lost) throw Error('SENTINEL lost provider reply');
      return Response.json({ spreadsheetId: selected.spreadsheetId, replies: options.badReply ? [null] : [{}] });
    }
    if (u.pathname === `/v4/spreadsheets/${selected.spreadsheetId}`) {
      if (!u.searchParams.has('ranges')) return Response.json(state.meta);
      const range = u.searchParams.get('ranges'); state.reads.push(range);
      const coords = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range); assert.ok(coords);
      const sr = Number(coords[2]) - 1, sc = letters(coords[1]), er = Number(coords[4]), ec = letters(coords[3]) + 1;
      const rowData = Array.from({ length: er - sr }, (_, y) => ({ values: Array.from({ length: ec - sc }, (_, x) => structuredClone(state.grid.get(key(sr + y, sc + x)) || {})) }));
      const data = { spreadsheetId: selected.spreadsheetId, sheets: [{ properties: { sheetId }, data: [{ startRow: sr, startColumn: sc, rowData }] }] };
      options.gridReply?.(data, state);
      return Response.json(data);
    }
    throw Error('SENTINEL unexpected request');
  };
  const sheets = createSheetsEditAdapter({ verifiedAccess: async () => 'SENTINEL access', fetchImpl });
  const drive = { getFile: async () => ({ id: selected.spreadsheetId, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false }) };
  const ports = { accounts, operations, drive, sheets, approve: async p => { state.approvals++; await options.approval?.(state, p); return options.decision || { outcome: 'submitted', value: { approved: true } }; }, diagnose: (stage, error) => state.logs.push({ stage, message: sheetsEditMessage(error) }) };
  const service = createSheetsEditService(ports);
  return { ...state, state, selected, operations, ports, service,
    input: async (values = [['After merged text']]) => {
      const inspected = await service.inspect(selected);
      const { rowCount, columnCount, ...where } = selected;
      return { ...where, expectedFingerprint: inspected.fingerprint, operationId: randomUUID(), values };
    }, close: () => host.harness.lifecycle.dispose() };
}
const safe = h => assert.doesNotMatch(JSON.stringify(h.state.logs), /SENTINEL|owner@example|synthetic-subject|merged-sheet/);
test('horizontal merged anchor inspects full footprint, reviews exact anchor, preserves all other cells and submits once', async () => {
  let proposal;
  const h = await setup({ approval: (_s, p) => { proposal = p; } });
  try {
    const originalMeta = structuredClone(h.state.meta), originalGrid = structuredClone(h.state.grid);
    const inspected = await h.service.inspect(h.selected);
    assert.equal(inspected.range.columnCount, 1); assert.equal(inspected.mergedRange.columnCount, 15); assert.equal(inspected.mergedRows[0].length, 15);
    assert.equal(inspected.rows[0][0].userEnteredValue.stringValue, 'Before merged text');
    const a = await h.input(), p = await h.service.update(a);
    assert.equal(p.outcome, 'preview'); assert.equal(h.state.writes, 0); assert.equal(h.state.approvals, 0);
    assert.deepEqual(p.proposal.mergedRange, inspected.mergedRange);
    const r = await h.service.update({ ...a, preview: false });
    assert.equal(r.outcome, 'verified'); assert.equal(h.state.writes, 1); assert.equal(h.state.approvals, 1);
    assert.deepEqual(proposal.range, inspected.range); assert.deepEqual(proposal.before, [[{ stringValue: 'Before merged text' }]]);
    assert.equal(h.state.reads.every(s => s === "'Review''s summary'!A26:O26"), true);
    assert.deepEqual(h.state.meta, originalMeta); assert.match(r.verification, /complete bounded merged footprint/);
    for (const [k, old] of originalGrid) {
      const observed = structuredClone(h.state.grid.get(k));
      if (k === '25:0') { delete old.userEnteredValue; delete observed.userEnteredValue; }
      assert.deepEqual(observed, old);
    }
    assert.equal((await h.service.status({ account, operationId: a.operationId })).outcome, 'verified');
    const reloaded = createSheetsEditService(h.ports);
    assert.equal((await reloaded.update({ ...a, preview: false })).receiptOnly, true); assert.equal(h.state.writes, 1); safe(h);
  } finally { await h.close(); }
});
test('vertical merged text and clearing preserve the complete footprint', async () => {
  for (const value of [null, '', '=a literal string']) {
    const h = await setup({ merges: [merge(25, 0, 3, 1)] });
    try { const a = await h.input([[value]]); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); assert.equal(h.state.reads.every(s => s.endsWith('!A26:A28')), true); assert.equal(h.state.grid.get('25:0').userEnteredValue?.stringValue, value || undefined); }
    finally { await h.close(); }
  }
});
test('disjoint merges do not block ordinary literal or explicit formula targets', async () => {
  for (const mode of ['literal', 'formulas']) {
    const h = await setup({ target: { startRow: 8, startColumn: 1 }, mode, formula: mode === 'formulas' });
    try { const a = await h.input(mode === 'formulas' ? [[{ formula: '=SUM(A1:A2)' }]] : [['Text']]); const read = await h.service.inspect(h.selected); assert.equal(read.mergedRange, undefined); assert.equal(read.mergeLayout.length, 2); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'verified'); if (mode === 'formulas') assert.equal(r.formulaReadbackMatches, true); }
    finally { await h.close(); }
  }
});
test('covered cells, multi-cell intersection and formula mode merged anchors fail before provider grid reads', async () => {
  for (const [patch, expected] of [[{ startColumn: 1 }, 'merged_anchor'], [{ columnCount: 2 }, 'merged_anchor'], [{ startRow: 24, rowCount: 2 }, 'merged_anchor'], [{ mode: 'formulas' }, 'merged_text']]) {
    const h = await setup({ target: patch });
    try { await assert.rejects(h.service.inspect(h.selected), e => e.sheetsEditCode === expected); assert.equal(h.state.reads.length, 0); assert.equal(h.state.writes, 0); }
    finally { await h.close(); }
  }
});
test('merged numeric/typed/formula/format changes and hidden unsupported cells fail without preview approval or writes', async () => {
  for (const value of [1, true, { date: '2026-10-30' }, { cad: 5 }]) {
    const h = await setup(); try { const a = await h.input([[value]]); await assert.rejects(h.service.update(a), e => e.sheetsEditCode === 'merged_text'); assert.equal(h.state.approvals, 0); assert.equal(h.state.writes, 0); } finally { await h.close(); }
  }
  const formatted = await setup(); try { const a = await formatted.input(); await assert.rejects(formatted.service.update({ ...a, formatTypedValues: true }), e => e.sheetsEditCode === 'merged_text'); } finally { await formatted.close(); }
  for (const patch of [ { userEnteredValue: { stringValue: 'hidden text' } }, { userEnteredValue: { formulaValue: '=1' } }, { effectiveValue: { numberValue: 7 } }, { textFormatRuns: [] }, { chipRuns: [] }, { dataValidation: {} }, { pivotTable: {} } ]) {
    const h = await setup({ mutate: s => Object.assign(s.grid.get('25:1'), patch) });
    try { await assert.rejects(h.service.inspect(h.selected)); assert.equal(h.state.writes, 0); safe(h); } finally { await h.close(); }
  }
});
test('malformed/unbounded/overlapping/excess merge metadata and protected/table tabs have safe specific refusals', async () => {
  const failures = [
    [undefined, s => s.meta.sheets[0].merges = {}], [[{}]], [[{ ...merge(), endRowIndex: undefined }]], [[merge(), merge(25, 1, 1, 2)]],
    [[{ ...merge(), sheetId: 8 }]], [[{ ...merge(), startRowIndex: -1 }]], [[{ ...merge(), endRowIndex: 301 }]], [[{ ...merge(), startColumnIndex: '0' }]],
    [[{ ...merge(), endColumnIndex: 51 }]], [[{ ...merge(), extra: true }]], [[merge(25, 0, 1, 1)]], [Array.from({ length: MAX_EDIT_MERGES + 1 }, (_, n) => merge(n, 0, 1, 2))],
  ];
  for (const [merges, mutate] of failures) {
    const h = await setup({ merges: merges || [], mutate });
    try { await assert.rejects(h.service.inspect(h.selected), e => e.sheetsEditCode === 'merged_structure'); assert.equal(h.state.reads.length, 0); } finally { await h.close(); }
  }
  for (const [field, category] of [['protectedRanges', 'protected_tab'], ['tables', 'table_tab']]) {
    const h = await setup({ mutate: s => s.meta.sheets[0][field] = [{}] });
    try { await assert.rejects(h.service.inspect(h.selected), e => e.sheetsEditCode === category); assert.doesNotMatch(sheetsEditMessage({ sheetsEditCode: category }), /SENTINEL/); } finally { await h.close(); }
  }
});
test('merge footprint bounds permit100cells/20columns and reject partial-footprint inspection', async () => {
  for (const [rows, cols, ok] of [[5, 20, true], [100, 1, true], [6, 20, false], [1, 21, false], [101, 1, false]]) {
    const h = await setup({ merges: [merge(25, 0, rows, cols)] });
    try { if (ok) { const read = await h.service.inspect(h.selected); assert.equal(read.mergedRows.length, rows); assert.equal(read.mergedRows[0].length, cols); } else await assert.rejects(h.service.inspect(h.selected), e => e.sheetsEditCode === 'merged_bounds'); } finally { await h.close(); }
  }
  const overflow = await setup({ mutate: s => s.grid.get('25:1').note = 'SENTINEL'.repeat(10000) });
  try { await assert.rejects(overflow.service.inspect(overflow.selected)); } finally { await overflow.close(); }
});
test('merge/anchor/retained style or note changes during approval stop submission', async () => {
  for (const approval of [s => s.meta.sheets[0].merges[0].endColumnIndex--, s => s.meta.sheets[0].merges.splice(0, 1), s => s.grid.get('25:0').userEnteredValue.stringValue = 'Other text', s => s.grid.get('25:14').note = 'Other note', s => s.grid.get('25:14').userEnteredFormat.horizontalAlignment = 'RIGHT']) {
    const h = await setup({ approval });
    try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'conflict'); assert.equal(r.writeAttempted, false); assert.equal(h.state.writes, 0); } finally { await h.close(); }
  }
});
test('merged approval cancellation/read-only scope never writes; readback mismatch stays unverified', async () => {
  for (const options of [{ decision: { outcome: 'cancelled', reason: 'timeout' } }, { decision: { outcome: 'submitted', value: { approved: false } } }, { scope: 'drive.readonly' }]) {
    const h = await setup(options); try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.writeAttempted, false); assert.equal(h.state.writes, 0); safe(h); } finally { await h.close(); }
  }
  for (const afterWrite of [s => s.grid.get('25:14').note = 'External change', s => s.meta.sheets[0].merges[0].endColumnIndex--]) {
    const h = await setup({ afterWrite }); try { const a = await h.input(); await h.service.update(a); const r = await h.service.update({ ...a, preview: false }); assert.equal(r.outcome, 'unverified'); assert.equal(h.state.writes, 1); safe(h); } finally { await h.close(); }
  }
});
test('lost or malformed reply with matching merged cells retains lock and never replays across a new service', async () => {
  for (const options of [{ lost: true }, { badReply: true }]) {
    const h = await setup(options); try { const a = await h.input(); await h.service.update(a); assert.equal((await h.service.update({ ...a, preview: false })).outcome, 'uncertain'); const service = createSheetsEditService(h.ports); const r = await service.status({ account, operationId: a.operationId }); assert.equal(r.outcome, 'observed_matching'); assert.equal(r.unresolvedLock, true); await service.update({ ...a, preview: false }); assert.equal(h.state.writes, 1); safe(h); } finally { await h.close(); }
  }
});
test('malformed full-footprint replies fail closed without normalizing invalid data to blank', async () => {
  for (const gridReply of [d => d.sheets[0].data = null, d => d.sheets[0].data = false, d => d.sheets[0].data = 0, d => d.sheets = {0:d.sheets[0],length:1}, d => d.sheets[0].data[0] = null, d => d.sheets[0].data[0].rowData = null, d => d.sheets[0].data[0].rowData[0] = [], d => d.sheets[0].data[0].rowData[0].values = null, d => d.sheets[0].data[0].rowData[0].values[0].userEnteredValue = [], d => d.sheets[0].data[0].rowData[0].values[1] = 'bad cell', d => d.sheets[0].data[0].startRow = null]) {
    const h = await setup({ gridReply }); try { await assert.rejects(h.service.inspect(h.selected), e => e.sheetsEditCode === 'unsupported'); assert.equal(h.state.writes, 0); assert.equal(h.state.approvals, 0); } finally { await h.close(); }
  }
});

test('review regression: acknowledged merged clear plus malformed outer grid container never verifies', async () => {
  for (const malformed of [null, false, 0]) {
    const h = await setup({ merges: [merge(25,0,1,2)], mutate: s => { for (const cell of s.grid.values()) { delete cell.userEnteredFormat; delete cell.note; } }, gridReply: (d,s) => { if (s.writes) d.sheets[0].data = malformed; } });
    try { const a = await h.input([[null]]); await h.service.update(a); const r = await h.service.update({...a,preview:false}); assert.equal(r.outcome,'unverified'); assert.equal(r.writeAttempted,true); assert.equal(r.currentMatch,undefined); assert.equal(h.state.writes,1); const status = await h.service.status({account,operationId:a.operationId}); assert.equal(status.outcome,'verification_unavailable'); assert.equal(status.currentMatch,undefined); assert.equal(h.state.writes,1); safe(h); }
    finally { await h.close(); }
  }
});

test('omitted zero merge starts normalize; merge order is canonical; plain tabs keep legacy snapshot shape', async () => {
  const a = metadata([merge(0, 0, 1, 3), merge()]); delete a.sheets[0].merges[0].startRowIndex; delete a.sheets[0].merges[0].startColumnIndex;
  const fail = category => { throw Error(category); };
  assert.deepEqual(editableLayout(a, target, fail).mergeLayout, editableLayout(metadata([merge(), merge(0, 0, 1, 3)]), target, fail).mergeLayout);
  const h = await setup({ merges: [] }); try { const read = await h.service.inspect(h.selected); assert.equal('mergedRows' in read, false); assert.equal('mergeLayout' in read, false); assert.equal('mergedRange' in read, false); } finally { await h.close(); }
});
