# Explicit bounded financial formulas

Formula authoring extends the existing Sheets inspection/preview/review/receipt
workflow; it is not a general editor, Excel importer or arbitrary API. Plain
strings, including `"=SUM(A1:A10)"`, remain literal **in every mode**. Native
creation remains literal-only. Existing edit tools gain an explicit opt-in:

```json
{
  "account":"writer@example.com", "spreadsheetId":"example-id", "sheetId":7,
  "startRow":2, "startColumn":1, "rowCount":1, "columnCount":2,
  "mode":"formulas"
}
```

Call **`gsheets_inspect_for_edit`** with those fields. Default `mode:"literal"`
retains its rejection of formula cells. Formula mode can inspect current entered
formulas, including unsupported pre-existing formulas, **as untrusted data**.
Inspection never evaluates instructions, submits a formula or approves changes.
Effective-only array/pivot output remains unsupported. Merges, protected ranges
and tables on the selected tab remain conservatively rejected; this change does
not relax structural protections.

Then preview **`gsheets_update_range`**:

```json
{
  "account":"writer@example.com", "spreadsheetId":"example-id", "sheetId":7,
  "startRow":2, "startColumn":1, "mode":"formulas",
  "operationId":"fe638131-e722-4d66-9712-05dd34650283",
  "expectedFingerprint":"<fingerprint from the formula-mode inspection>",
  "values":[[{"formula":"=SUM(A1:A2)"},"=SUM(A1:A2)"]],
  "preview":true
}
```

The first cell is an actual formula; the second is a literal string. A formula
object requires both explicit formula mode and an explicit user-requested
formula edit. Null still clears; ordinary numbers/booleans, dates and CAD work
as before. Apply identical arguments/key with `preview:false`, then approve the
exact before/after review. The card labels Formula versus Literal string and
warns about calculation and concurrency. The Docs approval preference never
bypasses it. Existing formulas are shown exactly before replacement; unsupported
old formulas are not automatically copied into new formula inputs.

## Supported grammar, not full Sheets compatibility

The non-evaluating tokenizer and recursive parser require complete consumption
of a formula beginning `=`. They accept:

- Finite decimal/scientific numeric literals, double-quoted strings with doubled
  quote escaping, booleans and parentheses; unary `+`/`-`, postfix `%`, arithmetic
  `+ - * / ^`, text concatenation `&` and comparisons `= <> < > <= >=`.
- Explicit A1 cells and ascending rectangular ranges, with optional `$` absolute
  markers. Unqualified references mean the target tab. Use `Budget!A1` or
  `'Forecast''s year'!$A$1:B10` for an existing tab in the same workbook; quoted
  names escape apostrophes by doubling them. Referenced tabs must be GRID tabs
  with known dimensions and exact title matches. No URLs, spreadsheet IDs or
  host/file paths are resolved.
- Comma-separated calls to this fixed, case-insensitive set, with bounded checked
  arity: `SUM AVERAGE MIN MAX COUNT COUNTA IF IFERROR IFNA AND OR NOT ABS ROUND
  ROUNDUP ROUNDDOWN INT MOD SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS
  SUMPRODUCT NPV IRR XNPV XIRR PMT PV FV NPER RATE IPMT PPMT INDEX MATCH VLOOKUP
  HLOOKUP DATE YEAR MONTH DAY DAYS EDATE EOMONTH TRUE FALSE NA`.

Ranges are accepted only in explicitly supported reducer/financial/lookup argument positions, never as the root result or in scalar arithmetic/IF branches. This avoids authoring direct multi-cell spill expressions. INDEX requires exactly three arguments and positive integer literal row/column selectors (no zero/omitted/dynamic selectors). VLOOKUP/HLOOKUP require positive integer literal result indexes. SUMPRODUCT accepts separate finite ranges, not vector arithmetic expressions.

Unknown syntax/functions fail closed, rather than guessing a meaning. Explicitly
unsupported: named ranges/functions, custom/script functions, external data or
cross-spreadsheet imports (`IMPORTRANGE`, `IMPORTDATA`, `IMPORTXML`, `IMAGE`,
`HYPERLINK`, etc.), dynamic references (`INDIRECT`, `OFFSET`), array literals,
LAMBDA/LET, spilled/implicit intersection syntax, whole-row/column ranges, union/
3D ranges, locale semicolon separators and Excel compatibility namespaces. Do
not bypass a refusal by changing scopes, using generic requests or pretending
formula text is a supported typed input. Strings may contain URL-looking text
because strings are inert; no allowed function fetches that text.

