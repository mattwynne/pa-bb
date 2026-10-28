import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const componentFile = new URL('./docs-approval.generated.mjs', import.meta.url);
const connectionFile = new URL('./docs-connection.generated.mjs', import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
await writeFile(connectionFile, compile(await readFile(new URL('../connection-ui.tsx', import.meta.url), 'utf8')));
await writeFile(componentFile, compile((await readFile(new URL('../docs-approval.tsx', import.meta.url), 'utf8')).replace('./connection-ui.js', './docs-connection.generated.mjs')));
const { DocsApproval } = await import('./docs-approval.generated.mjs');
test.after(async () => { await unlink(componentFile); await unlink(connectionFile); });
const payload = { account: 'writer@example.test', documentId: 'doc-a', title: 'Plan <script>private</script>', tabId: 'tab-a', tabTitle: 'Introduction', expectedRevisionId: 'rev-a', oldText: 'Old <script>text</script>', newText: 'New & exact text' };
const render = p => renderToStaticMarkup(createElement(DocsApproval, { interaction: { id: 'synthetic', payload: p }, submit: async () => {}, cancel: async () => {} }));
test('approval shows exact target/account/before/after as escaped text, not executable content', () => {
  const html = render(payload);
  assert.match(html, /writer@example.test/); assert.match(html, /Introduction/);
  assert.match(html, /Old &lt;script&gt;text&lt;\/script&gt;/); assert.match(html, /New &amp; exact text/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /No write has happened/);
  assert.match(html, /Approve replacement/); assert.match(html, /Decline/);
  assert.match(html, /https:\/\/docs.google.com\/document\/d\/doc-a\/edit/);
  assert.match(html, /<details><summary>Technical details/); assert.doesNotMatch(html, /<details open/);
});
test('deletion preview and missing data cannot be confused with a saved write', () => {
  assert.match(render({ ...payload, newText: '' }), /delete the matched text/);
  for (const p of [null, {}, { ...payload, oldText: undefined }, { ...payload, newText: undefined }, { ...payload, documentId: 'javascript:bad' }]) {
    const html = render(p);
    assert.match(html, /details are incomplete/); assert.match(html, /disabled=""[^>]*>Approve replacement/);
    assert.doesNotMatch(html, /href=/);
  }
  const example = render({ ...payload, exampleOnly: true });
  assert.match(example, /Example only/); assert.match(example, /No Google account or document is accessed/);
  assert.doesNotMatch(example, /href=/); assert.match(example, /Cancel review/);
});
