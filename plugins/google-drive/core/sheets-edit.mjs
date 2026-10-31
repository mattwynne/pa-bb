// One value rectangle: literal by default, explicit bounded formula opt-in.
// Sheets has no revision/CAS write control.
import { z } from 'zod';
import { hash, fileId } from './native-create.mjs';
import { SHEETS_MIME } from './sheets.mjs';
import { cellData } from './sheets-cells.mjs';
import { docsError } from './docs-edit.mjs';
import { docsApprovalDecision } from './docs-approval.mjs';
import { validateFormula, formulaCalculation } from './sheets-formula.mjs';
import { editableLayout } from './sheets-edit-layout.mjs';
export const EDIT_CELLS = 100;
const index = z.number().int().min(0).max(10_000_000);
const account = z.string().min(1).max(320);
const sheetId = z.number().int().min(0).max(2_147_483_647);
const target = { account, spreadsheetId: z.string().regex(/^[\w-]{1,256}$/), sheetId, startRow: index, startColumn: index };
const literal = z.union([z.string().max(2000), z.number(), z.boolean(), z.null(), z.object({ date: z.string().length(10).regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(), z.object({ cad: z.number() }).strict()]);
const editMode = z.enum(['literal', 'formulas']).default('literal').describe('Default literal rejects formula cells/objects. Explicit formulas mode permits formula-aware inspection and {formula} entries under the in-workbook financial grammar. Strings remain literal.');
const formulaCell = z.object({ formula: z.string().min(2).max(2000) }).strict();
export const isFormulaCell = value => !!value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.formula === 'string';
export const editInspectSchema = z.object({ ...target, mode: editMode, rowCount: z.number().int().min(1).max(100), columnCount: z.number().int().min(1).max(20) }).strict().refine(a => a.rowCount * a.columnCount <= EDIT_CELLS);
export const editStatusSchema = z.object({ account, operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) }).strict();
export const editRangeSchema = z.object({ ...target, mode: editMode, operationId: editStatusSchema.shape.operationId,
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), values: z.array(z.array(z.union([literal, formulaCell])).min(1).max(20)).min(1).max(100), formatTypedValues: z.boolean().default(false), preview: z.boolean().default(true),
}).strict().refine(a => a.values.every(r => r.length === a.values[0].length) && a.values.length * a.values[0].length <= EDIT_CELLS
  && (a.mode === 'formulas' || !a.values.flat().some(isFormulaCell))
  && a.values.flat().reduce((n, c) => n + (typeof c === 'string' ? c.length : isFormulaCell(c) ? c.formula.length : 0), 0) <= 20000);
