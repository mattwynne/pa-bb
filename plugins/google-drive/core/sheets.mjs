import { docsError } from './docs-edit.mjs';
import { createNativeCreationService, creationError, fileId, hash, validTitle } from './native-create.mjs';
export const SHEETS_MIME = 'application/vnd.google-apps.spreadsheet';
export const SHEETS_LIMITS = { tabs: 4, rows: 200, columns: 26, cells: 5000, text: 40000, cellText: 2000, readCells: 1000 };
const bad = () => { throw creationError('invalid_input'); };
import { cellData as encodeCell } from './sheets-cells.mjs';
export function cellData(value) { try { return encodeCell(value); } catch { return bad(); } }

function plan(tabs) {
  if (!Array.isArray(tabs) || !tabs.length || tabs.length > SHEETS_LIMITS.tabs) bad();
  const names = new Set(); let cells = 0, text = 0;
  const result = tabs.map((tab, index) => {
    if (!tab || Object.keys(tab).some(key => !['title', 'rows'].includes(key)) || !validTitle(tab.title) || tab.title.length > 100 || /[\[\]:*?/\\]/.test(tab.title)
      || names.has(tab.title.toLowerCase()) || !Array.isArray(tab.rows) || !tab.rows.length || tab.rows.length > SHEETS_LIMITS.rows) bad();
    names.add(tab.title.toLowerCase());
    const columns = Math.max(...tab.rows.map(row => Array.isArray(row) ? row.length : 0));
    if (!columns || columns > SHEETS_LIMITS.columns) bad();
    cells += tab.rows.length * columns;
    const rows = tab.rows.map(row => {
      if (!Array.isArray(row) || row.length > SHEETS_LIMITS.columns) bad();
      return Array.from({ length: columns }, (_, i) => {
        const value = i < row.length ? row[i] : null;
        if (typeof value === 'string') text += value.length;
        return cellData(value);
      });
    });
    return { sheetId: index + 1, title: tab.title, rowCount: rows.length, columnCount: columns, rows };
  });
  if (cells > SHEETS_LIMITS.cells || text > SHEETS_LIMITS.text) bad();
  return result;
}
function normalizedCell(cell = {}) {
  const value = cell.userEnteredValue || {};
  if (Object.keys(value).length > 1 || Object.keys(value).some(k => !['stringValue', 'numberValue', 'boolValue'].includes(k))) throw docsError('unsupported_document');
  const format = cell.userEnteredFormat?.numberFormat;
  return { value: value.stringValue === '' ? {} : value,
    format: format && ['DATE', 'CURRENCY'].includes(format.type) ? { type: format.type, pattern: format.pattern } : null };
}
const contentHash = tabs => hash(JSON.stringify(tabs.map(t => ({ sheetId: t.sheetId, title: t.title,
  rows: t.rows.map(row => row.map(normalizedCell)) }))));
