// One rectangle of literal values. Sheets has no revision/CAS write control.
import { z } from 'zod';
import { hash, fileId } from './native-create.mjs';
import { cellData, SHEETS_MIME } from './sheets.mjs';
import { docsError } from './docs-edit.mjs';
import { docsApprovalDecision } from './docs-approval.mjs';
export const EDIT_CELLS = 100;
const index = z.number().int().min(0).max(10_000_000);
const account = z.string().min(1).max(320);
const sheetId = z.number().int().min(0).max(2_147_483_647);
const target = { account, spreadsheetId: z.string().regex(/^[\w-]{1,256}$/), sheetId, startRow: index, startColumn: index };
const literal = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
export const editInspectSchema = z.object({ ...target, rowCount: z.number().int().min(1).max(100), columnCount: z.number().int().min(1).max(20) }).strict().refine(a => a.rowCount * a.columnCount <= EDIT_CELLS);
export const editStatusSchema = z.object({ account, operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) }).strict();
export const editRangeSchema = z.object({ ...target, operationId: editStatusSchema.shape.operationId,
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), values: z.array(z.array(literal).min(1).max(20)).min(1).max(100), preview: z.boolean().default(true),
}).strict().refine(a => a.values.every(r => r.length === a.values[0].length) && a.values.length * a.values[0].length <= EDIT_CELLS
  && a.values.flat().reduce((n, c) => n + (typeof c === 'string' ? c.length : 0), 0) <= 20000);