const messages = {
  invalid: 'Use an explicit account, spreadsheet/tab IDs, zero-based range, inspected fingerprint and single-use lowercase UUID v4. At most 100 cells/20 columns/2000 units per cell/20000 total. Strings stay literal. Explicit {formula} input requires mode formulas on inspection and edit; no arbitrary requests.',
  formula_unsupported: 'Formula is outside the supported in-workbook financial grammar. Use explicit A1 references/ranges, arithmetic/comparisons and documented built-ins; no names, external/custom/script/import functions or unsupported constructs.',
  unsupported: 'The requested cells or grid data contain an unsupported structure. Default literal mode rejects formulas; explicit formulas mode allows entered formulas. Computed-only cells, rich text/chips/validation and pivot/data-source cells are not editable. Inspect a smaller supported range; do not infer which structure caused this refusal.',
  protected_tab: 'The selected tab has protected-range metadata. This editing surface does not assess or bypass protection, even outside the target. Use Google Sheets or an unprotected supported tab.',
  table_tab: 'The selected tab contains table metadata, which this editing surface cannot safely preserve. Use Google Sheets or a supported tab without tables.',
  merged_structure: 'The selected tab has malformed, overlapping, unbounded or excessive merge metadata. No edit can be prepared safely; do not infer the target cell is itself merged.',
  merged_anchor: 'The target intersects a merged range. Inspect exactly one cell at its top-left anchor for a plain-text edit; covered cells and mixed/multi-cell targets are unsupported. Do not unmerge or expand the write.',
  merged_text: 'Merged-anchor editing supports plain text or clearing in literal mode only. Formulas, numeric/typed values and format changes are not supported in a merged target.',
  merged_bounds: 'The complete merged range exceeds the inspection limit of 100 cells, 20 columns or 100 rows. No partial-footprint edit is supported; use Google Sheets.',
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
const isEmptyReply = reply => !!reply && typeof reply === 'object' && !Array.isArray(reply) && Object.keys(reply).length === 0;
export const SHEETS_RACE_WARNING = 'Google Sheets has no revision/CAS guard. A fresh comparison detects earlier changes but cannot prevent a collaborator editing between comparison and submission. This may overwrite a concurrent edit. Use a quiet editing window. Dependent formulas elsewhere may recalculate.';
export function literalRows(values) {
  // Validate here too: the internal adapter never accepts raw batch requests.
  parse(editRangeSchema, { account: 'validation', spreadsheetId: 'validation', sheetId: 0, startRow: 0, startColumn: 0,
    operationId: '00000000-0000-4000-8000-000000000000', expectedFingerprint: '0'.repeat(64), values });
  try { return values.map(row => row.map(value => { const { userEnteredValue } = cellData(value); return userEnteredValue ? { userEnteredValue } : {}; })); } catch { throw sheetsEditError('invalid'); }
}
export function editRows(values, context) {
  if (context.mode !== 'formulas') return literalRows(values);
  parse(editRangeSchema, { account: 'validation', spreadsheetId: 'validation', sheetId: context.sheetId, startRow: 0, startColumn: 0, mode: 'formulas',
    operationId: '00000000-0000-4000-8000-000000000000', expectedFingerprint: '0'.repeat(64), values });
  try { return values.map(row => row.map(value => {
    if (isFormulaCell(value)) { validateFormula(value.formula, { tabs: context.tabs, sheetId: context.sheetId }); return { userEnteredValue: { formulaValue: value.formula } }; }
    const { userEnteredValue } = cellData(value); return userEnteredValue ? { userEnteredValue } : {};
  })); } catch (e) { if (e?.sheetsEditCode) throw e; throw sheetsEditError('invalid'); }
}
export function editRequest(input) {
  if (!input || Object.keys(input).some(k => !['spreadsheetId', 'sheetId', 'startRow', 'startColumn', 'values', 'mode', 'formulaTabs'].includes(k))
    || (input.mode !== undefined && !['literal', 'formulas'].includes(input.mode)) || (input.formulaTabs !== undefined && input.mode !== 'formulas') || !fileId(input.spreadsheetId)
    || !sheetId.safeParse(input.sheetId).success || ![input.startRow, input.startColumn].every(v => index.safeParse(v).success)) throw sheetsEditError('invalid');
  return { updateCells: { start: { sheetId: input.sheetId, rowIndex: input.startRow, columnIndex: input.startColumn },
    rows: editRows(input.values, { mode: input.mode, tabs: input.formulaTabs, sheetId: input.sheetId }).map(values => ({ values })), fields: 'userEnteredValue' } };
}
// One value rectangle plus tightly scoped number-format-only updates in one batch.
export function editRequests(input) {
  const { formatTypedValues = false, ...target } = input;
  if (typeof formatTypedValues !== 'boolean') throw sheetsEditError('invalid');
  const requests = [editRequest(target)];
  if (formatTypedValues) input.values.forEach((row, y) => row.forEach((value, x) => {
    const format = isFormulaCell(value) ? undefined : cellData(value).userEnteredFormat?.numberFormat;
    if (format) requests.push({ updateCells: { start: { sheetId: input.sheetId, rowIndex: input.startRow + y, columnIndex: input.startColumn + x },
      rows: [{ values: [{ userEnteredFormat: { numberFormat: format } }] }], fields: 'userEnteredFormat.numberFormat' } });
  }));
  return requests;
}
export function inspectEditableGrid(meta, data, args) {
  const fail = (category = 'unsupported') => { throw sheetsEditError(category); };
  const { tabs, tab, mergedRange, mergeLayout, readRange } = editableLayout(meta, args, fail);
  if (data?.spreadsheetId !== args.spreadsheetId || !Array.isArray(data.sheets) || data.sheets.length !== 1 || data.sheets[0]?.properties?.sheetId !== tab.sheetId) fail();
  const blocks = data.sheets[0].data === undefined ? [] : data.sheets[0].data;
  if (!Array.isArray(blocks) || blocks.length > 1) fail();
  const b = blocks[0];
  if (b !== undefined && (!b || typeof b !== 'object' || Array.isArray(b))) fail();
  if (b && ((b.startRow === undefined ? 0 : b.startRow) !== readRange.startRow || (b.startColumn === undefined ? 0 : b.startColumn) !== readRange.startColumn)) fail();
  const source = b?.rowData === undefined ? [] : b.rowData;
  if (!Array.isArray(source) || source.length > readRange.rowCount || source.some(r => !r || typeof r !== 'object' || Array.isArray(r) || (r.values !== undefined && !Array.isArray(r.values)) || (r.values?.length || 0) > readRange.columnCount)) fail();
  const gridRows = Array.from({ length: readRange.rowCount }, (_, r) => Array.from({ length: readRange.columnCount }, (_, c) => {
    const raw = source[r]?.values?.[c];
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) fail();
    const cell = clone(raw || {});
    // A new userEnteredValue erases rich-text/chip runs. Reject rather than lose
    // them. Effective-only cells can be array/pivot output from outside range.
    if (Object.keys(cell).some(k => !['userEnteredValue', 'userEnteredFormat', 'effectiveValue', 'effectiveFormat', 'formattedValue', 'hyperlink', 'note'].includes(k))) fail();
    if (cell.userEnteredValue !== undefined && (!cell.userEnteredValue || typeof cell.userEnteredValue !== 'object' || Array.isArray(cell.userEnteredValue))) fail();
    const value = cell.userEnteredValue || {}, keys = Object.keys(value);
    if (mergedRange && (keys.some(k => k !== 'stringValue') || ((r !== 0 || c !== 0) && keys.length))) fail('merged_text');
    if (keys.length > 1 || keys.some(k => !['stringValue', 'numberValue', 'boolValue', ...(args.mode === 'formulas' ? ['formulaValue'] : [])].includes(k))) fail();
    if (keys.length) {
      const v = value[keys[0]];
      if ((keys[0] === 'formulaValue' && (typeof v !== 'string' || !v.startsWith('='))) || (keys[0] === 'stringValue' && typeof v !== 'string') || (keys[0] === 'numberValue' && (typeof v !== 'number' || !Number.isFinite(v))) || (keys[0] === 'boolValue' && typeof v !== 'boolean')) fail();
      try { cellData(v); } catch { fail(); }
    }
    if (!keys.length && Object.keys(cell.effectiveValue || {}).length) fail();
    for (const key of ['effectiveValue', 'effectiveFormat', 'formattedValue', 'hyperlink']) delete cell[key];
    // Google omits cleared/empty values and trailing empty grid data.
    if (!keys.length || value.stringValue === '') delete cell.userEnteredValue;
    if (Object.keys(cell.userEnteredFormat || {}).length === 0) delete cell.userEnteredFormat;
    return cell;
  }));
  const rows = mergedRange ? [[gridRows[0][0]]] : gridRows;
  const snapshot = { spreadsheetId: args.spreadsheetId, title: meta.properties?.title || '', tabs, ...(args.mode === 'formulas' ? { mode: 'formulas' } : {}), range: {
    sheetId: args.sheetId, startRow: args.startRow, startColumn: args.startColumn, rowCount: args.rowCount, columnCount: args.columnCount }, rows,
    ...(mergeLayout.length ? { mergeLayout } : {}), ...(mergedRange ? { mergedRange, mergedRows: gridRows } : {}) };
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
    const { tab, readRange } = editableLayout(meta, args, category => { throw sheetsEditError(category); });
    const data = await sheets.grid(record, args.spreadsheetId, tab, { ...args, ...readRange });
    return { snapshot: inspectEditableGrid(meta, data, args), ...(args.mode === 'formulas' ? { calculation: formulaCalculation(data, args) } : {}) };
  }
  async function inspect(input) {
    const args = parse(editInspectSchema, input), record = await accountRecord(args);
    const { snapshot, calculation } = await load(args, record);
    return { ...snapshot, ...(calculation ? { calculation } : {}), account: record.email, complete: true, fingerprint: digest(snapshot), concurrency: SHEETS_RACE_WARNING };
  }
  function receipt(op, outcome = op.state, extra = {}) {
    return { operationId: op.operationId, spreadsheetId: op.spreadsheetId, range: op.range, ...(op.mergedRange ? { mergedRange: op.mergedRange } : {}), outcome, receiptOnly: true,
      writeAttempted: ['writing', 'uncertain'].includes(op.state) ? 'unknown' : op.writeAttempted, retrySafe: false,
      providerAcknowledged: op.acknowledged === true, ...(op.failureReason ? { failureReason: op.failureReason } : {}), url: `https://docs.google.com/spreadsheets/d/${op.spreadsheetId}/edit`,
      guidance: op.failureReason === 'scope_required' ? messages.scope_required : 'Historical receipt only unless currentMatch is provided. Use gsheets_edit_status with the SAME account/key. Never replay or replace an uncertain operation. Readback cannot prove absence of concurrent edits or attribute matching values to this request.', ...extra };
  }
  async function update(input, signal) {
    const args = parse(editRangeSchema, input), record = await accountRecord(args);
    const range = { sheetId: args.sheetId, startRow: args.startRow, startColumn: args.startColumn, rowCount: args.values.length, columnCount: args.values[0].length };
    const hashRows = args.mode === 'formulas' ? args.values : literalRows(args.values);
    const hasTypedValues = args.values.flat().some(value => value && typeof value === 'object');
    const requestHash = digest({
      subject: record.subject, spreadsheetId: args.spreadsheetId, range, expectedFingerprint: args.expectedFingerprint, rows: hashRows,
      ...(hasTypedValues ? { typedValues: args.values } : {}),
      ...(args.formatTypedValues ? { formatTypedValues: true } : {}), ...(args.mode === 'formulas' ? { mode: 'formulas' } : {}),
    });
    let op = await operations.get(args.operationId);
    if (op && (op.subject !== record.subject || op.requestHash !== requestHash)) throw sheetsEditError('conflict');
    if (op && op.state !== 'proposed') return receipt(op);
    if (!op && !args.preview) throw sheetsEditError('preview_required');
    const loaded = await load({ ...args, ...range }, record), before = loaded.snapshot;
    const rows = editRows(args.values, { mode: args.mode, tabs: before.tabs, sheetId: args.sheetId });
    if (digest(before) !== args.expectedFingerprint) throw sheetsEditError('stale');
    if (before.mergedRange && (args.formatTypedValues || args.values[0][0] !== null && typeof args.values[0][0] !== 'string')) throw sheetsEditError('merged_text');
    const after = clone(before);
    after.rows.forEach((row, r) => row.forEach((cell, c) => {
      delete cell.userEnteredValue; Object.assign(cell, rows[r][c]);
      const format = args.formatTypedValues && !isFormulaCell(args.values[r][c]) ? cellData(args.values[r][c]).userEnteredFormat?.numberFormat : undefined;
      if (format) cell.userEnteredFormat = { ...cell.userEnteredFormat, numberFormat: format };
    }));
    if (after.mergedRows) after.mergedRows[0][0] = clone(after.rows[0][0]);
    if (digest(before) === digest(after)) throw sheetsEditError('invalid');
    if (!op) {
      op = { operationId: args.operationId, subject: record.subject, spreadsheetId: args.spreadsheetId, range, requestHash,
        beforeHash: digest(before), afterHash: digest(after), ...(before.mergedRange ? { mergedRange: before.mergedRange } : {}), ...(args.mode === 'formulas' ? { mode: 'formulas' } : {}), state: 'proposed', writeAttempted: false, createdAt: clock() };
      if (!await operations.reserve(op)) {
        const current = await operations.get(op.operationId);
        if (!current || current.subject !== record.subject || current.requestHash !== requestHash) throw sheetsEditError('conflict');
        return receipt(current);
      }
    }
    const proposal = { ...(args.mode === 'formulas' ? { mode: 'formulas', calculation: loaded.calculation } : {}), account: record.email, spreadsheetId: args.spreadsheetId, title: before.title, tabTitle: before.tabs.find(t => t.sheetId === args.sheetId).title,
      operationId: op.operationId, range, ...(before.mergedRange ? { mergedRange: before.mergedRange } : {}), before: before.rows.map(row => row.map(c => c.userEnteredValue || null)), values: args.values, formatTypedValues: args.formatTypedValues, beforeFormats: before.rows.map(row => row.map(c => c.userEnteredFormat?.numberFormat || null)), concurrency: SHEETS_RACE_WARNING };
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
      if (digest(current.snapshot) !== op.beforeHash) return await finish('conflict');
      if (signal?.aborted) return await finish('cancelled');
      const writeInput = { spreadsheetId: args.spreadsheetId, sheetId: args.sheetId, startRow: args.startRow,
        startColumn: args.startColumn, values: args.values, formatTypedValues: args.formatTypedValues,
        ...(args.mode === 'formulas' ? { mode: 'formulas', formulaTabs: before.tabs } : {}) };
      const expectedReplyCount = editRequests(writeInput).length;
      // Durable claim precedes the only possible mutation. No compare-and-swap
      // is available at Google: this final comparison cannot close the race.
      if (!await operations.start({ ...op, state: 'writing', writeAttempted: true })) {
        const current = await operations.get(op.operationId);
        return receipt(current || op, current?.state || 'not_submitted');
      }
      op.state = 'writing'; op.writeAttempted = true; writing = true;
      let response;
      try { response = await writer.update(writeInput, signal); }
      catch (error) {
        diagnose('sheets_edit_write', error);
        if (error?.sheetsWriteAttempted === false) { writing = false; op.writeAttempted = false; op.failureReason = sheetsEditCategory(error); return await finish('not_submitted'); }
        return await finish(error?.sheetsRejected === true ? 'rejected' : 'uncertain');
      }
      const validResponse = response?.spreadsheetId === args.spreadsheetId && Array.isArray(response.replies)
        && response.replies.length === expectedReplyCount && response.replies.every(isEmptyReply);
      if (!validResponse) { diagnose('sheets_edit_write_response', undefined); return await finish('uncertain'); }
      op.acknowledged = true;
      const observed = await load({ ...args, ...range }, record);
      const matches = digest(observed.snapshot) === op.afterHash;
      if (!matches) diagnose('sheets_edit_readback_mismatch', undefined);
      return await finish(matches ? 'verified' : 'unverified', { receiptOnly: false, currentMatch: matches, ...(observed.calculation ? { calculation: observed.calculation, formulaReadbackMatches: matches } : {}),
        verification: (before.mergedRange ? 'The anchor text, complete bounded merged footprint and merge geometry were compared; only the anchor value was submitted. ' : '') + 'Only the bounded target values, cell formatting/notes and tab metadata were compared. Other cells/tabs are outside the write mask, not independently read back. Dependent formulas may recalculate. Concurrent overwrites cannot be excluded.' });
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
      const observed = await load({ spreadsheetId: op.spreadsheetId, ...op.range, ...(op.mode === 'formulas' ? { mode: 'formulas' } : {}) }, record);
      const matches = digest(observed.snapshot) === op.afterHash;
      // Read only, including the durable receipt. Do not release an unresolved
      // lock based on equal values: a timed-out Google request may still apply.
      return receipt(op, op.acknowledged ? matches ? 'verified' : 'unverified' : matches ? 'observed_matching' : op.state,
        { receiptOnly: false, currentMatch: matches, ...(observed.calculation ? { calculation: observed.calculation, formulaReadbackMatches: matches } : {}), unresolvedLock: ['reviewing', 'writing', 'uncertain'].includes(op.state),
          operationState: op.state, guidance: op.acknowledged ? 'Fresh bounded readback. This does not certify later edits or absence of a concurrent overwrite.'
            : 'Matching values do not prove this operation applied or that an in-flight request has finished. Unresolved locks stay held. Do not replay, replace the key, or force-unlock; reconcile with the owner.' });
    } catch (error) { diagnose('sheets_edit_status', error); return receipt(op, 'verification_unavailable'); }
  }
  return { inspect, update, status };
}