export function populationRequests(tabs, blankSheetId) {
  const planned = plan(tabs);
  let temporaryTitle = '_PA_initial';
  while (planned.some(t => t.title.toLowerCase() === temporaryTitle.toLowerCase())) temporaryTitle += '_';
  const requests = [{ updateSpreadsheetProperties: { properties: { locale: 'en_CA', timeZone: 'Etc/UTC' }, fields: 'locale,timeZone' } },
    { updateSheetProperties: { properties: { sheetId: blankSheetId, title: temporaryTitle }, fields: 'title' } }];
  for (const t of planned) {
    requests.push({ addSheet: { properties: { sheetId: t.sheetId, title: t.title, gridProperties: { rowCount: Math.max(2, t.rowCount), columnCount: t.columnCount, frozenRowCount: 1 } } } },
      { updateCells: { start: { sheetId: t.sheetId, rowIndex: 0, columnIndex: 0 }, rows: t.rows.map(values => ({ values })), fields: 'userEnteredValue,userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: t.sheetId }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment' } },
      { repeatCell: { range: { sheetId: t.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.93, blue: 0.96 } } }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor' } },
      { updateDimensionProperties: { range: { sheetId: t.sheetId, dimension: 'COLUMNS' }, properties: { pixelSize: 180 }, fields: 'pixelSize' } });
  }
  requests.push({ deleteSheet: { sheetId: blankSheetId } });
  return requests;
}
export function createSheetsService({ store, drive, sheets, diagnose }) {
  const creationService = createNativeCreationService({ store, drive, creation: sheets.creation, diagnose, spec: {
    kind: 'spreadsheet', idField: 'spreadsheetId', mimeType: SHEETS_MIME, stage: 'sheets_creation',
    statusTool: 'gsheets_creation_status', url: id => `https://docs.google.com/spreadsheets/d/${id}/edit`,
    verifiedGuidance: 'Title, destination, ordered tabs and all initial cell values/date/currency formats were read back exactly; first rows are frozen. Header styling and privacy are not independently certified. No sharing or invitations.',
    validate: args => { plan(args.tabs); },
    request: args => ['spreadsheet', args.folderId, args.title, args.tabs],
    expected(args) { const tabs = plan(args.tabs); return { contentHash: contentHash(tabs), shape: tabs.map(({ sheetId, rowCount, columnCount }) => ({ sheetId, rowCount, columnCount })) }; },
    async populate(writer, record, op, args, signal) {
      const blank = await sheets.metadata(record, op.spreadsheetId);
      const tab = blank.sheets?.[0];
      if (blank.spreadsheetId !== op.spreadsheetId || blank.properties?.title !== args.title || blank.sheets?.length !== 1 || !Number.isInteger(tab?.properties?.sheetId)
        || op.shape.some(t => t.sheetId === tab.properties.sheetId)) throw docsError('unsupported_document');
      // gridData at A1 cannot establish blankness of the entire sheet. Inspect
      // all allocated cells, with the shared bounded transport, before replacing it.
      const all = await sheets.blank(record, op.spreadsheetId);
      if (all.spreadsheetId !== op.spreadsheetId || all.sheets?.length !== 1 || all.sheets[0].properties?.sheetId !== tab.properties.sheetId || all.sheets.some(s => s.data?.some(d => d.rowData?.some(r => r.values?.some(c => c.userEnteredValue && Object.keys(c.userEnteredValue).length))))) throw docsError('unsupported_document');
      signal?.throwIfAborted();
      await writer.populate({ spreadsheetId: op.spreadsheetId, tabs: args.tabs, blankSheetId: tab.properties.sheetId }, signal);
    },
    async verify(record, op) {
      const meta = await sheets.metadata(record, op.spreadsheetId);
      if (meta.spreadsheetId !== op.spreadsheetId || hash(meta.properties?.title || '') !== op.titleHash || meta.properties?.locale !== 'en_CA' || meta.properties?.timeZone !== 'Etc/UTC' || meta.sheets?.length !== op.shape.length) return false;
      const tabs = [];
      for (const [index, shape] of op.shape.entries()) {
        const properties = meta.sheets[index]?.properties, grid = properties?.gridProperties;
        if (properties?.sheetId !== shape.sheetId || properties.index !== index || (properties.sheetType && properties.sheetType !== 'GRID') || grid?.rowCount !== Math.max(2, shape.rowCount) || grid?.columnCount !== shape.columnCount || grid?.frozenRowCount !== 1) return false;
        const data = await sheets.readGrid(record, op.spreadsheetId, properties, { startRow: 0, startColumn: 0, ...shape });
        tabs.push({ sheetId: shape.sheetId, title: properties.title, rows: gridRows(data, shape.rowCount, shape.columnCount) });
      }
      return contentHash(tabs) === op.contentHash;
    },
  } });
  async function read(args) {
    if (typeof args.account !== 'string' || !args.account.trim() || args.account.length > 320 || !fileId(args.spreadsheetId)
      || (args.sheetId !== undefined && (!Number.isInteger(args.sheetId) || args.sheetId < 0)) || !['startRow', 'startColumn', 'rowCount', 'columnCount'].every(k => Number.isInteger(args[k]))
      || args.startRow < 0 || args.startColumn < 0 || args.rowCount < 1 || args.columnCount < 1 || args.rowCount * args.columnCount > SHEETS_LIMITS.readCells) bad();
    const record = await store.byEmail(args.account);
    if (!record) throw docsError('unknown_account');
    const file = await drive.getFile(record, args.spreadsheetId);
    if (file.id !== args.spreadsheetId || file.mimeType !== SHEETS_MIME || file.trashed !== false) throw docsError('unsupported_document');
    const meta = await sheets.metadata(record, args.spreadsheetId);
    if (meta.spreadsheetId !== args.spreadsheetId || !Array.isArray(meta.sheets) || meta.sheets.length > 100) throw docsError('unsupported_document');
    const tab = (args.sheetId === undefined ? meta.sheets[0] : meta.sheets.find(t => t.properties?.sheetId === args.sheetId))?.properties;
    if (!tab || typeof tab.title !== 'string' || (tab.sheetType && tab.sheetType !== 'GRID') || !Number.isSafeInteger(tab.gridProperties?.rowCount) || !Number.isSafeInteger(tab.gridProperties?.columnCount)
      || args.startRow + args.rowCount > tab.gridProperties.rowCount || args.startColumn + args.columnCount > tab.gridProperties.columnCount) bad();
    const data = await sheets.readGrid(record, args.spreadsheetId, tab, args);
    const rows = gridRows(data, args.rowCount, args.columnCount);
    // Return raw typed values, never evaluate/render cell text as instructions.
    if (JSON.stringify(rows).length > 100000) throw docsError('unsupported_document');
    return { account: record.email, spreadsheetId: args.spreadsheetId, title: meta.properties?.title, url: `https://docs.google.com/spreadsheets/d/${args.spreadsheetId}/edit`,
      tabs: meta.sheets.map(t => t.properties), range: { sheetId: tab.sheetId, startRow: args.startRow, startColumn: args.startColumn, rowCount: args.rowCount, columnCount: args.columnCount }, rows, complete: true };
  }
  return { ...creationService, read };
}
function gridRows(data, rows, columns) {
  if (!Array.isArray(data) || data.length > 1) throw docsError('unsupported_document');
  const source = data[0]?.rowData || [];
  if (source.length > rows || source.some(r => (r.values?.length || 0) > columns)) throw docsError('unsupported_document');
  return Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => source[r]?.values?.[c] || {}));
}
