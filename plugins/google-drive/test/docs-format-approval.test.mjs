// SSR checks are not the mandatory rendered-BB/keyboard review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const componentFile = new URL('./format-approval.generated.mjs', import.meta.url);
const connectionFile = new URL('./format-connection.generated.mjs', import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
await writeFile(connectionFile, compile(await readFile(new URL('../connection-ui.tsx', import.meta.url), 'utf8')));
await writeFile(componentFile, compile((await readFile(new URL('../docs-format-approval.tsx', import.meta.url), 'utf8')).replace('./connection-ui.js', './format-connection.generated.mjs').replace('./core/docs-page-format.mjs', '../core/docs-page-format.mjs')));
const { DocsFormatApproval } = await import('./format-approval.generated.mjs');
test.after(async () => { await unlink(componentFile); await unlink(connectionFile); });
const payload = { account: 'writer@example.test', operationId: '11111111-1111-4111-8111-111111111111', documentId: 'doc-a', title: 'Proposal <script>bad</script>',
  expectedRevisionId: 'rev-a', selections: [{ tabId: 'main', startIndex: 1, endIndex: 8, textStyle: { fontFamily: 'Inter', sizePt: 30 }, paragraphStyle: { lineSpacing: 120 },
    paragraphs: [{ text: 'Exact <script>bad</script>\n', paragraphStyle: {}, runs: [{ startIndex: 1, endIndex: 8, textStyle: {} }] }] }],
  page: { before: {}, after: { tabId: 'main', size: 'LETTER', marginLeftPt: 61.2 } }, limits: 'Font readback does not prove rendering.' };
const render = p => renderToStaticMarkup(createElement(DocsFormatApproval, { interaction: { id: 'synthetic', payload: p }, submit: async () => {}, cancel: async () => {} }));
test('format card shows exact text/settings/account/revision, inheritance and rendering limits with escaped data', () => {
  const html = render(payload);
  for (const text of ['writer@example.test', 'rev-a', 'fontFamily: Inter', 'sizePt: 30', 'lineSpacing: 120', 'marginLeftPt: 61.2', '72 pt = 1 inch', 'Other page settings and tabs stay unchanged', 'Missing properties inherit', 'No write has happened', 'Approve formatting', 'Decline', 'Cancel review']) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /https:\/\/docs.google.com\/document\/d\/doc-a\/edit/);
});
test('colour-only approval names the exact opaque page colour without inventing Letter/margin changes', () => {
  const p = { ...payload, selections: [], page: { before: { marginLeft: { magnitude: 54, unit: 'PT' } }, after: { tabId: 'main', backgroundColor: '#F4F1E8' } } };
  const html = render(p);
  assert.match(html, /Page background: #F4F1E8/); assert.match(html, /not paragraph shading/);
  assert.match(html, /Other page settings and tabs stay unchanged/);
  assert.doesNotMatch(html, /Letter portrait:|marginLeftPt:|size: LETTER/);
  for (const after of [{ tabId: 'main' }, { tabId: 'main', backgroundColor: '#F4F1E880' }, { tabId: 'main', backgroundColor: 'red' }, { tabId: 'main', backgroundColor: '#F4F1E8', raw: {} }]) {
    const bad = render({ ...p, page: { before: {}, after } });
    assert.match(bad, /details are incomplete/); assert.match(bad, /disabled=""[^>]*>Approve formatting/);
  }
});
test('missing details fail closed; synthetic renderer has no live link', () => {
  for (const p of [null, {}, { ...payload, selections: [], page: null }, { ...payload, expectedRevisionId: '' }, { ...payload, documentId: 'javascript:bad' }]) {
    const html = render(p); assert.match(html, /details are incomplete/); assert.match(html, /disabled=""[^>]*>Approve formatting/); assert.doesNotMatch(html, /href=/);
  }
  const html = render({ ...payload, exampleOnly: true }); assert.match(html, /Example only/); assert.match(html, /All choices are no-ops/); assert.doesNotMatch(html, /href=/);
});
