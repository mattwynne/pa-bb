import { createDocsTransport, rejection } from './docs-transport.mjs';
import { editRequests, sheetsEditError } from '../core/sheets-edit.mjs';
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const column = index => { let name = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };
const policy = {
  scopes: ['drive', 'drive.file'].map(s => `https://www.googleapis.com/auth/${s}`),
  scopeError: () => sheetsEditError('scope_required'),
  beforeSubmissionFailure: error => Object.assign(error instanceof Error ? error : sheetsEditError('scope_required'), { sheetsWriteAttempted: false }),
  writeRejection(status) { const error = rejection(status); if ([400, 401, 403, 404].includes(status)) error.sheetsRejected = true; return error; },
};
export function createSheetsEditAdapter({ verifiedAccess, fetchImpl = fetch }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  const url = (id, fields) => { const u = new URL(`${BASE}/${encodeURIComponent(id)}`); u.searchParams.set('fields', fields); return u; };
  return {
    metadata(record, id) { return transport.get(record, url(id, 'spreadsheetId,properties(title),sheets(properties,merges,protectedRanges,tables)')); },
    grid(record, id, tab, range) {
      // All CellData fields are intentional: omitted rich text/chips or computed
      // output would make value-only editing appear safe when it is not.
      const u = url(id, 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values)))');
      u.searchParams.set('ranges', `'${tab.title.replaceAll("'", "''")}'!${column(range.startColumn)}${range.startRow + 1}:${column(range.startColumn + range.columnCount - 1)}${range.startRow + range.rowCount}`);
      u.searchParams.set('includeGridData', 'true');
      return transport.get(record, u);
    },
    async prepareWrite(record) {
      const post = await transport.prepareWrite(record, policy);
      return { update(input, signal) {
        const requests = editRequests(input);
        return post(`${BASE}/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`, { requests }, signal);
      } };
    },
  };
}
