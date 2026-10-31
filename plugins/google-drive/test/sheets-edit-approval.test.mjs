// Escaping/validation tests, not a substitute for rendered native BB review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const componentFile = new URL('./sheets-edit-approval.generated.mjs', import.meta.url);
const connectionFile = new URL('./sheets-edit-connection.generated.mjs', import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
// Literal imports remain inspectable by BB's public-SDK scanner. Exclusive
// creation prevents concurrent test runs from overwriting each other's files.
const created = [];
let SheetsEditApproval;
try {
  await writeFile(connectionFile, compile(await readFile(new URL('../connection-ui.tsx', import.meta.url), 'utf8')), { flag: 'wx' });
  created.push(connectionFile);
  await writeFile(componentFile, compile((await readFile(new URL('../sheets-edit-approval.tsx', import.meta.url), 'utf8')).replace('./connection-ui.js', './sheets-edit-connection.generated.mjs').replace("import './sheets-edit-approval.css';", '')), { flag: 'wx' });
  created.push(componentFile);
  ({ SheetsEditApproval } = await import('./sheets-edit-approval.generated.mjs'));
} finally {
  await Promise.all(created.map(file => unlink(file)));
}
const p = { account: 'owner@example.test', spreadsheetId: 'sheet-a', operationId: '11111111-1111-4111-8111-111111111111', title: '<script>private</script>', tabTitle: 'Plan',
  range: { sheetId: 7, startRow: 2, startColumn: 1, rowCount: 1, columnCount: 2 }, before: [[{ stringValue: '<script>old</script>' }, { boolValue: false }]], values: [['=SUM(A1)', null]], concurrency: 'No revision/CAS; concurrent overwrites are possible.' };
const render = payload => renderToStaticMarkup(createElement(SheetsEditApproval, { interaction: { id: 'fixture', payload }, submit: async () => {}, cancel: async () => {} }));
test('exact typed before/after, coordinates, clearing, warning and preservation with escaped strings', () => {
  const html = render(p);
  for (const text of ['owner@example.test','B3','C3','Literal string:','Boolean: false','Blank (clear)','=SUM(A1)','No revision/CAS','Notes and other formatting stay','Approve edit','Cancel review']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /spreadsheets\/d\/sheet-a\/edit#gid=7/);
});
test('incomplete/malformed approvals fail closed and synthetic examples have no live Google link', () => {
  for (const payload of [null, {}, { ...p, values: [[1]] }, { ...p, before: [[{}, null]] }, { ...p, values: [[{ formulaValue: '=1' }, null]] }, { ...p, spreadsheetId: 'javascript:bad' }, { ...p, values: [[{date:'2024-02-29'}, null]], formatTypedValues: true }]) {
    const html = render(payload); assert.match(html, /details are incomplete/); assert.match(html, /disabled=""[^>]*>Approve edit/); assert.doesNotMatch(html, /href=/);
  }
  const html = render({ ...p, exampleOnly: true }); assert.match(html, /Every choice is a no-op/); assert.doesNotMatch(html, /href=/);
});

test('explicit formula review labels formulas versus literal strings and separates calculation evidence', () => {
  const payload = { ...p, mode: 'formulas', before: [[{ formulaValue: '=1/0' }, { stringValue: '=literal' }]], values: [[{ formula: '=SUM(A1:A2)' }, '=SUM(A1:A2)']], calculation: [{ row: 2, column: 1, calculation: { errorType: 'DIVIDE_BY_ZERO' } }] };
  const html = render(payload);
  for (const text of ['Formulas mode', 'Formula: =1/0', 'Formula: =SUM(A1:A2)', 'Literal string:', 'separate from calculation success', 'neither triggers retry', 'DIVIDE_BY_ZERO']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /disabled=""[^>]*>Approve edit/);
  assert.match(render({ ...payload, mode: 'literal' }), /details are incomplete/);
  const expanded = render({...payload, calculation: Array.from({length: 20}, () => ({calculation: {text: '\u0001'.repeat(200)}}))});
  assert.match(expanded, /Optional calculation evidence omitted/); assert.doesNotMatch(expanded, /disabled=""[^>]*>Approve edit/);
});

test('merged anchor review names complete extent, exact top-left write and retained layout', () => {
  const payload = {...p, range: {...p.range,columnCount:1}, before: [[{stringValue:'Old text'}]], values: [['New text']], mergedRange: {sheetId:7,startRow:2,startColumn:1,rowCount:1,columnCount:3}};
  const html = render(payload);
  for (const text of ['Merged text: B3:D3', 'updating only B3', 'top-left cell', 'merge, cell notes and formatting stay intact', 'complete merged area', 'Exact merged-cell text change', 'Old text', 'New text']) assert.ok(html.includes(text),text);
  assert.doesNotMatch(html, /disabled=""[^>]*>Approve edit/);
  for (const patch of [{mergedRange:null}, {mergedRange:{...payload.mergedRange,startColumn:2}}, {mergedRange:{...payload.mergedRange,columnCount:21}}, {mergedRange:{...payload.mergedRange,rowCount:100}}, {mergedRange:{...payload.mergedRange,extra:true}}, {values:[[{cad:5}]]}, {before:[[{numberValue:1}]]}, {mode:'formulas'}, {formatTypedValues:true}]) {
    const rejected = render({...payload,...patch}); assert.match(rejected,/details are incomplete/); assert.match(rejected,/disabled=""[^>]*>Approve edit/); assert.doesNotMatch(rejected,/href=/);
  }
});

test('typed date and CAD format changes are explicit in approval', () => {
  const html = render({ ...p, values: [[{date: '2024-02-29'}, {cad: 12.5}]], formatTypedValues: true, beforeFormats: [[{type:'TEXT'}, null]] });
  for (const text of ['Civil date: 2024-02-29', 'CAD amount: 12.5', 'Number format before:', 'DATE yyyy-mm-dd', 'CURRENCY']) assert.ok(html.includes(text), text);
  const preserved = render({ ...p, values: [[{date:'2024-02-29'}, {cad:12.5}]], formatTypedValues: false }); assert.match(preserved, /Existing number formats stay/);
});
