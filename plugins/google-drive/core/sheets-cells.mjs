// Pure literal-to-CellData encoding shared by creation and editing.
const dateNumber = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') return null;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms / 86400000 + 25569 : null;
};
// ExtendedValue.stringValue is always literal, including =, +, -, @ prefixes.
// No formulaValue input is accepted. Dates are civil dates, not local instants.
export function cellData(value) {
  if (value === null || value === '') return {};
  if (typeof value === 'string') {
    if (value.length > 2000 || !value.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value)) throw new Error('invalid cell');
    return { userEnteredValue: { stringValue: value } };
  }
  if (typeof value === 'number' && Number.isFinite(value)) return { userEnteredValue: { numberValue: value } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (value && typeof value === 'object' && Object.keys(value).length === 1) {
    if (Object.hasOwn(value, 'date') && dateNumber(value.date) !== null) return { userEnteredValue: { numberValue: dateNumber(value.date) }, userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } };
    if (Object.hasOwn(value, 'cad') && typeof value.cad === 'number' && Number.isFinite(value.cad)) return { userEnteredValue: { numberValue: value.cad }, userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"CAD "#,##0.00;[Red]-"CAD "#,##0.00' } } };
  }
  throw new Error('invalid cell');
}