const messages = {
  invalid: 'Use an explicit account, spreadsheet/tab IDs, zero-based range, inspected fingerprint and single-use lowercase UUID v4. Supply a rectangular matrix of at most 100 literal cells, 20 columns, 2000 UTF-16 units per cell and 20000 total. No formula/date/currency objects or arbitrary requests.',
  unsupported: 'Editing supports ordinary literal cells only. Formula/calculated cells, rich text, chips, validation, pivot/data-source cells, merged/protected ranges and tables are rejected. Use a smaller ordinary range or edit in Google Sheets.',
  stale: 'The inspected range or tab metadata changed. Nothing new was submitted. Inspect again and prepare a separately requested proposal.',
  conflict: 'This operationId belongs to another account or request. Recover the original operation; never replace the key to bypass uncertainty.',
  busy: 'Another Sheets edit is reviewing, writing or unresolved on this spreadsheet. Recover that operation using its original account before another edit.',
  unknown: 'No Sheets editing receipt exists for this account/key. This does not prove that no external write occurred.',
  preview_required: 'First preview this exact edit with the same operationId and preview=true. A proposal is not a completed edit.',
  scope_required: 'Editing needs an existing owner-authorized Drive write grant (drive or drive.file). Check Google Drive Settings; do not change scopes, credentials or approval settings manually.',
};
export const sheetsEditError = code => Object.assign(new Error(messages[code] || 'Sheets editing is unavailable. Inspect the SAME operationId; never replay an uncertain write.'), { sheetsEditCode: code });
export const sheetsEditCategory = error => Object.hasOwn(messages, error?.sheetsEditCode) ? error.sheetsEditCode : 'unknown';
export const sheetsEditMessage = error => messages[error?.sheetsEditCode] || 'Sheets inspection or editing is unavailable. Check the account and enabled Sheets API in Settings. If an edit was submitted, use gsheets_edit_status with the SAME account/key; never replay or replace it.';
const parse = (schema, args) => { const p = schema.safeParse(args); if (!p.success) throw sheetsEditError('invalid'); return p.data; };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const digest = value => hash(JSON.stringify(stable(value)));
const clone = value => structuredClone(value);
export const SHEETS_RACE_WARNING = 'Google Sheets has no revision/CAS guard. A fresh comparison detects earlier changes but cannot prevent a collaborator editing between comparison and submission. This may overwrite a concurrent edit. Use a quiet editing window. Dependent formulas elsewhere may recalculate.';
export function literalRows(values) {
  // Validate here too: the internal adapter never accepts raw batch requests.
  parse(editRangeSchema, { account: 'validation', spreadsheetId: 'validation', sheetId: 0, startRow: 0, startColumn: 0,
    operationId: '00000000-0000-4000-8000-000000000000', expectedFingerprint: '0'.repeat(64), values });
  try { return values.map(row => row.map(value => cellData(value))); } catch { throw sheetsEditError('invalid'); }
}
export function editRequest(input) {
  if (!input || Object.keys(input).some(k => !['spreadsheetId', 'sheetId', 'startRow', 'startColumn', 'values'].includes(k)) || !fileId(input.spreadsheetId)
    || !sheetId.safeParse(input.sheetId).success || ![input.startRow, input.startColumn].every(v => index.safeParse(v).success)) throw sheetsEditError('invalid');
  return { updateCells: { start: { sheetId: input.sheetId, rowIndex: input.startRow, columnIndex: input.startColumn },
    rows: literalRows(input.values).map(values => ({ values })), fields: 'userEnteredValue' } };
}
export function inspectEditableGrid(meta, data, args) {
  const fail = () => { throw sheetsEditError('unsupported'); };
  if (meta?.spreadsheetId !== args.spreadsheetId || !Array.isArray(meta.sheets) || !meta.sheets.length || meta.sheets.length > 100) fail();
  const tabs = meta.sheets.map(s => s.properties);
  if (tabs.some(t => !Number.isSafeInteger(t?.sheetId) || typeof t?.title !== 'string') || new Set(tabs.map(t => t.sheetId)).size !== tabs.length) fail();
  const s = meta.sheets.find(s => s.properties.sheetId === args.sheetId), tab = s?.properties;
  if (!tab || (tab.sheetType && tab.sheetType !== 'GRID') || !Number.isSafeInteger(tab.gridProperties?.rowCount) || !Number.isSafeInteger(tab.gridProperties?.columnCount)
    || args.startRow + args.rowCount > tab.gridProperties.rowCount || args.startColumn + args.columnCount > tab.gridProperties.columnCount) fail();
  // Conservative first surface: reject these structures on the selected tab,
  // including anchors outside the rectangle whose effects may extend into it.
  if (['merges', 'protectedRanges', 'tables'].some(k => s[k]?.length)) fail();
  if (data?.spreadsheetId !== args.spreadsheetId || data.sheets?.length !== 1 || data.sheets[0].properties?.sheetId !== tab.sheetId) fail();
  const blocks = data.sheets[0].data || [];
  if (!Array.isArray(blocks) || blocks.length > 1) fail();
  const b = blocks[0];
  if (b && ((b.startRow || 0) !== args.startRow || (b.startColumn || 0) !== args.startColumn)) fail();
  const source = b?.rowData || [];
  if (!Array.isArray(source) || source.length > args.rowCount || source.some(r => !r || (r.values && !Array.isArray(r.values)) || (r.values?.length || 0) > args.columnCount)) fail();
  const rows = Array.from({ length: args.rowCount }, (_, r) => Array.from({ length: args.columnCount }, (_, c) => {
    const cell = clone(source[r]?.values?.[c] || {});
    // A new userEnteredValue erases rich-text/chip runs. Reject rather than lose
    // them. Effective-only cells can be array/pivot output from outside range.
    if (Object.keys(cell).some(k => !['userEnteredValue', 'userEnteredFormat', 'effectiveValue', 'effectiveFormat', 'formattedValue', 'hyperlink', 'note'].includes(k))) fail();
    const value = cell.userEnteredValue || {}, keys = Object.keys(value);
    if (keys.length > 1 || keys.some(k => !['stringValue', 'numberValue', 'boolValue'].includes(k))) fail();
    if (keys.length) {
      const v = value[keys[0]];
      if ((keys[0] === 'stringValue' && typeof v !== 'string') || (keys[0] === 'numberValue' && (typeof v !== 'number' || !Number.isFinite(v))) || (keys[0] === 'boolValue' && typeof v !== 'boolean')) fail();
      try { cellData(v); } catch { fail(); }
    }
    if (!keys.length && Object.keys(cell.effectiveValue || {}).length) fail();
    for (const key of ['effectiveValue', 'effectiveFormat', 'formattedValue', 'hyperlink']) delete cell[key];
    // Google omits cleared/empty values and trailing empty grid data.
    if (!keys.length || value.stringValue === '') delete cell.userEnteredValue;
    if (Object.keys(cell.userEnteredFormat || {}).length === 0) delete cell.userEnteredFormat;
    return cell;
  }));
  const snapshot = { spreadsheetId: args.spreadsheetId, title: meta.properties?.title || '', tabs, range: {
    sheetId: args.sheetId, startRow: args.startRow, startColumn: args.startColumn, rowCount: args.rowCount, columnCount: args.columnCount }, rows };
  if (JSON.stringify(snapshot).length > 60000) fail();
  return snapshot;
}
export function createSheetsEditService({ accounts, operations, drive, sheets, approve = async (_proposal) => /** @type {unknown} */ ({ outcome: 'cancelled', reason: 'request-aborted' }), diagnose = (_stage, _error) => {}, clock = () => Date.now() }) {
  async function accountRecord(args) {
    const record = await accounts.byEmail(args.account);
    if (!record) throw docsError('unknown_account');
    return record;
  }
  async function load(args, record) {
    const file = await drive.getFile(record, args.spreadsheetId);
    if (file.id !== args.spreadsheetId || file.trashed !== false || file.mimeType !== SHEETS_MIME) throw sheetsEditError('unsupported');
    const meta = await sheets.metadata(record, args.spreadsheetId);
    const tab = meta.sheets?.find(t => t.properties?.sheetId === args.sheetId)?.properties;
    if (!tab || typeof tab.title !== 'string') throw sheetsEditError('unsupported');
    const data = await sheets.grid(record, args.spreadsheetId, tab, args);
    return inspectEditableGrid(meta, data, args);
  }
  async function inspect(input) {
    const args = parse(editInspectSchema, input), record = await accountRecord(args);
    const snapshot = await load(args, record);
    return { ...snapshot, account: record.email, complete: true, fingerprint: digest(snapshot), concurrency: SHEETS_RACE_WARNING };
  }
  function receipt(op, outcome = op.state, extra = {}) {
    return { operationId: op.operationId, spreadsheetId: op.spreadsheetId, range: op.range, outcome, receiptOnly: true,
      writeAttempted: ['writing', 'uncertain'].includes(op.state) ? 'unknown' : op.writeAttempted, retrySafe: false,
      providerAcknowledged: op.acknowledged === true, ...(op.failureReason ? { failureReason: op.failureReason } : {}), url: `https://docs.google.com/spreadsheets/d/${op.spreadsheetId}/edit`,
      guidance: op.failureReason === 'scope_required' ? messages.scope_required : 'Historical receipt only unless currentMatch is provided. Use gsheets_edit_status with the SAME account/key. Never replay or replace an uncertain operation. Readback cannot prove absence of concurrent edits or attribute matching values to this request.', ...extra };
  }
  async function update(input, signal) {
    const args = parse(editRangeSchema, input), rows = literalRows(args.values), record = await accountRecord(args);
    const range = { sheetId: args.sheetId, startRow: args.startRow, startColumn: args.startColumn, rowCount: rows.length, columnCount: rows[0].length };
    const requestHash = digest({ subject: record.subject, spreadsheetId: args.spreadsheetId, range, expectedFingerprint: args.expectedFingerprint, rows });
    let op = await operations.get(args.operationId);
    if (op && (op.subject !== record.subject || op.requestHash !== requestHash)) throw sheetsEditError('conflict');
    if (op && op.state !== 'proposed') return receipt(op);
    if (!op && !args.preview) throw sheetsEditError('preview_required');
    const before = await load({ ...args, ...range }, record);
    if (digest(before) !== args.expectedFingerprint) throw sheetsEditError('stale');
    const after = clone(before);
    after.rows.forEach((row, r) => row.forEach((cell, c) => { delete cell.userEnteredValue; Object.assign(cell, rows[r][c]); }));
    if (digest(before) === digest(after)) throw sheetsEditError('invalid');
    if (!op) {
      op = { operationId: args.operationId, subject: record.subject, spreadsheetId: args.spreadsheetId, range, requestHash,
        beforeHash: digest(before), afterHash: digest(after), state: 'proposed', writeAttempted: false, createdAt: clock() };
      if (!await operations.reserve(op)) {
        const current = await operations.get(op.operationId);
        if (!current || current.subject !== record.subject || current.requestHash !== requestHash) throw sheetsEditError('conflict');
        return receipt(current);
      }
    }
    const proposal = { account: record.email, spreadsheetId: args.spreadsheetId, title: before.title, tabTitle: before.tabs.find(t => t.sheetId === args.sheetId).title,
      operationId: op.operationId, range, before: before.rows.map(row => row.map(c => c.userEnteredValue || null)), values: args.values, concurrency: SHEETS_RACE_WARNING };
    if (args.preview) return { ...receipt(op, 'preview'), receiptOnly: false, proposal, writeAttempted: false };
    if (!await operations.claim(op.operationId, op.spreadsheetId)) {
      const current = await operations.get(op.operationId);
      if (current && current.state !== 'proposed') return receipt(current);
      const blockingOperationId = await operations.active(op.spreadsheetId);
      return receipt(current || op, blockingOperationId ? 'busy' : 'not_claimed', { ...(editStatusSchema.shape.operationId.safeParse(blockingOperationId).success ? { blockingOperationId } : {}),
        guidance: blockingOperationId ? 'Another operation holds this spreadsheet lock. Use blockingOperationId with gsheets_edit_status and the original connected account. No account identity is disclosed; ask the owner if it is unknown. Do not bypass the lock with a new key.' : 'No durable claim was obtained. No write was attempted. Inspect the SAME operationId before deciding what to do; do not generate a replacement key.' });
    }
    op.state = 'reviewing';
    let writing = false;
    async function finish(state, extra = {}) {
      op.state = state;
      try { await operations.save(op); }
      catch (error) { diagnose('sheets_edit_receipt', error); return receipt(op, 'receipt_unavailable', { writeAttempted: writing ? true : false }); }
      return receipt(op, state, extra);
    }
    try {
      if (signal?.aborted) return await finish('cancelled');
      if (clock() - op.createdAt > 10 * 60_000) return await finish('expired');
      const writer = await sheets.prepareWrite(record);
      let decision;
      try { decision = docsApprovalDecision(await approve(proposal)); }
      catch (error) { diagnose('sheets_edit_approval', error); return await finish('approval_unavailable'); }
      if (decision.outcome !== 'approved') {
        if (!['owner_declined', 'user'].includes(decision.reason)) diagnose('sheets_edit_approval', undefined);
        return await finish(decision.outcome, { reason: decision.reason });
      }
      if (signal?.aborted) return await finish('cancelled');
      if (clock() - op.createdAt > 10 * 60_000) return await finish('expired');
      const currentRecord = await accountRecord(args);
      if (currentRecord.subject !== record.subject) return await finish('conflict');
      const current = await load({ ...args, ...range }, currentRecord);
      if (digest(current) !== op.beforeHash) return await finish('conflict');
      if (signal?.aborted) return await finish('cancelled');
      // Durable claim precedes the only possible mutation. No compare-and-swap
      // is available at Google: this final comparison cannot close the race.
      if (!await operations.start({ ...op, state: 'writing', writeAttempted: true })) {
        const current = await operations.get(op.operationId);
        return receipt(current || op, current?.state || 'not_submitted');
      }
      op.state = 'writing'; op.writeAttempted = true; writing = true;
      let response;
      try { response = await writer.update({ spreadsheetId: args.spreadsheetId, sheetId: args.sheetId, startRow: args.startRow, startColumn: args.startColumn, values: args.values }, signal); }
      catch (error) {
        diagnose('sheets_edit_write', error);
        if (error?.sheetsWriteAttempted === false) { writing = false; op.writeAttempted = false; op.failureReason = sheetsEditCategory(error); return await finish('not_submitted'); }
        return await finish(error?.sheetsRejected === true ? 'rejected' : 'uncertain');
      }
      if (response?.spreadsheetId !== args.spreadsheetId || !Array.isArray(response.replies) || response.replies.length !== 1 || !response.replies[0] || typeof response.replies[0] !== 'object' || Array.isArray(response.replies[0]) || Object.keys(response.replies[0]).length !== 0) { diagnose('sheets_edit_write_response', undefined); return await finish('uncertain'); }
      op.acknowledged = true;
      const observed = await load({ ...args, ...range }, record);
      const matches = digest(observed) === op.afterHash;
      if (!matches) diagnose('sheets_edit_readback_mismatch', undefined);
      return await finish(matches ? 'verified' : 'unverified', { receiptOnly: false, currentMatch: matches,
        verification: 'Only the bounded target values, cell formatting/notes and tab metadata were compared. Other cells/tabs are outside the write mask, not independently read back. Dependent formulas may recalculate. Concurrent overwrites cannot be excluded.' });
    } catch (error) {
      diagnose(writing ? 'sheets_edit_verification' : 'sheets_edit_preflight', error);
      if (!writing) op.failureReason = sheetsEditCategory(error);
      // An acknowledged batch with unavailable readback is complete_unverified;
      // a lost/unreadable response remains locked and never becomes retryable.
      return await finish(writing ? op.acknowledged ? 'unverified' : 'uncertain' : 'not_submitted');
    }
  }
  async function status(input) {
    const args = parse(editStatusSchema, input), record = await accountRecord(args), op = await operations.get(args.operationId);
    if (!op || op.subject !== record.subject) throw sheetsEditError('unknown');
    try {
      const observed = await load({ spreadsheetId: op.spreadsheetId, ...op.range }, record);
      const matches = digest(observed) === op.afterHash;
      // Read only, including the durable receipt. Do not release an unresolved
      // lock based on equal values: a timed-out Google request may still apply.
      return receipt(op, op.acknowledged ? matches ? 'verified' : 'unverified' : matches ? 'observed_matching' : op.state,
        { receiptOnly: false, currentMatch: matches, unresolvedLock: ['reviewing', 'writing', 'uncertain'].includes(op.state),
          operationState: op.state, guidance: op.acknowledged ? 'Fresh bounded readback. This does not certify later edits or absence of a concurrent overwrite.'
            : 'Matching values do not prove this operation applied or that an in-flight request has finished. Unresolved locks stay held. Do not replay, replace the key, or force-unlock; reconcile with the owner.' });
    } catch (error) { diagnose('sheets_edit_status', error); return receipt(op, 'verification_unavailable'); }
  }
  return { inspect, update, status };
}
