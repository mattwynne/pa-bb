// Pure metadata planning. A merged text edit writes only its exact anchor;
// inspection covers the complete, bounded merge without unmerging anything.
export const MAX_EDIT_MERGES = 256;
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const intersects = (a, b) => a.startRow < b.startRow + b.rowCount && b.startRow < a.startRow + a.rowCount
  && a.startColumn < b.startColumn + b.columnCount && b.startColumn < a.startColumn + a.columnCount;
export function editableLayout(meta, args, fail) {
  if (meta?.spreadsheetId !== args.spreadsheetId || !Array.isArray(meta.sheets) || !meta.sheets.length || meta.sheets.length > 100) fail('unsupported');
  const tabs = meta.sheets.map(s => s?.properties);
  if (tabs.some(t => !Number.isSafeInteger(t?.sheetId) || typeof t?.title !== 'string') || new Set(tabs.map(t => t.sheetId)).size !== tabs.length) fail('unsupported');
  const selected = meta.sheets.find(s => s.properties.sheetId === args.sheetId), tab = selected?.properties;
  const size = tab?.gridProperties;
  if (!tab || (tab.sheetType && tab.sheetType !== 'GRID') || !Number.isSafeInteger(size?.rowCount) || size.rowCount < 1
    || !Number.isSafeInteger(size?.columnCount) || size.columnCount < 1 || !['startRow', 'startColumn', 'rowCount', 'columnCount'].every(k => Number.isSafeInteger(args[k]))
    || args.startRow < 0 || args.startColumn < 0 || args.rowCount < 1 || args.columnCount < 1 || args.rowCount * args.columnCount > 100 || args.columnCount > 20
    || args.startRow + args.rowCount > size.rowCount || args.startColumn + args.columnCount > size.columnCount) fail('unsupported');
  // Protection and table semantics are deliberately not relaxed by merge support.
  for (const [key, category] of [['protectedRanges', 'protected_tab'], ['tables', 'table_tab']]) {
    if (selected[key] !== undefined && (!Array.isArray(selected[key]) || selected[key].length)) fail(category);
  }
  if (selected.merges !== undefined && (!Array.isArray(selected.merges) || selected.merges.length > MAX_EDIT_MERGES)) fail('merged_structure');
  const mergeLayout = (selected.merges || []).map(m => {
    if (!object(m) || Object.keys(m).some(k => !['sheetId', 'startRowIndex', 'endRowIndex', 'startColumnIndex', 'endColumnIndex'].includes(k))
      || (m.sheetId !== undefined && m.sheetId !== tab.sheetId)) fail('merged_structure');
    const startRow = m.startRowIndex === undefined ? 0 : m.startRowIndex, startColumn = m.startColumnIndex === undefined ? 0 : m.startColumnIndex;
    if (![startRow, startColumn, m.endRowIndex, m.endColumnIndex].every(Number.isSafeInteger) || startRow < 0 || startColumn < 0
      || m.endRowIndex <= startRow || m.endColumnIndex <= startColumn || m.endRowIndex > size.rowCount || m.endColumnIndex > size.columnCount
      || (m.endRowIndex - startRow) * (m.endColumnIndex - startColumn) < 2) fail('merged_structure');
    return { sheetId: tab.sheetId, startRow, startColumn, rowCount: m.endRowIndex - startRow, columnCount: m.endColumnIndex - startColumn };
  }).sort((a, b) => a.startRow - b.startRow || a.startColumn - b.startColumn || a.rowCount - b.rowCount || a.columnCount - b.columnCount);
  for (let i = 0; i < mergeLayout.length; i++) for (let j = i + 1; j < mergeLayout.length; j++) if (intersects(mergeLayout[i], mergeLayout[j])) fail('merged_structure');
  const touching = mergeLayout.filter(m => intersects(m, args));
  let mergedRange;
  if (touching.length) {
    const m = touching[0];
    if (touching.length !== 1 || args.rowCount !== 1 || args.columnCount !== 1 || args.startRow !== m.startRow || args.startColumn !== m.startColumn) fail('merged_anchor');
    if (args.mode === 'formulas') fail('merged_text');
    if (m.rowCount > 100 || m.columnCount > 20 || m.rowCount * m.columnCount > 100) fail('merged_bounds');
    mergedRange = m;
  }
  const range = { sheetId: tab.sheetId, startRow: args.startRow, startColumn: args.startColumn, rowCount: args.rowCount, columnCount: args.columnCount };
  return { tabs, tab, range, mergeLayout, mergedRange, readRange: mergedRange || range };
}
