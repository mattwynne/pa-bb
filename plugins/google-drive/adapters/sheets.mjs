import { createDocsTransport } from './docs-transport.mjs';
import { createNativeCreationAdapter } from './native-create.mjs';
import { populationRequests, SHEETS_MIME } from '../core/sheets.mjs';
import { docsError } from '../core/docs-edit.mjs';
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const metadataFields = 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount,frozenRowCount)))';
const gridFields = 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat(numberFormat),effectiveValue,formattedValue))))';
const columnName = index => { let name = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };
export function createSheetsAdapter({ verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  const url = (id, fields) => { const u = new URL(`${BASE}/${encodeURIComponent(id)}`); u.searchParams.set('fields', fields); return u; };
  return {
    creation: createNativeCreationAdapter({ verifiedAccess, fetchImpl, mimeType: SHEETS_MIME, marker: 'paSheetsCreation',
      population: ({ spreadsheetId, tabs, blankSheetId }) => ({ url: `${BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, body: { requests: populationRequests(tabs, blankSheetId) } }),
    }),
    metadata(record, id) { return transport.get(record, url(id, metadataFields)); },
    blank(record, id) {
      const u = url(id, 'spreadsheetId,sheets(properties(sheetId),data(rowData(values(userEnteredValue))))');
      u.searchParams.set('includeGridData', 'true');
      return transport.get(record, u);
    },
    async readGrid(record, id, tab, range) {
      const u = url(id, gridFields);
      // Quoting names prevents titles that resemble A1 or contain apostrophes
      // from becoming another range or a named-range lookup.
      const name = `'${tab.title.replaceAll("'", "''")}'`;
      u.searchParams.set('ranges', `${name}!${columnName(range.startColumn)}${range.startRow + 1}:${columnName(range.startColumn + range.columnCount - 1)}${range.startRow + range.rowCount}`);
      u.searchParams.set('includeGridData', 'true');
      const result = await transport.get(record, u);
      if (result.spreadsheetId !== id || result.sheets?.length !== 1 || result.sheets[0].properties?.sheetId !== tab.sheetId) throw docsError('unsupported_document');
      const data = result.sheets[0].data || [];
      if (data.some(d => (d.startRow || 0) !== range.startRow || (d.startColumn || 0) !== range.startColumn)) throw docsError('unsupported_document');
      return data;
    },
  };
}
