import { randomUUID } from 'node:crypto';
import { createDocsTransport } from './docs-transport.mjs';
import { createOfficeReadback } from './office-readback.mjs';
import { MAX_UPLOAD_BYTES, uploadError } from '../core/upload.mjs';
import { fileId } from '../core/native-create.mjs';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const literal = s => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
export function createUploadAdapter({ verifiedAccess, fetchImpl = fetch, sheets }) {
  const transport = createDocsTransport({ verifiedAccess, fetchImpl });
  const listing = (record, q) => { const u = new URL(FILES); u.search = new URLSearchParams({ q, spaces: 'drive', corpora: 'user', pageSize: '2', fields: 'files(id),nextPageToken,incompleteSearch' }).toString(); return transport.get(record, u); };
  return {
    ...createOfficeReadback(transport),
    async duplicates(record, parent, name) {
      const p = await listing(record, `trashed = false and ${literal(parent)} in parents and name = ${literal(name)}`);
      if (p.incompleteSearch === true || p.nextPageToken || !Array.isArray(p.files)) throw uploadError('incomplete');
      if (p.files.length) throw uploadError('duplicate');
    },
    async prepare(record) {
      const post = await transport.prepareWrite(record, { scopes: ['drive', 'drive.file'].map(s => `https://www.googleapis.com/auth/${s}`),
        scopeError: () => uploadError('scope'), beforeSubmissionFailure: e => Object.assign(e, { uploadNotSubmitted: true }),
        writeRejection: status => Object.assign(uploadError('incomplete'), { status, uploadRejected: [400, 401, 403, 404, 409, 413, 415, 422].includes(status) }),
      });
      return ({ bytes, name, mimeType, resultMime, destinationId, operationId, beforeSubmission }, signal) => {
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) throw Object.assign(uploadError('source'), { uploadNotSubmitted: true });
        // One bounded multipart request, not resumable state or metadata+media
        // stages. Google imports only when the explicit result MIME is native.
        const boundary = `pa-upload-${randomUUID()}`;
        const metadata = { name, mimeType: resultMime, parents: [destinationId], appProperties: { paLocalUpload: operationId } };
        const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        return post('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=false', body, signal,
          { binaryBody: true, contentType: `multipart/related; boundary=${boundary}`, beforeSubmission });
      };
    },
    get(record, id) { return transport.get(record, `${FILES}/${encodeURIComponent(id)}?fields=id,name,mimeType,size,md5Checksum,sha256Checksum,parents,trashed,appProperties&supportsAllDrives=false`); },
    async find(record, operationId) {
      const p = await listing(record, `trashed = false and appProperties has { key='paLocalUpload' and value=${literal(operationId)} }`);
      return p.incompleteSearch !== true && !p.nextPageToken && p.files?.length === 1 && fileId(p.files[0].id) ? p.files[0].id : null;
    },
    async inspectSheet(record, id, expected) {
      const m = await sheets.metadata(record, id), tabs = m.sheets?.map(s => s.properties);
      if (m.spreadsheetId !== id || !Array.isArray(tabs) || tabs.length > 100 || tabs.some(t => !Number.isSafeInteger(t?.sheetId) || typeof t.title !== 'string' || !t.title || t.title.length > 100 || t.sheetType !== 'GRID')) throw uploadError('incomplete');
      const sampled = []; let formulas = 0, errors = 0;
      for (const tab of tabs.slice(0, 10)) {
        const rowCount = Math.min(10, tab.gridProperties?.rowCount || 0), columnCount = Math.min(10, tab.gridProperties?.columnCount || 0);
        if (!rowCount || !columnCount) throw uploadError('incomplete');
        const data = await sheets.readGrid(record, id, tab, { startRow: 0, startColumn: 0, rowCount, columnCount });
        const errorCells = []; let tabFormulas = 0;
        for (const d of data) for (const [r, row] of (d.rowData || []).entries()) for (const [c, cell] of (row.values || []).entries()) {
          if (typeof cell.userEnteredValue?.formulaValue === 'string') { formulas++; tabFormulas++; }
          if (cell.effectiveValue?.errorValue) {
            errors++; const type = cell.effectiveValue.errorValue.type;
            errorCells.push({ row: r + 1, column: c + 1, type: ['ERROR', 'NULL_VALUE', 'DIVIDE_BY_ZERO', 'VALUE', 'REF', 'NAME', 'NUM', 'N_A', 'LOADING'].includes(type) ? type : 'UNKNOWN' });
          }
        }
        sampled.push({ sheetId: tab.sheetId, title: tab.title, range: { startRow: 0, startColumn: 0, rowCount, columnCount }, formulaCount: tabFormulas, errorCells });
      }
      return { structureMatches: JSON.stringify(tabs.map(t => t.title)) === JSON.stringify(expected.tabs),
        tabs: tabs.map(t => ({ sheetId: t.sheetId, title: t.title, rows: t.gridProperties?.rowCount, columns: t.gridProperties?.columnCount })),
        sampled, observedFormulaCount: formulas, observedCalculationErrorCount: errors, sourceFormulaCount: expected.sourceFormulaCount,
        fidelityVerified: false, inspection: 'First 10 rows × 10 columns of first 10 tabs only (up to 1000 cells). Other formulas/results, recalculation, Excel features and visual fidelity remain unverified. A verified import is NOT a verified working financial model.' };
    },
  };
}
