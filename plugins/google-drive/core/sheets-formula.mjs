// Small non-evaluating, fail-closed Sheets formula grammar. This is NOT a
// general Sheets/Excel parser and never executes a formula or resolves a URL.
const arity = {
  SUM: [1, 50], AVERAGE: [1, 50], MIN: [1, 50], MAX: [1, 50], COUNT: [1, 50], COUNTA: [1, 50],
  IF: [2, 3], IFERROR: [2, 2], IFNA: [2, 2], AND: [1, 50], OR: [1, 50], NOT: [1, 1],
  ABS: [1, 1], ROUND: [1, 2], ROUNDUP: [2, 2], ROUNDDOWN: [2, 2], INT: [1, 1], MOD: [2, 2],
  SUMIF: [2, 3], SUMIFS: [3, 51], COUNTIF: [2, 2], COUNTIFS: [2, 50], AVERAGEIF: [2, 3], AVERAGEIFS: [3, 51], SUMPRODUCT: [1, 30],
  NPV: [2, 50], IRR: [1, 2], XNPV: [3, 3], XIRR: [2, 3], PMT: [3, 5], PV: [3, 5], FV: [3, 5], NPER: [3, 5], RATE: [3, 6], IPMT: [4, 6], PPMT: [4, 6],
  INDEX: [3, 3], MATCH: [2, 3], VLOOKUP: [3, 4], HLOOKUP: [3, 4],
  DATE: [3, 3], YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], DAYS: [2, 2], EDATE: [2, 2], EOMONTH: [2, 2], TRUE: [0, 0], FALSE: [0, 0], NA: [0, 0],
};
export const FORMULA_FUNCTIONS = Object.keys(arity);
const isRange = node => node.type === 'range';
const isReference = node => ['reference', 'range'].includes(node.type);
const positiveIndex = node => node.type === 'number' && Number.isInteger(node.number) && node.number > 0;
function scalarArguments(name, args) {
  if (['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'SUMPRODUCT', 'AND', 'OR'].includes(name)) return true;
  if (name === 'NPV') return !isRange(args[0]);
  if (name === 'IRR') return args.length < 2 || !isRange(args[1]);
  if (name === 'XNPV') return !isRange(args[0]) && args.slice(1).every(isReference);
  if (name === 'XIRR') return args.slice(0, 2).every(isReference) && (args.length < 3 || !isRange(args[2]));
  if (['SUMIF', 'AVERAGEIF'].includes(name)) return isReference(args[0]) && !isRange(args[1]) && (args.length < 3 || isReference(args[2]));
  if (['SUMIFS', 'AVERAGEIFS'].includes(name)) return isReference(args[0]) && args.slice(1).every((a, i) => i % 2 === 0 ? isReference(a) : !isRange(a));
  if (['COUNTIF', 'COUNTIFS'].includes(name)) return args.every((a, i) => i % 2 === 0 ? isReference(a) : !isRange(a));
  if (name === 'INDEX') return isReference(args[0]) && args.slice(1).every(positiveIndex);
  if (['VLOOKUP', 'HLOOKUP'].includes(name)) return !isRange(args[0]) && isReference(args[1]) && positiveIndex(args[2]) && (args.length < 4 || !isRange(args[3]));
  if (name === 'MATCH') return !isRange(args[0]) && isReference(args[1]) && (args.length < 3 || !isRange(args[2]));
  return args.every(a => !isRange(a));
}
export const formulaError = () => Object.assign(new Error('Formula is outside the supported in-workbook financial grammar. Use explicit A1 references/ranges, arithmetic/comparisons and documented built-ins; no names, external/custom/script/import functions or unsupported constructs.'), { sheetsEditCode: 'formula_unsupported' });
function tokens(text) {
  const result = [];
  for (let p = 1; p < text.length;) {
    const c = text[p];
    if (/\s/.test(c)) { if (![' ', '\t', '\n'].includes(c)) throw formulaError(); p++; continue; }
    if (c === '"' || c === "'") {
      const quote = c; let value = ''; p++; let closed = false;
      while (p < text.length) {
        if (text[p] === quote) { p++; if (text[p] === quote) { value += quote; p++; } else { closed = true; break; } }
        else { value += text[p++]; }
      }
      if (!closed) throw formulaError(); result.push({ type: quote === '"' ? 'string' : 'sheet', value });
    } else {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(text.slice(p));
      const word = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(text.slice(p));
      if (number) { if (!Number.isFinite(Number(number[0]))) throw formulaError(); result.push({ type: 'number', value: number[0] }); p += number[0].length; }
      else if (word) { result.push({ type: 'word', value: word[0] }); p += word[0].length; }
      else {
        const op = ['<=', '>=', '<>'].find(op => text.startsWith(op, p)) || c;
        if (!['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '%', '=', '<', '>', '(', ')', ',', ':', '!'].includes(op)) throw formulaError();
        result.push({ type: op, value: op }); p += op.length;
      }
    }
    if (result.length > 512) throw formulaError();
  }
  return result;
}
export function validateFormula(text, { tabs, sheetId }) {
  if (typeof text !== 'string' || text[0] !== '=' || text.length < 2 || text.length > 2000 || !text.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)
    || !Array.isArray(tabs) || tabs.length < 1 || tabs.length > 100) throw formulaError();
  const current = tabs.find(t => t.sheetId === sheetId);
  const queue = tokens(text); let p = 0, depth = 0; const references = [], functions = [];
  const peek = type => queue[p]?.type === type;
  const take = type => { if (!peek(type)) throw formulaError(); return queue[p++]; };
  function coordinate(value, tab) {
    const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,7})$/.exec(value);
    if (!m || !tab || (tab.sheetType && tab.sheetType !== 'GRID') || !Number.isSafeInteger(tab.gridProperties?.rowCount) || !Number.isSafeInteger(tab.gridProperties?.columnCount)) throw formulaError();
    const row = Number(m[2]), column = [...m[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    if (row > tab.gridProperties.rowCount || column > tab.gridProperties.columnCount) throw formulaError();
    return { row, column };
  }
  function reference(first, tab) {
    const start = coordinate(first, tab); let end = start;
    if (peek(':')) { take(':'); end = coordinate(take('word').value, tab); }
    if (end.row < start.row || end.column < start.column || (end.row - start.row + 1) * (end.column - start.column + 1) > 100000) throw formulaError();
    references.push({ sheetId: tab.sheetId, start, end }); return { type: start.row === end.row && start.column === end.column ? 'reference' : 'range' };
  }
  function atom() {
    if (++depth > 32) throw formulaError(); let node;
    if (peek('+') || peek('-')) { p++; node = atom(); if (isRange(node)) throw formulaError(); node = { type: 'unary' }; }
    else if (peek('(')) { take('('); node = expression(0); take(')'); }
    else if (peek('number') || peek('string')) { const token = queue[p++]; node = { type: token.type, ...(token.type === 'number' ? { number: Number(token.value) } : {}) }; }
    else if (peek('word') || peek('sheet')) {
      const first = queue[p++];
      if (peek('!')) {
        take('!'); const matching = tabs.filter(t => t.title === first.value);
        if (matching.length !== 1) throw formulaError(); node = reference(take('word').value, matching[0]);
      } else if (first.type === 'sheet') throw formulaError();
      else if (peek('(')) {
        const name = first.value.toUpperCase(), limits = Object.hasOwn(arity, name) && arity[name]; if (!limits) throw formulaError();
        take('('); const args = [];
        if (!peek(')')) { do { args.push(expression(0)); if (args.length > limits[1]) throw formulaError(); if (!peek(',')) break; take(','); } while (true); }
        take(')'); const count = args.length;
        if (count < limits[0] || (name === 'COUNTIFS' && count % 2 !== 0) || (['SUMIFS', 'AVERAGEIFS'].includes(name) && count % 2 !== 1) || !scalarArguments(name, args)) throw formulaError();
        functions.push(name); node = { type: 'call' };
      } else if (['TRUE', 'FALSE'].includes(first.value.toUpperCase())) node = { type: 'boolean' };
      else node = reference(first.value, current);
    } else throw formulaError();
    if (peek('%')) { take('%'); if (isRange(node)) throw formulaError(); node = { type: 'percent' }; }
    depth--; return node;
  }
  const precedence = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  function expression(minimum) {
    let left = atom();
    while (Object.hasOwn(precedence, queue[p]?.type) && precedence[queue[p].type] >= minimum) {
      const op = queue[p++].type, right = expression(precedence[op] + 1);
      if (isRange(left) || isRange(right)) throw formulaError(); left = { type: 'binary' };
    }
    return left;
  }
  if (!current) throw formulaError(); const root = expression(0); if (isRange(root) || p !== queue.length) throw formulaError();
  return { references, functions: [...new Set(functions)] };
}
// Value-only evidence: never provider messages or instructions. Calculation is
// independent of entered-formula verification, may be delayed, and can drift.
export function formulaCalculation(data, range) {
  const result = []; let textBudget = 4000; const allowed = ['ERROR', 'NULL_VALUE', 'DIVIDE_BY_ZERO', 'VALUE', 'REF', 'NAME', 'NUM', 'N_A', 'LOADING'];
  const rows = data?.sheets?.[0]?.data?.[0]?.rowData || [];
  for (let y = 0; y < range.rowCount; y++) for (let x = 0; x < range.columnCount; x++) {
    const c = rows[y]?.values?.[x]; if (typeof c?.userEnteredValue?.formulaValue !== 'string') continue;
    const v = c.effectiveValue || {}, error = v.errorValue?.type;
    const text = typeof v.stringValue === 'string' ? v.stringValue.slice(0, Math.min(200, textBudget)) : undefined;
    if (text !== undefined) textBudget -= text.length;
    result.push({ row: range.startRow + y, column: range.startColumn + x,
      calculation: error ? { errorType: allowed.includes(error) ? error : 'UNKNOWN' }
        : typeof v.numberValue === 'number' && Number.isFinite(v.numberValue) ? { number: v.numberValue }
          : typeof v.boolValue === 'boolean' ? { boolean: v.boolValue }
            : text !== undefined ? { text, truncated: v.stringValue.length > text.length }
              : { pending: true } });
  }
  // JSON escaping can expand control characters sixfold. Calculation evidence
  // is optional; keep its SERIALIZED budget separate from raw text units.
  for (let i = result.length - 1; JSON.stringify(result).length > 12000 && i >= 0; i--) {
    const calculation = result[i].calculation;
    if (typeof calculation.text === 'string') { calculation.text = ''; calculation.truncated = true; }
  }
  return result;
}