Limits: existing 100-cell/20-column/100-row rectangle; at most 2,000 UTF-16 units
per formula and 20,000 total string+formula input units, 512 tokens per formula,
32 nested expression/call levels and at most 100,000 cells per referenced
rectangle within known sheet dimensions. Range/scalar argument shapes and fixed positive lookup indexes are checked;
whole-workbook dependencies, cell values and financial semantics are not
evaluated locally. Financial formulas can be syntactically
supported but financially wrong or produce provider errors.

These rules prevent authoring direct external-fetch/custom/script constructs
through this tool, **not** an audit of pre-existing workbook behavior. Existing
referenced cells/dependent formulas may already fetch external data or recalculate.
The tool cannot promise a workbook-wide network-free recalculation. It does not
execute source instructions, formulas, scripts, macros or links locally.

## Preservation and verification

The same adapter builds a bounded `updateCells` request using only
`userEnteredValue`. Only explicit formula objects produce `formulaValue`; normal
strings always produce `stringValue`. Notes/styles/merges and unrelated cells
are outside the write mask. `formatTypedValues:true` still requires an explicit
formatting request and changes only the fixed DATE/CAD number formats on those
typed cells—not on formula cells. The new mode never expands existing grants,
settings, identity handling, sharing or invitations.

Inspection fingerprints include entered formulas and tab metadata but exclude
volatile calculated values/results. Formula-mode and default-literal fingerprints
are distinct. Fresh post-approval inspection must match before submission; Google
Sheets still has **no revision/CAS guard**, so a concurrent edit racing the last
comparison can be overwritten. The review warns about this and recommends a
quiet window. No formula grammar or comparison creates a native revision lock.

`outcome:"verified"` and `formulaReadbackMatches:true` mean an acknowledged batch
followed by exact bounded entered-value/formula, retained format/note and tab
metadata readback. They do **not** mean calculation succeeded or that financial
results are correct. Separate `calculation` evidence gives zero-based coordinates
and current numeric/boolean/text results, error types or `pending:true`.
Provider error messages are never returned; string results are limited to200
units per cell/4,000 raw total, with truncation flags. Serialized calculation evidence is separately capped at12,000 units, including JSON escaping; oversized optional UI evidence is omitted rather than disabling an otherwise exact approval. Calculation can be delayed or
change later. `#REF!`, division by zero, other errors and pending results neither
undo a saved formula nor authorize replay, rollback or a replacement key.

## Same receipts and read-only recovery

Formula mode uses the same account/request-bound single-use SQLite edit receipts,
spreadsheet-wide cross-account claims, mandatory review, preview expiry and
original-key **`gsheets_edit_status`**. Receipts add a mode flag only for new
formula operations; they retain hashes, not formula/value contents. Old literal,
date/CAD and historical primitive proposal hashes are preserved. Existing
unresolved locks remain unchanged.

Status restores the saved inspection mode. It only reads; it never updates the
receipt, retries, repairs, rolls back or force-unlocks. An unacknowledged matching
formula is `observed_matching`, not attributed completion, and remains locked.
Acknowledged but mismatching/unavailable formula readback is unverified. Keep the
original account/key after interruption; do not bypass it with a fresh operation.

Tests use synthetic workbooks/fake transport and disposable SQLite/native BB.
They cover grammar allow/deny cases, default literal behavior, existing formula
inspection, exact formula/format/note preservation, typed dates/CAD, native owner
review, errors/pending calculation, staleness, old receipts, missing grants and
lost-response recovery. No real business formula write is an engineering test.
Diagnostics retain existing fixed Sheets stages and a bounded
`formula_unsupported` category—no formula text, cell results, account identifiers,
credentials or raw provider exception/body. Read-only
`bb plugin rpc call google-drive sheetsFormulaCapabilities --json` reports the
running formula contract without accessing a Google file.
