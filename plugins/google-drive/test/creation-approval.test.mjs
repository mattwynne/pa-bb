import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const component = new URL('./creation-approval.generated.mjs', import.meta.url), connection = new URL('./creation-connection.generated.mjs', import.meta.url);
const compile = text => ts.transpileModule(text, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
await writeFile(connection, compile(await readFile(new URL('../connection-ui.tsx', import.meta.url), 'utf8')));
await writeFile(component, compile((await readFile(new URL('../creation-approval.tsx', import.meta.url), 'utf8')).replace('./connection-ui.js', './creation-connection.generated.mjs').replaceAll("'./core/", "'../core/")));
const { CreationApproval } = await import('./creation-approval.generated.mjs');
test.after(async () => { await unlink(component); await unlink(connection); });
const payload = { account: 'owner@example.invalid', operationId: '11111111-1111-4111-8111-111111111111', destinationId: 'folder', path: 'My Drive / Team', owners: 'owner@example.invalid', audience: 'team@example.invalid', title: 'Synthetic <script>', mimeType: 'application/vnd.google-apps.document', content: 'Exact <script> content' };
const render = p => renderToStaticMarkup(createElement(CreationApproval, { interaction: { id: 'synthetic', payload: p }, submit: async () => {}, cancel: async () => {} }));
test('review shows exact content, exposure and access with escaped provider data', () => {
  const html = render(payload);
  for (const text of ['owner@example.invalid', 'My Drive / Team', 'team@example.invalid', 'partial content', 'Complete requested content', 'Approve creation', 'Decline', 'Cancel review', '&lt;script&gt;']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/);
});
test('incomplete payload cannot be approved', () => {
  for (const key of Object.keys(payload)) assert.match(render({ ...payload, [key]: '' }), /disabled=""[^>]*>Approve creation/);
});
